"""Offline tests; no scheduled tasks, authentication, or Azure changes."""
import base64
import copy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("automation", Path(__file__).with_name("codey-windows-automation.py"))
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)

CONFIG = {
    "subscription": "00000000-0000-0000-0000-000000000001",
    "resourceGroup": "test-group", "appName": "codey",
    "tokenEnvironment": "CODEY_WINDOWS_WORKSPACE_TUNNEL_TOKEN",
    "tunnelId": "windows-workspace", "clusterId": "jpe1",
    "renewBeforeSeconds": 28800, "ownerSid": "S-1-5-21-test",
}
RUNTIME = {"devtunnelExe": r"C:\tools\devtunnel.exe", "tunnelId": "windows-workspace.jpe1",
           "nodeExe": r"C:\tools\node.exe", "entryPath": r"C:\workspace\index.js"}
APP = {
    "location": "japaneast", "tags": {"preserve": "yes"},
    "identity": {"type": "UserAssigned", "userAssignedIdentities": {"/unchanged-mi": {"clientId": "metadata"}}},
    "properties": {
        "provisioningState": "Succeeded", "latestRevisionName": "codey--before",
        "latestReadyRevisionName": "codey--before", "managedEnvironmentId": "/unchanged-env",
        "environmentId": "/unchanged-env", "workloadProfileName": "Consumption",
        "configuration": {
            "activeRevisionsMode": "Single",
            "ingress": {"fqdn": "existing.example", "external": True, "targetPort": 3000},
            "secrets": [{"name": "winws-connect-existing"}, {"name": "master-do-not-export"},
                        {"name": "kv-ref", "keyVaultUrl": "https://existing.example/secret", "identity": "/unchanged-mi"}],
        },
        "template": {
            "revisionSuffix": "before",
            "containers": [
                {"name": "portal", "image": "portal@sha256:unchanged",
                 "env": [{"name": CONFIG["tokenEnvironment"], "secretRef": "winws-connect-existing"},
                         {"name": "UNRELATED", "value": "preserve"}]},
                {"name": "mcp", "image": "mcp@sha256:unchanged"},
            ], "scale": {"minReplicas": 1, "maxReplicas": 1},
        },
    },
}


def plan():
    return {"suffix": "winws-r-test", "revision": "codey--winws-r-test",
            "secretName": "winws-connect-existing", "expiresAt": "2026-09-09T03:00:00+00:00",
            "createdEpoch": time.time(),
            "beforeTemplate": copy.deepcopy(APP["properties"]["template"]),
            "beforeConfiguration": copy.deepcopy(APP["properties"]["configuration"]),
            "beforeIdentity": copy.deepcopy(APP["identity"]),
            "beforeResourceSettings": worker.resource_settings(APP)}


class TemplateTests(unittest.TestCase):
    def setUp(self):
        self.original = copy.deepcopy(APP)
        self.template = worker.renewal_template(APP, CONFIG, plan(), "/subscriptions/test/app")
        self.nested = self.template["resources"][0]["properties"]
        self.inner = self.nested["template"]
        self.resource = self.inner["resources"][0]

    def test_secure_server_side_secret_preservation(self):
        self.assertEqual(self.inner["parameters"]["existingSecrets"]["type"], "secureObject")
        self.assertEqual(self.inner["parameters"]["connectToken"]["type"], "secureString")
        self.assertEqual(self.template["parameters"]["connectToken"]["type"], "secureString")
        self.assertIn("listSecrets(", self.nested["parameters"]["existingSecrets"]["value"])
        self.assertNotIn("outputs", self.inner)
        self.assertNotIn("outputs", self.template)

    def test_replace_exact_secret_without_accumulation(self):
        configuration = self.resource["properties"]["configuration"]
        self.assertNotIn("secrets", configuration)
        loop = configuration["copy"][0]
        self.assertEqual(loop["name"], "secrets")
        self.assertIn("equals(", loop["input"])
        self.assertIn("copyIndex('secrets')", loop["input"])
        self.assertEqual(loop["count"], "[length(parameters('existingSecrets').value)]")
        self.assertNotIn("concat(", loop["input"])
        self.assertEqual(self.nested["parameters"]["secretName"]["value"], "winws-connect-existing")

    def test_preserves_images_environment_network_and_identity(self):
        original = copy.deepcopy(APP["properties"]["template"])
        original["revisionSuffix"] = "winws-r-test"
        self.assertEqual(self.resource["properties"]["template"], original)
        ingress = self.resource["properties"]["configuration"]["ingress"]
        self.assertEqual(ingress, {"external": True, "targetPort": 3000})
        self.assertEqual(self.resource["identity"]["userAssignedIdentities"], {"/unchanged-mi": {}})
        self.assertEqual(self.resource["tags"], APP["tags"])
        self.assertEqual(self.resource["properties"]["managedEnvironmentId"], "/unchanged-env")
        self.assertEqual(APP, self.original)

    def test_forbids_local_listsecrets_and_other_subscription(self):
        arm = object.__new__(worker.Arm)
        arm.config = CONFIG
        arm.session = Mock()
        for path, code in [
            (f"/subscriptions/{CONFIG['subscription']}/app/listSecrets", "local_secret_export_forbidden"),
            ("/subscriptions/another/app", "unexpected_arm_scope"),
        ]:
            with self.assertRaisesRegex(worker.SafeError, code):
                arm.request("POST", path)
        arm.session.request.assert_not_called()

    def test_concurrent_changes_fail_closed(self):
        variants = []
        for key, value in [("location", "another-region"), ("tags", {"changed": "true"}),
                           ("identity", {"type": "SystemAssigned"})]:
            current = copy.deepcopy(APP)
            current[key] = value
            variants.append(current)
        for key, value in [("workloadProfileName", "different"), ("environmentId", "/different"),
                           ("configuration", {}), ("template", {})]:
            current = copy.deepcopy(APP)
            current["properties"][key] = value
            variants.append(current)
        for current in variants:
            with self.subTest(current=current), self.assertRaisesRegex(worker.SafeError, "concurrent_azure_change"):
                worker.unchanged(APP, current)

    def test_busy_revision_is_not_overwritten(self):
        current = copy.deepcopy(APP)
        current["properties"]["latestReadyRevisionName"] = "not-ready"
        with self.assertRaisesRegex(worker.SafeError, "azure_deployment_busy"):
            worker.unchanged(APP, current)

    def test_secret_order_only_is_not_a_configuration_change(self):
        current = copy.deepcopy(APP)
        current["properties"]["configuration"]["secrets"].reverse()
        worker.unchanged(APP, current)
        current["properties"]["configuration"]["secrets"][0]["keyVaultUrl"] = "https://different.example/secret"
        with self.assertRaisesRegex(worker.SafeError, "concurrent_azure_change"):
            worker.unchanged(APP, current)

    def test_duplicate_secret_names_are_not_silently_collapsed(self):
        configuration = {"secrets": [{"name": "same"}, {"name": "same"}]}
        with self.assertRaisesRegex(worker.SafeError, "duplicate_azure_secret_names"):
            worker.comparable_configuration(configuration)


class TokenTests(unittest.TestCase):
    def invoke(self, **changes):
        claims = {"scp": "connect", "tunnelId": CONFIG["tunnelId"], "clusterId": CONFIG["clusterId"],
                  "exp": 100000 + 86400, **changes}
        encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        result = subprocess.CompletedProcess([], 0, json.dumps({"token": f"header.{encoded}.signature"}), "")
        with patch.object(worker.subprocess, "run", return_value=result) as run, patch.object(worker.time, "time", return_value=100000):
            token, expiration = worker.connect_token(CONFIG, RUNTIME)
            self.assertEqual(run.call_args.args[0], [RUNTIME["devtunnelExe"], "token", RUNTIME["tunnelId"],
                                                   "--scope", "connect", "--json"])
            self.assertNotIn(token, repr(run.call_args))
            return token, expiration

    def test_connect_only_correct_tunnel(self):
        _, expiration = self.invoke()
        self.assertEqual(datetime.fromisoformat(expiration).timestamp(), 186400)

    def test_wrong_scope_tunnel_cluster_or_expiry_rejected(self):
        for changes in [{"scp": "host"}, {"scp": "manage"}, {"tunnelId": "different"},
                        {"clusterId": "different"}, {"exp": 100001}, {"exp": 200000}]:
            with self.subTest(changes=changes), self.assertRaisesRegex(worker.SafeError, "unexpected_tunnel_credential"):
                self.invoke(**changes)

    def test_no_raw_cli_error_in_failure(self):
        result = subprocess.CompletedProcess([], 1, "sensitive-output", "sensitive-stderr")
        with patch.object(worker.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(worker.SafeError, "^devtunnel_interactive_login_required$"):
                worker.connect_token(CONFIG, RUNTIME)

    def test_due_window(self):
        config = {"renewBeforeSeconds": 28800}
        self.assertTrue(worker.renewal_due({}, config, 100000))
        expiration = datetime.fromtimestamp(128800, timezone.utc).isoformat()
        self.assertTrue(worker.renewal_due({"expiresAt": expiration}, config, 100000))
        self.assertFalse(worker.renewal_due({"expiresAt": expiration}, config, 99999))


class RenewalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = {**CONFIG, "stateRoot": self.directory.name,
                       "deploymentLock": str(Path(self.directory.name) / "deployment.lock")}
        self.arm = Mock()
        self.arm.app_id = "/subscriptions/test/app"
        self.arm.app.return_value = copy.deepcopy(APP)
        self.arm.deployment_id.side_effect = lambda suffix: "/deployment/" + suffix
        self.arm.request.return_value = {}

    def test_validation_cannot_deploy_or_persist_token(self):
        with patch.object(worker, "Arm", return_value=self.arm), \
             patch.object(worker, "connect_token", return_value=("test-secret-do-not-log", "tomorrow")):
            result = worker.renew(self.config, RUNTIME, validate_only=True)
        self.assertEqual(result["state"], "validated_only")
        self.assertEqual([call.args[0] for call in self.arm.request.call_args_list], ["POST"])
        self.assertTrue(self.arm.request.call_args.args[1].endswith("/validate"))
        self.assertFalse(Path(self.config["deploymentLock"]).exists())
        for file in Path(self.directory.name).iterdir():
            self.assertNotIn("test-secret-do-not-log", file.read_text())

    def test_not_due_does_not_mint_or_change_azure(self):
        expires = datetime.fromtimestamp(time.time() + 86400, timezone.utc).isoformat()
        worker.save(Path(self.directory.name) / "renewal-state.json", {"expiresAt": expires})
        with patch.object(worker, "Arm") as arm, patch.object(worker, "connect_token") as token:
            result = worker.renew(self.config, RUNTIME)
        self.assertEqual(result["state"], "not_due")
        arm.assert_not_called()
        token.assert_not_called()

    def test_other_controller_lock_never_stolen(self):
        lock = Path(self.config["deploymentLock"])
        owner = {"release": "another-controller", "pid": 0}
        worker.save(lock, owner)
        with patch.object(worker, "Arm") as arm:
            with self.assertRaisesRegex(worker.SafeError, "other_deployment_or_stale_lock"):
                worker.renew(self.config, RUNTIME)
        self.assertEqual(worker.read(lock), owner)
        arm.assert_not_called()

    def test_concurrent_change_between_validate_and_apply_aborts(self):
        changed = copy.deepcopy(APP)
        changed["tags"] = {"changed": "concurrently"}
        self.arm.app.side_effect = [copy.deepcopy(APP), changed]
        with patch.object(worker, "Arm", return_value=self.arm), \
             patch.object(worker, "connect_token", return_value=("secret", "tomorrow")):
            with self.assertRaisesRegex(worker.SafeError, "concurrent_azure_change"):
                worker.renew(self.config, RUNTIME)
        self.assertNotIn("PUT", [call.args[0] for call in self.arm.request.call_args_list])
        self.assertFalse((Path(self.directory.name) / "renewal-state.json").exists())

    def test_indeterminate_submission_never_blindly_retried(self):
        state = {"pending": plan()}
        self.arm.request.return_value = None
        with self.assertRaisesRegex(worker.SafeError, "deployment_submission_indeterminate"):
            worker.reconcile(self.arm, self.config, state)
        self.assertIn("pending", state)
        self.assertEqual([call.args[0] for call in self.arm.request.call_args_list], ["GET"])

    def test_success_reconciles_all_preserved_settings(self):
        state = {"pending": plan()}
        before = copy.deepcopy(state["pending"]["beforeTemplate"])
        app = copy.deepcopy(APP)
        app["properties"]["template"]["revisionSuffix"] = "winws-r-test"
        app["properties"]["latestRevisionName"] = "codey--winws-r-test"
        app["properties"]["latestReadyRevisionName"] = "codey--winws-r-test"
        self.arm.app.return_value = app
        self.arm.request.return_value = {"properties": {"provisioningState": "Succeeded"}}
        pending = state["pending"]
        self.assertTrue(worker.reconcile(self.arm, self.config, state))
        self.assertEqual(state["secretName"], "winws-connect-existing")
        self.assertNotIn("pending", state)
        self.assertEqual(pending["beforeTemplate"], before)

    def test_superseded_revision_needs_attention(self):
        state = {"pending": plan()}
        self.arm.request.return_value = {"properties": {"provisioningState": "Succeeded"}}
        app = copy.deepcopy(APP)
        app["properties"]["latestRevisionName"] = "codey--another-deployment"
        app["properties"]["latestReadyRevisionName"] = "codey--another-deployment"
        self.arm.app.return_value = app
        with self.assertRaisesRegex(worker.SafeError, "deployment_superseded"):
            worker.reconcile(self.arm, self.config, state)
        self.assertIn("pending", state)
        self.assertNotIn("lastSucceededAt", state)

    def test_arm_success_waits_for_cold_revision_without_new_deployment(self):
        state = {"pending": plan()}
        self.arm.request.return_value = {"properties": {"provisioningState": "Succeeded"}}
        app = copy.deepcopy(APP)
        app["properties"]["latestRevisionName"] = state["pending"]["revision"]
        self.arm.app.return_value = app
        self.assertFalse(worker.reconcile(self.arm, self.config, state))
        self.assertIn("pending", state)
        self.assertNotIn("lastSucceededAt", state)
        self.assertEqual([call.args[0] for call in self.arm.request.call_args_list], ["GET"])

    def test_eventually_consistent_app_snapshot_is_not_treated_as_superseded(self):
        state = {"pending": plan()}
        self.arm.request.return_value = {"properties": {"provisioningState": "Succeeded"}}
        self.assertFalse(worker.reconcile(self.arm, self.config, state))
        self.assertIn("pending", state)


@unittest.skipUnless(os.name == "nt", "Windows metadata parser")
class ProcessTests(unittest.TestCase):
    def inventory(self, rows, component="workspace"):
        result = subprocess.CompletedProcess([], 0, json.dumps(rows), "")
        config = {**CONFIG, "powershellExe": "powershell.exe",
                  "acceptedPreviousEntries": [r"C:\workspace\old-index.js"]}
        with patch.object(worker.subprocess, "run", return_value=result):
            return worker.matching_processes(config, RUNTIME, component)

    def test_exact_entry_not_substring_and_previous_entry_is_adopted(self):
        rows = [{"pid": 1, "exe": RUNTIME["nodeExe"], "cmd": r'C:\tools\node.exe "C:\workspace\index.js.extra"',
                 "sid": CONFIG["ownerSid"]},
                {"pid": 2, "exe": RUNTIME["nodeExe"], "cmd": r'C:\tools\node.exe "C:\workspace\old-index.js"',
                 "sid": CONFIG["ownerSid"]}]
        self.assertEqual(self.inventory(rows), [2])

    def test_unrelated_or_other_owner_not_adopted(self):
        row = {"pid": 1, "exe": RUNTIME["nodeExe"],
               "cmd": r'C:\tools\node.exe "C:\workspace\index.js"', "sid": "another-owner"}
        with self.assertRaisesRegex(worker.SafeError, "component_has_different_owner"):
            self.inventory([row])
        row["exe"] = r"C:\different\node.exe"
        self.assertEqual(self.inventory([row]), [])

    def test_exact_host_command_only(self):
        rows = [{"pid": 1, "exe": RUNTIME["devtunnelExe"],
                 "cmd": r'C:\tools\devtunnel.exe host windows-workspace.jpe1-extra', "sid": CONFIG["ownerSid"]},
                {"pid": 2, "exe": RUNTIME["devtunnelExe"],
                 "cmd": r'C:\tools\devtunnel.exe host windows-workspace.jpe1 --host-header unchanged --origin-header unchanged',
                 "sid": CONFIG["ownerSid"]}]
        self.assertEqual(self.inventory(rows, "tunnel"), [2])

    def test_duplicate_processes_fail_without_killing_anything(self):
        row = {"pid": 1, "exe": RUNTIME["nodeExe"],
               "cmd": r'C:\tools\node.exe "C:\workspace\index.js"', "sid": CONFIG["ownerSid"]}
        with self.assertRaisesRegex(worker.SafeError, "duplicate_component_processes"):
            self.inventory([row, {**row, "pid": 2}])


class InstallerTests(unittest.TestCase):
    def test_consoleless_python_supplies_only_null_streams(self):
        with patch.object(worker.sys, "stdin", None), patch.object(worker.sys, "stdout", None), \
             patch.object(worker.sys, "stderr", None):
            worker.ensure_standard_streams()
            streams = [worker.sys.stdin, worker.sys.stdout, worker.sys.stderr]
            try:
                self.assertTrue(all(stream.name == os.devnull for stream in streams))
                self.assertEqual(streams[0].read(), "")
                self.assertEqual(streams[1].write("discarded"), 9)
                self.assertEqual(streams[2].write("discarded"), 9)
            finally:
                for stream in streams:
                    stream.close()

    def test_logon_only_no_credentials_elevation_or_policy_bypass(self):
        script = Path(__file__).with_name("install-codey-windows-automation.ps1").read_text()
        self.assertIn("<LogonType>InteractiveToken</LogonType>", script)
        self.assertIn("<RunLevel>LeastPrivilege</RunLevel>", script)
        self.assertIn("<LogonTrigger>", script)
        self.assertIn("<Interval>PT1H</Interval>", script)
        self.assertNotIn("<BootTrigger>", script)
        for forbidden in ["Get-Credential", "SecureStringTo", "-ExecutionPolicy", "-Verb RunAs",
                          "New-NetFirewallRule", "Set-NetFirewall", "Register-ScheduledTask"]:
            self.assertNotIn(forbidden, script)
        self.assertIn("if (-not $Apply)", script)
        self.assertIn("protectedCopilotTaskUnchanged", script)


class SupervisorTests(unittest.TestCase):
    class Finished(BaseException):
        pass

    def test_exited_child_restarts_hidden_with_backoff(self):
        config = {**CONFIG, "powershellExe": "powershell.exe", "workspaceLauncher": r"C:\launch\workspace.ps1",
                  "runtimeConfig": r"C:\private\runtime.json"}
        child = Mock(pid=99, returncode=42)
        child.poll.side_effect = [None, 42]
        context = Mock()
        context.__enter__ = Mock(return_value=child)
        context.__exit__ = Mock(return_value=False)
        with patch.object(worker, "matching_processes", return_value=[]), \
             patch.object(worker, "windows_context", return_value={}), patch.object(worker, "status") as status, \
             patch.object(worker.time, "monotonic", side_effect=[0, 1]), \
             patch.object(worker.time, "sleep") as sleep, \
             patch.object(worker.subprocess, "Popen", side_effect=[context, self.Finished()]) as popen:
            with self.assertRaises(self.Finished):
                worker.supervise(config, RUNTIME, "workspace")
        self.assertEqual(popen.call_count, 2)
        self.assertIn("Hidden", popen.call_args.args[0])
        self.assertEqual(popen.call_args.kwargs["creationflags"], worker.CREATE_NO_WINDOW)
        self.assertEqual(popen.call_args.kwargs["stdout"], subprocess.DEVNULL)
        self.assertEqual(popen.call_args.kwargs["stderr"], subprocess.DEVNULL)
        self.assertEqual(sleep.call_args_list[-1].args[0], 10)
        status.assert_any_call(config, "workspace", "component_exited", exitCode=42, retryInSeconds=10)

    def test_manual_process_is_adopted_until_it_exits(self):
        config = {**CONFIG, "powershellExe": "powershell.exe", "workspaceLauncher": r"C:\launch\workspace.ps1",
                  "runtimeConfig": r"C:\private\runtime.json"}
        with patch.object(worker, "matching_processes", return_value=[123]), \
             patch.object(worker, "process_alive", side_effect=[True, False]), \
             patch.object(worker, "windows_context", return_value={}), patch.object(worker, "status") as status, \
             patch.object(worker.time, "sleep") as sleep, \
             patch.object(worker.subprocess, "Popen", side_effect=self.Finished()) as popen:
            with self.assertRaises(self.Finished):
                worker.supervise(config, RUNTIME, "workspace")
        status.assert_any_call(config, "workspace", "adopted", pid=123, context={})
        status.assert_any_call(config, "workspace", "restart_pending")
        sleep.assert_called_once_with(15)
        popen.assert_called_once()


if __name__ == "__main__":
    unittest.main(verbosity=2)
