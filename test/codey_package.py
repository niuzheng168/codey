import hashlib
import importlib.util
import io
import json
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
            "updater/install.py", "updater/engine.py", "updater/updater.py",
        ):
            file = self.runtime / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture only\n")
        self.cloud = {"version": "1.37.2", "commit": "c" * 40}
        self.copilot = {"version": "2.5.3", "commit": "d" * 40}
        write_json(self.runtime / "codey-build.json", {
            "schema": 1, "name": "codey", "version": pkg["version"], "sourceCommit": "b" * 40,
            "cloudcli": self.cloud, "copilotApi": self.copilot,
            "lockSha256": package.metadata(self.runtime / "npm-shrinkwrap.json")["sha256"],
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
                               "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n")
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
        self.assertEqual(info["version"], "0.1.0")
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
        self.assertEqual(output.strip(), "codey 0.1.0")

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

    def test_machine_bundle_and_publisher_use_the_npm_package_without_changing_portal_outer_schema(self):
        file = self.machine_bundle()
        _, outer, raw = publisher.inspect_package(file)
        self.assertEqual(outer["schema"], 2)
        self.assertEqual(outer["runtimePackage"]["name"], "codey")
        self.assertEqual(outer["runtimePackage"]["file"], self.artifact["file"])
        self.assertEqual(outer["codey"], package.inspect_npm_package(self.file))
        self.assertEqual(outer["releaseId"], "machine-" + package.metadata(file)["sha256"][:16])
        self.assertEqual(json.loads(raw), outer)
        with zipfile.ZipFile(file) as archive:
            archives = [name for name in archive.namelist() if name.endswith((".tgz", ".tar.gz"))]
            self.assertEqual(archives, ["config-new-codey-machine/assets/" + self.artifact["file"]])
        result = subprocess.run([
            sys.executable, str(ROOT / "scripts/publish-machine-skill.py"),
            "--package", str(file), "--config", "not-used-in-dry-run",
            "--expected-current", "none",
        ], check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout)["azureRequests"], 0)

    def test_publisher_rejects_extra_split_archives_or_payload_corruption(self):
        file = self.machine_bundle()
        with zipfile.ZipFile(file) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        for changes in (
            {"config-new-codey-machine/assets/cloudcli.tar.gz": b"old split application"},
            {"config-new-codey-machine/assets/" + self.artifact["file"]: b"corrupt"},
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
