"""Isolated native-Mac installer control flow; no live launchd, login or model calls."""
import importlib.util
import fcntl
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills/config-new-codey-machine"


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load("mac_oneclick_test", SKILL / "scripts/install-macos.py")
service = installer.service
updater = load("mac_oneclick_updater_contract", ROOT / "node-updater/macos/native.py")
NODE = shutil.which("node")


def write(file, value):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    service.write_private(file, value)


def make_package(directory):
    skill = directory / "skill"
    shutil.copytree(SKILL, skill)
    shutil.copy2(ROOT / "scripts/install-codey-runtime.mjs", skill / "scripts/install-runtime.mjs")
    assets = skill / "assets"
    assets.mkdir()
    lock = b'{"name":"codey","version":"0.1.0","lockfileVersion":3}\n'
    write(directory / "fixture-lock", lock)
    build = {"schema": 1, "name": "codey", "version": "0.1.0", "runtimePlatforms": installer.PLATFORMS}
    write(directory / "fixture-build", build)
    tgz = assets / "codey-0.1.0.tgz"
    tgz.write_bytes(b"fixture-npm-artifact-not-executed")
    manifest = {
        "schema": 2, "name": "codey", "platform": "linux-x64", "runtimePlatforms": installer.PLATFORMS,
        "dependencyMode": "npm-codey-package", "releaseId": "machine-" + service.digest(directory / "fixture-build")[:16],
        "codey": {"version": "0.1.0", "entrySha256": service.digest(directory / "fixture-build"),
                  "lockSha256": service.digest(directory / "fixture-lock")},
        "artifacts": [{"file": tgz.name, "size": tgz.stat().st_size, "sha256": service.digest(tgz)}],
    }
    write(assets / "manifest.json", manifest)
    write(assets / "setup.json", {
        "schema": 1, "portalOrigin": "https://codey.example.test", "platform": "linux-x64",
        "releaseId": manifest["releaseId"], "network": {"mode": "devtunnel"}, "tunnelAuthProvider": "github",
        "updater": {"protocol": 1, "releasePublicKey": subprocess.check_output([
            NODE, "-e", "process.stdout.write(require('node:crypto').generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}))"
        ], text=True)},
    })
    (assets / "SHA256SUMS").write_text("\n".join(
        f"{service.digest(assets / name)}  {name}" for name in (tgz.name, "manifest.json", "setup.json")) + "\n")
    return skill


class Fixture(installer.Installer):
    def __init__(self, directory, target):
        self.fixture = directory
        self.skill = make_package(directory)
        self.home = directory / "owner"
        self.home.mkdir(mode=0o700)
        self.target, self.computer, self.domain = target, "FIXTURE-MAC", f"gui/{os.getuid()}"
        self.root = self.home / ".local/share/codey-machine-macos"
        self.config_root = self.home / ".config/codey-machine-macos"
        self.file = self.config_root / "runtime.json"
        self.state = self.root / "state"
        self.agents = self.home / "Library/LaunchAgents"
        self.manifest, self.setup, self.pins = installer.read_package(self.skill, target)
        self.calls, self.live, self.disabled = [], {}, set()
        self.fail_model = self.fail_registration = self.fail_bootstrap = False
        self.fail_updater = False
        self.updater_config = None
        write(self.home / ".codex/auth.json", {"sentinel": "preserve-owner-auth"})
        write(self.home / ".codex/sessions/session.jsonl", b"preserve-owner-session\n")
        write(self.home / ".zshrc", b"export OWNER_SETTING=preserved\n")

    def download(self, item, destination):
        self.calls.append(("download", item["url"]))
        if item["url"].endswith(".tar.gz"):
            prefix = f"node-v{self.pins['nodeVersion']}-darwin-{self.target.removeprefix('macos-')}"
            with tarfile.open(destination, "w:gz") as archive:
                data = b"fixture-native-node"
                info = tarfile.TarInfo(prefix + "/bin/node")
                info.size, info.mode = len(data), 0o700
                archive.addfile(info, io.BytesIO(data))
        elif item["url"].endswith("codex/install.sh"):
            write(destination, b"# fixture https://releases.openai.com/codex\n")
        else:
            write(destination, b"fixture-native-devtunnel\n")

    def run(self, args, **options):
        args = list(map(str, args))
        self.calls.append(tuple(args))
        out, code = "", 0
        file = Path(args[0])
        if file.name == "launchctl":
            operation = args[1]
            if operation == "print-disabled":
                out = "{\n" + "\n".join(f'"{name}" => true' for name in self.disabled) + "\n}"
            elif operation == "print":
                if args[2] != self.domain:
                    name = args[2].split("/")[-1]
                    if name not in self.live:
                        raise RuntimeError("Fixture LaunchAgent is not loaded")
                    out = f"path = {self.live[name]}\npid = 400\n"
            elif operation == "bootstrap":
                plist = Path(args[3])
                definition = plistlib.loads(plist.read_bytes())
                if self.fail_bootstrap and definition["Label"].endswith(".tunnel"):
                    raise RuntimeError("Fixture bootstrap failure")
                self.live[definition["Label"]] = str(plist)
                if definition["Label"].endswith(".codey"):
                    cfg = service.read_private(self.file)
                    write(Path(cfg["environment"]["DATABASE_PATH"]), b"fixture-workspace-db")
            elif operation == "bootout":
                self.live.pop(args[2].split("/")[-1], None)
            elif operation == "enable":
                self.disabled.discard(args[2].split("/")[-1])
            elif operation == "disable":
                self.disabled.add(args[2].split("/")[-1])
            else:
                raise AssertionError("Unexpected launchctl mutation")
        elif file.name == "pgrep":
            code = 1
        elif file.name == "openssl":
            # Only a real, isolated local TLS certificate; never a host service.
            return subprocess.run(args, text=True, capture_output=True, check=True)
        elif file.name == "node":
            if args[1] == "--version":
                out = "v" + self.pins["nodeVersion"]
            elif args[1].endswith("install-runtime.mjs"):
                app = Path(args[args.index("--prefix") + 1]) / "lib/node_modules/codey"
                write(app / "codey-build.json", (self.fixture / "fixture-build").read_bytes())
                write(app / "npm-shrinkwrap.json", (self.fixture / "fixture-lock").read_bytes())
                write(app / "package.json", {"name": "codey", "version": "0.1.0"})
                write(app / "bin/codey.mjs", b"// fixture only\n")
                subprocess.run([NODE, str(ROOT / "scripts/build-native-updaters.mjs"), str(app / "updater/native")], check=True)
            elif args[1].endswith("updater-bootstrap.mjs"):
                script = """
import {pathToFileURL} from "node:url";
const {prepareUpdater}=await import(pathToFileURL(process.argv[2]).href);
await prepareUpdater(process.argv[3],process.argv[4],{platform:process.argv[5]});
"""
                return subprocess.run([NODE, "--input-type=module", "-e", script, "fixture-updater",
                    args[1], args[2], args[3], self.target], text=True, capture_output=True, check=True)
            elif args[1].endswith("windows-runtime.mjs"):
                operation = args[2]
                if operation == "check-tunnel":
                    return subprocess.run([NODE, *args[1:]], text=True, capture_output=True, check=True)
                if operation == "registration":
                    if self.fail_registration:
                        raise RuntimeError("Fixture registration/token verification failed")
                    script = """
import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
const {registrationDocument,writeRegistration}=await import(pathToFileURL(process.argv[2]).href);
const cfg=JSON.parse(await fs.readFile(process.argv[3]));
const identity=JSON.parse(await fs.readFile(cfg.identityFile));
const setup=JSON.parse(await fs.readFile(cfg.setupFile));
const tunnel=JSON.parse(await fs.readFile(cfg.tunnelFile));
const coordinates={tunnelId:tunnel.tunnelId,clusterId:tunnel.clusterId};
const token=`e30.${Buffer.from(JSON.stringify({...coordinates,scp:"connect",exp:Math.floor(Date.now()/1000)+72000})).toString("base64url")}.c2ln`;
await writeRegistration(path.join(cfg.ownerHome,"codey-machine-registration.json"),
  registrationDocument(setup,identity,coordinates,token,await fs.readFile(cfg.certificate,"utf8"),cfg.computer));
"""
                    return subprocess.run([NODE, "--input-type=module", "-e", script, "fixture-export",
                        str(SKILL / "scripts/registration.mjs"), str(self.file)],
                        text=True, capture_output=True, check=True)
                if operation not in ("verify", "sdk-probe"):
                    raise AssertionError("Unexpected model/helper operation")
            elif args[1].endswith("registration.mjs"):
                return subprocess.run([NODE, *args[1:]], text=True, capture_output=True, check=True)
            elif args[1].endswith("codey.mjs") and args[2:5] == ["auth", "login", "--provider"]:
                write(Path(options["env"]["COPILOT_API_HOME"]) / "github_token", b"fixture-owner-token")
            else:
                raise AssertionError("Unexpected fixture Node command")
        elif file.name == "devtunnel":
            if args[1] == "user":
                out = '{"status":"Logged in","provider":"github"}'
            elif args[1] == "show":
                identity = service.read_private(self.state / "identity.json")
                out = json.dumps({"tunnelId": "codey-" + identity["nodeId"], "clusterId": "usw2", "ports": [
                    {"portNumber": 3001, "protocol": "https"}, {"portNumber": 8443, "protocol": "https"}]})
            else:
                raise AssertionError("Unexpected fixture DevTunnel mutation")
            out = "Welcome to dev tunnels!\n\n" + out
        elif file.name == "bash":
            env = options["env"]
            native = Path(env["CODEX_HOME"]) / "versions/fixture/codex"
            write(native, b"fixture-native-codex")
            shim = Path(env["CODEX_INSTALL_DIR"]) / "codex"
            shim.unlink(missing_ok=True)
            shim.symlink_to(native)
        elif file.name == "codex":
            if args[1] == "--version":
                out = "codex-cli fixture"
            else:
                write(Path(args[args.index("--output-last-message") + 1]),
                      b"wrong response" if self.fail_model else b"CODEY_CODEX_OK")
        elif file.name.startswith("python") and "--apply" in args:
            # The real updater takes this lock; the outer installer must release it first.
            with (self.config_root / "install.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.fail_updater:
                raise RuntimeError("Fixture automatic updater failure")
            self.updater_config = service.read_private(Path(args[args.index("--config") + 1]))
            write(self.home / ".config/codey-updater/config.json", self.updater_config)
        else:
            raise AssertionError("Unexpected command: " + file.name)
        return subprocess.CompletedProcess(args, code, out, "")

    def execute(self, **changes):
        args = SimpleNamespace(apply=True, network_approved=True, expected_computer=self.computer,
                               replace_existing=False, retry_failed=False, codex_home=str(self.home / ".codex"))
        args.__dict__.update(changes)
        # Never inspect or reserve real host listeners, GUI domains or applications.
        old_umask = os.umask(0o077)  # Match the real CLI's main(), including parent directories.
        try:
            with patch.object(installer.socket, "socket"), patch.object(installer.time, "sleep"), \
                    patch.object(installer.shutil, "disk_usage", return_value=SimpleNamespace(free=20 * 1024 ** 3)):
                return self.apply(args)
        finally:
            os.umask(old_umask)


@unittest.skipUnless(os.name == "posix" and NODE and shutil.which("openssl"), "Isolated POSIX fixtures need Node/OpenSSL")
class MacInstallerTests(unittest.TestCase):
    def fixture(self, target="macos-arm64"):
        temporary = tempfile.TemporaryDirectory(prefix="codey-macos-oneclick-")
        self.addCleanup(temporary.cleanup)
        return Fixture(Path(temporary.name), target)

    def test_both_architectures_export_real_schema_and_existing_node_recreates_missing_file_without_reinstall(self):
        for target in ("macos-arm64", "macos-x64"):
            with self.subTest(target=target):
                f = self.fixture(target)
                cfg = f.execute()
                output = f.home / "codey-machine-registration.json"
                document = json.loads(output.read_text())
                self.assertEqual(document["schema"], 2)
                self.assertEqual(document["package"]["platform"], target)
                self.assertEqual(document["machine"]["platform"], target)
                self.assertEqual(document["machine"]["nodeId"], cfg["nodeId"])
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                self.assertNotIn("PRIVATE KEY", output.read_text())
                self.assertEqual(len(f.live), 3)
                self.assertEqual(f.updater_config["platform"], target)
                identity = service.read_private(Path(cfg["identityFile"]))
                self.assertEqual(f.updater_config["credential"], identity["updaterCredential"])
                self.assertEqual(f.updater_config["ownerId"], identity["workspaceSubject"])
                for component in service.COMPONENTS:
                    self.assertEqual(service.agent_definition(cfg, f.file, component),
                                     updater.agent_definition(cfg, f.file, component))
                # Check the actual persisted contract, not a synthetic "updater supported" flag.
                adapter = object.__new__(updater.Native)
                adapter.home, adapter.root, adapter.config_root, adapter.file = f.home, f.root, f.config_root, f.file
                adapter.target, adapter.private = target, f.home / ".config/codey-updater"
                self.assertEqual(adapter.config()["nodeId"], cfg["nodeId"])
                before = {name: file.read_bytes() for name, file in {
                    "identity": Path(cfg["identityFile"]), "runtime": f.file,
                    "auth": f.home / ".codex/auth.json", "sessions": f.home / ".codex/sessions/session.jsonl",
                }.items()}
                output.unlink()
                f.calls.clear()
                f.execute()
                self.assertTrue(output.is_file())
                self.assertEqual(Path(cfg["identityFile"]).read_bytes(), before["identity"])
                self.assertEqual(f.file.read_bytes(), before["runtime"])
                self.assertEqual((f.home / ".codex/auth.json").read_bytes(), before["auth"])
                self.assertEqual((f.home / ".codex/sessions/session.jsonl").read_bytes(), before["sessions"])
                self.assertFalse(any(call[0] == "download" or "bootstrap" in call or "bootout" in call
                                     or any("install-runtime.mjs" in arg for arg in call) for call in f.calls))
                self.assertIn("OWNER_SETTING=preserved", (f.home / ".zshrc").read_text())

    def test_plan_and_approval_rejections_never_install_or_create_registration(self):
        f = self.fixture()
        plan = f.execute(apply=False)
        self.assertEqual(plan["mode"], "plan")
        self.assertEqual(f.calls, [])
        for changes in ({"network_approved": False}, {"expected_computer": "OTHER-MAC"}):
            with self.assertRaises(RuntimeError):
                f.execute(**changes)
        self.assertFalse(f.root.exists())
        self.assertFalse(f.config_root.exists())
        self.assertFalse((f.home / "codey-machine-registration.json").exists())
        self.assertEqual(f.calls, [])

    def test_model_registration_or_launchagent_failure_never_marks_ready_or_leaves_started_jobs(self):
        for failure in ("fail_model", "fail_bootstrap"):
            with self.subTest(failure=failure):
                f = self.fixture()
                setattr(f, failure, True)
                with self.assertRaises(RuntimeError):
                    f.execute()
                self.assertEqual(f.live, {})
                cfg = service.read_private(f.file)
                self.assertFalse(cfg["ready"])
                self.assertEqual(cfg["state"], "failed")
                self.assertFalse((f.home / "codey-machine-registration.json").exists())
                self.assertTrue(Path(cfg["identityFile"]).is_file())
                self.assertEqual(service.read_private(f.home / ".codex/auth.json"), {"sentinel": "preserve-owner-auth"})
                self.assertIn(service.label(cfg["nodeId"], "codey"), f.disabled,
                              "Failed nodes must not restart automatically at the next login")

    def test_updater_failure_blocks_registration_and_can_retry_without_reinstalling_apps(self):
        f = self.fixture()
        f.fail_updater = True
        with self.assertRaisesRegex(RuntimeError, "updater failure"):
            f.execute()
        self.assertFalse((f.home / "codey-machine-registration.json").exists())
        cfg = service.read_private(f.file)
        self.assertTrue(cfg["ready"], "Already-verified application services remain available for a safe retry")
        identity = Path(cfg["identityFile"]).read_bytes()
        f.calls.clear()
        f.fail_updater = False
        f.execute()
        self.assertTrue((f.home / "codey-machine-registration.json").is_file())
        self.assertEqual(Path(cfg["identityFile"]).read_bytes(), identity)
        self.assertFalse(any(call[0] == "download" or "bootstrap" in call or "bootout" in call for call in f.calls))

    def test_missing_native_artifact_or_wrong_platform_cannot_be_relabelled_for_a_mac(self):
        f = self.fixture()
        manifest = f.skill / "assets/manifest.json"
        raw = json.loads(manifest.read_text())
        raw["runtimePlatforms"] = ["linux-x64", "windows-x64"]
        write(manifest, raw)
        with self.assertRaises(RuntimeError):
            installer.read_package(f.skill, f.target)
        with self.assertRaises(RuntimeError):
            installer.read_package(f.skill, "windows-x64")

    def test_explicit_failed_install_retry_preserves_identity_and_existing_owner_data(self):
        f = self.fixture()
        f.fail_model = True
        with self.assertRaises(RuntimeError):
            f.execute()
        identity = (f.state / "identity.json").read_bytes()
        with self.assertRaisesRegex(RuntimeError, "retry-failed"):
            f.execute()
        with self.assertRaisesRegex(RuntimeError, "replace-existing"):
            f.execute(retry_failed=True)
        f.fail_model = False
        cfg = f.execute(retry_failed=True, replace_existing=True)
        self.assertTrue(cfg["ready"])
        self.assertEqual((f.state / "identity.json").read_bytes(), identity)
        self.assertTrue((f.home / "codey-machine-registration.json").is_file())
        self.assertEqual((f.home / ".codex/sessions/session.jsonl").read_bytes(), b"preserve-owner-session\n")

    def test_malformed_devtunnel_json_is_rejected_without_echoing_the_token(self):
        self.assertEqual(installer.parse_tunnel_json('Welcome!\n{"token":"private"}'), {"token": "private"})
        for source in ('{"token":"private",}', '{"token":"private"}\n{}', "[]", ""):
            with self.assertRaisesRegex(RuntimeError, "^DevTunnel did not return a valid JSON object$"):
                installer.parse_tunnel_json(source)


if __name__ == "__main__":
    unittest.main()
