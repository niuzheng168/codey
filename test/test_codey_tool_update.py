"""Native Linux tool transactions. All OS services, processes and network/model probes are mocked."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).parent))
import test_node_updater as fixtures

spec = importlib.util.spec_from_file_location("codey_tool_service", ROOT / "packages/codey/lib/tool-update-service.py")
tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)
engine = fixtures.engine


def elf(file, content):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    header = bytearray(64)
    header[:6] = b"\x7fELF\x02\x01"
    header[18:20] = b"\x3e\x00"
    file.write_bytes(bytes(header) + content.encode())
    file.chmod(0o700)


@unittest.skipUnless(sys.platform == "linux" and os.getuid() != 0, "Owner-only isolated Linux service fixtures")
class LinuxToolTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(os.umask, os.umask(0o022))
        temporary = tempfile.TemporaryDirectory(prefix="codey-tool-linux-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "home"
        self.runtime = fixtures.FakeNpmRuntime(self.home, directory_anchor=True)
        self.runtime.profile_file = self.runtime.private / "profile.json"
        engine.save(self.runtime.private / "config.json", {"nodeId": "alpha", "ownerId": "owner-a", "username": "owner"})
        engine.save(self.runtime.private / "installed.json", {"releaseId": "signed-before", "sequence": 7, "digest": "a" * 64})
        self.adapter = object.__new__(tools.LinuxTool)
        self.adapter.home = self.home
        self.adapter.root = self.runtime.anchors["cloudcli"].resolve()
        self.adapter.config_file = self.runtime.private / "config.json"
        self.adapter.runtime = self.runtime
        self.adapter.engine = engine
        self.adapter.jobs = self.runtime.root / "local-updates"
        self.job = self.adapter.jobs / ("c" * 32)
        self.job.mkdir(parents=True, mode=0o700)
        self.codex = self.home / ".local/bin/codex"
        self.tunnel = self.home / ".local/share/codey-tools/devtunnel/devtunnel"
        elf(self.codex, "old-codex")
        elf(self.tunnel, "old-devtunnel")
        self.old_hashes = {tools.sha(file) for file in (self.codex, self.tunnel)}
        self.environment = {"CODEY_CODEX_EXECUTABLE": str(self.codex), "PATH": "/unrelated"}
        self.units = self.home / ".config/systemd/user"
        self.units.mkdir(parents=True)
        self.renew_file = self.home / ".local/share/codey-machine/renew-devtunnel.sh"
        self.renew_file.parent.mkdir()
        self.renew_file.write_text(f'"{self.tunnel}" token "fixture.jpe" --scope connect --json\n')
        self.renew_file.chmod(0o700)
        definitions = {
            "codey-node-updater.service": "ExecStart=/fixture/python updater.py\nTimeoutStopSec=900\n",
            tools.HOST: f"ExecStart={self.tunnel} host fixture.jpe --host-header unchanged --origin-header unchanged\n",
            tools.RENEW: f"ExecStart={self.renew_file}\n",
            tools.TIMER: f"Unit={tools.RENEW}\n",
        }
        for name, body in definitions.items():
            (self.units / name).write_text(body)
            (self.units / name).chmod(0o600)
        self.active = {"codey-node-updater.service": True, "codey-cloudcli.service": True,
                       tools.HOST: True, tools.RENEW: False, tools.TIMER: True}
        self.controls, self.probes = [], []
        self.patcher(Path, "home", return_value=self.home)
        self.patcher(tools, "run", side_effect=self.control)
        self.patcher(tools.local, "run", side_effect=self.control)
        self.patcher(tools.local, "external_linux", return_value=None)
        self.patcher(tools, "assert_host_process", return_value=None)
        self.patcher(tools, "tool_processes", return_value=[])
        self.patcher(engine, "environment", side_effect=lambda _pid: self.environment)
        self.patcher(self.runtime, "probe", side_effect=self.probe)

    def patcher(self, obj, name, **kwargs):
        patcher = patch.object(obj, name, **kwargs)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def control(self, arguments, **_):
        args = [str(item) for item in arguments]
        if args[:3] == ["systemctl", "--user", "show"]:
            name = args[3]
            return (f"ActiveState={'active' if self.active[name] else 'inactive'}\n"
                    f"FragmentPath={self.units / name}\nMainPID=999\nDropInPaths=")
        if args[:3] in (["systemctl", "--user", "stop"], ["systemctl", "--user", "start"]):
            self.controls.append(args[2:])
            for name in args[3:]:
                self.assertIn(name, self.active, "Unrelated service must not be touched")
                self.active[name] = args[2] == "start"
            return ""
        if args[-1] == "--version":
            component = Path(args[0]).name
            value = "0.153.0" if tools.sha(args[0]) in self.old_hashes else "0.154.0"
            return ("codex-cli" if component == "codex" else "devtunnel") + " " + value
        if args[0] == "/fixture/node" and args[2] in ("probe", "tunnel"):
            self.probes.append(args[2])
            return '{"ok":true}'
        self.fail("Unexpected OS/network command: " + repr(args))

    def probe(self, mode, *_):
        self.assertEqual(mode, "idle", "Tool updates must not contact a model")
        self.probes.append(mode)
        return {"runningSessions": 0}

    def request(self, component="codex", allow=True):
        candidate = self.job / "payload" / component
        elf(candidate, "new-" + component)
        companion = candidate.parent / "runtime.dat"
        companion.write_text("native companion")
        companion.chmod(0o600)
        files = {file.name: {"size": file.stat().st_size, "sha256": tools.sha(file),
                              "executable": file == candidate} for file in (candidate, companion)}
        manifest = {"schema": 1, "kind": "codey-tool-update", "component": component, "platform": "linux-x64",
                    "version": "0.154.0", "minimumCodeyVersion": "0.1.3", "entry": component, "files": files}
        engine.save(self.job / "tool-update.json", manifest)
        request = {"schema": 1, "component": component, "job": str(self.job), "candidate": str(candidate),
                   "version": manifest["version"], "sha256": tools.sha(self.job / "tool-update.json"),
                   "manifest": manifest, "entrySha256": tools.sha(candidate),
                   "allowDisconnect": allow, "plan": self.adapter.plan_tool(component)}
        engine.save(self.job / "request.json", request)
        return request

    def test_codex_switches_only_native_cli_alias_and_workspace_not_codey_or_gateway_or_tunnel(self):
        request = self.request()
        before = self.runtime.snapshot()
        result = self.adapter.activate(request)
        self.assertTrue(result["ok"])
        self.assertTrue(self.codex.is_symlink())
        self.assertEqual(str(self.codex.resolve()), request["candidate"])
        self.assertEqual(tools.sha(self.job / "previous-entry"), request["plan"]["entrySha256"])
        self.assertEqual(self.runtime.snapshot(), before)
        self.assertEqual(self.runtime.model_calls, 0)
        self.assertEqual(self.controls, [
            ["stop", "codey-node-updater.service"], ["stop", "codey-cloudcli.service"],
            ["start", "codey-cloudcli.service"], ["start", "codey-node-updater.service"],
        ])
        self.assertIn("probe", self.probes)
        self.assertEqual(engine.read(self.job / "local-update.json")["state"], "complete")

    def test_failed_codex_verification_restores_relative_symlink_and_never_stale_user_data(self):
        target = self.home / ".codex/packages/standalone/releases/old/bin/codex"
        elf(target, "old-codex")
        self.codex.unlink()
        relative = os.path.relpath(target, self.codex.parent)
        self.codex.symlink_to(relative)
        request = self.request()
        original = self.adapter.verify

        def verify(before, req, job, rollback=False):
            if not rollback:
                (self.runtime.data / "user-data.txt").write_text("new work, not a stale backup")
                raise tools.local.UpdateError("synthetic incompatible app-server")
            return original(before, req, job, rollback=True)

        with patch.object(self.adapter, "verify", side_effect=verify):
            with self.assertRaisesRegex(tools.local.UpdateError, "incompatible"):
                self.adapter.activate(request)
        self.assertEqual(os.readlink(self.codex), relative)
        self.assertEqual((self.runtime.data / "user-data.txt").read_text(), "new work, not a stale backup")
        self.assertEqual(engine.read(self.job / "local-update.json")["state"], "rolled_back")
        self.assertTrue(self.active["codey-node-updater.service"])

    def test_busy_or_pending_nodes_do_not_stop_apps_or_native_tools(self):
        request = self.request()
        with patch.object(self.runtime, "idle", return_value=False):
            with self.assertRaisesRegex(tools.local.UpdateError, "active"):
                self.adapter.activate(request)
        self.assertEqual(self.controls, [["stop", "codey-node-updater.service"], ["start", "codey-node-updater.service"]])
        self.controls.clear()
        engine.save(self.runtime.private / "pending.json", {"id": "portal-active"})
        with self.assertRaisesRegex(tools.local.UpdateError, "Portal update"):
            self.adapter.activate(request)
        self.assertEqual(self.controls, [])
        self.assertFalse(self.codex.is_symlink())

    def test_external_codex_processes_are_refused_not_killed_even_if_no_model_task_is_reported(self):
        request = self.request()
        with patch.object(tools, "tool_processes", return_value=[(123, self.codex, ["codex", "--help"])]):
            with self.assertRaisesRegex(tools.local.UpdateError, "external native"):
                self.adapter.activate(request)
        self.assertEqual(self.controls, [])

    def test_immutable_desktop_or_system_codex_paths_are_not_adopted(self):
        self.environment["CODEY_CODEX_EXECUTABLE"] = str(self.home / ".codex/packages/standalone/releases/old/bin/codex")
        with self.assertRaisesRegex(tools.local.UpdateError, "stable owner-managed"):
            self.adapter.plan_tool("codex")
        self.assertEqual(self.controls, [])

    def test_payload_and_configuration_drift_block_before_service_changes(self):
        request = self.request()
        (self.job / "payload/runtime.dat").write_text("tampered companion")
        with self.assertRaisesRegex(tools.local.UpdateError, "checksum"):
            self.adapter.activate(request)
        self.assertEqual(self.controls, [])

    def test_a_failed_rollback_keeps_pull_updater_paused_then_explicit_recovery_finishes(self):
        request = self.request()
        with patch.object(self.adapter, "verify", side_effect=tools.local.UpdateError("synthetic verification failed")), \
                patch.object(self.adapter, "restore_anchor", side_effect=tools.local.UpdateError("synthetic rollback failed")):
            with self.assertRaisesRegex(tools.local.UpdateError, "rollback failed"):
                self.adapter.activate(request)
        self.assertFalse(self.active["codey-node-updater.service"])
        journal = engine.read(self.job / "local-update.json")
        self.assertEqual(journal["state"], "applying")
        result = self.adapter.recover(journal, self.job)
        self.assertEqual(result["recovered"], "rolled_back")
        self.assertFalse(self.codex.is_symlink())
        self.assertTrue(self.active["codey-node-updater.service"])

    def test_recovery_handles_the_gap_after_original_entry_rename_before_new_link_creation(self):
        request = self.request()
        journal = {"kind": "linux-tool", "state": "applying", "request": request,
                   "before": self.runtime.snapshot(), "updaterWasActive": True}
        engine.save(self.job / "local-update.json", journal)
        self.codex.rename(self.job / "previous-entry")
        self.active["codey-node-updater.service"] = False
        self.active["codey-cloudcli.service"] = False
        self.assertEqual(self.adapter.recover(journal, self.job)["recovered"], "rolled_back")
        self.assertEqual(tools.sha(self.codex), request["plan"]["entrySha256"])
        self.assertTrue(self.active["codey-cloudcli.service"])

    def test_recovery_refuses_an_unrelated_alias_change_before_stopping_services(self):
        request = self.request()
        self.adapter.switch_anchor(request)
        foreign = self.home / ".local/bin/foreign"
        elf(foreign, "another user's reviewed deployment")
        self.codex.unlink()
        self.codex.symlink_to(foreign)
        journal = {"kind": "linux-tool", "state": "applying", "request": request,
                   "before": self.runtime.snapshot(), "updaterWasActive": True}
        with self.assertRaisesRegex(tools.local.UpdateError, "Another installation"):
            self.adapter.recover(journal, self.job)
        self.assertEqual(self.controls, [])
        self.assertEqual(self.codex.resolve(), foreign)

    def test_completed_activation_and_updater_resume_recovery_do_not_undo_new_tool(self):
        request = self.request()
        self.adapter.activate(request)
        journal = engine.read(self.job / "local-update.json")
        journal["state"] = "resume_updater"
        self.controls.clear()
        result = self.adapter.recover(journal, self.job)
        self.assertEqual(result["recovered"], "complete")
        self.assertEqual(self.controls, [["start", "codey-node-updater.service"]])
        self.assertEqual(str(self.codex.resolve()), request["candidate"])

    def test_devtunnel_switches_host_and_same_renewal_alias_without_changing_identity_or_timer_configuration(self):
        request = self.request("devtunnel")
        definitions = {file: file.read_bytes() for file in self.units.iterdir()}
        renewal = self.renew_file.read_bytes()
        before = self.runtime.snapshot()
        self.adapter.activate(request)
        self.assertEqual(self.runtime.snapshot(), before)
        self.assertEqual(self.renew_file.read_bytes(), renewal)
        for file, body in definitions.items():
            self.assertEqual(file.read_bytes(), body)
        self.assertEqual(self.controls, [
            ["stop", "codey-node-updater.service"], ["stop", tools.TIMER], ["stop", tools.HOST],
            ["start", tools.HOST], ["start", tools.TIMER], ["start", "codey-node-updater.service"],
        ])
        self.assertIn("tunnel", self.probes)
        self.assertFalse(self.codex.is_symlink())

    def test_devtunnel_without_disconnect_consent_or_with_active_token_renewal_is_refused(self):
        request = self.request("devtunnel", allow=False)
        with self.assertRaisesRegex(tools.local.UpdateError, "disconnect consent"):
            self.adapter.activate(request)
        self.active[tools.RENEW] = True
        with self.assertRaisesRegex(tools.local.UpdateError, "renewal idle"):
            self.adapter.plan_tool("devtunnel")
        self.assertEqual(self.controls, [])

    def test_inactive_renewal_timer_stays_inactive_after_devtunnel_update(self):
        self.active[tools.TIMER] = False
        self.adapter.activate(self.request("devtunnel"))
        self.assertFalse(self.active[tools.TIMER])
        self.assertFalse(any(tools.TIMER in args for args in self.controls))


if __name__ == "__main__":
    unittest.main()
