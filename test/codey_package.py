import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import codey_package as package


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bundle = load("codey_machine_bundle", "scripts/build-machine-bundle.py")
publisher = load("codey_machine_publisher", "scripts/publish-machine-skill.py")


def write_json(file, value):
    file.write_text(json.dumps(value, indent=2) + "\n")

class MemoryStore:
    def __init__(self, fail_on=None):
        self.files, self.directories, self.writes = {}, set(), []
        self.fail_on = fail_on

    def ensure_root(self): pass
    def list_root(self): return list(self.files)
    def read(self, name, limit):
        value = self.files.get(name)
        if value is not None:
            assert len(value) <= limit
        return value
    def mkdir(self, name, exclusive=False):
        if exclusive and name in self.directories:
            raise FileExistsError(name)
        self.directories.add(name)
    def write_bytes_new(self, name, data):
        publisher.checked_name(name)
        assert name not in self.files
        self.files[name] = data
        self.writes.append(name)
    def write_file_new(self, name, file, size, digest):
        if self.fail_on and name.endswith(self.fail_on):
            raise OSError("fixture upload failed")
        data = Path(file).read_bytes()
        assert len(data) == size and hashlib.sha256(data).hexdigest() == digest
        self.write_bytes_new(name, data)
    def replace(self, source, destination):
        self.files[destination] = self.files.pop(source)
        self.writes.append(destination)
    def unlink(self, name): self.files.pop(name, None)
    def rmdir(self, name): self.directories.remove(name)


class BuildHostTests(unittest.TestCase):
    def test_installer_archive_names_use_only_valid_codey_versions(self):
        for version in ("0.2.0", "12.34.56", "0.3.0-rc.1"):
            with self.subTest(version=version):
                self.assertEqual(package.machine_skill_filename(version), f"codey-{version}.zip")
        for version in (None, ["0.2.0"], "", "latest", "0.2", "../0.2.0", "0.2.0/other", "0.2.0\r\n"):
            with self.subTest(version=version), self.assertRaisesRegex(RuntimeError, "Invalid Codey version"):
                package.machine_skill_filename(version)

    def test_mac_experiments_cannot_become_production_builds(self):
        for system, machine in (("Darwin", "arm64"), ("Darwin", "x86_64")):
            with patch.object(package.platform, "system", return_value=system), \
                    patch.object(package.platform, "machine", return_value=machine):
                for reviewed, node in ((False, None), (False, "/node"), (True, None)):
                    with self.assertRaisesRegex(RuntimeError, "Release builds require Linux"):
                        package.validate_build_host(reviewed, node)
                package.validate_build_host(True, "/node")
        with patch.object(package.platform, "system", return_value="Linux"), \
                patch.object(package.platform, "machine", return_value="x86_64"):
            package.validate_build_host(False, None)


@unittest.skipUnless(sys.platform in ("linux", "darwin"), "Unix package contract")
class CodeyPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="codey-npm-package-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.node = Path(shutil.which("node")).parent.parent
        pkg = json.loads((ROOT / "packages/codey/package.json").read_text())
        self.version = pkg["version"]
        pkg.update({"dependencies": {}, "optionalDependencies": {}, "overrides": {}, "scripts": {}})
        write_json(self.runtime / "package.json", pkg)
        write_json(self.runtime / "npm-shrinkwrap.json", {
            "name": "codey", "version": pkg["version"], "lockfileVersion": 3,
            "packages": {"": {"name": "codey", "version": pkg["version"],
                             "dependencies": {}, "optionalDependencies": {}}},
        })
        for name in ("bin", "lib"):
            shutil.copytree(ROOT / "packages/codey" / name, self.runtime / name)
        for name in (
            "dist-server/server/index.js", "dist/index.html", "gateway/main.js", "pages/index.html",
            "lib/codex-sdk/index.js",
        ):
            file = self.runtime / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture only\n")
        package.copy_onboarding(ROOT, self.runtime)
        self.cloud = {"version": "1.37.2", "commit": "c" * 40}
        self.copilot = {"version": "2.5.3", "commit": "d" * 40}
        self.release_source = {
            "schema": 1, "kind": "codey-main-source", "ref": "refs/heads/main",
            "commit": "b" * 40, "tree": "a" * 40, "sourceDirty": False, "codeyVersion": pkg["version"],
            "submodules": {"cloudcli": self.cloud["commit"], "copilot-api": self.copilot["commit"]},
        }
        self.setup = {
            "schema": 1, "portalOrigin": "https://codey.example.test", "platform": "auto",
            "network": {"mode": "devtunnel"}, "tunnelAuthProvider": "github",
        }
        write_json(self.runtime / "onboarding/setup.json", self.setup)
        write_json(self.runtime / "codey-build.json", {
            "schema": 1, "name": "codey", "version": pkg["version"], "sourceCommit": "b" * 40,
            "sourceDirty": False, "releaseSource": self.release_source,
            "runtimePlatforms": package.RUNTIME_PLATFORMS,
            "cloudcli": self.cloud, "copilotApi": self.copilot,
            "lockSha256": package.metadata(self.runtime / "npm-shrinkwrap.json")["sha256"],
            "workspaceEntrySha256": package.metadata(self.runtime / "dist-server/server/index.js")["sha256"],
            "gatewayEntrySha256": package.metadata(self.runtime / "gateway/main.js")["sha256"],
        })
        self.artifact = package.pack_runtime(self.runtime, self.root, self.node, None)
        self.file = self.root / self.artifact["file"]

    def machine_bundle(self):
        built = {
            "node": "24.20.0", "nodeDistribution": {}, "bunBuildTool": "1.4.2",
            "cloudcli": self.cloud, "copilotApi": self.copilot,
            "codey": package.inspect_npm_package(self.file), "artifact": self.artifact,
            "releaseSource": self.release_source,
        }
        result = bundle.assemble_bundle(self.root, built, "https://codey.example.test")
        self.assertEqual(result["package"]["file"], f"codey-{self.version}.zip")
        return self.root / result["package"]["file"]

    def rewritten(self, transform):
        with tarfile.open(self.file, "r:gz") as archive:
            files = {item.name: archive.extractfile(item).read() for item in archive if item.isfile()}
        transform(files)
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            for name, body in files.items():
                item = tarfile.TarInfo(name)
                item.size = len(body)
                archive.addfile(item, io.BytesIO(body))
        data.seek(0)
        return data

    def test_real_npm_pack_has_one_application_manifest_and_is_deterministic(self):
        info = package.inspect_npm_package(self.file)
        self.assertEqual(info["version"], self.version)
        with tarfile.open(self.file) as archive:
            manifests = [item.name for item in archive if item.name.endswith("/package.json")]
            self.assertEqual(manifests, ["package/package.json"])
        second = self.root / "second"
        second.mkdir()
        self.assertEqual(self.artifact, package.pack_runtime(self.runtime, second, self.node, None))

    def test_shared_package_size_limit_accepts_boundary_and_rejects_larger_files_and_streams(self):
        self.assertEqual(package.MAX_PACKAGE_BYTES, 8 * 1024 * 1024)
        content = self.file.read_bytes()
        for source in (self.file, io.BytesIO(content)):
            with self.subTest(stream=hasattr(source, "read")):
                with patch.object(package, "MAX_PACKAGE_BYTES", len(content)):
                    self.assertEqual(package.inspect_npm_package(source)["version"], self.version)
                with patch.object(package, "MAX_PACKAGE_BYTES", len(content) - 1):
                    with self.assertRaisesRegex(RuntimeError, "8 MiB release limit"):
                        package.inspect_npm_package(source)

    def test_npm_can_install_the_one_package_and_creates_only_the_codey_executable(self):
        prefix = self.root / "installation"
        subprocess.run([
            str(self.node / "bin/npm"), "install", "--global", "--prefix", str(prefix),
            "--offline", "--ignore-scripts", "--no-audit", "--no-fund", str(self.file),
        ], check=True, capture_output=True)
        self.assertEqual([file.name for file in (prefix / "lib/node_modules").iterdir()
                          if not file.name.startswith(".")], ["codey"])
        self.assertEqual([file.name for file in (prefix / "bin").iterdir()], ["codey"])
        output = subprocess.check_output([str(prefix / "bin/codey"), "--version"], text=True)
        self.assertEqual(output.strip(), f"codey {self.version}")
        help_text = subprocess.check_output([str(prefix / "bin/codey"), "guard", "--help"], text=True)
        self.assertIn("--timeout", help_text)
        self.assertIn("supervisors", help_text)
        removed = subprocess.run([str(prefix / "bin/codey"), "setup", "--help"], capture_output=True, text=True)
        self.assertEqual(removed.returncode, 1)
        self.assertIn("Unknown command: setup", removed.stderr)

    def test_npm_onboarding_contains_cli_reference_and_importable_shared_setup(self):
        reference = "references/codey-cli.md"
        expected = (ROOT / "skills/config-new-codey-machine" / reference).read_bytes()
        with tarfile.open(self.file) as archive:
            self.assertEqual(archive.extractfile("package/onboarding/" + reference).read(), expected)
        entry = self.runtime / "onboarding/scripts/install-machine.mjs"
        result = subprocess.run([
            str(self.node / "bin/node"), "--input-type=module", "-e",
            "import {pathToFileURL} from 'node:url'; "
            "const entry=process.argv[1]; process.argv[1]='onboarding-import-fixture'; "
            "const {Installer}=await import(pathToFileURL(entry).href); "
            "if(typeof Installer!=='function')process.exit(1);", str(entry),
        ], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "")

    def test_missing_modules_nested_app_packages_archives_and_traversal_are_rejected(self):
        for transform in (
            lambda files: files.pop("package/gateway/main.js"),
            lambda files: files.pop("package/lib/workspace.mjs"),
            lambda files: files.pop("package/lib/install.mjs"),
            lambda files: files.update({"package/cloudcli/package.json": b"{}"}),
            lambda files: files.update({"package/copilot-api.tar.gz": b"old split package"}),
            lambda files: files.update({"package/node_modules/@jeffreycao/copilot-api/index.js": b""}),
            lambda files: files.update({"package/../../outside": b"unsafe"}),
        ):
            with self.subTest(transform=transform), self.assertRaises(RuntimeError):
                package.inspect_npm_package(self.rewritten(transform))

    def test_dependency_lock_and_build_metadata_cannot_describe_different_packages(self):
        def change_manifest(files):
            value = json.loads(files["package/package.json"])
            value["dependencies"] = {"@jeffreycao/copilot-api": "2.5.3"}
            files["package/package.json"] = json.dumps(value).encode()
        def change_version(files):
            value = json.loads(files["package/codey-build.json"])
            value["version"] = "9.9.9"
            files["package/codey-build.json"] = json.dumps(value).encode()
        for transform in (change_manifest, change_version):
            with self.subTest(transform=transform), self.assertRaises(RuntimeError):
                package.inspect_npm_package(self.rewritten(transform))

    def test_shared_lock_rejects_private_feeds_local_sources_and_unverified_dependencies(self):
        pkg = json.loads((self.runtime / "package.json").read_text())
        lock = json.loads((self.runtime / "npm-shrinkwrap.json").read_text())
        good = {
            "version": "1.0.0", "resolved": "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
            "integrity": "sha512-YWJjZA==",
        }
        lock["packages"]["node_modules/example"] = good
        package.validate_runtime_lock(pkg, lock)
        for changed in (
            {"resolved": "https://ms-feed-25.pkgs.visualstudio.com/example.tgz"},
            {"resolved": "file:C:/Users/builder/example.tgz"},
            {"resolved": "https://user:secret@registry.npmjs.org/example.tgz"},
            {"integrity": ""}, {"link": True},
        ):
            lock["packages"]["node_modules/example"] = {**good, **changed}
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, "shared public npm lock"):
                package.validate_runtime_lock(pkg, lock)

    def test_native_payloads_and_build_host_restrictions_cannot_enter_shared_releases(self):
        for name, body in (
            ("public/addon.node", b"native payload"),
            ("public/program", b"\x7fELFnative payload"),
            ("public/program.js", b"MZnative payload"),
            *((f"public/mach-{magic}", bytes.fromhex(magic) + b"native payload") for magic in
              ("feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca")),
        ):
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, "platform-native"):
                package.inspect_npm_package(self.rewritten(
                    lambda files: files.update({"package/" + name: body})))
        def host_only(files):
            value = json.loads(files["package/codey-build.json"])
            value["platform"] = "windows-x64"
            files["package/codey-build.json"] = json.dumps(value).encode()
        def limited_manifest(files):
            value = json.loads(files["package/package.json"])
            value["os"] = ["linux"]
            files["package/package.json"] = json.dumps(value).encode()
        for transform in (host_only, limited_manifest):
            with self.subTest(transform=transform), self.assertRaises(RuntimeError):
                package.inspect_npm_package(self.rewritten(transform))

    def test_text_normalization_preserves_binary_files_dependencies_and_lock_contents(self):
        tree = self.root / "text-fixture"
        (tree / "node_modules/example").mkdir(parents=True)
        text = b'{\r\n  "z": 1,\r\n  "a": 2\r\n}\r\n'
        binary = b"\x89PNG\r\n\x1a\nfixture\r\n"
        for name in ("entry.js", "module.mjs", "npm-shrinkwrap.json", "LICENSE"):
            (tree / name).write_bytes(text)
        (tree / "icon.png").write_bytes(binary)
        (tree / "node_modules/example/index.js").write_bytes(text)
        package.normalize_runtime_text(tree)
        for name in ("entry.js", "module.mjs", "npm-shrinkwrap.json", "LICENSE"):
            self.assertEqual((tree / name).read_bytes(), text.replace(b"\r\n", b"\n"))
        self.assertEqual((tree / "icon.png").read_bytes(), binary)
        self.assertEqual((tree / "node_modules/example/index.js").read_bytes(), text)
        before = package.content_digest(tree)
        package.normalize_runtime_text(tree)
        self.assertEqual(package.content_digest(tree), before)

    def test_machine_bundle_and_publisher_use_the_npm_package_without_changing_portal_outer_schema(self):
        file = self.machine_bundle()
        _, outer, raw = publisher.inspect_package(file)
        self.assertEqual(file.name, f"codey-{self.version}.zip")
        self.assertEqual(outer["package"]["file"], file.name)
        self.assertFalse((self.root / "config-new-codey-machine.zip").exists())
        self.assertEqual(outer["schema"], 2)
        self.assertEqual(outer["runtimePackage"]["name"], "codey")
        self.assertEqual(outer["runtimePackage"]["file"], self.artifact["file"])
        self.assertEqual(outer["codey"], package.inspect_npm_package(self.file))
        self.assertEqual(outer["npmSetup"], 1)
        self.assertEqual(outer["managedInstallPlatforms"], package.RUNTIME_PLATFORMS)
        self.assertEqual(outer["runtimePlatforms"], package.RUNTIME_PLATFORMS)
        self.assertEqual(outer["installer"]["file"], "install-codey-linux.sh")
        self.assertEqual(outer["runtimeInstaller"]["file"], "install-codey.mjs")
        self.assertEqual(outer["runtimeInstaller"]["sha256"], package.metadata(self.root / "install-codey.mjs")["sha256"])
        self.assertIn(self.artifact["file"], (self.root / "install-codey-linux.sh").read_text())
        self.assertEqual(outer["releaseId"], "machine-" + package.metadata(file)["sha256"][:16])
        self.assertEqual(json.loads(raw), outer)
        with zipfile.ZipFile(file) as archive:
            for required in package.MACHINE_SKILL_FILES:
                self.assertIn("config-new-codey-machine/" + required, archive.namelist())
            archives = [name for name in archive.namelist() if name.endswith((".tgz", ".tar.gz"))]
            self.assertEqual(archives, ["config-new-codey-machine/assets/" + self.artifact["file"]])
            self.assertEqual(archive.read(archives[0]), self.file.read_bytes(), "Never repack the application for the Skill's OS")
            self.assertEqual(json.loads(archive.read("config-new-codey-machine/assets/setup.json"))["platform"], "linux-x64")
            installer = archive.read("config-new-codey-machine/scripts/install-runtime.mjs")
            self.assertEqual(installer, (self.root / "install-codey.mjs").read_bytes())
            self.assertIn(f'const DEFAULT_PACKAGE_FILE = "{self.artifact["file"]}";'.encode(), installer)
            self.assertIn(f'const DEFAULT_PACKAGE_SHA256 = "{self.artifact["sha256"]}";'.encode(), installer)
        with tarfile.open(self.file) as archive:
            self.assertEqual(json.load(archive.extractfile("package/onboarding/setup.json"))["platform"], "auto")
        self.assertEqual((self.root / (self.artifact["file"] + ".sha256")).read_text(),
                         f'{self.artifact["sha256"]}  {self.artifact["file"]}\n')
        result = subprocess.run([
            sys.executable, str(ROOT / "scripts/publish-machine-skill.py"),
            "--package", str(file), "--config", "not-used-in-dry-run",
            "--expected-current", "none",
        ], check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout)["azureRequests"], 0)

    def test_publisher_derives_archive_name_from_validated_contents_not_input_filename(self):
        file = self.machine_bundle()
        renamed = file.rename(self.root / "downloaded-copy.zip")
        inspected, manifest, _ = publisher.inspect_package(renamed)
        self.assertEqual(inspected, renamed)
        self.assertEqual(manifest["package"]["file"], f"codey-{self.version}.zip")
        self.assertEqual(manifest["package"]["sha256"], package.metadata(renamed)["sha256"])

    def test_complete_skill_preserves_guidance_and_legacy_npm_entrypoint(self):
        file = self.machine_bundle()
        extracted = self.root / "extracted"
        with zipfile.ZipFile(file) as archive:
            archive.extractall(extracted)
        skill = extracted / "config-new-codey-machine"
        for relative in ("SKILL.md", "agents/openai.yaml", "references/codey-cli.md"):
            self.assertEqual(
                (skill / relative).read_bytes(),
                (ROOT / "skills/config-new-codey-machine" / relative).read_bytes(),
                "The Skill must ship its current guidance and metadata unchanged",
            )
        self.assertEqual(len(list((skill / "assets").glob("*.tgz"))), 1)
        if sys.platform != "linux":
            return  # Package contents are universal; this legacy shell entry is Linux-only.
        home = self.root / "skill-home"
        home.mkdir()
        stubs = self.root / "preflight-stubs"
        stubs.mkdir()
        for name, body in {
            "ss": "exit 0",
            "getent": 'printf "fixture:x:%s:1000::%s:/bin/bash\\n" "$(id -u)" "$HOME"',
        }.items():
            file = stubs / name
            file.write_text("#!/bin/sh\n" + body + "\n")
            file.chmod(0o700)
        prefix = home / ".local/share/codey-skill-check"
        result = subprocess.run([
            "bash", "-c",
            'bash scripts/install-npm.sh --package assets/codey-*.tgz --node-dir "$1" --prefix "$2" --check',
            "skill-check", str(self.node), str(prefix),
        ], cwd=skill, env={
            **os.environ, "HOME": str(home), "SUDO_USER": "", "npm_config_offline": "true",
            "PATH": str(stubs) + os.pathsep + os.environ["PATH"],
            "npm_config_cache": str(home / ".npm"),
        }, check=True, capture_output=True, text=True, timeout=60)
        self.assertIn("Read-only check", result.stdout)
        self.assertFalse(prefix.exists())
        self.assertFalse((home / ".config/codey-machine").exists())
        self.assertFalse((home / ".codex").exists())

    def test_publisher_uploads_direct_npm_and_installer_before_activating_and_never_partial_releases(self):
        file = self.machine_bundle()
        _, manifest, raw = publisher.inspect_package(file)
        store = MemoryStore()
        publisher.publish(store, file, manifest, raw, "none")
        release = "releases/" + manifest["releaseId"] + "/"
        self.assertEqual(store.files[release + f"codey-{self.version}.zip"], file.read_bytes())
        self.assertNotIn(release + "config-new-codey-machine.zip", store.files)
        self.assertLess(store.writes.index(release + f"codey-{self.version}.zip"), store.writes.index("active.json"))
        self.assertEqual(store.files[release + self.artifact["file"]], self.file.read_bytes())
        self.assertEqual(store.files[release + "install-codey-linux.sh"], (self.root / "install-codey-linux.sh").read_bytes())
        self.assertEqual(store.files[release + "install-codey.mjs"], (self.root / "install-codey.mjs").read_bytes())
        self.assertLess(store.writes.index(release + self.artifact["file"]), store.writes.index("active.json"))
        self.assertLess(store.writes.index(release + "install-codey-linux.sh"), store.writes.index("active.json"))
        self.assertLess(store.writes.index(release + "install-codey.mjs"), store.writes.index("active.json"))
        self.assertEqual(json.loads(store.files["active.json"])["releaseId"], manifest["releaseId"])
        self.assertEqual(len([name for name in store.writes if name.startswith(".active-")]), 1)
        self.assertNotIn("publish.lock", store.directories)
        for failed_file in (f"codey-{self.version}.zip", "install-codey-linux.sh", "install-codey.mjs"):
            failed = MemoryStore(fail_on=failed_file)
            with self.subTest(file=failed_file), self.assertRaises(OSError):
                publisher.publish(failed, file, manifest, raw, "none")
            self.assertNotIn("active.json", failed.files)
            self.assertNotIn("publish.lock", failed.directories)

    def test_renaming_an_existing_release_cannot_mutate_its_files_or_active_pointer(self):
        file = self.machine_bundle()
        _, manifest, raw = publisher.inspect_package(file)
        legacy = {**manifest, "package": {**manifest["package"], "file": "config-new-codey-machine.zip"}}
        legacy_raw = (json.dumps(legacy, indent=2) + "\n").encode()
        release = "releases/" + manifest["releaseId"]
        store = MemoryStore()
        store.directories.add(release)
        store.files.update({
            ".codey-machine-skill-store.json": publisher.MARKER,
            release + "/manifest.json": legacy_raw,
            release + "/config-new-codey-machine.zip": file.read_bytes(),
            "active.json": (json.dumps({
                "schema": 1, "releaseId": manifest["releaseId"],
                "manifestSha256": hashlib.sha256(legacy_raw).hexdigest(),
            }) + "\n").encode(),
        })
        before = dict(store.files)
        with self.assertRaisesRegex(publisher.PublishError, "IMMUTABLE_MANIFEST_COLLISION"):
            publisher.publish(store, file, manifest, raw, manifest["releaseId"])
        self.assertEqual(store.files, before)
        self.assertEqual(store.directories, {release})
        self.assertFalse(any(name.startswith(release + "/") for name in store.writes))

    def test_publisher_rejects_noncanonical_archive_names_before_store_access(self):
        file = self.machine_bundle()
        _, manifest, raw = publisher.inspect_package(file)
        for filename in ("config-new-codey-machine.zip", "codey-99.0.0.zip", "../codey.zip"):
            store = MemoryStore()
            with self.subTest(filename=filename), self.assertRaisesRegex(publisher.PublishError, "INVALID_PACKAGE_NAME"):
                publisher.publish(store, file, {
                    **manifest, "package": {**manifest["package"], "file": filename},
                }, raw, "none")
            self.assertEqual(store.files, {})
            self.assertEqual(store.directories, set())

    def test_production_machine_publication_refuses_missing_or_dirty_main_proof_before_store_access(self):
        file = self.machine_bundle()
        _, manifest, raw = publisher.inspect_package(file)
        for source in (None, {**self.release_source, "sourceDirty": True},
                       {**self.release_source, "ref": "refs/heads/dev"}):
            store = MemoryStore()
            with self.subTest(source=source), self.assertRaisesRegex(RuntimeError, "main provenance"):
                publisher.publish(store, file, {**manifest, "releaseSource": source}, raw, "none")
            self.assertEqual(store.files, {})
            self.assertEqual(store.directories, set())

    def test_publisher_rejects_extra_split_archives_or_payload_corruption(self):
        file = self.machine_bundle()
        with zipfile.ZipFile(file) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        for changes in (
            {"config-new-codey-machine/assets/cloudcli.tar.gz": b"old split application"},
            {"config-new-codey-machine/assets/" + self.artifact["file"]: b"corrupt"},
            {"config-new-codey-machine/scripts/install-runtime.mjs":
                files["config-new-codey-machine/scripts/install-runtime.mjs"].replace(
                    self.artifact["sha256"].encode(), b"a" * 64)},
        ):
            modified = self.root / "invalid.zip"
            with zipfile.ZipFile(modified, "w", compression=zipfile.ZIP_STORED) as archive:
                for name, body in {**files, **changes}.items():
                    archive.writestr(name, body)
            with self.subTest(changes=changes), self.assertRaises(publisher.PublishError):
                publisher.inspect_package(modified)

    def test_publisher_rejects_skill_without_any_native_installer_or_registration_helper(self):
        file = self.machine_bundle()
        with zipfile.ZipFile(file) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        for missing in ["scripts/install.ps1", "scripts/install-macos.mjs", "scripts/install-macos.sh", "scripts/registration.mjs",
                        "scripts/windows-common.ps1", "scripts/macos-service.mjs", "dependencies.macos.json"]:
            modified = self.root / "incomplete.zip"
            with zipfile.ZipFile(modified, "w", compression=zipfile.ZIP_STORED) as archive:
                for name, body in files.items():
                    if name != "config-new-codey-machine/" + missing:
                        archive.writestr(name, body)
            with self.subTest(missing=missing), self.assertRaises(publisher.PublishError):
                publisher.inspect_package(modified)

    def test_runtime_and_skill_do_not_ship_python_or_updaters(self):
        with tarfile.open(self.file) as archive:
            names = archive.getnames()
        self.assertFalse(any(name.endswith((".py", ".pyc")) or "/updater/" in name for name in names))
        self.assertNotIn("package/lib/update.mjs", names)
        with zipfile.ZipFile(self.machine_bundle()) as archive:
            self.assertFalse(any(name.endswith((".py", ".pyc")) for name in archive.namelist()))
            setup = json.loads(archive.read("config-new-codey-machine/assets/setup.json"))
            self.assertNotIn("updater", setup)
        for name in ["package/lib/worker.py", "package/updater/agent.mjs", "package/lib/update.mjs"]:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, "retired updaters"):
                package.inspect_npm_package(self.rewritten(lambda files: files.update({name: b"retired"})))

    def test_source_dependency_changes_require_updating_the_single_manifest(self):
        package.validate_dependencies({"dependencies": {"a": "1"}, "optionalDependencies": {}},
                                      {"dependencies": {"a": "1", "@openai/codex": "1"}}, {})
        with self.assertRaises(RuntimeError):
            package.validate_dependencies({"dependencies": {"a": "1"}}, {"dependencies": {"a": "2"}}, {})
        with self.assertRaises(RuntimeError):
            package.validate_dependencies({"dependencies": {"a": "1"}},
                                          {"dependencies": {"a": "1"}}, {"dependencies": {"a": "2"}})

    def test_runtime_manifest_is_a_reviewed_subset_not_the_frontend_dependency_union(self):
        package.validate_dependencies(
            {"dependencies": {"server": "1"}},
            {"dependencies": {"server": "1", "react": "2", "mermaid": "3"},
             "optionalDependencies": {"unused-desktop": "4"}},
            {"dependencies": {"build-only": "5"}},
        )
        for manifest in (
            {"dependencies": {"server": "different"}},
            {"dependencies": {"unreviewed": "1"}},
            {"dependencies": {"@openai/codex": "1"}},
            {"dependencies": {"server": "1"}, "optionalDependencies": {"server": "1"}},
        ):
            with self.subTest(manifest=manifest), self.assertRaises(RuntimeError):
                package.validate_dependencies(manifest, {"dependencies": {"server": "1"}}, {})

    def test_reviewed_source_patch_applies_inside_an_outer_checkout_without_touching_it(self):
        source = self.root / "source-repo"
        source.mkdir()
        subprocess.run(["git", "init", "-q", str(source)], check=True)
        write_json(source / "package.json", {"name": "fixture", "version": "1.0.0"})
        (source / "config.ts").write_text("export const enabled = true\n")
        subprocess.run(["git", "-C", str(source), "add", "package.json", "config.ts"], check=True)
        subprocess.run([
            "git", "-C", str(source), "-c", "user.name=Fixture",
            "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false",
            "commit", "-q", "-m", "fixture",
        ], check=True)
        (source / "config.ts").write_text("export const enabled = false\n")
        outer = self.root / "outer-repo"
        outer.mkdir()
        subprocess.run(["git", "init", "-q", str(outer)], check=True)
        sentinel = outer / "config.ts"
        sentinel.write_text("unrelated outer checkout file\n")
        destination = outer / "artifacts/build/source"
        destination.parent.mkdir(parents=True)
        with self.assertRaises(RuntimeError):
            package.source(source, destination, False)
        self.assertFalse(destination.exists())
        info = package.source(source, destination, True)
        self.assertEqual((destination / "config.ts").read_bytes(), (source / "config.ts").read_bytes())
        self.assertEqual(sentinel.read_text(), "unrelated outer checkout file\n")
        self.assertIsNotNone(info["patchSha256"])


if __name__ == "__main__":
    unittest.main()
