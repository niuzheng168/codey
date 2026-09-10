"""Native Linux onboarding tests; all cloud, login and service mutations are mocked."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/config-new-codey-machine/scripts"


sys.path.insert(0, str(SCRIPTS))
from codey_node.platforms.linux import install as installer
from codey_node.devtunnel import auth, binding as tunnels, renewal
from codey_node.common.errors import TunnelError
from codey_node.common import config_defaults
from codey_node.service.launcher import runtime_files

ID = "n-" + "a" * 24


def fixture(root):
    skill, home = root / "skill", root / "home"
    assets = skill / "assets"
    assets.mkdir(parents=True)
    home.mkdir()
    (skill / "dependencies.json").write_bytes((SCRIPTS.parent / "dependencies.json").read_bytes())
    (skill / "templates").mkdir()
    (skill / config_defaults.CATALOG_FILE).write_bytes((SCRIPTS.parent / config_defaults.CATALOG_FILE).read_bytes())
    (skill / "scripts").mkdir()
    for relative in runtime_files("linux"):
        target = skill / "scripts" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((SCRIPTS / relative).read_bytes())
    enrollment = {
        "schema": 1, "nodeId": ID, "principalId": "owner-test", "username": "alice",
        "platform": "linux-x64", "portalOrigin": "https://codey.example.test",
        "expiresAt": int(time.time() * 1000) + 86400000,
        "network": {"mode": "devtunnel"}, "tunnelAuthProvider": "github",
        "clientSigningKey": "a" * 43, "workspaceSsoKey": "b" * 43, "tunnelUpdateKey": "c" * 43,
    }
    manifest = {
        "schema": 1, "platform": "linux-x64", "node": "24.20.0", "bunBuildTool": "1.4.2",
        "dependencyMode": "install-on-target",
        "nodeDistribution": {
            "file": "node-v24.20.0-linux-x64.tar.xz",
            "url": "https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz",
            "sha256": "d" * 64,
        }, "artifacts": [],
    }
    for name in ("cloudcli-source.tar.gz", "copilot-api-source.tar.gz"):
        data = b"non-deployable unit-test source fixture"
        (assets / name).write_bytes(data)
        manifest["artifacts"].append({"file": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    identity = "\n".join([manifest["node"], manifest["bunBuildTool"], "d" * 64] +
                         [item["sha256"] for item in manifest["artifacts"]])
    manifest["releaseId"] = enrollment["releaseId"] = "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
    (assets / "enrollment.json").write_text(json.dumps(enrollment))
    (assets / "manifest.json").write_text(json.dumps(manifest))
    updater = assets / "codey-updater"
    updater.mkdir()
    (updater / "config.json").write_text(json.dumps({
        "nodeId": ID, "ownerId": "owner-test", "username": "alice", "portalOrigin": enrollment["portalOrigin"],
        "protocol": 1, "credential": "e" * 43,
    }))
    for name in ("install.py", "updater.py", "engine.py", "probe.mjs", "UPGRADE.md"):
        (updater / name).write_text("non-deployable fixture")
    executable = home / "devtunnel"
    executable.write_bytes(b"non-executable CLI fixture")
    executable.chmod(0o700)
    codex = home / "codex"
    codex.write_bytes(b"\x7fELF non-executable test fixture")
    codex.chmod(0o700)
    codex_home = home / ".codex"
    codex_home.mkdir()
    (codex_home / "config.toml").write_text('model = "previous"\n[mcp_servers.keep]\ncommand = "preserve"\n')
    (codex_home / "auth.json").write_text('{"credential":"preserve-model-login-fixture"}')
    args = installer.arguments(["--enrollment", str(assets / "enrollment.json"),
                                "--out", str(root / "machine.json"), "--devtunnel-bin", str(executable),
                                "--codex-bin", str(codex), "--codex-home", str(codex_home)])
    network = {"schema": 1, "nodeId": ID, "networkMode": "devtunnel", "listenIp": "127.0.0.1"}
    return SimpleNamespace(skill=skill, home=home, args=args, manifest=manifest,
                           enrollment=enrollment, network=network, executable=executable)


class LinuxContractTests(unittest.TestCase):
    def test_plan_is_default_and_no_network_file_argument_exists(self):
        args = installer.arguments([])
        self.assertFalse(args.apply)
        self.assertFalse(hasattr(args, "network_file"))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            installer.arguments(["--network-file", "must-not-be-consumed"])

    def test_only_native_loopback_github_identity_and_separate_keys_are_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            f = fixture(Path(directory))
            self.assertEqual(len(installer.validate_inputs(f.enrollment, f.manifest, f.network)), 2)
            for changes in ({"network": {"portalSubnetId": "not-consumed"}},
                            {"tunnelAuthProvider": "microsoft"}, {"platform": "windows-x64"},
                            {"tunnelUpdateKey": f.enrollment["clientSigningKey"]}, {"expiresAt": 0}):
                with self.subTest(changes=changes), self.assertRaises(installer.SetupError):
                    installer.validate_inputs({**f.enrollment, **changes}, f.manifest, f.network)
            for changes in ({"listenIp": "0.0.0.0"}, {"listenIp": "10.0.0.7"}, {"networkMode": "private-link"}):
                with self.assertRaises(installer.SetupError):
                    installer.validate_inputs(f.enrollment, f.manifest, {**f.network, **changes})
            installer.validate_inputs({**f.enrollment, "expiresAt": 0}, f.manifest, f.network, ready=True)

    def test_machine_export_has_only_public_binding_not_credentials_or_vm_metadata(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root = Path(directory)
            f = fixture(root)
            cert = root / "leaf.pem"
            cert.write_text("PUBLIC_TEST_CERTIFICATE")
            network = {**f.network, "name": "test", "devTunnel": {"tunnelId": "codey-" + ID, "clusterId": "jpe1"}}
            installer.emit_machine(f.enrollment, network, cert, Path(f.args.out))
            value = json.loads(Path(f.args.out).read_text())
            self.assertEqual(value["platform"], "linux-x64")
            self.assertEqual(value["networkMode"], "devtunnel")
            for field in ("privateIp", "vmResourceId", "clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey", "connectToken"):
                self.assertNotIn(field, value)
            for key in ("clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey"):
                self.assertNotIn(f.enrollment[key], Path(f.args.out).read_text())

    def test_github_is_verified_from_json_not_login_text_or_microsoft(self):
        good = {"status": "Logged in", "provider": "github", "username": "alice"}
        self.assertTrue(auth.github_logged_in(SimpleNamespace(returncode=0, stdout=json.dumps(good))))
        for value in ({**good, "provider": "microsoft"}, {**good, "status": "Not logged in"},
                      {**good, "username": ""}, {}, None, ["github"]):
            self.assertFalse(auth.github_logged_in(SimpleNamespace(returncode=0, stdout=json.dumps(value))))
        for text in ("Logged in as alice using GitHub", "GitHub", "Not logged in", ""):
            self.assertFalse(auth.github_logged_in(SimpleNamespace(returncode=0, stdout=text)))
        result = SimpleNamespace(returncode=0, stdout=json.dumps({**good, "provider": "microsoft"}))
        with patch.object(auth, "cli", return_value=result) as calls, self.assertRaises(TunnelError):
            auth.require_github_login("reviewed-cli")
        self.assertEqual(calls.call_args.args[1], ["user", "show", "--json"])

    def test_shared_binding_supports_linux_and_mac_qualified_ids_without_anonymous_access(self):
        for platform, label in (("linux-x64", "Linux"), ("macos-arm64", "macOS")):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                calls = []
                def runner(arguments, **kwargs):
                    calls.append(arguments)
                    return SimpleNamespace(returncode=0, stdout=json.dumps({
                        "tunnelId": "codey-" + ID + ".jpe1", "description": "Codey " + label + " " + ID, "ports": [],
                    }))
                result = tunnels.ensure_tunnel("cli", {"nodeId": ID, "platform": platform}, directory, runner=runner)
                self.assertEqual(result, {"tunnelId": "codey-" + ID, "clusterId": "jpe1"})
                self.assertEqual(len(calls), 3)
                self.assertNotIn("--allow-anonymous", str(calls))
                self.assertNotIn("--anonymous", str(calls))

    def test_anonymous_existing_tunnel_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            value = {"tunnelId": "codey-" + ID + ".jpe1", "description": "Codey Linux " + ID,
                     "ports": [], "accessControl": {"entries": [{"type": "Anonymous", "isDeny": False}]}}
            with patch.object(auth, "cli", return_value=SimpleNamespace(stdout=json.dumps(value))), self.assertRaises(TunnelError):
                tunnels.ensure_tunnel("cli", {"nodeId": ID, "platform": "linux-x64"}, directory)

    def test_guardian_and_renewal_environment_do_not_export_model_credentials(self):
        unit = installer.unit("test", "/usr/bin/true", "/tmp", "/tmp/test.env", "/usr/bin:/bin")
        for expected in ("Restart=always", "RestartSec=5", "StartLimitIntervalSec=0", "WantedBy=default.target"):
            self.assertIn(expected, unit)
        with patch.dict(os.environ, {"GITHUB_TOKEN": "private", "OPENAI_API_KEY": "private",
                                     "CODEX_THREAD_ID": "private", "HTTPS_PROXY": "http://proxy.test"}):
            env = auth.cli_environment()
            cli_env = auth.cli_environment()
        for key in ("GITHUB_TOKEN", "OPENAI_API_KEY", "CODEX_THREAD_ID"):
            self.assertNotIn(key, env)
            self.assertNotIn(key, cli_env)
        self.assertEqual(env["HTTPS_PROXY"], "http://proxy.test")
        self.assertEqual(cli_env["HTTPS_PROXY"], "http://proxy.test")
        with patch.object(auth.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="{}")):
            calls = []
            def runner(args, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(returncode=0, stdout="{}")
            auth.cli("fixture", ["user", "show", "--json"], runner=runner)
            self.assertNotIn("GITHUB_TOKEN", calls[0]["env"])


@unittest.skipUnless(sys.platform.startswith("linux"), "native Linux transaction tests")
class LinuxTransactionTests(unittest.TestCase):
    @contextlib.contextmanager
    def setup(self, *, existing=False, linger=True, occupied=False, free_bytes=16 * 1024 ** 3):
        with tempfile.TemporaryDirectory() as directory:
            f = fixture(Path(directory))
            calls = []
            def run(args, **kwargs):
                nonlocal linger
                args = [str(arg) for arg in args]
                calls.append(args)
                text = ""
                if args[:2] == ["id", "-un"]:
                    text = "test-owner"
                elif args[:2] == ["loginctl", "show-user"]:
                    text = "yes" if linger else "no"
                elif args[:2] == ["loginctl", "enable-linger"]:
                    linger = True
                elif existing and args[:4] == ["systemctl", "--user", "show", "copilot-api.service"]:
                    text = "/existing/protected/copilot-api.service"
                elif args[0] == "openssl":
                    Path(args[args.index("-keyout") + 1]).write_text("PRIVATE_TEST_CERT_KEY")
                    Path(args[args.index("-out") + 1]).write_text("PUBLIC_TEST_CERTIFICATE")
                return SimpleNamespace(returncode=0, stdout=text, stderr="")
            def build(manifest, enrollment, root, stage, log, *, skill):
                for file in ("node/bin/node", "cloudcli/dist-server/server/index.js", "copilot-api/dist/main.js",
                             "cloudcli/node_modules/@openai/codex/bin/codex.js"):
                    target = stage / file
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("non-executable test fixture")
                (stage / "release.json").write_text(json.dumps(manifest))
            old_mask = os.umask(0o077)
            try:
                with patch.object(installer, "SKILL", f.skill), patch.object(Path, "home", return_value=f.home), \
                     patch.object(installer.codex_cli, "version", return_value="codex-cli 0.146.0"), \
                     patch.object(installer.socket, "socket") as socket_factory, \
                     patch.object(installer.shutil, "disk_usage", return_value=SimpleNamespace(free=free_bytes)), \
                     patch.object(installer, "run", side_effect=run), \
                     patch.object(installer, "prepare_runtime", side_effect=build) as builder, \
                     patch.object(installer, "verify", return_value={"usage": False, "tokenUsage": True, "warnings": ["quota unavailable"]}), \
                     patch.object(installer.cli, "prepare_cli", return_value=f.executable) as cli, \
                     patch.object(auth, "require_github_login") as login, \
                     patch.object(tunnels, "ensure_tunnel", return_value={"tunnelId": "codey-" + ID, "clusterId": "jpe1"}) as create, \
                     patch.object(renewal, "renew", return_value={"ok": True}), \
                     contextlib.redirect_stdout(io.StringIO()):
                    socket_factory.return_value.__enter__.return_value.bind.side_effect = (
                        OSError("occupied test listener") if occupied else None)
                    f.calls, f.builder, f.cli, f.login, f.create = calls, builder, cli, login, create
                    yield f
            finally:
                os.umask(old_mask)

    def test_plan_does_not_download_login_create_files_or_services(self):
        with self.setup() as f:
            installer.configure(f.args)
            f.builder.assert_not_called()
            f.cli.assert_not_called()
            f.login.assert_not_called()
            f.create.assert_not_called()
            self.assertFalse((f.home / ".config/codey-machine").exists())
            self.assertFalse(any("enable" in call for call in f.calls))

    def test_existing_services_are_not_taken_over(self):
        with self.setup(existing=True) as f:
            f.args.apply = True
            with self.assertRaises(installer.SetupError):
                installer.configure(f.args)
            f.cli.assert_not_called()
            self.assertFalse(any("stop" in call or "disable" in call for call in f.calls))

    def test_occupied_ports_fail_before_any_download_or_takeover(self):
        with self.setup(occupied=True) as f:
            f.args.apply = True
            with self.assertRaisesRegex(installer.SetupError, "occupied or not local"):
                installer.configure(f.args)
            f.cli.assert_not_called()
            f.builder.assert_not_called()
            self.assertFalse(any("stop" in call or "disable" in call for call in f.calls))

    def test_insufficient_disk_fails_before_any_download_or_service_start(self):
        with self.setup(free_bytes=1024 ** 3) as f:
            f.args.apply = True
            with self.assertRaisesRegex(installer.SetupError, "8 GiB"):
                installer.configure(f.args)
            f.cli.assert_not_called()
            f.builder.assert_not_called()
            self.assertFalse(any("enable" in call for call in f.calls))

    def test_unknown_runtime_and_reused_updater_key_fail_before_actions(self):
        with self.setup() as f:
            root = f.home / ".local/share/codey-machine"
            root.mkdir(parents=True)
            (root / "unrelated.txt").write_text("preserve")
            with self.assertRaisesRegex(installer.SetupError, "unrecognized Codey runtime"):
                installer.configure(f.args)
            f.cli.assert_not_called()
            self.assertEqual((root / "unrelated.txt").read_text(), "preserve")
        with self.setup() as f:
            file = f.skill / "assets/codey-updater/config.json"
            config = json.loads(file.read_text())
            config["credential"] = f.enrollment["tunnelUpdateKey"]
            file.write_text(json.dumps(config))
            with self.assertRaisesRegex(installer.SetupError, "updater bootstrap"):
                installer.configure(f.args)
            f.cli.assert_not_called()

    def test_boot_autostart_requires_linger_approval_before_installation(self):
        with self.setup(linger=False) as f:
            f.args.apply = True
            with self.assertRaisesRegex(installer.SetupError, "Boot autostart"):
                installer.configure(f.args)
            f.cli.assert_not_called()
            self.assertFalse((f.home / ".config/codey-machine").exists())

    def test_explicit_linger_is_enabled_only_when_missing_and_before_services(self):
        for already_enabled in (False, True):
            with self.subTest(already_enabled=already_enabled), self.setup(linger=already_enabled) as f:
                f.args.apply = f.args.enable_linger = True
                installer.configure(f.args)
                enabled = [i for i, call in enumerate(f.calls) if call[:2] == ["loginctl", "enable-linger"]]
                self.assertEqual(len(enabled), 0 if already_enabled else 1)
                if enabled:
                    first_start = next(i for i, call in enumerate(f.calls) if call[:4] == ["systemctl", "--user", "enable", "--now"])
                    self.assertLess(enabled[0], first_start)

    def test_github_login_failure_precedes_runtime_or_service_mutations(self):
        with self.setup() as f:
            f.args.apply = True
            f.login.side_effect = TunnelError("wrong-provider")
            with self.assertRaisesRegex(installer.SetupError, "--github --use-device-code-auth"):
                installer.configure(f.args)
            f.builder.assert_not_called()
            f.create.assert_not_called()
            self.assertFalse((f.home / ".config/codey-machine").exists())

    def test_success_has_supervision_timer_and_idempotent_verification(self):
        with self.setup() as f:
            f.args.apply = True
            with patch.dict(os.environ, {"CODEY_MODEL_API_KEY": "do-not-copy-old-shell-key"}):
                installer.configure(f.args)
            config = f.home / ".config/codey-machine"
            self.assertTrue(json.loads((config / "installation.json").read_text())["ready"])
            gateway = json.loads((f.home / ".local/share/codey-machine/data/copilot-api/config.json").read_text())
            self.assertFalse(gateway["useResponsesApiWebSocket"])
            self.assertEqual(len(gateway["auth"]["apiKeys"]), 1)
            self.assertNotIn("do-not-copy-old-shell-key", gateway["auth"]["apiKeys"])
            self.assertIn("CODEY_MODEL_API_KEY=" + json.dumps(gateway["auth"]["apiKeys"][0]), (config / "provider.env").read_text())
            self.assertIn("CODEX_HOME=" + f.args.codex_home, (config / "cloudcli.env").read_text())
            codex_config = tomllib.loads((Path(f.args.codex_home) / "config.toml").read_text())
            self.assertEqual(codex_config["model"], "gpt-6-astra")
            self.assertEqual(codex_config["mcp_servers"], {"keep": {"command": "preserve"}})
            self.assertEqual((Path(f.args.codex_home) / "auth.json").read_text(), '{"credential":"preserve-model-login-fixture"}')
            units = f.home / ".config/systemd/user"
            for name in ("codey-copilot-api.service", "codey-cloudcli.service", "codey-devtunnel.service"):
                text = (units / name).read_text()
                self.assertIn("Restart=always", text)
                self.assertIn("WantedBy=default.target", text)
            renew = (units / "codey-devtunnel-renew.service").read_text()
            self.assertIn("Type=oneshot", renew)
            self.assertNotIn("Restart=always", renew)
            self.assertIn("OnUnitInactiveSec=300", (units / "codey-devtunnel-renew.timer").read_text())
            before = len(f.calls)
            f.builder.reset_mock()
            f.create.reset_mock()
            with patch.object(config_defaults, "prepare") as defaults_prepare:
                installer.configure(f.args)
                defaults_prepare.assert_not_called()
            self.assertEqual(len(f.calls), before)
            f.builder.assert_not_called()
            f.create.assert_not_called()

    def test_failure_only_disables_new_services_and_never_marks_ready(self):
        with self.setup() as f:
            f.args.apply = True
            with patch.object(installer, "emit_machine", side_effect=OSError("test export failure")), self.assertRaises(OSError):
                installer.configure(f.args)
            state = json.loads((f.home / ".config/codey-machine/installation.json").read_text())
            self.assertFalse(state["ready"])
            stopped = [call[-1] for call in f.calls if call[:4] == ["systemctl", "--user", "disable", "--now"]]
            self.assertIn("codey-devtunnel.service", stopped)
            self.assertIn("codey-node-updater.service", stopped)
            self.assertNotIn("copilot-api.service", stopped)

    @unittest.skipUnless(shutil.which("systemd-analyze"), "systemd parser required")
    def test_native_systemd_accepts_the_guardian_unit(self):
        runtime = Path(os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}")
        if not runtime.is_dir() or runtime.stat().st_uid != os.getuid():
            self.skipTest("systemd verification requires this owner's runtime directory")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = root / "service.env"
            env.write_text("")
            service = root / "codey-skill-test.service"
            service.write_text(installer.unit("Codey test only", "/usr/bin/true", root, env, "/usr/bin:/bin"))
            result = subprocess.run(["systemd-analyze", "--user", "verify", str(service)],
                                    text=True, capture_output=True, timeout=20,
                                    env={**os.environ, "XDG_RUNTIME_DIR": str(runtime)})
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
