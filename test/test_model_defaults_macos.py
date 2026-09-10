"""Mac first-install defaults orchestration with every native operation mocked."""
from contextlib import contextmanager, ExitStack, redirect_stdout
import base64
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import sys
import tomllib
from types import SimpleNamespace, ModuleType
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/config-new-codey-machine/scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(ROOT / "test"))
from test_model_defaults import fixture, ACTIVE_KEY, OLD_KEY
from codey_node.common import config_defaults, config_files
from codey_node.service.launcher import runtime_files


def key(value):
    return base64.urlsafe_b64encode(bytes([value]) * 32).decode().rstrip("=")


@contextmanager
def mac_fixture():
    with ExitStack() as stack:
        if os.name == "nt":
            # Import-only stand-ins; no fcntl/pwd or native Mac services run on Windows.
            stack.enter_context(patch.dict(sys.modules, {"pwd": ModuleType("pwd"), "fcntl": ModuleType("fcntl")}))
        installer = importlib.import_module("codey_node.platforms.macos.install")
        f = stack.enter_context(fixture(config='model = "old"\n[mcp_servers.keep]\ncommand = "original"\n'))
        uid = os.getuid() if hasattr(os, "getuid") and os.getuid() else 1000
        skill = f.home / "package"
        (skill / "assets").mkdir(parents=True)
        (skill / "templates").mkdir()
        (skill / config_defaults.CATALOG_FILE).write_bytes(config_defaults.catalog(SCRIPTS.parent))
        for relative in runtime_files("macos"):
            target = skill / "scripts" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((SCRIPTS / relative).read_bytes())
        node_id = "n-" + "b" * 24
        manifest = {
            "schema": 1, "platform": "macos-arm64", "node": "24.20.0", "bunBuildTool": "1.4.2",
            "dependencyMode": "install-on-target",
            "nodeDistribution": {"file": "node-v24.20.0-darwin-arm64.tar.gz",
                                 "url": "https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz", "sha256": "d" * 64},
            "artifacts": [],
        }
        for name in ("cloudcli-source.tar.gz", "copilot-api-source.tar.gz", "portal-node-source.tar.gz"):
            data = ("non-deployable fixture " + name).encode()
            (skill / "assets" / name).write_bytes(data)
            manifest["artifacts"].append({"file": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        identity = "\n".join([manifest["node"], manifest["bunBuildTool"], "d" * 64] +
                             [row["sha256"] for row in manifest["artifacts"]])
        manifest["releaseId"] = "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
        setup = {
            "schema": 1, "platform": "macos-arm64", "releaseId": manifest["releaseId"],
            "portalOrigin": "https://codey.example.test",
            "network": {"mode": "devtunnel"}, "tunnelAuthProvider": "github",
        }
        local_identity = {
            "platform": "macos-arm64", "nodeId": node_id,
            "workspaceSubject": "m-" + "f" * 24, "workspaceUsername": "fixture-owner",
            "releaseId": manifest["releaseId"], "portalOrigin": setup["portalOrigin"],
            "network": {"mode": "devtunnel"}, "tunnelAuthProvider": "github",
            "clientSigningKey": key(1), "workspaceSsoKey": key(2),
            "tunnelUpdateKey": key(3), "updaterCredential": key(4),
        }
        for name, value in (("manifest", manifest), ("setup", setup)):
            (skill / "assets" / (name + ".json")).write_text(json.dumps(value))
        tools = f.home / "tools"
        tools.mkdir()
        for name in ("codex", "devtunnel", "openssl"):
            file = tools / name
            file.write_text("non-executable fixture; never run")
            file.chmod(0o700)
        usage = f.home / "usage.key"
        usage.write_text("existing-usage-credential-fixture")
        args = SimpleNamespace(
            apply=False, retry_failed=False, name="Mac fixture", codex_home=str(f.codex), codex_bin=str(tools / "codex"),
            devtunnel_bin=str(tools / "devtunnel"), openssl_bin=str(tools / "openssl"), usage_key_file=str(usage),
            workspace_root=str(f.home), npm_registry="https://registry.npmjs.org/",
            out=f.home / "out/codey-machine-registration.json",
            copilot_api_config=str(f.gateway), model_key_file=None,
        )
        commands = []
        def run(argv, **_kwargs):
            command = [str(value) for value in argv]
            commands.append(command)
            if command[1:] == ["version"]:
                return SimpleNamespace(returncode=0, stdout="OpenSSL 3.0.0 offline-fixture", stderr="")
            if command[:2] == ["launchctl", "print"]:
                return SimpleNamespace(returncode=1, stdout="", stderr="")
            if "-keyout" in command:
                Path(command[command.index("-keyout") + 1]).write_text("private TLS fixture")
                Path(command[command.index("-out") + 1]).write_text("public TLS fixture")
            if command[:2] == ["launchctl", "bootstrap"]:
                self_config = tomllib.loads((f.codex / "config.toml").read_text())
                assert self_config["model"] == "gpt-6-astra"
                assert json.loads(f.gateway.read_text())["useResponsesApiWebSocket"] is False
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")
        def build(manifest, root, release, registry, log, *, skill):
            for relative in ("node/bin/node", "cloudcli/dist-server/server/index.js", "portal-node/node-relay/server.mjs"):
                path = release / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("non-executable fixture")
        stack.enter_context(patch.object(installer, "SKILL", skill))
        stack.enter_context(patch.object(Path, "home", return_value=f.home))
        stack.enter_context(patch.object(sys, "platform", "darwin"))
        stack.enter_context(patch.object(os, "getuid", return_value=uid, create=True))
        stack.enter_context(patch.object(installer.pwd, "getpwuid", return_value=SimpleNamespace(pw_name="fixture-owner"), create=True))
        stack.enter_context(patch.object(config_files, "current_identity", return_value=f.kwargs["owner"].identity))
        stack.enter_context(patch.object(installer.platform, "machine", return_value="arm64"))
        stack.enter_context(patch.object(installer.registration, "existing", return_value=local_identity))
        stack.enter_context(patch.object(installer.registration, "load_or_create", return_value=local_identity))
        stack.enter_context(patch.object(installer, "port_busy", side_effect=lambda port: port == 4141))
        stack.enter_context(patch.object(installer.codex_cli, "require_cli", return_value=tools / "codex"))
        login = stack.enter_context(patch.object(installer.auth, "cli", return_value=SimpleNamespace(
            returncode=0, stdout=json.dumps({"status": "Logged in", "provider": "github", "username": "alice"}))))
        stack.enter_context(patch.object(installer, "run", side_effect=run))
        builder = stack.enter_context(patch.object(installer, "build_runtime", side_effect=build))
        stack.enter_context(patch.object(installer, "token_bound_tunnel", return_value=("codey-" + node_id, "jpe1")))
        portal_renew = stack.enter_context(patch.object(installer.service, "renew"))
        stack.enter_context(patch.object(installer, "connect_token", return_value="header.connect.signature"))
        stack.enter_context(patch.object(installer.service, "private_json", side_effect=lambda path: json.loads(Path(path).read_bytes())))
        stack.enter_context(patch.object(installer.common, "verify", return_value={"mocked": True}))
        stack.enter_context(patch.object(installer, "verify_backend"))
        model = stack.enter_context(patch.object(
            installer.model_test, "codex",
            return_value={"marker": "CODEY_INSTALL_OK", "passed": True},
        ))
        stack.enter_context(patch.dict(os.environ, {"CODEY_MODEL_API_KEY": OLD_KEY}))
        f.module, f.args, f.node_id, f.commands, f.builder, f.login = installer, args, node_id, commands, builder, login
        f.identity, f.portal_renew, f.model = local_identity, portal_renew, model
        f.output = stack.enter_context(redirect_stdout(io.StringIO()))
        yield f


@unittest.skipIf(os.name != "nt" and os.getuid() == 0, "Mac installer tests require a non-root owner")
class MacDefaultsInstallTests(unittest.TestCase):
    def test_plan_contains_explicit_gateway_and_risk_settings_without_any_native_actions(self):
        with mac_fixture() as f:
            before = {str(path): path.read_bytes() for path in f.home.rglob("*") if path.is_file()}
            f.module.configure(f.args)
            plan = json.loads(f.output.getvalue())["plan"]["modelDefaults"]
            self.assertEqual(plan["gatewayConfig"], str(f.gateway))
            self.assertEqual(plan["codexSettings"]["approval_policy"], "never")
            f.builder.assert_not_called()
            f.login.assert_not_called()
            f.model.assert_not_called()
            self.assertTrue(all(command[1:] == ["version"] for command in f.commands))
            self.assertEqual({str(path): path.read_bytes() for path in f.home.rglob("*") if path.is_file()}, before)

    def test_apply_binds_actual_key_preserves_config_and_successful_rerun_remains_verification_only(self):
        with mac_fixture() as f:
            auth_before = (f.codex / "auth.json").read_bytes()
            f.args.apply = True
            f.module.configure(f.args)
            first_result = json.loads(f.output.getvalue())
            self.assertTrue(first_result["realModelCallsTested"])
            self.assertEqual(first_result["modelTest"]["marker"], "CODEY_INSTALL_OK")
            config_root = f.home / ".config/codey-machine-macos" / f.node_id
            runtime = json.loads((config_root / "runtime.json").read_bytes())
            self.assertEqual(runtime["providerEnv"], {"CODEY_MODEL_API_KEY": ACTIVE_KEY})
            self.assertEqual(f.module.service.environment(
                runtime, json.loads((config_root / "registration-secrets.json").read_bytes()))
                             ["CODEY_MODEL_API_KEY"], ACTIVE_KEY)
            self.assertFalse(json.loads(f.gateway.read_bytes())["useResponsesApiWebSocket"])
            parsed = tomllib.loads((f.codex / "config.toml").read_text())
            self.assertEqual(parsed["model"], "gpt-6-astra")
            self.assertEqual(parsed["mcp_servers"], {"keep": {"command": "original"}})
            self.assertEqual((f.codex / "auth.json").read_bytes(), auth_before)
            self.assertEqual(len([command for command in f.commands if command[:2] == ["launchctl", "bootstrap"]]), 5)
            self.assertEqual(f.model.call_count, 1)
            exported = json.loads(Path(f.args.out).read_text())
            self.assertEqual(exported["schema"], 2)
            self.assertEqual(exported["credentials"], f.module.registration.exported_credentials(f.identity))
            f.portal_renew.assert_not_called()
            for secret in (ACTIVE_KEY, OLD_KEY, "private TLS fixture"):
                self.assertNotIn(secret, f.output.getvalue())
                self.assertNotIn(secret, Path(f.args.out).read_text())
            for secret in f.module.registration.exported_credentials(f.identity).values():
                self.assertIn(secret, Path(f.args.out).read_text())
                self.assertNotIn(secret, f.output.getvalue())
            (f.codex / "config.toml").write_text('model = "owner-changed-after-install"\n')
            before = {str(path): path.read_bytes() for path in f.home.rglob("*") if path.is_file()}
            f.commands.clear()
            f.builder.reset_mock()
            f.login.reset_mock()
            with patch.object(config_defaults, "prepare") as prepare:
                f.module.configure(f.args)
                prepare.assert_not_called()
            self.assertEqual(f.model.call_count, 2)
            f.builder.assert_not_called()
            f.login.assert_not_called()
            self.assertEqual(f.commands, [])
            self.assertEqual({str(path): path.read_bytes() for path in f.home.rglob("*") if path.is_file()}, before)

    def test_missing_gateway_config_cannot_apply_or_start_a_service(self):
        with mac_fixture() as f:
            f.args.copilot_api_config = None
            f.module.configure(f.args)
            self.assertTrue(json.loads(f.output.getvalue())["plan"]["modelDefaults"]["requiredActions"])
            f.args.apply = True
            with self.assertRaisesRegex(Exception, "--copilot-api-config"):
                f.module.configure(f.args)
            f.login.assert_not_called()
            f.builder.assert_not_called()
            self.assertTrue(all(command[1:] == ["version"] for command in f.commands))
            self.assertEqual((f.codex / "config.toml").read_text(), 'model = "old"\n[mcp_servers.keep]\ncommand = "original"\n')


if __name__ == "__main__":
    unittest.main()
