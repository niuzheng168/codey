"""Offline regression checks; never connect to Azure, SSH, or a model."""
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from common import archive_tree, canonical, read, release_name, require, safe_extract, save, sha
from node import protected_hash


class DeploymentSafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def archive(self, rows):
        target = self.root / "input.tar.gz"
        with tarfile.open(target, "w:gz") as output:
            for name, kind, value in rows:
                item = tarfile.TarInfo(name)
                item.mode = 0o644
                if kind == "file":
                    item.size = len(value)
                    output.addfile(item, io.BytesIO(value))
                else:
                    item.type = tarfile.SYMTYPE if kind == "link" else tarfile.LNKTYPE
                    item.linkname = value
                    output.addfile(item)
        return target

    def test_safe_package_roundtrip(self):
        source = self.root / "source"
        source.mkdir()
        (source / "entry.js").write_text("export const ok = true;")
        archive_tree(source, self.root / "package.tar.gz")
        safe_extract(self.root / "package.tar.gz", self.root / "destination")
        self.assertEqual(sha(source / "entry.js"), sha(self.root / "destination/entry.js"))

    def test_archive_traversal_denied_before_creating_destination(self):
        target = self.archive([("../escape", "file", b"bad")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination")
        self.assertFalse((self.root / "destination").exists())
        self.assertFalse((self.root / "escape").exists())

    def test_absolute_archive_denied(self):
        target = self.archive([("/escape", "file", b"bad")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination")

    def test_package_symlinks_denied(self):
        target = self.archive([("entry", "link", "../escape")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination")

    def test_hardlinks_denied_even_in_source(self):
        target = self.archive([("entry", "hardlink", "elsewhere")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination", allow_source_symlinks=True)

    def test_escaping_source_symlink_denied(self):
        target = self.archive([("entry", "link", "../escape")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination", allow_source_symlinks=True)

    def test_duplicate_archive_path_denied(self):
        target = self.archive([("one", "file", b"a"), ("./one", "file", b"b")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, self.root / "destination")

    def test_existing_destination_never_overwritten(self):
        destination = self.root / "destination"
        destination.mkdir()
        (destination / "user.txt").write_text("keep")
        target = self.archive([("user.txt", "file", b"replace")])
        with self.assertRaises(RuntimeError):
            safe_extract(target, destination)
        self.assertEqual((destination / "user.txt").read_text(), "keep")

    def test_timestamp_add_remove_is_not_config_drift(self):
        file = self.root / ".codex/config.toml"
        file.parent.mkdir()
        file.write_text('model = "gpt-6-astra"\nlast_updated = "2026-09-07T10:00:00Z"\n')
        before = protected_hash(file)
        file.write_text('model = "gpt-6-astra"\n')
        self.assertEqual(before, protected_hash(file))

    def test_actual_model_or_auth_config_change_is_drift(self):
        file = self.root / ".codex/config.toml"
        file.parent.mkdir()
        file.write_text('env_key = "CODEY_MODEL_API_KEY"\n')
        before = protected_hash(file)
        file.write_text('env_key = "UNAUTHORIZED_REPLACEMENT"\n')
        self.assertNotEqual(before, protected_hash(file))

    def test_only_well_formed_release_names(self):
        self.assertEqual(release_name("fast-20260907-120000-abc123"), "fast-20260907-120000-abc123")
        for name in ("../release", "local", "fast-20260907-120000-ABC123", "fast-20260907-120000-abc123/other"):
            with self.assertRaises(RuntimeError):
                release_name(name)

    def test_secret_reference_canonicalization_preserves_other_configuration(self):
        self.assertEqual(canonical({"env": [{"name": "TOKEN", "value": "", "secretRef": "token"}]}),
                         {"env": [{"name": "TOKEN", "secretRef": "token"}]})
        self.assertNotEqual(canonical({"scale": {"minReplicas": 1}}), canonical({"scale": {"minReplicas": 0}}))

    def test_atomic_report_write(self):
        target = self.root / "report.json"
        save(target, {"passed": False})
        save(target, {"passed": True})
        self.assertEqual(read(target), {"passed": True})
        self.assertFalse((self.root / "report.json.next").exists())

    def test_guards_are_not_python_asserts(self):
        with self.assertRaisesRegex(RuntimeError, "guard"):
            require(False, "guard")

    def test_controller_requires_explicit_apply(self):
        from common import command
        import sys
        with self.assertRaises(RuntimeError):
            command([sys.executable, str(Path(__file__).with_name("deploy.py"))], timeout=5)

    def test_azure_secret_reads_are_not_logged(self):
        from builder import Builder
        worker = object.__new__(Builder)
        worker.config = {"subscription": "test"}
        worker.job = self.root
        with patch("builder.command", return_value=('{"value":"must-stay-in-memory"}', 0)) as run:
            worker.az(["containerapp", "secret", "list", "--show-values"])
            self.assertIsNone(run.call_args.kwargs["log"])
        with patch("builder.command", return_value=('"must-stay-in-memory"', 0)) as run:
            worker.az(["storage", "account", "keys", "list"])
            self.assertIsNone(run.call_args.kwargs["log"])

    def test_reviewed_snapshot_preserves_real_index_head_and_dirty_files(self):
        from common import command
        from deploy import Deploy
        repository = self.root / "repository"
        repository.mkdir()
        command(["git", "init", "--quiet"], cwd=repository)
        command(["git", "config", "user.name", "Offline release test"], cwd=repository)
        command(["git", "config", "user.email", "release-test@example.invalid"], cwd=repository)
        (repository / "public").mkdir()
        file = repository / "public/app.js"
        file.write_text("before\n")
        command(["git", "add", "public/app.js"], cwd=repository)
        command(["git", "commit", "--quiet", "-m", "Offline test baseline"], cwd=repository)
        head = command(["git", "rev-parse", "HEAD"], cwd=repository)[0]
        index = sha(repository / ".git/index")
        file.write_text("after\n")
        (repository / "public/portal-features.js").write_text("export const enabled = false;\n")
        worker = object.__new__(Deploy)
        worker.root = repository
        worker.job = self.root / "snapshot-job"
        worker.job.mkdir()
        result = worker.freeze_portal()
        self.assertEqual(result["baseCommit"], head)
        self.assertFalse(result["commitCreated"])
        self.assertFalse(result["pushed"])
        self.assertEqual(index, sha(repository / ".git/index"))
        self.assertEqual(head, command(["git", "rev-parse", "HEAD"], cwd=repository)[0])
        self.assertEqual(file.read_text(), "after\n")
        safe_extract(worker.job / "portal-reviewed.tar.gz", self.root / "snapshot")
        self.assertEqual((self.root / "snapshot/public/app.js").read_text(), "after\n")
        self.assertTrue((self.root / "snapshot/public/portal-features.js").is_file())


if __name__ == "__main__":
    unittest.main()
