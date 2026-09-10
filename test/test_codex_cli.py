"""New-machine native CLI preparation, with downloads/commands isolated from real tools."""
from contextlib import ExitStack
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills/config-new-codey-machine"
sys.path.insert(0, str(SKILL / "scripts"))
from codey_node.common import codex_cli
from codey_node.platforms.windows import codex_runtime as windows_native


def package_bytes(spec, *, unsafe=False):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        values = {
            spec["entry"]: (b"MZ" if spec["platform"] == "windows-x64" else b"\x7fELF"
                            if spec["platform"] == "linux-x64" else b"\xcf\xfa\xed\xfe") + b"fixture-never-executed",
            spec["vendor"] + "/codex-package.json": json.dumps({
                "layoutVersion": 1, "version": spec["version"], "target": spec["triple"],
                "entrypoint": "bin/" + codex_cli.TARGETS[spec["platform"]][2],
            }).encode(),
        }
        if unsafe:
            values["package/../../outside"] = b"must-not-extract"
        for name, data in values.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o700
            archive.addfile(info, io.BytesIO(data))
    return stream.getvalue()


class CodexCliTests(unittest.TestCase):
    def environment(self, root, *, unsafe=False, mismatch=False):
        spec = codex_cli.pin(SKILL, codex_cli.native_platform())
        payload = package_bytes(spec, unsafe=unsafe)
        spec["integrity"] = "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode()
        if mismatch:
            spec["integrity"] = "sha512-" + base64.b64encode(bytes(64)).decode()
        stack = ExitStack()
        stack.enter_context(patch.object(codex_cli.Path, "home", return_value=root))
        stack.enter_context(patch.object(codex_cli, "pin", return_value=spec))
        stack.enter_context(patch.object(codex_cli.shutil, "which", return_value=None))
        runner = stack.enter_context(patch.object(codex_cli, "version", return_value="codex-cli " + spec["version"]))

        def download(*args, **kwargs):
            self.assertEqual(args[0], spec["url"])
            response = io.BytesIO(payload)
            response.geturl = lambda: spec["url"]
            return response

        fetch = stack.enter_context(patch.object(codex_cli.urllib.request, "urlopen", side_effect=download))
        if os.name == "nt":
            from codey_node.platforms.windows import owner, helpers
            stack.enter_context(patch.object(owner, "owner_context",
                                            return_value={"sid": "test-owner", "elevated": False, "sessionId": 1}))
            stack.enter_context(patch.object(helpers, "private_directory",
                                            side_effect=lambda target, _sid: target.mkdir(parents=True)))
        return stack, spec, fetch, runner

    def test_every_platform_pin_matches_the_reviewed_lock_not_latest(self):
        lock = json.loads((ROOT / "cloudcli/package-lock.json").read_text(encoding="utf-8"))["packages"]
        for target, (suffix, _triple, _binary) in codex_cli.TARGETS.items():
            spec = codex_cli.pin(SKILL, target)
            package = lock["node_modules/@openai/codex-" + suffix]
            self.assertEqual(spec["integrity"], package["integrity"])
            self.assertEqual(spec["url"], package["resolved"])
            self.assertNotIn("latest", spec["url"])

    def test_empty_machine_plan_downloads_nothing_and_does_not_need_node(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stack, spec, fetch, runner = self.environment(root)
            with stack:
                result = codex_cli.install(SKILL)
            self.assertEqual(result["action"], "install")
            self.assertFalse(result["applied"])
            fetch.assert_not_called()
            runner.assert_not_called()
            self.assertEqual(list(root.iterdir()), [])

    def test_fresh_install_and_rerun_preserve_login_and_use_verified_native_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / ".codex"
            codex_home.mkdir()
            (codex_home / "config.toml").write_bytes(b"preserve-original-provider")
            (codex_home / "auth.json").write_bytes(b"preserve-owner-login")
            stack, spec, fetch, runner = self.environment(root)
            with stack:
                result = codex_cli.install(SKILL, apply=True)
                self.assertTrue(result["ok"] and result["applied"])
                self.assertTrue(Path(result["executable"]).is_file())
                self.assertEqual(codex_cli.install(SKILL, apply=True)["action"], "reuse")
                fetch.assert_called_once()
                self.assertEqual(runner.call_args_list[0].kwargs, {"expected": spec["version"]})
                file = Path(result["executable"])
                file.write_bytes(file.read_bytes() + b"tampered")
                with self.assertRaises(codex_cli.SetupError):
                    codex_cli.install(SKILL, apply=True)
            self.assertEqual((codex_home / "config.toml").read_bytes(), b"preserve-original-provider")
            self.assertEqual((codex_home / "auth.json").read_bytes(), b"preserve-owner-login")
            self.assertFalse((root / "bin").exists(), "No global/user PATH shim")

    def test_untrusted_download_or_traversal_is_never_executed(self):
        for unsafe, mismatch in ((False, True), (True, False)):
            with self.subTest(unsafe=unsafe), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                stack, spec, fetch, runner = self.environment(root, unsafe=unsafe, mismatch=mismatch)
                with stack, self.assertRaises(codex_cli.SetupError):
                    codex_cli.install(SKILL, apply=True)
                runner.assert_not_called()
                self.assertFalse(list(root.rglob("receipt.json")))
                self.assertFalse((root / "outside").exists())

    def test_existing_explicit_cli_is_reused_without_downloading_or_logging_in(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spec = codex_cli.pin(SKILL, codex_cli.native_platform())
            executable = root / codex_cli.TARGETS[spec["platform"]][2]
            executable.write_bytes((b"MZ" if os.name == "nt" else b"\x7fELF"
                                    if sys.platform == "linux" else b"\xcf\xfa\xed\xfe") + b"existing")
            with patch.object(codex_cli, "version", return_value="codex-cli 0.146.0"), \
                 patch.object(codex_cli.urllib.request, "urlopen") as download:
                result = codex_cli.install(SKILL, apply=True, explicit=executable)
            self.assertEqual(result["action"], "reuse")
            self.assertEqual(result["executable"], str(executable.resolve()))
            download.assert_not_called()
            self.assertEqual(len(list(root.iterdir())), 1)

    def test_version_probe_never_passes_model_credentials_or_runs_login(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "must-not-leak", "GITHUB_TOKEN": "must-not-leak",
                                     "CODEX_THREAD_ID": "must-not-leak"}), \
             patch.object(codex_cli.subprocess, "run",
                          return_value=SimpleNamespace(returncode=0, stdout="codex-cli 0.146.0")) as runner:
            self.assertEqual(codex_cli.version("reviewed-codex", expected="0.146.0"), "codex-cli 0.146.0")
        self.assertEqual(runner.call_args.args[0], ["reviewed-codex", "--version"])
        for name in ("OPENAI_API_KEY", "GITHUB_TOKEN", "CODEX_THREAD_ID"):
            self.assertNotIn(name, runner.call_args.kwargs["env"])

    def test_windows_native_snapshot_preserves_the_official_resource_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            node_id = "n-" + "a" * 24
            node = root / node_id
            node.mkdir()
            source = root / "upstream"
            for name in windows_native.PACKAGE_FILES:
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("public fixture")
            (source / "codex-package.json").write_text(json.dumps({
                "layoutVersion": 1, "target": "x86_64-pc-windows-msvc",
                "entrypoint": "bin/codex.exe", "resourcesDir": "codex-resources", "pathDir": "codex-path",
            }))
            (source / "auth.json").write_text("never-copy-owner-login")
            snapshot = windows_native.pin(source / "bin/codex.exe", node, node_id, apply=True)
            self.assertEqual(set(snapshot["files"]), set(windows_native.PACKAGE_FILES))
            self.assertEqual(windows_native.verify(snapshot, node, node_id), snapshot)
            destination = Path(snapshot["executable"]).parent.parent
            self.assertFalse((destination / "auth.json").exists())
            self.assertTrue((destination / "codex-resources/codex-command-runner.exe").is_file())


if __name__ == "__main__":
    unittest.main()
