"""Real local Git fixtures; never contact Azure/GitHub or modify the user's repo."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from release_source import (
    COMPONENT_FILE, SOURCE_FILE, commits, export_sources, select_main,
    validate_source, verify_export, verify_tooling,
    verify_source_files,
)


def git(root, *args):
    return subprocess.check_output(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", *map(str, args)],
        cwd=root, stderr=subprocess.PIPE, text=True,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
    ).strip()


def initialize(root):
    root.mkdir()
    git(root, "init", "--quiet", "-b", "main")
    git(root, "config", "user.name", "Isolated source test")
    git(root, "config", "user.email", "source@example.invalid")


class MainSources(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="codey-main-source-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "checkout"
        initialize(self.root)
        self.links = {}
        self.origins = {}
        for name in ("cloudcli", "copilot-api"):
            upstream = self.base / name
            initialize(upstream)
            (upstream / "package.json").write_text(json.dumps({"name": name, "version": "1.0.0"}))
            (upstream / "input.txt").write_text("committed component")
            (upstream / "CLAUDE.md").symlink_to("input.txt")
            git(upstream, "add", ".")
            git(upstream, "commit", "--quiet", "-m", "Fixture component")
            self.links[name] = git(upstream, "rev-parse", "HEAD")
            git(self.base, "clone", "--quiet", upstream, self.root / name)
            self.origins[name] = upstream
        (self.root / ".gitignore").write_text("artifacts/\n")
        (self.root / ".gitattributes").write_text("*.ps1 text eol=crlf\n")
        (self.root / "public").mkdir()
        (self.root / "public/app.js").write_text("committed Portal")
        (self.root / "public/fixture.ps1").write_bytes(b"# committed Windows source\nWrite-Output ok\n")
        (self.root / "packages/codey").mkdir(parents=True)
        (self.root / "packages/codey/package.json").write_text('{"name":"codey","version":"0.2.0"}')
        (self.root / "skills/codey-deploy/scripts").mkdir(parents=True)
        (self.root / "skills/codey-deploy/scripts/deploy.py").write_text("# fixture committed tool\n")
        git(self.root, "add", ".gitignore", ".gitattributes", "public", "packages", "skills")
        for name, commit in self.links.items():
            git(self.root, "update-index", "--add", "--cacheinfo", "160000," + commit + "," + name)
        git(self.root, "commit", "--quiet", "-m", "Fixture main")
        self.head = git(self.root, "rev-parse", "HEAD")
        self.remote = self.base / "origin.git"
        git(self.base, "clone", "--quiet", "--bare", self.root, self.remote)
        git(self.root, "remote", "add", "origin", self.remote)

    def test_exports_only_main_and_recorded_gitlinks_without_changing_checkout_or_index(self):
        for name, upstream in self.origins.items():
            (upstream / "input.txt").write_text("newer branch tip, not selected by parent")
            git(upstream, "add", ".")
            git(upstream, "commit", "--quiet", "-m", "Unpinned component")
            git(self.root / name, "pull", "--ff-only", "origin", "main")
        portal = self.root / "public/app.js"
        portal.write_text("staged user work")
        git(self.root, "add", "public/app.js")
        portal.write_text("unstaged user work")
        (self.root / "public/unfinished.js").write_text("untracked user work")
        before_index = (self.root / ".git/index").read_bytes()
        selected = select_main(self.root, "fixture-export", self.head)
        output = self.base / "export"
        export_sources(self.root, selected, output)
        self.assertEqual(selected["commit"], self.head)
        self.assertEqual(selected["submodules"], self.links)
        self.assertEqual(selected["codeyVersion"], "0.2.0")
        self.assertEqual(verify_export(output, selected), selected)
        verify_source_files(self.root, selected, output)
        self.assertEqual((output / "portal/public/app.js").read_text(), "committed Portal")
        self.assertFalse((output / "portal/public/unfinished.js").exists())
        for name in self.links:
            self.assertEqual((output / name / "input.txt").read_text(), "committed component")
            self.assertTrue((output / name / "CLAUDE.md").is_symlink())
            proof = json.loads((output / name / COMPONENT_FILE).read_text())
            self.assertEqual(proof["source"], selected)
            self.assertEqual(proof["files"]["input.txt"], hashlib.sha256(b"committed component").hexdigest())
        self.assertEqual(git(self.root, "rev-parse", "HEAD"), self.head)
        self.assertEqual((self.root / ".git/index").read_bytes(), before_index)
        self.assertEqual(portal.read_text(), "unstaged user work")
        self.assertTrue((self.root / "public/unfinished.js").is_file())
        with self.assertRaisesRegex(RuntimeError, "already has frozen"):
            export_sources(self.root, selected, output)

    def test_production_launcher_rejects_dirty_untracked_and_stale_checkouts(self):
        selected = select_main(self.root, "fixture-clean")
        verify_tooling(self.root, selected)
        file = self.root / "public/app.js"
        before = file.read_bytes()
        file.write_text("uncommitted runtime")
        with self.assertRaisesRegex(RuntimeError, "dirty"):
            verify_tooling(self.root, selected)
        file.write_bytes(before)
        extra = self.root / "unfinished.py"
        extra.write_text("untracked")
        with self.assertRaisesRegex(RuntimeError, "dirty"):
            verify_tooling(self.root, selected)
        extra.unlink()
        verify_tooling(self.root, selected)
        with self.assertRaisesRegex(RuntimeError, "clean checkout"):
            verify_tooling(self.root, {**selected, "commit": "a" * 40})

    def test_expected_main_mismatch_and_missing_gitlinks_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, "main changed"):
            select_main(self.root, "fixture-mismatch", "a" * 40)
        for value in ("main", "../branch", "A" * 40):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "full lowercase"):
                select_main(self.root, "fixture-invalid", value)
        git(self.root, "update-index", "--force-remove", "copilot-api")
        git(self.root, "commit", "--quiet", "-m", "Fixture missing gitlink")
        git(self.root, "push", "origin", "main")
        with self.assertRaisesRegex(RuntimeError, "gitlink"):
            select_main(self.root, "fixture-missing")

    def test_provenance_rejects_local_refs_dirty_flags_missing_modules_and_tampering(self):
        selected = select_main(self.root, "fixture-proof")
        for value in (None, {}, {**selected, "sourceDirty": True}, {**selected, "schema": True},
                      {**selected, "ref": "refs/heads/dev"}, {**selected, "submodules": {}},
                      {**selected, "commit": ["a" * 40]}, {**selected, "privateKey": "never"}):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "main provenance"):
                validate_source(value)
        self.assertEqual(commits(selected), {"portal": self.head, **self.links})
        output = self.base / "proof-export"
        export_sources(self.root, selected, output)
        (output / "portal" / SOURCE_FILE).write_text(json.dumps({**selected, "tree": "b" * 40}))
        with self.assertRaisesRegex(RuntimeError, "provenance changed"):
            verify_export(output, selected)

    def test_edits_inside_the_export_cannot_keep_claiming_the_same_main_sha(self):
        source = select_main(self.root, "fixture-content")
        output = self.base / "content-export"
        export_sources(self.root, source, output)
        file = output / "portal/public/app.js"
        file.write_text("a build-time hotfix")
        with self.assertRaisesRegex(RuntimeError, "differs from main"):
            verify_source_files(self.root, source, output)
        file.write_text("committed Portal")
        extra = output / "portal/src/injected.mjs"
        extra.parent.mkdir()
        extra.write_text("uncommitted new module")
        with self.assertRaisesRegex(RuntimeError, "Untracked file"):
            verify_source_files(self.root, source, output)
        extra.unlink()
        verify_source_files(self.root, source, output)


if __name__ == "__main__":
    unittest.main()
