"""Native Linux onboarding tests; all cloud, login and service mutations are mocked."""
import base64
from concurrent.futures import ThreadPoolExecutor
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills/config-new-codey-machine/scripts"


sys.path.insert(0, str(SCRIPTS))
from codey_node.platforms.linux import install as installer  # noqa: E402
from codey_node.platforms.linux import codex_process, login  # noqa: E402
from codey_node.devtunnel import auth, binding as tunnels, renewal  # noqa: E402
from codey_node.common.errors import SetupError, TunnelError  # noqa: E402
from codey_node.common import config_defaults, registration  # noqa: E402
from codey_node.service.launcher import runtime_files  # noqa: E402

ID = "n-" + "a" * 24


def key(value):
    return base64.urlsafe_b64encode(bytes([value]) * 32).decode().rstrip("=")


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
    identity = {
        "nodeId": ID, "workspaceSubject": "m-" + "f" * 24, "workspaceUsername": "alice",
        "platform": "linux-x64", "portalOrigin": "https://codey.example.test",
        "network": {"mode": "devtunnel"}, "tunnelAuthProvider": "github",
        "clientSigningKey": key(1), "workspaceSsoKey": key(2),
        "tunnelUpdateKey": key(3), "updaterCredential": key(4),
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
    release_identity = "\n".join([manifest["node"], manifest["bunBuildTool"], "d" * 64] +
                                 [item["sha256"] for item in manifest["artifacts"]])
    manifest["releaseId"] = "machine-" + hashlib.sha256(release_identity.encode()).hexdigest()[:16]
    setup = {
        "schema": 1, "portalOrigin": "https://codey.example.test",
        "releaseId": manifest["releaseId"], "platform": "linux-x64",
        "network": {"mode": "devtunnel"}, "tunnelAuthProvider": "github",
        "updater": {"protocol": 1, "releasePublicKey": "PUBLIC RELEASE KEY FIXTURE"},
    }
    identity["releaseId"] = manifest["releaseId"]
    (assets / "setup.json").write_text(json.dumps(setup))
    (assets / "manifest.json").write_text(json.dumps(manifest))
    updater = assets / "codey-updater"
    updater.mkdir()
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
    args = installer.arguments(["--out", str(root / "registration.json"), "--devtunnel-bin", str(executable),
                                "--codex-bin", str(codex), "--codex-home", str(codex_home)])
    network = {"schema": 1, "nodeId": ID, "networkMode": "devtunnel", "listenIp": "127.0.0.1"}
    return SimpleNamespace(skill=skill, home=home, args=args, manifest=manifest,
                           setup=setup, identity=identity, network=network, executable=executable)


class LinuxContractTests(unittest.TestCase):
    def test_plan_is_default_and_no_network_file_argument_exists(self):
        args = installer.arguments([])
        self.assertFalse(args.apply)
        self.assertFalse(hasattr(args, "network_file"))
        self.assertFalse(hasattr(args, "enrollment"))
        self.assertEqual(Path(args.out).name, "codey-machine-registration.json")
        self.assertEqual(Path(args.out).parent, Path.home())
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            installer.arguments(["--network-file", "must-not-be-consumed"])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            installer.arguments(["--enrollment", "legacy-must-not-be-consumed"])

    def test_static_setup_is_exact_and_matches_the_runtime_release(self):
        with tempfile.TemporaryDirectory() as directory:
            f = fixture(Path(directory))
            self.assertEqual(registration.load_setup(f.skill, "linux-x64"), f.setup)
            self.assertEqual(len(installer.validate_inputs(f.setup, f.manifest)), 2)
            setup_file = f.skill / "assets/setup.json"
            for changes in (
                {"network": {"mode": "vnet"}},
                {"tunnelAuthProvider": "microsoft"},
                {"platform": "windows-x64"},
                {"nodeId": ID},
                {"updater": {"protocol": 1}},
            ):
                with self.subTest(changes=changes):
                    setup_file.write_text(json.dumps({**f.setup, **changes}))
                    with self.assertRaises(SetupError):
                        registration.load_setup(f.skill, "linux-x64")
            setup_file.write_text(json.dumps(f.setup))
            with self.assertRaises(SetupError):
                installer.validate_inputs(
                    {**f.setup, "releaseId": "machine-" + "0" * 16}, f.manifest,
                )

    def test_legacy_personalized_assets_are_rejected_even_when_setup_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            f = fixture(Path(directory))
            for relative in ("enrollment.json", "codey-updater/config.json"):
                with self.subTest(relative=relative):
                    file = f.skill / "assets" / relative
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_text('{"legacy":"secret"}')
                    with self.assertRaisesRegex(SetupError, "Legacy personalized package rejected"):
                        registration.load_setup(f.skill, "linux-x64")
                    file.unlink()

    def test_local_credentials_are_random_distinct_private_and_stable_for_rerun(self):
        with tempfile.TemporaryDirectory() as directory:
            f = fixture(Path(directory))
            first = registration.load_or_create(f.home, f.setup, username="alice")
            second = registration.load_or_create(f.home, f.setup, username="alice")
            self.assertEqual(first, second)
            self.assertRegex(first["nodeId"], r"^n-[a-f0-9]{24}$")
            self.assertRegex(first["workspaceSubject"], r"^m-[a-f0-9]{24}$")
            self.assertEqual(first["workspaceUsername"], "alice")
            keys = [first[name] for name in registration.KEY_NAMES]
            self.assertEqual(len(set(keys)), 4)
            for key in keys:
                self.assertRegex(key, r"^[A-Za-z0-9_-]{43}$")
            private = registration.state_path(f.home, f.setup)
            self.assertTrue(private.is_file())
            if os.name == "posix":
                self.assertEqual(private.stat().st_mode & 0o777, 0o600)
                self.assertEqual(private.parent.stat().st_mode & 0o777, 0o700)
            other = f.home.parent / "other-home"
            other.mkdir()
            third = registration.load_or_create(other, f.setup, username="alice")
            self.assertNotEqual(first["nodeId"], third["nodeId"])
            self.assertTrue(set(keys).isdisjoint(third[name] for name in registration.KEY_NAMES))

    def test_concurrent_identity_creation_converges_on_one_complete_record(self):
        with tempfile.TemporaryDirectory() as directory:
            f = fixture(Path(directory))
            with ThreadPoolExecutor(max_workers=8) as executor:
                identities = list(executor.map(
                    lambda _: registration.load_or_create(f.home, f.setup, username="alice"),
                    range(16),
                ))
            self.assertTrue(all(identity == identities[0] for identity in identities))
            self.assertEqual(registration.existing(f.home, f.setup), identities[0])
            self.assertFalse(list(registration.state_path(f.home, f.setup).parent.glob("*.next")))

    @unittest.skipIf(os.name == "nt", "Windows symlink creation requires optional privileges")
    def test_local_identity_state_cannot_escape_home_through_an_ancestor_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            f = fixture(Path(directory))
            outside = f.home.parent / "outside-state"
            outside.mkdir()
            (f.home / ".local").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(SetupError, "inside the owner Home"):
                registration.load_or_create(f.home, f.setup, username="alice")

    def test_portal_username_rule_is_enforced_for_all_platforms(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for platform_name in ("linux-x64", "windows-x64", "macos-arm64", "macos-x64"):
                setup = {
                    "schema": 1,
                    "portalOrigin": "https://codey.example.test",
                    "releaseId": "machine-" + "a" * 16,
                    "platform": platform_name,
                    "network": {"mode": "devtunnel"},
                    "tunnelAuthProvider": "github",
                    **({"updater": {"protocol": 1, "releasePublicKey": "public"}}
                       if platform_name == "linux-x64" else {}),
                }
                home = root / platform_name
                home.mkdir()
                with self.subTest(platform=platform_name), self.assertRaisesRegex(
                        SetupError, "current OS username must match"):
                    registration.load_or_create(home, setup, username="Uppercase User")

    def test_noncanonical_base64url_registration_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            f = fixture(Path(directory))
            registration.load_or_create(f.home, f.setup, username="alice")
            file = registration.state_path(f.home, f.setup)
            saved = json.loads(file.read_text())
            saved["credentials"]["clientSigningKey"] = "A" * 43
            saved["credentials"]["workspaceSsoKey"] = "A" * 42 + "B"
            file.write_text(json.dumps(saved))
            with self.assertRaisesRegex(SetupError, "key is invalid"):
                registration.existing(f.home, f.setup)

    def test_official_standalone_codex_app_server_is_recognized(self):
        home = Path("/home/alice")
        executable = home / ".codex/packages/standalone/releases/0.200.0-linux-x64/bin/codex"
        self.assertTrue(codex_process.recognized(home, executable, [str(executable), "app-server"]))

    def test_registration_export_has_exact_schema_private_credentials_and_public_machine(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root = Path(directory)
            f = fixture(root)
            cert = root / "leaf.pem"
            cert.write_text("PUBLIC_TEST_CERTIFICATE")
            network = {**f.network, "name": "test", "devTunnel": {"tunnelId": "codey-" + ID, "clusterId": "jpe1"}}
            token = "header.connect-only.signature"
            installer.emit_registration(
                f.setup, f.identity, network, cert, Path(f.args.out), token,
            )
            value = json.loads(Path(f.args.out).read_text())
            self.assertEqual(
                set(value),
                {"schema", "package", "machine", "credentials", "devTunnelConnectToken"},
            )
            self.assertEqual(value["schema"], 2)
            self.assertEqual(value["package"], registration.package_fields(f.setup))
            self.assertEqual(value["credentials"], registration.exported_credentials(f.identity))
            self.assertEqual(value["devTunnelConnectToken"], token)
            self.assertEqual(value["machine"]["schema"], 1)
            self.assertEqual(value["machine"]["platform"], "linux-x64")
            self.assertEqual(value["machine"]["networkMode"], "devtunnel")
            self.assertNotIn("credentials", value["machine"])
            self.assertNotIn("devTunnelConnectToken", value["machine"])
            if os.name == "posix":
                self.assertEqual(Path(f.args.out).stat().st_mode & 0o777, 0o600)
            with patch.object(installer, "SKILL", f.skill), \
                    self.assertRaisesRegex(SetupError, "outside the reusable Skill"):
                installer.emit_registration(
                    f.setup, f.identity, network, cert,
                    f.skill / "output/codey-machine-registration.json", token,
                )

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

    def test_devtunnel_device_login_is_github_only_and_rechecked(self):
        calls = []

        def runner(args, **kwargs):
            calls.append((args, kwargs))
            if args[1:4] == ["user", "login", "--github"]:
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            logged_in = len(calls) > 2
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps({
                    "status": "Logged in" if logged_in else "Not logged in",
                    "provider": "github" if logged_in else "",
                    "username": "alice" if logged_in else "",
                }),
                stderr="",
            )

        with contextlib.redirect_stdout(io.StringIO()):
            result = auth.login_github_device("/home/alice/devtunnel", runner=runner)
        self.assertEqual(result, {"action": "login", "provider": "github"})
        self.assertEqual(calls[1][0], [
            "/home/alice/devtunnel", "user", "login", "--github", "--use-device-code-auth",
        ])
        self.assertNotIn("GITHUB_TOKEN", calls[1][1]["env"])

    def test_connect_token_is_issued_locally_without_a_portal_request(self):
        payload = base64.urlsafe_b64encode(json.dumps({
            "tunnelId": "codey-" + ID,
            "clusterId": "jpe1",
            "scp": "connect",
            "exp": 2_000_000_000,
        }).encode()).decode().rstrip("=")
        token = "e30." + payload + ".fixture"
        calls = []

        def runner(arguments, **_kwargs):
            calls.append(arguments)
            return SimpleNamespace(returncode=0, stdout=json.dumps({"token": token}), stderr="")

        config = {
            "nodeId": ID,
            "tunnelId": "codey-" + ID,
            "clusterId": "jpe1",
            "tunnelAuthProvider": "github",
            "devtunnelExe": "/reviewed/devtunnel",
        }
        with patch.object(auth, "require_github_login") as logged_in:
            self.assertEqual(renewal.connect_token(config, runner=runner, now=1_000), token)
        logged_in.assert_called_once_with("/reviewed/devtunnel", runner=runner)
        self.assertEqual(calls, [[
            "/reviewed/devtunnel", "token", "codey-" + ID + ".jpe1",
            "--scope", "connect", "--json",
        ]])

    def test_shell_hook_loads_provider_env_without_copying_its_key(self):
        provider = Path("/home/alice/.config/codey-machine/provider.env")
        original = "# preserve existing profile\n"
        updated = login.patch(original, provider)
        self.assertIn(original.strip(), updated)
        self.assertIn(f". '{provider}'", updated)
        self.assertIn("export CODEY_MODEL_API_KEY", updated)
        self.assertEqual(updated.count(login.START), 1)
        self.assertEqual(login.patch(updated, provider), updated)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux /proc path semantics required")
    def test_codex_process_recognition_is_limited_to_owner_app_servers(self):
        home = Path("/home/alice")
        wrapper = home / ".local/lib/node_modules/@openai/codex/bin/codex.js"
        native = home / (".local/lib/node_modules/@openai/codex/node_modules/@openai/"
                         "codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex")
        self.assertTrue(codex_process.recognized(home, Path("/usr/bin/node"),
                                                ["/usr/bin/node", str(wrapper), "app-server"]))
        self.assertTrue(codex_process.recognized(home, native, [str(native), "app-server"]))
        self.assertFalse(codex_process.recognized(home, native, [str(native), "exec"]))
        self.assertFalse(codex_process.recognized(home, Path("/opt/other/codex"),
                                                 ["/opt/other/codex", "app-server"]))

@unittest.skipUnless(sys.platform.startswith("linux"), "native Linux transaction tests")
class LinuxTransactionTests(unittest.TestCase):
    @contextlib.contextmanager
    def setup(self, *, existing=False, linger=True, occupied=False, free_bytes=16 * 1024 ** 3):
        with tempfile.TemporaryDirectory() as directory:
            f = fixture(Path(directory))
            calls = []
            service_dir = f.home / ".config/systemd/user"
            legacy_specs = {
                "copilot-api.service": (True, 4242, "/legacy/copilot-api"),
                "copilot-api-update.service": (False, 0, "/legacy/copilot-api-update"),
                "copilot-api-update.timer": (True, 0, None),
                "codey-cloudcli.service": (True, 4343, "/legacy/cloudcli"),
                "codey-node-updater.service": (True, 4444, "/legacy/codey-updater"),
            }
            service_states, legacy_units = {}, {}
            if existing:
                service_dir.mkdir(parents=True)
                for name, (active, pid, executable) in legacy_specs.items():
                    unit = service_dir / name
                    unit.write_text(("[Timer]\nOnCalendar=daily\n" if executable is None else
                                     f"[Service]\nExecStart={executable}\n"))
                    legacy_units[name] = unit
                    service_states[name] = {"active": active, "pid": pid, "enabled": True}
            def run(args, **kwargs):
                nonlocal linger
                args = [str(arg) for arg in args]
                calls.append(args)
                text = ""
                if args[:2] == ["id", "-un"]:
                    text = "alice"
                elif args[:2] == ["loginctl", "show-user"]:
                    text = "yes" if linger else "no"
                elif args[:2] == ["loginctl", "enable-linger"]:
                    linger = True
                elif args[:3] == ["systemctl", "--user", "show"]:
                    name = args[3]
                    if name in service_states:
                        state = service_states[name]
                        text = "\n".join([
                            "Id=" + name, "LoadState=loaded",
                            "ActiveState=" + ("active" if state["active"] else "inactive"),
                            "MainPID=" + str(state["pid"]),
                            "FragmentPath=" + str(legacy_units[name]), "DropInPaths=", "",
                        ])
                    else:
                        text = "\n".join([
                            "Id=" + name, "LoadState=not-found", "ActiveState=inactive",
                            "MainPID=0", "FragmentPath=", "DropInPaths=", "",
                        ])
                elif args[:4] == ["systemctl", "--user", "disable", "--now"]:
                    if args[-1] in service_states:
                        service_states[args[-1]].update(active=False, pid=0, enabled=False)
                elif args[:4] == ["systemctl", "--user", "enable", "--now"]:
                    name = args[-1]
                    unit = service_dir / name
                    legacy_units[name] = unit
                    service_states[name] = {
                        "active": True,
                        "pid": 0 if name.endswith(".timer") else 5000,
                        "enabled": True,
                    }
                elif args[:3] == ["systemctl", "--user", "restart"]:
                    if args[-1] in service_states:
                        service_states[args[-1]]["active"] = True
                elif args[:3] == ["systemctl", "--user", "is-enabled"]:
                    text = "enabled" if service_states.get(args[-1], {}).get("enabled") else "disabled"
                elif args[:3] == ["systemctl", "--user", "is-active"]:
                    text = "active" if service_states.get(args[-1], {}).get("active") else "inactive"
                elif len(args) > 1 and args[1].endswith("codey-updater/install.py"):
                    name = "codey-node-updater.service"
                    unit = service_dir / name
                    unit.parent.mkdir(parents=True, exist_ok=True)
                    unit.write_text("# Managed by Codey node updater\n[Service]\nExecStart=/fixture/updater\n")
                    legacy_units[name] = unit
                    service_states[name] = {"active": True, "pid": 5001, "enabled": True}
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
                codex_plan = SimpleNamespace(
                    executable=Path(f.args.codex_bin),
                    report=lambda: {
                        "action": "update", "release": "latest",
                        "targetExecutable": str(Path(f.args.codex_bin)),
                    },
                    apply=Mock(return_value={
                        "applied": True, "version": "0.999.0", "stoppedProcesses": [],
                    }),
                )
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(installer, "SKILL", f.skill))
                    stack.enter_context(patch.object(Path, "home", return_value=f.home))
                    stack.enter_context(patch.object(installer.registration, "existing", return_value=f.identity))
                    stack.enter_context(patch.object(installer.registration, "load_or_create", return_value=f.identity))
                    codex_prepare = stack.enter_context(
                        patch.object(installer.codex_latest, "prepare", return_value=codex_plan))
                    socket_factory = stack.enter_context(patch.object(installer.socket, "socket"))
                    stack.enter_context(patch.object(
                        installer.shutil, "disk_usage", return_value=SimpleNamespace(free=free_bytes)))
                    stack.enter_context(patch.object(installer, "run", side_effect=run))
                    builder = stack.enter_context(patch.object(installer, "prepare_runtime", side_effect=build))
                    stack.enter_context(patch.object(
                        installer, "verify",
                        return_value={"usage": False, "tokenUsage": True, "warnings": ["quota unavailable"]},
                    ))
                    cli = stack.enter_context(patch.object(
                        installer.cli, "prepare_cli", return_value=f.executable))
                    login = stack.enter_context(patch.object(auth, "require_github_login"))
                    stack.enter_context(patch.object(
                        installer.copilot_api, "login",
                        return_value={"action": "login", "provider": "github-copilot"},
                    ))
                    stack.enter_context(patch.object(
                        installer.copilot_api, "wait_ready", return_value={"modelsStatus": 200}))
                    stack.enter_context(patch.object(
                        installer.codex_latest, "test_model",
                        return_value={"marker": "CODEY_INSTALL_OK", "passed": True},
                    ))
                    create = stack.enter_context(patch.object(
                        tunnels, "ensure_tunnel",
                        return_value={"tunnelId": "codey-" + ID, "clusterId": "jpe1"},
                    ))
                    connect_token = stack.enter_context(patch.object(
                        renewal, "connect_token", return_value="header.connect-only.signature"))
                    portal_renew = stack.enter_context(patch.object(renewal, "renew"))
                    output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                    def bind(_address):
                        if occupied or any(state["active"] and state["pid"] for state in service_states.values()):
                            raise OSError("occupied test listener")
                    socket_factory.return_value.__enter__.return_value.bind.side_effect = bind
                    f.calls, f.builder, f.cli, f.login, f.create = calls, builder, cli, login, create
                    f.connect_token, f.portal_renew = connect_token, portal_renew
                    f.codex_plan, f.codex_prepare = codex_plan, codex_prepare
                    f.output, f.legacy_units, f.service_states = output, legacy_units, service_states
                    f.legacy_unit = legacy_units.get("copilot-api.service", service_dir / "copilot-api.service")
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

    def test_existing_services_are_automatically_planned_for_replacement(self):
        with self.setup(existing=True) as f:
            installer.configure(f.args)
            plan = json.loads(f.output.getvalue())
            self.assertTrue(plan["replacement"]["detected"])
            self.assertFalse(any("stop" in call or "disable" in call for call in f.calls))

    def test_replacement_rejects_a_linked_or_external_unit_file(self):
        with self.setup(existing=True) as f:
            external = f.home / "external-copilot-api.service"
            external.write_text("[Service]\nExecStart=/unknown/copilot-api\n")
            f.legacy_unit.unlink()
            f.legacy_unit.symlink_to(external)
            with self.assertRaisesRegex(installer.SetupError, "not an ordinary unit owned by this user"):
                installer.configure(f.args)
            self.assertFalse(any("stop" in call or "disable" in call for call in f.calls))

    def test_replacement_plan_is_read_only_and_apply_archives_only_codey_paths(self):
        process = {"pid": 9191, "start": "123", "executable": "/home/test/codex"}
        with self.setup(existing=True) as f, \
                patch.object(installer.replacement.codex_process, "inspect",
                             side_effect=[[process], [process], [process], []]), \
                patch.object(installer.replacement.codex_process, "stop", return_value=[9191]) as stop:
            root = f.home / ".local/share/codey-machine"
            config = f.home / ".config/codey-machine"
            root.mkdir(parents=True)
            config.mkdir(parents=True)
            (root / "old-runtime.txt").write_text("preserve old runtime")
            (config / "old-config.txt").write_text("preserve old config")
            legacy_copilot = f.home / ".local/share/copilot-api"
            legacy_cloudcli_config = f.home / ".config/codey-cloudcli"
            legacy_copilot.mkdir()
            legacy_cloudcli_config.mkdir()
            (legacy_copilot / "config.json").write_text('{"legacy":"credential-bearing config"}')
            (legacy_cloudcli_config / "service.env").write_text("LEGACY_CONFIG=preserve\n")
            codex_home = Path(f.args.codex_home)
            sessions = codex_home / "sessions"
            sessions.mkdir()
            session = sessions / "original.jsonl"
            session.write_text('{"preserve":"session"}\n')
            auth_before = (codex_home / "auth.json").read_bytes()
            session_before = session.read_bytes()
            installer.configure(f.args)
            plan = json.loads(f.output.getvalue())
            self.assertTrue(plan["replacement"]["detected"])
            self.assertEqual(plan["replacement"]["occupiedPorts"], [3001, 8443, 4141])
            self.assertEqual(plan["replacement"]["codexProcesses"], [process])
            self.assertEqual(plan["modelDefaults"]["mode"],
                             "fresh defaults will be prepared after the existing installation is archived")
            self.assertFalse(any(call[:4] == ["systemctl", "--user", "disable", "--now"] for call in f.calls))
            self.assertTrue(f.legacy_unit.exists())
            f.output.seek(0)
            f.output.truncate(0)
            f.args.apply = True
            installer.configure(f.args)
            backups = list((f.home / ".local/state/codey-service-backups").iterdir())
            self.assertEqual(len(backups), 1)
            backup = backups[0]
            self.assertEqual((backup / "runtime/old-runtime.txt").read_text(), "preserve old runtime")
            self.assertEqual((backup / "config/old-config.txt").read_text(), "preserve old config")
            self.assertEqual((backup / "previous-copilot-api-runtime/config.json").read_text(),
                             '{"legacy":"credential-bearing config"}')
            self.assertEqual((backup / "previous-cloudcli-config/service.env").read_text(),
                             "LEGACY_CONFIG=preserve\n")
            self.assertEqual((backup / "units/copilot-api.service").read_text(),
                             "[Service]\nExecStart=/legacy/copilot-api\n")
            self.assertEqual((backup / "units/codey-node-updater.service").read_text(),
                             "[Service]\nExecStart=/legacy/codey-updater\n")
            self.assertEqual((backup / "units/copilot-api-update.timer").read_text(),
                             "[Timer]\nOnCalendar=daily\n")
            self.assertTrue((backup / "replacement.json").is_file())
            self.assertTrue(json.loads((f.home / ".config/codey-machine/installation.json").read_text())["ready"])
            stopped = {call[-1] for call in f.calls
                       if call[:4] == ["systemctl", "--user", "disable", "--now"]}
            self.assertTrue({"copilot-api.service", "copilot-api-update.service",
                             "copilot-api-update.timer", "codey-cloudcli.service",
                             "codey-node-updater.service"}.issubset(stopped))
            for name in ("copilot-api.service", "copilot-api-update.service", "copilot-api-update.timer"):
                self.assertFalse(f.service_states[name]["active"])
            for name in ("codey-copilot-api.service", "codey-cloudcli.service",
                         "codey-devtunnel.service", "codey-devtunnel-renew.timer",
                         "codey-node-updater.service"):
                self.assertTrue(f.service_states[name]["active"])
            stop.assert_called_once_with(f.home, [process])
            self.assertEqual((codex_home / "auth.json").read_bytes(), auth_before)
            self.assertEqual(session.read_bytes(), session_before)
            codex_config = tomllib.loads((codex_home / "config.toml").read_text())
            self.assertEqual(codex_config["mcp_servers"]["keep"]["command"], "preserve")
            self.assertEqual(codex_config["model_provider"], "copilot_api")

    def test_occupied_ports_fail_before_any_download_or_replacement(self):
        with self.setup(occupied=True) as f:
            f.args.apply = True
            with self.assertRaisesRegex(installer.SetupError, "unknown process"):
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

    def test_existing_runtime_is_planned_for_archive_and_bundled_updater_config_is_rejected(self):
        with self.setup() as f:
            root = f.home / ".local/share/codey-machine"
            root.mkdir(parents=True)
            (root / "unrelated.txt").write_text("preserve")
            installer.configure(f.args)
            plan = json.loads(f.output.getvalue())
            self.assertTrue(plan["replacement"]["detected"])
            self.assertIn(str(root), [row["path"] for row in plan["replacement"]["archivePaths"]])
            self.assertEqual((root / "unrelated.txt").read_text(), "preserve")
        with self.setup() as f:
            file = f.skill / "assets/codey-updater/config.json"
            file.write_text('{"legacy":"private"}')
            with self.assertRaisesRegex(installer.SetupError, "Legacy personalized package rejected"):
                installer.configure(f.args)
            f.cli.assert_not_called()

    def test_boot_autostart_enables_linger_automatically(self):
        with self.setup(linger=False) as f:
            f.args.apply = True
            installer.configure(f.args)
            self.assertTrue(any(call[:2] == ["loginctl", "enable-linger"] for call in f.calls))
            self.assertTrue((f.home / ".config/codey-machine").exists())

    def test_existing_bash_login_profile_receives_the_model_environment_hook(self):
        with self.setup() as f:
            profile = f.home / ".bash_profile"
            profile.write_text("# existing login profile\n")
            f.args.apply = True
            installer.configure(f.args)
            self.assertIn(login.START, profile.read_text())
            self.assertFalse((f.home / ".profile").exists())

    def test_explicit_linger_is_enabled_only_when_missing_and_before_services(self):
        for already_enabled in (False, True):
            with self.subTest(already_enabled=already_enabled), self.setup(linger=already_enabled) as f:
                f.args.apply = True
                installer.configure(f.args)
                enabled = [i for i, call in enumerate(f.calls) if call[:2] == ["loginctl", "enable-linger"]]
                self.assertEqual(len(enabled), 0 if already_enabled else 1)
                if enabled:
                    first_start = next(i for i, call in enumerate(f.calls) if call[:4] == ["systemctl", "--user", "enable", "--now"])
                    self.assertLess(enabled[0], first_start)

    def test_github_login_failure_precedes_runtime_or_service_mutations(self):
        with self.setup() as f:
            f.args.apply = True
            with patch.object(auth, "login_github_device",
                              side_effect=SetupError("GitHub DevTunnel login did not complete")), \
                    self.assertRaisesRegex(installer.SetupError, "DevTunnel login"):
                installer.configure(f.args)
            f.builder.assert_not_called()
            f.create.assert_not_called()
            self.assertFalse((f.home / ".config/codey-machine").exists())

    def test_success_has_supervision_timer_and_next_run_plans_replacement(self):
        with self.setup() as f:
            f.args.apply = True
            with patch.dict(os.environ, {"CODEY_MODEL_API_KEY": "do-not-copy-old-shell-key"}):
                installer.configure(f.args)
            config = f.home / ".config/codey-machine"
            installation = json.loads((config / "installation.json").read_text())
            self.assertTrue(installation["ready"])
            self.assertEqual(set(installation["supervision"]), {
                "codey-copilot-api.service",
                "codey-cloudcli.service",
                "codey-devtunnel.service",
                "codey-devtunnel-renew.timer",
                "codey-node-updater.service",
            })
            gateway = json.loads((f.home / ".local/share/codey-machine/data/copilot-api/config.json").read_text())
            self.assertFalse(gateway["useResponsesApiWebSocket"])
            self.assertEqual(len(gateway["auth"]["apiKeys"]), 1)
            self.assertNotIn("do-not-copy-old-shell-key", gateway["auth"]["apiKeys"])
            self.assertIn("CODEY_MODEL_API_KEY=" + json.dumps(gateway["auth"]["apiKeys"][0]), (config / "provider.env").read_text())
            self.assertIn("CODEX_HOME=" + f.args.codex_home, (config / "cloudcli.env").read_text())
            cloudcli_env = (config / "cloudcli.env").read_text()
            self.assertIn("CODEY_PORTAL_PRINCIPAL_ID=" + f.identity["workspaceSubject"], cloudcli_env)
            self.assertIn("CODEY_PORTAL_USERNAME=" + f.identity["workspaceUsername"], cloudcli_env)
            self.assertEqual(
                json.loads((config / "updater-bootstrap.json").read_text()),
                registration.updater_config(f.setup, f.identity),
            )
            self.assertFalse((f.skill / "assets/codey-updater/config.json").exists())
            self.assertEqual(json.loads((config / "registration-secrets.json").read_text()), f.identity)
            codex_config = tomllib.loads((Path(f.args.codex_home) / "config.toml").read_text())
            self.assertEqual(codex_config["model"], "gpt-6-astra")
            self.assertEqual(codex_config["mcp_servers"], {"keep": {"command": "preserve"}})
            self.assertEqual((Path(f.args.codex_home) / "auth.json").read_text(), '{"credential":"preserve-model-login-fixture"}')
            provider_env = f.home / ".config/codey-machine/provider.env"
            for profile in (f.home / ".profile", f.home / ".bashrc"):
                text = profile.read_text()
                self.assertIn(str(provider_env), text)
                self.assertNotIn(gateway["auth"]["apiKeys"][0], text)
            wrapper = (f.home / ".local/share/codey-machine/bin/codex").read_text()
            self.assertIn(str(provider_env), wrapper)
            self.assertIn("export CODEY_MODEL_API_KEY", wrapper)
            units = f.home / ".config/systemd/user"
            for name in ("codey-copilot-api.service", "codey-cloudcli.service", "codey-devtunnel.service"):
                text = (units / name).read_text()
                self.assertIn("Restart=always", text)
                self.assertIn("WantedBy=default.target", text)
            renew = (units / "codey-devtunnel-renew.service").read_text()
            self.assertIn("Type=oneshot", renew)
            self.assertNotIn("Restart=always", renew)
            self.assertIn("OnUnitInactiveSec=300", (units / "codey-devtunnel-renew.timer").read_text())
            f.portal_renew.assert_not_called()
            f.connect_token.assert_called_once()
            registration_file = json.loads(Path(f.args.out).read_text())
            self.assertEqual(registration_file["schema"], 2)
            self.assertEqual(registration_file["credentials"], registration.exported_credentials(f.identity))
            self.assertEqual(registration_file["devTunnelConnectToken"], "header.connect-only.signature")
            for secret in registration.exported_credentials(f.identity).values():
                self.assertNotIn(secret, f.output.getvalue())
            self.assertFalse((f.skill / "output/codey-machine-registration.json").exists())
            f.output.seek(0)
            f.output.truncate(0)
            f.args.apply = False
            installer.configure(f.args)
            replacement = json.loads(f.output.getvalue())
            self.assertTrue(replacement["replacement"]["detected"])
            self.assertEqual(replacement["codexUpdate"]["release"], "latest")

    def test_failure_only_disables_new_services_and_never_marks_ready(self):
        with self.setup() as f:
            f.args.apply = True
            with patch.object(installer, "emit_registration", side_effect=OSError("test export failure")), self.assertRaises(OSError):
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
