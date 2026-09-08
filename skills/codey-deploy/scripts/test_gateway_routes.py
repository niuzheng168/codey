"""Offline release-routing regression tests; no Azure, SSH or credentials."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from gateway_routes import CONFIG_FILE, POLICY_FILE, freeze, validate, verify_frozen, verify_published

ROUTE = {
    "id": "local", "upstream": "https://localhost:3001", "tlsServerName": "localhost",
    "fingerprint": ":".join(["AB"] * 32),
    "devTunnel": {"tunnelId": "windows-workspace", "clusterId": "jpe1", "port": 3001,
                  "connectTokenEnv": "CODEY_WINDOWS_WORKSPACE_TUNNEL_TOKEN"},
}
LINUX = {"id": "linux", "upstream": "https://10.0.0.1:3001", "tlsServerName": "linux.example"}
CONFIG = {"nodes": [ROUTE, LINUX]}
POLICY = {"schema": 1, "routes": [ROUTE], "probeNodeIds": ["local"]}
ENVIRONMENT = {"CODEY_WINDOWS_WORKSPACE_TUNNEL_TOKEN"}
APP = {"properties": {"template": {"containers": [
    {"name": "portal", "env": [{"name": next(iter(ENVIRONMENT)), "secretRef": "connect-only"}]},
]}}}


class GatewayRoutes(unittest.TestCase):
    def test_existing_reviewed_route_is_accepted_without_credentials(self):
        proof = validate(CONFIG, POLICY, ENVIRONMENT)
        self.assertEqual(proof["nodeIds"], ["local", "linux"])
        self.assertEqual(proof["requiredTunnelIds"], ["local"])
        self.assertNotIn("connect-only", json.dumps(proof))
        self.assertNotIn("fingerprint", json.dumps(proof))

    def test_old_linux_only_config_cannot_drop_windows(self):
        with self.assertRaisesRegex(RuntimeError, "route set changed"):
            validate({"nodes": [LINUX]}, POLICY, ENVIRONMENT)

    def test_missing_policy_cannot_hide_a_live_token_reference(self):
        with self.assertRaisesRegex(RuntimeError, "Missing reviewed"):
            validate({"nodes": [LINUX]}, None, ENVIRONMENT)

    def test_empty_policy_cannot_hide_a_live_token_reference(self):
        with self.assertRaisesRegex(RuntimeError, "no protected route"):
            validate({"nodes": [LINUX]}, {"schema": 1, "routes": [], "probeNodeIds": []}, ENVIRONMENT)

    def test_legacy_no_tunnel_installation_still_works(self):
        self.assertEqual(validate({"nodes": [LINUX]}, None, set())["requiredTunnelIds"], [])

    def test_changed_pin_tunnel_or_upstream_rejected(self):
        changes = [
            ("fingerprint", ":".join(["CD"] * 32)),
            ("upstream", "https://127.0.0.1:3001"),
            ("devTunnel", {**ROUTE["devTunnel"], "tunnelId": "another-tunnel"}),
        ]
        for key, value in changes:
            with self.subTest(key=key):
                changed = copy.deepcopy(CONFIG)
                changed["nodes"][0][key] = value
                with self.assertRaisesRegex(RuntimeError, "route changed"):
                    validate(changed, POLICY, ENVIRONMENT)

    def test_no_anonymous_mode_arbitrary_port_or_url_credentials(self):
        for changes in [
            {"upstream": "http://localhost:3001"},
            {"upstream": "https://user:pass@localhost:3001"},
            {"devTunnel": {**ROUTE["devTunnel"], "port": 8443}},
            {"devTunnel": {**ROUTE["devTunnel"], "allowAnonymous": True}},
        ]:
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                validate({"nodes": [{**ROUTE, **changes}]}, POLICY, ENVIRONMENT)

    def test_unreviewed_new_tunnel_and_missing_credential_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "route set changed"):
            validate({"nodes": [ROUTE, {**ROUTE, "id": "another"}]}, POLICY, ENVIRONMENT)
        with self.assertRaisesRegex(RuntimeError, "credential reference"):
            validate(CONFIG, POLICY, set())

    def test_duplicates_are_not_collapsed(self):
        with self.assertRaisesRegex(RuntimeError, "Duplicate Workspace"):
            validate({"nodes": [ROUTE, ROUTE]}, POLICY, ENVIRONMENT)
        with self.assertRaisesRegex(RuntimeError, "Duplicate required"):
            validate(CONFIG, {**POLICY, "routes": [ROUTE, ROUTE]}, ENVIRONMENT)

    def test_names_may_change_but_owner_probe_scope_is_explicit(self):
        validate({"nodes": [{**ROUTE, "name": "Windows Dev Box"}, LINUX]}, POLICY, ENVIRONMENT)
        with self.assertRaisesRegex(RuntimeError, "owner-scoped"):
            validate(CONFIG, {**POLICY, "probeNodeIds": ["another-users-node"]}, ENVIRONMENT)

    def test_freeze_cannot_be_rebased_or_drift_after_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, job = Path(temporary) / "root", Path(temporary) / "job"
            (root / "config").mkdir(parents=True)
            frozen = job / "source/portal/config"
            frozen.mkdir(parents=True)
            (root / "config" / POLICY_FILE).write_text(json.dumps(POLICY))
            (frozen / CONFIG_FILE).write_text(json.dumps(CONFIG))
            proof = freeze(root, job, APP)
            self.assertEqual(verify_frozen(root, job, APP), proof)
            with self.assertRaisesRegex(RuntimeError, "already exists"):
                freeze(root, job, APP)
            (frozen / CONFIG_FILE).write_text(json.dumps({"nodes": [LINUX, ROUTE]}))
            with self.assertRaisesRegex(RuntimeError, "changed during"):
                verify_frozen(root, job, APP)

    def test_published_owner_api_must_expose_windows(self):
        http = Mock()
        http.return_value.json.return_value = {"nodes": [LINUX]}
        with self.assertRaisesRegex(RuntimeError, "absent"):
            verify_published(http, validate(CONFIG, POLICY, ENVIRONMENT))
        self.assertEqual(http.call_count, 1)

    def test_published_check_uses_owner_sso_not_usage_or_model_calls(self):
        def request(path, **kwargs):
            response = Mock()
            response.json.return_value = ({"nodes": CONFIG["nodes"]} if path == "/api/cloudcli/nodes"
                                          else {"managedAuthentication": True})
            return response
        http = Mock(side_effect=request)
        result = verify_published(http, validate(CONFIG, POLICY, ENVIRONMENT))
        http.assert_any_call("/cloudcli/local/api/auth/status", authenticated=False, expected=401)
        self.assertEqual(result["modelCalls"], 0)
        self.assertFalse(result["adminAccessExpanded"])
        self.assertTrue(all("/usage" not in call.args[0] for call in http.call_args_list))


if __name__ == "__main__":
    unittest.main(verbosity=2)
