"""Latest Linux Codex installation tests without touching real user tools."""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills/config-new-codey-machine/scripts"))

from codey_node.platforms.linux import codex_latest


class FakeOwner:
    def __init__(self, home):
        self.home = home

    def mkdir(self, path):
        Path(path).mkdir(parents=True, exist_ok=True)


class LinuxCodexLatestTests(unittest.TestCase):
    def test_plan_reuses_the_existing_owner_bin_location(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            executable = home / ".npm-global/bin/codex"
            executable.parent.mkdir(parents=True)
            executable.write_text("fixture")
            owner = SimpleNamespace(home=home, check=lambda path: Path(path))
            with patch.object(codex_latest.Owner, "target", return_value=owner), \
                    patch.object(codex_latest, "_version", return_value="0.147.0"), \
                    patch.object(codex_latest.codex_process, "inspect", return_value=[]):
                plan = codex_latest.prepare(home, home / ".codex", executable)
            self.assertEqual(plan.bin_directory, executable.parent)
            self.assertEqual(plan.executable, executable)
            self.assertEqual(plan.report()["release"], "latest")

    def test_managed_fixed_cli_is_replaced_by_the_normal_owner_bin(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            executable = home / ".local/share/codey-tools/codex/0.146.0-linux-x64/package/vendor/test/bin/codex"
            executable.parent.mkdir(parents=True)
            executable.write_text("fixture")
            owner = SimpleNamespace(home=home, check=lambda path: Path(path))
            with patch.object(codex_latest.Owner, "target", return_value=owner), \
                    patch.object(codex_latest, "_version", return_value="0.146.0"), \
                    patch.object(codex_latest.codex_process, "inspect", return_value=[]):
                plan = codex_latest.prepare(home, home / ".codex", executable)
            self.assertEqual(plan.bin_directory, home / ".local/bin")

    def test_apply_stops_processes_and_runs_the_official_installer_noninteractively(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            plan = codex_latest.Plan(
                FakeOwner(home), home / ".codex", home / ".local/bin",
                home / ".local/bin/codex", None, None, [{"pid": 42}],
            )
            calls = []

            def command(args, **kwargs):
                calls.append((args, kwargs))
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            installer = (
                b"#!/bin/sh\n"
                b'RELEASES_BASE_URL=\"https://releases.openai.com/codex\"\n'
                b": \"${CODEX_INSTALL_DIR:?}\"\n"
            )
            with patch.object(codex_latest, "_download_installer", return_value=installer), \
                    patch.object(codex_latest.codex_process, "inspect", return_value=[{"pid": 42}]), \
                    patch.object(codex_latest.codex_process, "stop", return_value=[42]) as stop, \
                    patch.object(codex_latest.subprocess, "run", side_effect=command), \
                    patch.object(codex_latest, "_version", return_value="0.200.0"):
                with patch.dict(os.environ, {"CODEX_RELEASE": "must-not-leak"}, clear=False):
                    result = plan.apply()
            stop.assert_called_once()
            self.assertEqual(result["version"], "0.200.0")
            self.assertEqual(result["stoppedProcesses"], [42])
            self.assertEqual(calls[0][0][0], "/bin/sh")
            self.assertEqual(calls[0][1]["env"]["CODEX_NON_INTERACTIVE"], "true")
            self.assertNotIn("CODEX_RELEASE", calls[0][1]["env"])


if __name__ == "__main__":
    unittest.main()
