"""Offline Mac installer/launchd/renewal regression tests; no live accounts."""
import base64
import copy
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import sys
import tempfile
import time
import unittest
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if os.name == "nt":
    pwd_stub = ModuleType("pwd")
    pwd_stub.getpwuid = lambda _uid: ("owner",)
    sys.modules.setdefault("pwd", pwd_stub)
    sys.modules.setdefault("fcntl", ModuleType("fcntl"))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


sys.path.insert(0, str(ROOT / "skills/config-new-codey-machine/scripts"))
from codey_node.platforms.macos import install as installer, build
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
    def test_cli_qualified_ids_are_normalized_and_the_same_tunnel_is_reused(self):
        enrollment, _ = inputs()
        requested = "codey-" + enrollment["nodeId"]
        description = "Codey macOS " + enrollment["nodeId"]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            calls = []

            def run(args, **_kwargs):
                calls.append(args)
                self.assertNotIn("--allow-anonymous", args)
                if args[1] == "create":
                    self.assertEqual(json.loads((root / "tunnel.json").read_text()), {"requested": requested})
                    value = {"tunnel": {"tunnelId": requested + ".jpe1", "description": description, "ports": []}}
                elif args[1] == "show":
                    self.assertEqual(args[2], requested + ".jpe1")
                    value = {"tunnelId": requested, "clusterId": "jpe1", "description": description,
                             "ports": [{"portNumber": p, "protocol": "https"} for p in (3001, 8443)]}
                else:
                    self.assertEqual(args[1:4], ["port", "create", requested + ".jpe1"])
                    value = {}
                return SimpleNamespace(returncode=0, stdout=json.dumps(value))

            with patch.object(installer, "run", side_effect=run):
                self.assertEqual(installer.token_bound_tunnel("/reviewed/devtunnel", enrollment, root), (requested, "jpe1"))
                saved = json.loads((root / "tunnel.json").read_text())
                self.assertEqual(saved, {"requested": requested, "tunnelId": requested, "clusterId": "jpe1",
                                         "qualifiedId": requested + ".jpe1"})
                self.assertEqual(installer.token_bound_tunnel("/reviewed/devtunnel", enrollment, root), (requested, "jpe1"))
            self.assertEqual([args[1] for args in calls], ["create", "port", "port", "show"])

    def test_tunnel_normalization_rejects_missing_or_conflicting_regions(self):
        for value in (None, [], {"tunnel": None}, {"tunnelId": 123},
                      {"tunnelId": "codey-test"}, {"tunnelId": "codey-test.jpe1.extra"},
                      {"tunnelId": "codey-test.jpe1", "clusterId": "usw2"},
                      {"tunnelId": "codey-test.jpe1", "clusterId": None},
                      {"tunnelId": "../codey-test", "clusterId": "jpe1"}):
            with self.subTest(value=value), self.assertRaises(installer.tunnels.TunnelError):
                installer.tunnels.normalize_tunnel(value)
        value = {"tunnelId": "codey-test.jpe1", "clusterId": "jpe1"}
        self.assertEqual(installer.tunnels.normalize_tunnel(value), {"tunnelId": "codey-test", "clusterId": "jpe1"})
        self.assertEqual(value["tunnelId"], "codey-test.jpe1", "Do not mutate raw CLI records or token claims")

    def test_existing_tunnel_binding_cannot_change_on_retry(self):
        enrollment, _ = inputs()
        requested = "codey-" + enrollment["nodeId"]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            saved = {"requested": requested, "qualifiedId": requested + ".jpe1",
                     "tunnelId": requested, "clusterId": "jpe1"}
            service.write_private(root / "tunnel.json", saved)
            response = {"tunnelId": requested + ".usw2", "description": "Codey macOS " + enrollment["nodeId"],
                        "ports": []}
            with patch.object(installer, "run", return_value=SimpleNamespace(
                    returncode=0, stdout=json.dumps(response))) as run:
                with self.assertRaises(installer.tunnels.TunnelError):
                    installer.token_bound_tunnel("/reviewed/devtunnel", enrollment, root)
                run.assert_called_once()
            self.assertEqual(json.loads((root / "tunnel.json").read_text()), saved)

    def test_wrong_tunnel_or_invalid_ports_never_create_ports(self):
        enrollment, _ = inputs()
        requested = "codey-" + enrollment["nodeId"]
        valid = {"tunnelId": requested + ".jpe1", "description": "Codey macOS " + enrollment["nodeId"], "ports": []}
        cases = [
            {**valid, "tunnelId": "another-node.jpe1"},
            {**valid, "description": "another installation"},
            {**valid, "ports": None},
            {**valid, "ports": [{"portNumber": 22, "protocol": "https"}]},
            {**valid, "ports": [{"portNumber": 3001, "protocol": "http"}]},
            {**valid, "ports": [{"portNumber": 3001, "protocol": "https"}] * 2},
        ]
        for response in cases:
            with self.subTest(response=response), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                with patch.object(installer, "run", return_value=SimpleNamespace(
                        returncode=0, stdout=json.dumps(response))) as run:
                    with self.assertRaises(installer.tunnels.TunnelError):
                        installer.token_bound_tunnel("/reviewed/devtunnel", enrollment, root)
                    run.assert_called_once()
                self.assertEqual(json.loads((root / "tunnel.json").read_text()), {"requested": requested})

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
            build.normalize_registry(file, "https://feed.example.test/public/npm/registry/")
            after = json.loads(file.read_text())["packages"]["node_modules/@scope/pkg"]
            self.assertEqual(after["version"], package["version"])
            self.assertEqual(after["integrity"], package["integrity"])
            self.assertEqual(after["resolved"], "https://feed.example.test/public/npm/registry/@scope/pkg/-/pkg-1.2.3.tgz")
            with self.assertRaises(service.ServiceError):
                build.normalize_registry(file, "https://user:secret@feed.example.test/")
            package["resolved"] = "https://unreviewed.example.test/pkg.tgz"
            file.write_text(json.dumps({"packages": {"node_modules/pkg": package}}))
            with self.assertRaises(service.ServiceError):
                build.normalize_registry(file, "https://registry.npmjs.org/")

    def test_registry_rebasing_preserves_aliases_and_uses_the_actual_package_name(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "package-lock.json"
            packages = {
                "node_modules/wrap-ansi-cjs": {
                    "name": "wrap-ansi", "version": "7.0.0", "integrity": "sha512-wrap-original",
                    "resolved": "https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-7.0.0.tgz",
                },
                "node_modules/scoped-alias": {
                    "name": "@scope/package", "version": "1.2.3", "integrity": "sha512-scoped-original",
                    "resolved": "https://registry.npmjs.org/@scope/package/-/package-1.2.3.tgz",
                },
            }
            file.write_text(json.dumps({"lockfileVersion": 3, "packages": packages}))
            build.normalize_registry(file, "https://feed.example.test/public/npm/registry/")
            actual = json.loads(file.read_text())
            self.assertEqual(actual["lockfileVersion"], 3)
            self.assertEqual(set(actual["packages"]), set(packages))
            for key, before in packages.items():
                after = actual["packages"][key]
                self.assertEqual({k: v for k, v in after.items() if k != "resolved"},
                                 {k: v for k, v in before.items() if k != "resolved"})
                self.assertEqual(after["resolved"], "https://feed.example.test/public/npm/registry/"
                                 + before["resolved"].removeprefix("https://registry.npmjs.org/"))

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
            if os.name != "nt":
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
