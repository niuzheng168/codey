"""Offline Windows onboarding checks; no real login, tunnel, or service changes."""
import base64
import copy
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/config-new-codey-machine/scripts"


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SCRIPT / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


client = load("test_windows_tunnel_client", "windows-tunnel-client.py")
worker = load("test_windows_tunnel_worker", "windows-tunnel-service.py")
installer = load("test_windows_tunnel_installer", "configure-windows-tunnel.py")
ID = "n-0123456789abcdef01234567"
NOW = 1788939000000


def invitation():
    return {
        "schema": 1, "platform": "windows-x64", "nodeId": ID, "principalId": "owner-a", "username": "zhn",
        "clientSigningKey": "A" * 43, "workspaceSsoKey": "B" * 43, "tunnelUpdateKey": "C" * 43,
        "portalOrigin": "https://codey.test", "network": {"mode": "devtunnel"}, "expiresAt": NOW + 86400000,
    }


def fixture_manifest():
    distribution = {
        "file": "node-v24.20.0-win-x64.zip",
        "url": "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip", "sha256": "a" * 64,
    }
    artifacts = [{"file": file, "sha256": str(index) * 64, "size": 20} for index, file in enumerate(
        ["cloudcli-source.tar.gz", "copilot-api-source.tar.gz", "portal-node-source.tar.gz"], 1)]
    identity = "\n".join(["24.20.0", "1.4.2", distribution["sha256"]] + [row["sha256"] for row in artifacts])
    return {
        "schema": 1, "platform": "windows-x64", "node": "24.20.0", "bunBuildTool": "1.4.2",
        "nodeDistribution": distribution, "artifacts": artifacts, "dependencyMode": "install-on-target",
        "releaseId": "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16],
    }


def token(**changes):
    claims = {"tunnelId": "codey-test-windows", "clusterId": "jpe1", "scp": "connect", "exp": NOW // 1000 + 72000, **changes}
    return ".".join(["e30", base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("="), "c2ln"])


class WindowsTunnelTests(unittest.TestCase):
    def proxy_probe(self, responses, key_file=None):
        calls = []

        class Response(io.BytesIO):
            status = 200

        def open_request(request, **_kwargs):
            calls.append(request.full_url)
            self.assertTrue(request.full_url.startswith("http://127.0.0.1:4141/"))
            self.assertIsNone(request.get_header("Cookie"))
            if key_file:
                self.assertEqual(request.get_header("Authorization"), "Bearer " + key_file.read_text().strip())
            pathname = request.full_url.removeprefix("http://127.0.0.1:4141")
            status, body = responses[pathname]
            if status != 200:
                raise urllib.error.HTTPError(request.full_url, status, "redacted fixture", {}, io.BytesIO(b"never log"))
            return Response(json.dumps(body).encode())

        def build_opener(proxy_handler, redirect_handler):
            self.assertEqual(proxy_handler.proxies, {})
            self.assertIs(redirect_handler, installer.tunnel.NoRedirect)
            return SimpleNamespace(open=open_request)

        with patch.object(installer.urllib.request, "build_opener", side_effect=build_opener):
            return installer.verify_usage(key_file), calls

    def test_quota_failure_uses_independent_authenticated_local_statistics_without_claiming_model_health(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / "existing.key"
            key.write_text("private-fixture-credential" * 2)
            for status, body in [(500, {"error": "Failed to fetch Copilot usage"}), (503, {}),
                                 (404, {}), (429, {}), (200, None)]:
                with self.subTest(status=status, body=body):
                    result, calls = self.proxy_probe({
                        "/usage": (status, body), "/token-usage": (200, {"totals": {"requests": 1}}),
                    }, key)
                    self.assertFalse(result["usage"])
                    self.assertTrue(result["tokenUsage"])
                    self.assertEqual(result["usageHttpStatus"], status)
                    self.assertEqual(result["warnings"], ["copilot_quota_unavailable_model_inference_not_tested"])
                    self.assertEqual(calls, ["http://127.0.0.1:4141/usage", "http://127.0.0.1:4141/token-usage"])
                    self.assertNotIn(key.read_text(), json.dumps(result))
            result, calls = self.proxy_probe({"/usage": (200, {"copilot_plan": "test"})}, key)
            self.assertTrue(result["usage"])
            self.assertEqual(result["warnings"], [])
            self.assertEqual(len(calls), 1)

    def test_quota_warning_never_bypasses_authentication_redirects_or_invalid_data(self):
        for status, body in [(401, {}), (403, {}), (302, {}), (200, []), (200, {"error": "invalid"})]:
            with self.subTest(endpoint="usage", status=status, body=body), self.assertRaises(installer.Error):
                self.proxy_probe({"/usage": (status, body)})
        for status, body in [(401, {}), (403, {}), (500, {}), (404, {}),
                             (200, None), (200, []), (200, {"error": "invalid"})]:
            with self.subTest(endpoint="tokens", status=status, body=body), self.assertRaises(installer.Error):
                self.proxy_probe({"/usage": (500, {}), "/token-usage": (status, body)})
        with patch.object(installer.urllib.request, "build_opener",
                          return_value=SimpleNamespace(open=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                              OSError("private diagnostic must not be printed")))):
            with self.assertRaisesRegex(installer.Error, "^existing_proxy_data_probe_unavailable_no_service_changed$"):
                installer.verify_usage(None)

    def test_local_tls_verification_reports_quota_warning_but_still_enforces_all_security_controls(self):
        enrollment = invitation()

        def verify(**changes):
            values = {
                "mode": "devtunnel", "usage": (500, {"error": "Failed to fetch Copilot usage"}),
                "health": (200, {"relay": "codey-node-relay", "nodeId": ID}),
                "tokens": (200, {"totals": {}}), "anonymousTokens": 401,
                "history": 200, "username": "zhn", "anonymousUsage": 401, "anonymousWorkspace": 401,
                **changes,
            }

            def probe(_ip, _port, _dns, _cert, pathname, headers=None):
                if pathname == "/healthz":
                    return values["health"]
                if pathname == "/usage":
                    return values["usage"] if headers else (values["anonymousUsage"], {})
                if pathname == "/token-usage":
                    return values["tokens"] if headers else (values["anonymousTokens"], {})
                if pathname.startswith("/session-history"):
                    self.assertTrue(headers["authorization"].startswith("Bearer "))
                    return values["history"], {"items": []}
                self.assertEqual(pathname, "/api/auth/status")
                return (200, {"managedAuthentication": True, "user": {"username": values["username"]}}) if headers else (
                    values["anonymousWorkspace"], {})

            with patch.object(installer.windows.common, "local_probe", side_effect=probe):
                return installer.windows.common.verify(
                    {**enrollment, "network": {"mode": values["mode"]}}, {"listenIp": "127.0.0.1"}, Path("fixture.pem"))

        result = verify()
        self.assertFalse(result["usage"])
        self.assertTrue(result["tokenUsage"])
        self.assertEqual(result["usageHttpStatus"], 500)
        self.assertTrue(result["history"] and result["workspaceSso"] and result["anonymousDenied"])
        self.assertTrue(verify(mode="same-vnet", usage=(200, None))["usage"], "Preserve existing headless VNet setup")
        for changes in [
            {"usage": (401, {})}, {"usage": (403, {})}, {"usage": (302, {})},
            {"usage": (200, {"error": "bad"})}, {"mode": "same-vnet"},
            {"health": (200, {"relay": "codey-node-relay", "nodeId": "different-owner-node"})},
            {"tokens": (401, {})}, {"tokens": (500, {})}, {"tokens": (200, {"error": "bad"})},
            {"anonymousTokens": 200}, {"history": 500}, {"username": "other-owner"},
            {"anonymousUsage": 200}, {"anonymousWorkspace": 200},
        ]:
            with self.subTest(changes=changes), self.assertRaises(installer.Error):
                verify(**changes)
        with patch.object(installer.windows.common, "local_probe", side_effect=OSError("TLS fixture failure")):
            with self.assertRaises(OSError):
                installer.windows.common.verify(enrollment, {"listenIp": "127.0.0.1"}, Path("fixture.pem"))

    def install_fixture(self, root):
        home, skill = root / "home", root / "package"
        home.mkdir()
        (skill / "assets").mkdir(parents=True)
        manifest = fixture_manifest()
        for row in manifest["artifacts"]:
            data = ("fixture " + row["file"]).encode()
            (skill / "assets" / row["file"]).write_bytes(data)
            row.update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
        identity = "\n".join([manifest["node"], manifest["bunBuildTool"], manifest["nodeDistribution"]["sha256"]]
                             + [row["sha256"] for row in manifest["artifacts"]])
        manifest["releaseId"] = "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
        enrollment = invitation()
        enrollment.update(releaseId=manifest["releaseId"], expiresAt=int(time.time() * 1000) + 86400000)
        (skill / "assets/manifest.json").write_text(json.dumps(manifest))
        (skill / "assets/enrollment.json").write_text(json.dumps(enrollment))
        tools = root / "tools"
        tools.mkdir()
        for name in ("codex.exe", "openssl.exe", "devtunnel.exe"):
            (tools / name).write_bytes(b"fixture only; never executed")
        codex_home = home / "existing-codex"
        codex_home.mkdir()
        (codex_home / "config.toml").write_text('model = "preserve-me"\n')
        args = SimpleNamespace(
            expected_computer_name=os.environ.get("COMPUTERNAME", ""), apply=True, network_approved=True,
            enrollment=str(skill / "assets/enrollment.json"), out=str(root / "output/codey-machine.json"),
            codex_executable=str(tools / "codex.exe"), openssl=str(tools / "openssl.exe"),
            devtunnel_executable=str(tools / "devtunnel.exe"), usage_key_file=None, workspace_root=str(home), name="Test Windows",
        )
        return home, skill, codex_home, args

    def test_windows_bundle_requires_native_pinned_sources_and_separate_credentials(self):
        manifest, enrollment = fixture_manifest(), invitation()
        enrollment["releaseId"] = manifest["releaseId"]
        self.assertEqual(len(client.validate_bundle(enrollment, manifest, now=NOW)), 3)
        for key, value in [("platform", "linux-x64"), ("network", {"mode": "same-vnet"}),
                           ("workspaceSsoKey", enrollment["clientSigningKey"]), ("expiresAt", NOW - 1)]:
            with self.subTest(key=key), self.assertRaises(client.TunnelError):
                client.validate_bundle({**enrollment, key: value}, manifest, now=NOW)
        for value in ["http://codey.test", "https://user:key@codey.test", "https://codey.test/path"]:
            with self.subTest(origin=value), self.assertRaises(client.TunnelError):
                client.validate_bundle({**enrollment, "portalOrigin": value}, manifest, now=NOW)
        wrong = copy.deepcopy(manifest)
        wrong["nodeDistribution"]["file"] = "node-v24.20.0-linux-x64.tar.xz"
        with self.assertRaises(client.TunnelError):
            client.validate_bundle(enrollment, wrong, now=NOW)
        wrong = copy.deepcopy(manifest)
        wrong["artifacts"].pop()
        with self.assertRaises(client.TunnelError):
            client.validate_bundle(enrollment, wrong, now=NOW)

    def test_ready_install_can_be_verified_after_invitation_expiry(self):
        manifest, enrollment = fixture_manifest(), invitation()
        enrollment.update(releaseId=manifest["releaseId"], expiresAt=NOW - 1)
        self.assertEqual(len(client.validate_bundle(enrollment, manifest, ready=True, now=NOW)), 3)

    def test_renewal_is_request_bound_connect_only_and_keeps_tokens_out_of_state(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"nodeId": ID, "configRoot": directory, "devtunnelExe": "devtunnel.exe",
                      "tunnelId": "codey-test-windows", "clusterId": "jpe1"}
            calls, requests = [], []

            def runner(argv, **kwargs):
                calls.append(argv)
                self.assertEqual(argv[1:], ["token", "codey-test-windows.jpe1", "--scope", "connect", "--json"])
                self.assertNotIn(token(), json.dumps(argv))
                self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
                return SimpleNamespace(returncode=0, stdout=json.dumps({"token": token()}))

            class Response:
                status = 200
                def __enter__(self): return self
                def __exit__(self, *_args): return False
                def read(self, _limit):
                    return json.dumps({"ok": True, "nodeId": ID, "expiresAt": NOW + 72000000}).encode()

            def opener(request, **_kwargs):
                requests.append(request)
                self.assertEqual(request.full_url, f"https://codey.test/api/machine-tunnels/{ID}/token")
                scheme, auth = request.get_header("Authorization").split(" ")
                timestamp, nonce, signature = auth.split(":")
                self.assertEqual(scheme, "CodeyTunnel")
                message = f"POST\n/api/machine-tunnels/{ID}/token\n{timestamp}\n{nonce}\n{hashlib.sha256(request.data).hexdigest()}".encode()
                expected = base64.urlsafe_b64encode(hmac.new(base64.urlsafe_b64decode("C" * 43 + "="),
                                                            message, hashlib.sha256).digest()).decode().rstrip("=")
                self.assertEqual(signature, expected)
                self.assertIsNone(request.get_header("Cookie"))
                self.assertIsNone(request.get_header("Origin"))
                return Response()

            result = client.renew(config, invitation(), runner=runner, opener=opener, now=NOW)
            self.assertTrue(result["ok"])
            state = (Path(directory) / "renewal.json").read_text()
            self.assertNotIn(token(), state)
            self.assertNotIn(invitation()["tunnelUpdateKey"], state)
            self.assertEqual(client.renew(config, invitation(), runner=runner, opener=opener, now=NOW), result)
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(requests), 1)

    def test_invalid_tokens_never_reach_the_portal(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"nodeId": ID, "configRoot": directory, "devtunnelExe": "devtunnel.exe",
                      "tunnelId": "codey-test-windows", "clusterId": "jpe1"}
            for claims in [{"scp": "host connect"}, {"scp": "manage"}, {"tunnelId": "other-node"},
                           {"clusterId": "usw2"}, {"exp": NOW // 1000}, {"exp": True}]:
                with self.subTest(claims=claims), patch.object(client, "cli", return_value=SimpleNamespace(
                    stdout=json.dumps({"token": token(**claims)}))) as cli, \
                        patch.object(client.urllib.request, "build_opener") as opener:
                    with self.assertRaises(client.TunnelError):
                        client.renew(config, invitation(), force=True, now=NOW)
                    cli.assert_called_once()
                    opener.assert_not_called()
            self.assertFalse((Path(directory) / "renewal.json").exists())

    def test_redirects_are_not_followed(self):
        self.assertIsNone(client.NoRedirect().redirect_request(None, None, 302, "", {}, "https://untrusted.test"))

    def test_login_detection_handles_cli_success_codes_that_still_require_sign_in(self):
        for status, text in [(1, "error"), (0, "Not logged in"), (0, "Entra ID login required."),
                             (0, ""), (0, "A window handle must be configured")]:
            self.assertFalse(installer.logged_in(SimpleNamespace(returncode=status, stdout=text)))
        self.assertTrue(installer.logged_in(SimpleNamespace(returncode=0, stdout="Logged in as the owner")))
        self.assertFalse(installer.logged_in(SimpleNamespace(
            returncode=0, stdout="Logged in as the owner", stderr="A window handle must be configured")))

    def test_cached_devtunnel_login_is_reused_even_without_an_interactive_console(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "devtunnel.exe"
            executable.write_bytes(b"fixture only")
            args = SimpleNamespace(devtunnel_executable=str(executable))
            for read_only in (False, True):
                with self.subTest(read_only=read_only), \
                        patch.object(installer.tunnel, "cli", return_value=SimpleNamespace(
                            returncode=0, stdout="Logged in as the owner")) as show, \
                        patch.object(installer, "interactive_auth_console", return_value=False) as console, \
                        patch.object(installer.subprocess, "run") as login:
                    self.assertEqual(installer.prepare_devtunnel(args, Path(directory), "owner", read_only=read_only),
                                     executable.resolve())
                    show.assert_called_once_with(executable.resolve(), ["user", "show"], check=False)
                    console.assert_not_called()
                    login.assert_not_called()

    def test_headless_and_read_only_setup_report_browser_login_action_without_trying_any_authentication(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "owner's tools" / "devtunnel.exe"
            executable.parent.mkdir()
            executable.write_bytes(b"fixture only")
            args = SimpleNamespace(devtunnel_executable=str(executable))
            for read_only, interactive in ((False, False), (True, False), (True, True)):
                with self.subTest(read_only=read_only, interactive=interactive), \
                        patch.object(installer.tunnel, "cli", return_value=SimpleNamespace(
                            returncode=0, stdout="Entra ID login required.")), \
                        patch.object(installer, "interactive_auth_console", return_value=interactive), \
                        patch.object(installer.subprocess, "run") as login:
                    with self.assertRaises(installer.DevTunnelBrowserLoginRequired) as failure:
                        installer.prepare_devtunnel(args, Path(directory), "owner", read_only=read_only)
                    login.assert_not_called()
                    result = installer.setup_error(failure.exception)
                    self.assertFalse(result["ok"])
                    action = result["userAction"]
                    self.assertIn("visible, non-admin PowerShell", action["where"])
                    self.assertEqual(action["command"],
                        "& '" + str(executable.resolve()).replace("'", "''") + "' user login --entra --use-browser-auth")
                    self.assertFalse(action["deviceCodeFallback"])
                    self.assertIn("az login does not sign in DevTunnel", action["note"])
                    self.assertNotIn("--use-device-code-auth", action["command"])

    def test_interactive_setup_uses_browser_auth_once_in_the_inherited_console_and_checks_cached_login(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "devtunnel.exe"
            executable.write_bytes(b"fixture only")
            args = SimpleNamespace(devtunnel_executable=str(executable))
            responses = [SimpleNamespace(returncode=0, stdout="Not logged in"),
                         SimpleNamespace(returncode=0, stdout="Logged in as the owner")]
            from contextlib import redirect_stdout
            with patch.object(installer.tunnel, "cli", side_effect=responses) as show, \
                    patch.object(installer, "interactive_auth_console", return_value=True), \
                    patch.object(installer.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as login, \
                    redirect_stdout(io.StringIO()):
                self.assertEqual(installer.prepare_devtunnel(args, Path(directory), "owner"), executable.resolve())
            login.assert_called_once_with(
                [str(executable.resolve()), "user", "login", "--entra", "--use-browser-auth"],
                timeout=300, creationflags=0)
            self.assertEqual(show.call_count, 2)

    def test_failed_browser_login_never_retries_device_code_azure_login_or_clears_the_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "devtunnel.exe"
            executable.write_bytes(b"fixture only")
            args = SimpleNamespace(devtunnel_executable=str(executable))
            from contextlib import redirect_stdout
            for outcome in ("failure", "timeout", "not-cached"):
                with self.subTest(outcome=outcome), \
                        patch.object(installer.tunnel, "cli", return_value=SimpleNamespace(
                            returncode=0, stdout="Not logged in")) as show, \
                        patch.object(installer, "interactive_auth_console", return_value=True), \
                        patch.object(installer.subprocess, "run",
                            side_effect=subprocess.TimeoutExpired("private diagnostic", 300) if outcome == "timeout" else None,
                            return_value=SimpleNamespace(returncode=1 if outcome == "failure" else 0)) as login, \
                        redirect_stdout(io.StringIO()):
                    with self.assertRaises(installer.DevTunnelBrowserLoginRequired) as failure:
                        installer.prepare_devtunnel(args, Path(directory), "owner")
                    login.assert_called_once()
                    self.assertEqual(login.call_args.args[0][-2:], ["--entra", "--use-browser-auth"])
                    self.assertEqual(show.call_count, 2 if outcome == "not-cached" else 1)
                    self.assertNotIn("private diagnostic", json.dumps(installer.setup_error(failure.exception)))

    def test_authentication_requires_live_interactive_streams_not_pipes_or_pythonw(self):
        tty = SimpleNamespace(isatty=lambda: True)
        pipe = SimpleNamespace(isatty=lambda: False)
        for streams, expected in [((tty, tty, tty), True), ((pipe, tty, tty), False),
                                  ((tty, pipe, tty), False), ((tty, tty, pipe), False), ((None, None, None), False)]:
            with self.subTest(expected=expected), patch.object(installer.sys, "stdin", streams[0]), \
                    patch.object(installer.sys, "stdout", streams[1]), patch.object(installer.sys, "stderr", streams[2]):
                self.assertEqual(installer.interactive_auth_console(), expected)

    @unittest.skipUnless(os.name == "nt", "Windows sharing violations")
    def test_atomic_state_retries_sharing_violations_without_removing_old_state(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "state.json"
            file.write_text('{"old":true}')
            original = client.os.replace
            calls = []
            def replace(source, target):
                calls.append((source, target))
                if len(calls) == 1:
                    self.assertEqual(file.read_text(), '{"old":true}')
                    error = PermissionError("fixture sharing violation")
                    error.winerror = 32
                    raise error
                return original(source, target)
            with patch.object(client.os, "replace", side_effect=replace), patch.object(client.time, "sleep"):
                client.write_state(file, {"new": True})
            self.assertEqual(len(calls), 2)
            self.assertEqual(json.loads(file.read_text()), {"new": True})

    def test_tunnel_creation_journals_before_request_and_never_adds_anonymous_access(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            value = {"tunnelId": "codey-" + ID, "clusterId": "jpe1",
                     "description": "Codey Windows " + ID, "ports": []}

            def runner(argv, **_kwargs):
                self.assertTrue((Path(directory) / "tunnel.json").is_file())
                self.assertNotIn("--allow-anonymous", argv)
                calls.append(argv)
                return SimpleNamespace(returncode=0, stdout=json.dumps({"tunnel": value}))

            binding = client.ensure_tunnel("devtunnel.exe", invitation(), directory, runner=runner)
            self.assertEqual(binding, {"tunnelId": "codey-" + ID, "clusterId": "jpe1"})
            self.assertEqual(calls[0][1], "create")
            self.assertEqual([row[row.index("--port-number") + 1] for row in calls[1:]], ["3001", "8443"])
            value["ports"] = [{"portNumber": port, "protocol": "https"} for port in (3001, 8443)]
            client.ensure_tunnel("devtunnel.exe", invitation(), directory, runner=runner)
            self.assertEqual(calls[-1][1], "show")
            self.assertEqual(sum(row[1] == "create" for row in calls), 1)

    def test_ambiguous_creation_does_not_allocate_another_tunnel(self):
        with tempfile.TemporaryDirectory() as directory:
            def lost(argv, **_kwargs):
                raise subprocess.TimeoutExpired(argv, 45)
            with self.assertRaises(subprocess.TimeoutExpired):
                client.ensure_tunnel("devtunnel.exe", invitation(), directory, runner=lost)
            calls = []
            def missing(argv, **_kwargs):
                calls.append(argv)
                return SimpleNamespace(returncode=1, stdout="")
            with self.assertRaises(client.TunnelError):
                client.ensure_tunnel("devtunnel.exe", invitation(), directory, runner=missing)
            self.assertEqual([row[1] for row in calls], ["show"])

    def test_foreign_tunnel_and_extra_ports_are_rejected(self):
        for description, ports in [("Someone else's tunnel", []),
                                   ("Codey Windows " + ID, [{"portNumber": 22, "protocol": "auto"}]),
                                   ("Codey Windows " + ID, [{"portNumber": 3001, "protocol": "http"}])]:
            with self.subTest(description=description, ports=ports), tempfile.TemporaryDirectory() as directory:
                def runner(_argv, **_kwargs):
                    return SimpleNamespace(returncode=0, stdout=json.dumps({"tunnel": {
                        "tunnelId": "codey-" + ID, "clusterId": "jpe1",
                        "description": description, "ports": ports,
                    }}))
                with self.assertRaises(client.TunnelError):
                    client.ensure_tunnel("devtunnel.exe", invitation(), directory, runner=runner)

    def test_unknown_host_metrics_never_become_disconnected(self):
        config = {"devtunnelExe": "devtunnel.exe", "tunnelId": "codey-test-windows", "clusterId": "jpe1"}
        for count, expected in [(0, 0), (1, 1), (None, None), (True, None), (-1, None), ("0", None)]:
            with self.subTest(count=count), patch.object(client, "cli", return_value=SimpleNamespace(
                    stdout=json.dumps({"tunnel": {"tunnelId": config["tunnelId"], "clusterId": config["clusterId"],
                                                 "hostConnections": count}}))):
                self.assertEqual(client.host_connections(config), expected)
        with patch.object(client, "cli", side_effect=client.TunnelError("authentication_failed")):
            self.assertIsNone(client.host_connections(config))

    @unittest.skipUnless(os.name == "nt", "Native Windows safety guard")
    def test_wrong_computer_fails_before_owner_network_or_file_changes(self):
        args = SimpleNamespace(expected_computer_name="OTHER-ACCEPTANCE-BOX")
        with patch.object(installer.windows.service, "owner_context") as context, \
                patch.object(installer, "gateway_proof") as proof:
            with self.assertRaisesRegex(installer.Error, "wrong_computer"):
                installer.configure(args)
            context.assert_not_called()
            proof.assert_not_called()

    def test_unrelated_provider_credentials_are_not_forwarded_to_local_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / "key"
            key.write_text("private fixture credential")
            provider = {"base_url": "https://api.unrelated.test/v1", "auth": {"command": "cat", "args": [str(key)]}}
            self.assertIsNone(installer.usage_key_file(None, provider, Path(directory)))
            provider["base_url"] = "http://127.0.0.1:4141/v1"
            self.assertEqual(installer.usage_key_file(None, provider, Path(directory)), key.resolve())

    def test_worker_environment_does_not_inherit_the_installing_codex_task(self):
        config = {"servicePath": "pinned path", "nodeId": ID, "certificate": "certificate",
                  "privateKey": "private-key", "databasePath": "db", "codexHome": "owner-home",
                  "codexExe": "codex.exe", "workspaceRoot": "workspace", "name": "Windows",
                  "ticketKeyFile": "ticket-key"}
        with patch.dict(os.environ, {"CODEX_THREAD_ID": "must-not-inherit", "NODE_OPTIONS": "--require=untrusted.js",
                                     "UNRELATED_PROVIDER_SECRET": "must-not-inherit"}):
            env = worker.environment(config, invitation())
        self.assertNotIn("CODEX_THREAD_ID", env)
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertNotIn("UNRELATED_PROVIDER_SECRET", env)
        self.assertEqual(env["CODEY_CODEX_RUNTIME_TRANSPORT"], "stdio")
        self.assertEqual(env["HOST"], "127.0.0.1")
        self.assertEqual(env["CODEY_RELAY_UPSTREAM"], "http://127.0.0.1:4141/")
        for name in ["PATH", "NODE_OPTIONS", "CODEY_RELAY_UPSTREAM", "CODEX_HOME"]:
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                worker.environment({**config, "providerEnv": {name: "untrusted"}}, invitation())

    @unittest.skipUnless(os.name == "nt", "Windows owned-child Job Object")
    def test_job_closes_only_a_new_child_not_an_existing_service(self):
        with subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(60)"],
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              creationflags=worker.CREATE_NO_WINDOW) as child:
            job = None
            try:
                job = worker.ChildJob(child)
                self.assertIsNone(child.poll())
                job.close()
                child.wait(timeout=10)
            finally:
                if job:
                    job.close()
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=10)

    def test_logon_tasks_never_manage_the_existing_model_proxy(self):
        text = (SCRIPT / "windows-tunnel-tasks.ps1").read_text(encoding="utf-8")
        self.assertIn("@('workspace', 'data', 'tunnel', 'renew')", text)
        self.assertIn("LogonType = 3", text)
        self.assertIn("RunLevel = 0", text)
        self.assertIn("Triggers.Create(9)", text)
        self.assertNotIn("'copilot-api'", text)
        self.assertNotIn("Triggers.Create(8)", text)
        self.assertNotIn("Stop-Process", text)
        self.assertNotIn("Remove-Item", text)

    @unittest.skipUnless(os.name == "nt", "Mocked native Windows transaction")
    def test_install_transaction_preserves_existing_model_and_codex_and_rolls_back_only_new_tasks(self):
        for export_fails in (False, True):
            with self.subTest(export_fails=export_fails), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                home, skill, codex_home, args = self.install_fixture(root)
                proof = {"pid": 12345, "ownerSid": "test-owner", "executable": "protected-node.exe",
                         "startedUtc": "original start", "mentionsCopilotApi": True}
                context = {"sid": "test-owner", "sessionId": 1, "elevated": False}
                commands = []

                def build(_manifest, _root, stage, _log):
                    for name in ("node/node.exe", "cloudcli/dist-server/server/index.js", "portal-node/node-relay/server.mjs"):
                        file = stage / name
                        file.parent.mkdir(parents=True, exist_ok=True)
                        file.write_bytes(b"fixture executable; never run")

                def command(argv, **_kwargs):
                    values = [str(item) for item in argv]
                    commands.append(values)
                    if values[0] == args.openssl:
                        Path(values[values.index("-out") + 1]).write_text("public certificate fixture")
                        Path(values[values.index("-keyout") + 1]).write_text("private key fixture")
                    return SimpleNamespace(returncode=0, stdout="{}")

                original_export = installer.export_machine
                from contextlib import ExitStack, redirect_stdout
                import io
                output = io.StringIO()
                with ExitStack() as stack:
                    stack.enter_context(patch.object(installer, "SKILL", skill))
                    stack.enter_context(patch.object(installer.Path, "home", return_value=home))
                    stack.enter_context(patch.dict(os.environ, {"CODEX_HOME": str(codex_home)}))
                    stack.enter_context(patch.object(installer.windows.service, "owner_context", return_value=context))
                    stack.enter_context(patch.object(installer.windows, "private_directory",
                                                    side_effect=lambda target, _sid: Path(target).mkdir(parents=True)))
                    stack.enter_context(patch.object(installer, "gateway_proof", return_value=proof))
                    stack.enter_context(patch.object(installer, "free_ports", return_value=[]))
                    stack.enter_context(patch.object(installer, "verify_usage", return_value={
                        "dataAccess": True, "usage": False, "usageHttpStatus": 500, "tokenUsage": True,
                        "warnings": ["copilot_quota_unavailable_model_inference_not_tested"],
                    }))
                    stack.enter_context(patch.object(installer.shutil, "disk_usage", return_value=SimpleNamespace(free=16 * 1024 ** 3)))
                    stack.enter_context(patch.object(installer, "prepare_devtunnel", return_value=Path(args.devtunnel_executable)))
                    stack.enter_context(patch.object(installer, "build_runtime", side_effect=build))
                    stack.enter_context(patch.object(installer, "run", side_effect=command))
                    stack.enter_context(patch.object(installer.tunnel, "ensure_tunnel",
                                                    return_value={"tunnelId": "codey-test-windows", "clusterId": "jpe1"}))
                    stack.enter_context(patch.object(installer.tunnel, "renew", return_value={"ok": True}))
                    verify = stack.enter_context(patch.object(installer.windows.common, "verify", return_value={
                        "usage": False, "usageHttpStatus": 500, "tokenUsage": True,
                        "warnings": ["copilot_quota_unavailable_model_inference_not_tested"],
                    }))
                    stack.enter_context(patch.object(installer, "export_machine",
                                                    side_effect=OSError("fixture export failure") if export_fails else original_export))
                    stack.enter_context(redirect_stdout(output))
                    if export_fails:
                        with self.assertRaisesRegex(OSError, "fixture export failure"):
                            installer.configure(args)
                    else:
                        installer.configure(args)
                config_root = home / ".config/codey-machine-windows" / ID
                state = json.loads((config_root / "installation.json").read_text())
                runtime = json.loads((config_root / "runtime.json").read_text())
                self.assertEqual(state["ready"], not export_fails)
                self.assertFalse(state["proxyPreflight"]["usage"])
                self.assertEqual(runtime["protectedModelProcess"], proof)
                self.assertEqual((codex_home / "config.toml").read_text(), 'model = "preserve-me"\n')
                self.assertEqual(runtime["codexHome"], str(codex_home))
                self.assertEqual(runtime["kind"], "windows-devtunnel")
                task_actions = [row[-1] for row in commands if "-Operation" in row]
                self.assertEqual(task_actions, ["Install", "RemoveCreated"] if export_fails else ["Install"])
                self.assertTrue(all(row[0] != proof["executable"] for row in commands))
                verify.assert_called_once()
                if not export_fails:
                    machine = json.loads(Path(args.out).read_text())
                    self.assertEqual(machine["nodeId"], ID)
                    self.assertEqual(machine["networkMode"], "devtunnel")
                    self.assertNotIn("privateIp", machine)
                    self.assertNotIn("vmResourceId", machine)
                    self.assertTrue(json.loads(output.getvalue())["existingModelServiceUnchanged"])
                    self.assertFalse(json.loads(output.getvalue())["verification"]["usage"])
                    self.assertFalse(json.loads(output.getvalue())["realModelCallsTested"])
                    for secret in ("A" * 43, "B" * 43, "C" * 43, "private key fixture"):
                        self.assertNotIn(secret, Path(args.out).read_text())

    @unittest.skipUnless(os.name == "nt", "Native Windows candidate target guard")
    def test_python_entry_cannot_bypass_candidate_target_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, _, args = self.install_fixture(Path(directory))
            file = Path(args.enrollment)
            enrollment = json.loads(file.read_text())
            enrollment["acceptance"] = {"expectedComputerName": "OTHER-BOX", "expiresAt": NOW + 86400000}
            file.write_text(json.dumps(enrollment))
            with patch.object(installer.windows.service, "owner_context",
                              return_value={"sid": "test-owner", "sessionId": 1, "elevated": False}), \
                    patch.object(installer, "gateway_proof") as proof, \
                    patch.object(installer.windows, "private_directory") as private:
                with self.assertRaisesRegex(installer.Error, "different_computer"):
                    installer.configure(args)
                proof.assert_not_called()
                private.assert_not_called()


if __name__ == "__main__":
    unittest.main()
