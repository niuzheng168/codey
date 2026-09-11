"""Local updater service transactions. All systemctl/launchd/process/model operations are mocked."""
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

engine = fixtures.engine
spec = importlib.util.spec_from_file_location("codey_local_service", ROOT / "packages/codey/lib/update-service.py")
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


@unittest.skipUnless(sys.platform == "linux" and os.getuid() != 0, "Owner-only isolated POSIX service fixtures")
class LinuxLocalTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(os.umask, os.umask(0o022))
        temporary = tempfile.TemporaryDirectory(prefix="codey-local-linux-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "home"
        self.runtime = fixtures.FakeNpmRuntime(self.home, directory_anchor=True)
        self.addCleanup(patch.stopall)
        patch.object(Path, "home", return_value=self.home).start()
        self.runtime.profile_file = self.runtime.private / "profile.json"
        engine.save(self.runtime.private / "config.json", {"nodeId": "alpha", "ownerId": "owner-a", "username": "owner"})
        engine.save(self.runtime.private / "installed.json", {
            "releaseId": "signed-before", "sequence": 42, "digest": "a" * 64,
        })
        self.adapter = object.__new__(local.Linux)
        self.adapter.home = self.home
        self.adapter.root = self.runtime.anchors["cloudcli"].resolve()
        self.adapter.config_file = self.runtime.private / "config.json"
        self.adapter.runtime = self.runtime
        self.adapter.engine = engine
        self.adapter.jobs = self.runtime.root / "local-updates"
        self.job = self.adapter.jobs / ("a" * 32)
        self.job.mkdir(parents=True, mode=0o700)
        self.target = self.job / "candidate"
        fixtures.FakeNpmRuntime.npm_package(self.target, "2.0.0", "b" * 40)
        build = engine.read(self.target / "codey-build.json")
        build.update({"workspaceEntrySha256": engine.sha(self.target / "dist-server/server/index.js"),
                      "gatewayEntrySha256": engine.sha(self.target / "gateway/main.js")})
        engine.save(self.target / "codey-build.json", build)
        self.unit = self.home / ".config/systemd/user/codey-node-updater.service"
        self.unit.parent.mkdir(parents=True)
        self.unit.write_text("ExecStart=/fixture/python updater.py\nTimeoutStopSec=900\n")
        self.controls = []
        self.probes = []
        self.updater_active = True
        patch.object(local, "run", side_effect=self.control).start()
        patch.object(local, "external_linux", return_value=None).start()
        patch.object(engine, "run", side_effect=self.runtime.runner).start()
        patch.object(self.runtime, "probe", side_effect=self.probe).start()
        self.request = {
            "plan": self.adapter.plan(), "job": str(self.job), "candidate": str(self.target),
            "entrySha256": engine.sha(self.target / "codey-build.json"),
            "sha256": "f" * 64, "version": "2.0.0",
        }

    def control(self, arguments, **_):
        args = [str(item) for item in arguments]
        self.controls.append(args)
        if args[:4] == ["systemctl", "--user", "show", "codey-node-updater.service"]:
            return f"ActiveState={'active' if self.updater_active else 'inactive'}\nFragmentPath={self.unit}"
        if args[:3] == ["systemctl", "--user", "stop"]:
            self.assertEqual(args[3:], ["codey-node-updater.service"])
            self.updater_active = False
            return ""
        if args[:3] == ["systemctl", "--user", "start"]:
            self.assertEqual(args[3:], ["codey-node-updater.service"])
            self.updater_active = True
            return ""
        self.fail("Unexpected OS command: " + repr(args))

    def probe(self, mode, *_):
        self.assertEqual(mode, "idle", "Local update must never request a model probe")
        self.probes.append(mode)
        return {"runningSessions": 0}

    def test_application_switch_preserves_runtimes_identity_data_and_signed_sequence(self):
        before = self.runtime.snapshot()
        credentials = self.adapter.config_file.read_bytes()
        result = self.adapter.activate(self.request)
        after = self.runtime.snapshot()
        self.assertTrue(result["ok"])
        self.assertEqual(after["components"]["codey"]["version"], "2.0.0")
        self.assertEqual(after["highestSequence"], 42)
        self.assertEqual(after["cloudcliNode"], before["cloudcliNode"])
        self.assertEqual(after["protected"], before["protected"])
        self.assertEqual(self.adapter.config_file.read_bytes(), credentials)
        self.assertEqual(engine.read(self.runtime.private / "installed.json")["source"], "local-package")
        self.assertEqual(self.runtime.model_calls, 0)
        self.assertEqual(self.runtime.actions, [
            ["systemctl", "--user", "stop", "codey-cloudcli.service", "codey-copilot-api.service"],
            ["systemctl", "--user", "start", "codey-cloudcli.service", "codey-copilot-api.service"],
        ])
        self.assertTrue(self.updater_active)
        self.assertEqual(engine.read(self.job / "local-update.json")["state"], "complete")

    def test_native_validation_failure_rolls_back_package_and_bookkeeping_not_new_user_data(self):
        before = self.runtime.snapshot()
        installed = (self.runtime.private / "installed.json").read_bytes()

        def failure(*_):
            (self.runtime.data / "user-data.txt").write_text("new user data during verification")
            raise local.UpdateError("synthetic verification failed")

        with patch.object(self.adapter, "verify", side_effect=failure):
            with self.assertRaisesRegex(local.UpdateError, "synthetic"):
                self.adapter.activate(self.request)
        self.assertEqual(self.runtime.snapshot()["components"], before["components"])
        self.assertEqual((self.runtime.private / "installed.json").read_bytes(), installed)
        self.assertEqual((self.runtime.data / "portal-build.json").read_bytes(), self.runtime.before_pin)
        self.assertEqual((self.runtime.data / "user-data.txt").read_text(), "new user data during verification")
        self.assertEqual(engine.read(self.job / "local-update.json")["state"], "rolled_back")
        self.assertTrue(self.updater_active)

    def test_busy_node_does_not_stop_apps_and_resumes_the_unmodified_updater(self):
        with patch.object(self.runtime, "idle", return_value=False):
            with self.assertRaisesRegex(local.UpdateError, "active"):
                self.adapter.activate(self.request)
        self.assertEqual(self.runtime.actions, [])
        self.assertTrue(self.updater_active)
        self.assertEqual(engine.read(self.job / "local-update.json")["state"], "aborted")

    def test_pending_portal_job_and_configuration_drift_block_before_any_stop(self):
        engine.save(self.runtime.private / "pending.json", {"id": "signed-active"})
        with self.assertRaisesRegex(local.UpdateError, "Portal update"):
            self.adapter.activate(self.request)
        self.assertEqual(self.controls, [])
        self.assertEqual(self.runtime.actions, [])
        (self.runtime.private / "pending.json").unlink()
        (self.runtime.data / "config.json").write_text('{"auth":{"apiKeys":["new-external-key"]}}')
        with self.assertRaisesRegex(local.UpdateError, "changed while staging"):
            self.adapter.activate(self.request)
        self.assertEqual(self.controls, [])

    def test_a_racing_portal_job_after_pause_is_not_overwritten(self):
        original = self.control

        def race(args, **kwargs):
            answer = original(args, **kwargs)
            if args[:3] == ["systemctl", "--user", "stop"]:
                engine.save(self.runtime.private / "pending.json", {"id": "needs-acknowledgement"})
            return answer

        with patch.object(local, "run", side_effect=race):
            with self.assertRaisesRegex(local.UpdateError, "Portal transaction"):
                self.adapter.activate(self.request)
        self.assertEqual(self.runtime.actions, [])
        self.assertTrue(self.updater_active)
        self.assertTrue((self.runtime.private / "pending.json").exists())

    def test_interrupted_switch_recovers_package_pin_and_original_updater_state(self):
        before = self.runtime.snapshot()

        # Simulate an uncatchable interruption by exercising the saved journal and
        # existing engine directly; recovery, not a second install, restores it.
        anchor = Path(before["codeyAnchor"])
        anchors = [{"component": "codey", "anchor": str(anchor), "target": str(self.target),
                    "kind": "directory", "previousTarget": str(anchor.resolve()),
                    "backup": str(self.job / "backup/codey"), "service": "codey-cloudcli.service",
                    "services": ["codey-cloudcli.service", before["copilotService"]]}]
        release = {"id": "local-" + "f" * 24, "components": {"codey": {"sha256": "f" * 64}}}
        self.runtime.prepare_metadata(release, before, ["codey"], self.job)
        self.runtime.switch(anchors, self.job)
        self.runtime.update_pin(release, before, ["codey"])
        journal = {"state": "applying", "request": self.request, "updaterWasActive": True}
        result = self.adapter.recover(journal, self.job)
        self.assertEqual(result["recovered"], "rolled_back")
        self.assertEqual(self.runtime.snapshot()["components"], before["components"])
        self.assertEqual((self.runtime.data / "portal-build.json").read_bytes(), self.runtime.before_pin)
        self.assertTrue(self.updater_active)

    def test_completed_activation_recovery_does_not_undo_success_or_need_daemon_lock(self):
        self.adapter.activate(self.request)
        journal = engine.read(self.job / "local-update.json")
        before_actions = list(self.runtime.actions)
        result = self.adapter.recover(journal, self.job)
        self.assertEqual(result["recovered"], "complete")
        self.assertEqual(self.runtime.actions, before_actions)
        self.assertEqual(self.runtime.snapshot()["highestSequence"], 42)

    def test_failed_rollback_keeps_pull_updates_paused_until_explicit_recovery(self):
        with patch.object(self.adapter, "verify", side_effect=local.UpdateError("synthetic health failure")), \
                patch.object(self.runtime, "rollback", side_effect=local.UpdateError("synthetic rollback failure")):
            with self.assertRaisesRegex(local.UpdateError, "rollback failure"):
                self.adapter.activate(self.request)
        self.assertFalse(self.updater_active, "A Portal job must not race an unfinished local rollback")
        journal = engine.read(self.job / "local-update.json")
        self.assertEqual(journal["state"], "applying")
        result = self.adapter.recover(journal, self.job)
        self.assertEqual(result["recovered"], "rolled_back")
        self.assertTrue(self.updater_active)
        self.assertEqual(self.runtime.snapshot()["components"]["codey"]["version"], "1.0.0")


if __name__ == "__main__":
    unittest.main()
