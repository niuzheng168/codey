"""Offline Mac installer/launchd/renewal regression tests; no live accounts."""
import base64
import copy
import hashlib
import hmac
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import tempfile
import time
import unittest
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


installer = load("mac_installer_test", "skills/config-new-codey-machine/scripts/configure-macos.py")
service = installer.service
builder = load("mac_bundle_test", "scripts/build-machine-bundle.py")


def inputs(target="macos-arm64"):
    suffix = "darwin-arm64.tar.gz" if target == "macos-arm64" else "darwin-x64.tar.gz"
    artifacts = [{"file": f, "sha256": "a" * 64, "size": 12}
                 for f in ("cloudcli-source.tar.gz", "copilot-api-source.tar.gz", "portal-node-source.tar.gz")]
    manifest = {"schema": 1, "platform": target, "node": "24.20.0", "bunBuildTool": "1.4.2",
                "dependencyMode": "install-on-target", "artifacts": artifacts,
                "nodeDistribution": {"file": f"node-v24.20.0-{suffix}",
                                     "url": f"https://nodejs.org/dist/v24.20.0/node-v24.20.0-{suffix}", "sha256": "b" * 64}}
    identity = "\n".join([manifest["node"], manifest["bunBuildTool"], "b" * 64] + ["a" * 64] * 3)
    manifest["releaseId"] = "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
    enrollment = {"schema": 1, "nodeId": "n-" + "a" * 24, "principalId": "test-owner", "username": "owner",
                  "platform": target, "portalOrigin": "https://portal.example.test", "network": {"mode": "devtunnel"},
                  "releaseId": manifest["releaseId"], "expiresAt": int(time.time() * 1000) + 86400000,
                  **{key: "a" * 43 for key in ("clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey")}}
    return enrollment, manifest


class MacNodeTests(unittest.TestCase):
    def test_architecture_release_and_purpose_keys_are_checked(self):
        for target in ("macos-arm64", "macos-x64"):
            enrollment, manifest = inputs(target)
            self.assertEqual(len(installer.validate(enrollment, manifest, target)), 3)
            wrong = "macos-x64" if target == "macos-arm64" else "macos-arm64"
            with self.assertRaises(service.ServiceError):
                installer.validate(enrollment, manifest, wrong)
            for field, replacement in [("tunnelUpdateKey", "model-key"), ("network", {}),
                                       ("portalOrigin", "https://user:secret@evil.test")]:
                modified = {**enrollment, field: replacement}
                with self.assertRaises(service.ServiceError):
                    installer.validate(modified, manifest, target)
            expired = {**enrollment, "expiresAt": 0}
            with self.assertRaises(service.ServiceError):
                installer.validate(expired, manifest, target)
            installer.validate(expired, manifest, target, ready=True)
            changed = copy.deepcopy(manifest)
            changed["artifacts"][0]["sha256"] = "c" * 64
            with self.assertRaises(service.ServiceError):
                installer.validate(enrollment, changed, target)

    def test_registry_rebasing_keeps_locked_version_and_integrity(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "package-lock.json"
            package = {"version": "1.2.3", "integrity": "sha512-original",
                       "resolved": "https://registry.npmmirror.com/pkg/-/pkg-1.2.3.tgz"}
            file.write_text(json.dumps({"packages": {"node_modules/@scope/pkg": package}}))
            installer.normalize_registry(file, "https://feed.example.test/public/npm/registry/")
            after = json.loads(file.read_text())["packages"]["node_modules/@scope/pkg"]
            self.assertEqual(after["version"], package["version"])
            self.assertEqual(after["integrity"], package["integrity"])
            self.assertEqual(after["resolved"], "https://feed.example.test/public/npm/registry/@scope/pkg/-/pkg-1.2.3.tgz")
            with self.assertRaises(service.ServiceError):
                installer.normalize_registry(file, "https://user:secret@feed.example.test/")
            package["resolved"] = "https://unreviewed.example.test/pkg.tgz"
            file.write_text(json.dumps({"packages": {"node_modules/pkg": package}}))
            with self.assertRaises(service.ServiceError):
                installer.normalize_registry(file, "https://registry.npmjs.org/")

    def test_launchd_jobs_are_user_login_scoped_and_renewal_is_periodic(self):
        config = {"worker": "/private/worker.py", "releaseRoot": "/private/release", "configRoot": "/private/state"}
        workspace = plistlib.loads(installer.launch_agent("com.codey.test.workspace", "workspace", config, "/private/runtime.json").encode())
        renewal = plistlib.loads(installer.launch_agent("com.codey.test.renew", "renew", config, "/private/runtime.json").encode())
        self.assertEqual(workspace["ProgramArguments"][1], "-I")
        self.assertTrue(workspace["KeepAlive"])
        self.assertEqual(renewal["StartInterval"], 300)
        self.assertNotIn("UserName", workspace)
        self.assertEqual(workspace["Umask"], 63)
        self.assertNotIn("EnvironmentVariables", workspace, "No inline secrets in the LaunchAgent")

    def test_renewal_sends_only_a_connect_token_to_the_bound_portal_and_persists_no_token(self):
        with tempfile.TemporaryDirectory() as temp:
            now = int(time.time() * 1000)
            enrollment, _ = inputs()
            config = {"nodeId": enrollment["nodeId"], "configRoot": temp, "devtunnelExe": "/reviewed/devtunnel",
                      "tunnelId": "codey-test", "clusterId": "jpe1"}
            claims = {"tunnelId": config["tunnelId"], "clusterId": config["clusterId"], "scp": "connect",
                      "exp": now // 1000 + 72000}
            token = "e30." + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + ".c2ln"
            calls = []

            def runner(args, **kwargs):
                calls.append(args)
                return SimpleNamespace(returncode=0, stdout=json.dumps({"token": token}))

            def opener(request, **kwargs):
                self.assertEqual(request.full_url, enrollment["portalOrigin"] + "/api/machine-tunnels/" + config["nodeId"] + "/token")
                self.assertNotIn("Origin", request.headers)
                body = json.loads(request.data)
                self.assertEqual(set(body), {"tunnelId", "clusterId", "connectToken"})
                header = request.get_header("Authorization")
                timestamp, nonce, signature = header.removeprefix("CodeyTunnel ").split(":")
                message = f"POST\n{request.selector}\n{timestamp}\n{nonce}\n{hashlib.sha256(request.data).hexdigest()}".encode()
                expected = base64.urlsafe_b64encode(hmac.new(
                    base64.urlsafe_b64decode(enrollment["tunnelUpdateKey"] + "="), message, hashlib.sha256,
                ).digest()).decode().rstrip("=")
                self.assertEqual(signature, expected)
                response = io.BytesIO(json.dumps({"ok": True, "nodeId": config["nodeId"], "expiresAt": claims["exp"] * 1000}).encode())
                response.status = 200
                return response

            result = service.renew(config, enrollment, runner=runner, opener=opener, now=now)
            self.assertTrue(result["ok"])
            self.assertEqual(calls[0], ["/reviewed/devtunnel", "token", "codey-test.jpe1", "--scope", "connect", "--json"])
            saved = (Path(temp) / "renewal.json").read_text()
            self.assertNotIn(token, saved)
            self.assertNotIn(enrollment["tunnelUpdateKey"], saved)
            service.renew(config, enrollment, runner=lambda *a, **kw: self.fail("Unnecessary token issuance"), now=now)
            self.assertEqual((Path(temp) / "renewal.json").stat().st_mode & 0o777, 0o600)

    def test_privileged_or_wrong_tunnel_tokens_never_reach_the_portal(self):
        with tempfile.TemporaryDirectory() as temp:
            enrollment, _ = inputs()
            config = {"nodeId": enrollment["nodeId"], "configRoot": temp, "devtunnelExe": "/reviewed/devtunnel",
                      "tunnelId": "codey-test", "clusterId": "jpe1"}
            for scope, tunnel in (("host", "codey-test"), ("connect", "another-tunnel")):
                payload = {"scp": scope, "tunnelId": tunnel, "clusterId": "jpe1", "exp": int(time.time()) + 72000}
                token = "e30." + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=") + ".c2ln"
                with self.assertRaises(service.ServiceError):
                    service.renew(config, enrollment,
                                  runner=lambda *a, **kw: SimpleNamespace(returncode=0, stdout=json.dumps({"token": token})),
                                  opener=lambda *a, **kw: self.fail("Unsafe credential was transmitted"))

    def test_bundle_archiving_is_deterministic_without_gnu_tar(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            (source / "file.txt").write_text("reviewed source\n")
            a, b = root / "a.tar.gz", root / "b.tar.gz"
            builder.archive_tree(source, a)
            builder.archive_tree(source, b)
            self.assertEqual(a.read_bytes(), b.read_bytes())


if __name__ == "__main__":
    unittest.main()
