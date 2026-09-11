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


@unittest.skipUnless(sys.platform == "linux", "Linux package builder")
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
            "updater/install.py", "updater/engine.py", "updater/updater.py", "updater/probe.mjs",
            "onboarding/scripts/install.sh", "onboarding/templates/a100-models.json",
        ):
            file = self.runtime / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture only\n")
        self.cloud = {"version": "1.37.2", "commit": "c" * 40}
        self.copilot = {"version": "2.5.3", "commit": "d" * 40}
        self.setup = {
            "schema": 1, "portalOrigin": "https://codey.example.test", "platform": "auto",
            "network": {"mode": "devtunnel"}, "tunnelAuthProvider": "github",
            "updater": {"protocol": 1, "releasePublicKey": subprocess.check_output([
                str(self.node / "bin/node"), "-e",
                "process.stdout.write(require('node:crypto').generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}))",
            ], text=True)},
        }
        write_json(self.runtime / "onboarding/setup.json", self.setup)
        write_json(self.runtime / "codey-build.json", {
            "schema": 1, "name": "codey", "version": pkg["version"], "sourceCommit": "b" * 40,
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
        }
        bundle.assemble_bundle(self.root, built, "https://codey.example.test",
                               self.setup["updater"]["releasePublicKey"])
        return self.root / "config-new-codey-machine.zip"

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
        help_text = subprocess.check_output([str(prefix / "bin/codey"), "setup", "--help"], text=True)
        self.assertIn("--check", help_text)

    def test_missing_modules_nested_app_packages_archives_and_traversal_are_rejected(self):
        for transform in (
            lambda files: files.pop("package/gateway/main.js"),
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
        self.assertEqual(outer["schema"], 2)
        self.assertEqual(outer["runtimePackage"]["name"], "codey")
        self.assertEqual(outer["runtimePackage"]["file"], self.artifact["file"])
        self.assertEqual(outer["codey"], package.inspect_npm_package(self.file))
        self.assertEqual(outer["npmSetup"], 1)
        self.assertEqual(outer["installer"]["file"], "install-codey-linux.sh")
        self.assertEqual(outer["runtimeInstaller"]["file"], "install-codey.mjs")
        self.assertEqual(outer["runtimeInstaller"]["sha256"], package.metadata(self.root / "install-codey.mjs")["sha256"])
        self.assertIn(self.artifact["file"], (self.root / "install-codey-linux.sh").read_text())
        self.assertEqual(outer["releaseId"], "machine-" + package.metadata(file)["sha256"][:16])
        self.assertEqual(json.loads(raw), outer)
        with zipfile.ZipFile(file) as archive:
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

    def test_complete_skill_can_run_its_documented_npm_entrypoint_without_other_downloads(self):
        file = self.machine_bundle()
        extracted = self.root / "extracted"
        with zipfile.ZipFile(file) as archive:
            archive.extractall(extracted)
        skill = extracted / "config-new-codey-machine"
        self.assertTrue((skill / "SKILL.md").is_file())
        self.assertTrue((skill / "agents/openai.yaml").is_file())
        self.assertIn("bash scripts/install-npm.sh --package assets/codey-*.tgz",
                      (skill / "SKILL.md").read_text())
        self.assertEqual(len(list((skill / "assets").glob("*.tgz"))), 1)
        home = self.root / "skill-home"
        home.mkdir()
        prefix = home / ".local/share/codey-skill-check"
        result = subprocess.run([
            "bash", "-c",
            'bash scripts/install-npm.sh --package assets/codey-*.tgz --node-dir "$1" --prefix "$2" --check',
            "skill-check", str(self.node), str(prefix),
        ], cwd=skill, env={
            **os.environ, "HOME": str(home), "npm_config_offline": "true",
            "npm_config_cache": str(home / ".npm"),
        }, check=True, capture_output=True, text=True, timeout=60)
        self.assertIn('"serviceChanges":false', result.stdout)
        self.assertTrue((prefix / "lib/node_modules/codey/bin/codey.mjs").is_file())
        self.assertFalse((home / ".config/codey-machine").exists())
        self.assertFalse((home / ".codex").exists())

    def test_publisher_uploads_direct_npm_and_installer_before_activating_and_never_partial_releases(self):
        file = self.machine_bundle()
        _, manifest, raw = publisher.inspect_package(file)
        store = MemoryStore()
        publisher.publish(store, file, manifest, raw, "none")
        release = "releases/" + manifest["releaseId"] + "/"
        self.assertEqual(store.files[release + self.artifact["file"]], self.file.read_bytes())
        self.assertEqual(store.files[release + "install-codey-linux.sh"], (self.root / "install-codey-linux.sh").read_bytes())
        self.assertEqual(store.files[release + "install-codey.mjs"], (self.root / "install-codey.mjs").read_bytes())
        self.assertLess(store.writes.index(release + self.artifact["file"]), store.writes.index("active.json"))
        self.assertLess(store.writes.index(release + "install-codey-linux.sh"), store.writes.index("active.json"))
        self.assertLess(store.writes.index(release + "install-codey.mjs"), store.writes.index("active.json"))
        self.assertEqual(json.loads(store.files["active.json"])["releaseId"], manifest["releaseId"])
        self.assertEqual(len([name for name in store.writes if name.startswith(".active-")]), 1)
        self.assertNotIn("publish.lock", store.directories)
        for failed_file in ("install-codey-linux.sh", "install-codey.mjs"):
            failed = MemoryStore(fail_on=failed_file)
            with self.subTest(file=failed_file), self.assertRaises(OSError):
                publisher.publish(failed, file, manifest, raw, "none")
            self.assertNotIn("active.json", failed.files)
            self.assertNotIn("publish.lock", failed.directories)

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

    def test_source_dependency_changes_require_updating_the_single_manifest(self):
        package.validate_dependencies({"dependencies": {"a": "1"}, "optionalDependencies": {}},
                                      {"dependencies": {"a": "1", "@openai/codex": "1"}}, {})
        with self.assertRaises(RuntimeError):
            package.validate_dependencies({"dependencies": {"a": "1"}}, {"dependencies": {"a": "2"}}, {})
        with self.assertRaises(RuntimeError):
            package.validate_dependencies({"dependencies": {"a": "1"}},
                                          {"dependencies": {"a": "1"}}, {"dependencies": {"a": "2"}})

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
