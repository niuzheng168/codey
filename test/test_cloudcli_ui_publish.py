"""Offline publisher tests. No Azure credentials, resource calls or live services."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("publisher", ROOT / "scripts/publish-cloudcli-ui.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class UiPublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="codey-ui-publish-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = publisher.LocalStore(self.root / "store")

    def package(self, release, script=b"test"):
        directory = self.root / release
        directory.mkdir()
        values = {
            "index.html": b'<!-- CODEY_WORKSPACE_RUNTIME -->__CODEY_WORKSPACE_MANIFEST__',
            "sw.js": b"worker",
            "manifest.json": b'{"icons":[]}',
            "assets/app.js": script,
        }
        for name, body in values.items():
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        manifest = {
            "schema": 1, "kind": "codey-cloudcli-ui", "release": release,
            "assetBase": f"/cloudcli-ui/{release}/", "apiContract": 1,
            "cloudCliVersion": "1.37.2", "sourceSha256": "a" * 64,
            "files": {name: {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
                      for name, body in values.items()},
        }
        (directory / "ui-package.json").write_text(json.dumps(manifest))
        return directory

    def active(self):
        return json.loads((self.root / "store/active.json").read_text())

    def test_publish_upgrade_and_rollback_keep_old_versions(self):
        first, second = self.package("ui-first"), self.package("ui-second", b"new")
        report = publisher.publish_package(self.store, first, "none")
        self.assertEqual(report["nodeDeployments"], 0)
        self.assertEqual(report["serviceRestarts"], 0)
        publisher.publish_package(self.store, second, "ui-first")
        self.assertEqual(self.active()["release"], "ui-second")
        self.assertEqual((self.root / "store/releases/ui-first/assets/app.js").read_bytes(), b"test")
        publisher.publish_package(self.store, first, "ui-second")
        self.assertEqual(self.active()["release"], "ui-first")
        self.assertEqual(len(list((self.root / "store/history").iterdir())), 3)
        self.assertFalse((self.root / "store/publish.lock").exists())

    def test_stale_expected_release_cannot_overwrite_another_publication(self):
        first, second = self.package("ui-first"), self.package("ui-second")
        publisher.publish_package(self.store, first, "none")
        original = self.store.read("active.json", 1024)
        with self.assertRaisesRegex(publisher.PublishError, "ACTIVE_RELEASE_CHANGED"):
            publisher.publish_package(self.store, second, "none")
        self.assertEqual(self.store.read("active.json", 1024), original)
        self.assertFalse((self.root / "store/releases/ui-second").exists())

    def test_bad_upload_keeps_previous_activation_and_releases_lock(self):
        first, second = self.package("ui-first"), self.package("ui-second")
        publisher.publish_package(self.store, first, "none")
        write_new = self.store.write_new

        def fail(name, body):
            if name == "releases/ui-second/sw.js":
                raise OSError("simulated storage failure")
            write_new(name, body)

        self.store.write_new = fail
        with self.assertRaises(OSError):
            publisher.publish_package(self.store, second, "ui-first")
        self.assertEqual(self.active()["release"], "ui-first")
        self.assertFalse((self.root / "store/releases/ui-second/ui-package.json").exists())
        self.assertFalse((self.root / "store/publish.lock").exists())
        self.store.write_new = write_new
        publisher.publish_package(self.store, second, "ui-first")
        self.assertEqual(self.active()["release"], "ui-second")

    def test_immutable_release_collision_is_not_overwritten(self):
        first = self.package("ui-first")
        publisher.publish_package(self.store, first, "none")
        target = self.root / "store/releases/ui-first/assets/app.js"
        target.write_bytes(b"oops")
        with self.assertRaisesRegex(publisher.PublishError, "IMMUTABLE_RELEASE_COLLISION"):
            publisher.publish_package(self.store, first, "ui-first")
        self.assertEqual(target.read_bytes(), b"oops")
        self.assertEqual(self.active()["release"], "ui-first")

    def test_crashed_writers_lock_is_not_stolen(self):
        first = self.package("ui-first")
        publisher.publish_package(self.store, first, "none")
        lock = self.root / "store/publish.lock"
        lock.mkdir()
        (lock / "owner.json").write_text('{"transaction":"another-writer"}')
        with self.assertRaisesRegex(publisher.PublishError, "UI_PUBLISH_LOCKED"):
            publisher.publish_package(self.store, first, "ui-first")
        self.assertTrue(lock.exists())

    def test_unknown_directory_and_symlinks_are_refused(self):
        first = self.package("ui-first")
        self.store.ensure_root()
        private = self.root / "store/accounts.json"
        private.write_bytes(b"private")
        with self.assertRaisesRegex(publisher.PublishError, "REFUSING_NON_UI_DIRECTORY"):
            publisher.publish_package(self.store, first, "none")
        self.assertEqual(private.read_bytes(), b"private")
        link = self.root / "store-link"
        link.symlink_to(self.root / "store", target_is_directory=True)
        with self.assertRaisesRegex(publisher.PublishError, "STORE_SYMLINK"):
            publisher.LocalStore(link)

    def test_dry_run_has_no_target_side_effects(self):
        first = self.package("ui-first")
        result = subprocess.run([
            sys.executable, "-I", "-S", str(ROOT / "scripts/publish-cloudcli-ui.py"),
            "--package", str(first), "--local", str(self.root / "not-created"),
        ], capture_output=True, text=True, check=True)
        report = json.loads(result.stdout)
        self.assertTrue(report["dryRun"])
        self.assertEqual(report["azureRequests"], 0)
        self.assertFalse((self.root / "not-created").exists())

    def test_store_paths_cannot_inject_queries_or_escape_directories(self):
        for value in ["../active.json", "/active.json", "nested//file", "file?token=x", "file#other", r"nested\\file"]:
            with self.subTest(value=value), self.assertRaises(publisher.PublishError):
                publisher.checked_name(value)

    def test_lost_rename_response_reports_uncertain_activation_instead_of_assuming_rollback(self):
        first, second = self.package("ui-first"), self.package("ui-second")
        publisher.publish_package(self.store, first, "none")
        replace = self.store.replace

        def lost_response(source, destination):
            replace(source, destination)
            raise ConnectionError("simulated lost response after the atomic rename")

        self.store.replace = lost_response
        with self.assertRaisesRegex(publisher.PublishError, "ACTIVATION_MAY_HAVE_COMMITTED"):
            publisher.publish_package(self.store, second, "ui-first")
        self.assertEqual(self.active()["release"], "ui-second")
        self.assertFalse((self.root / "store/publish.lock").exists())


if __name__ == "__main__":
    unittest.main()
