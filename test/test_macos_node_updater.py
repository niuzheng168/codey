#!/usr/bin/env python3
"""Filesystem/launchd transaction fixtures, not real macOS or model acceptance."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import struct
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


native = module("mac_native_test", ROOT / "node-updater/macos/native.py")
installer = module("mac_installer_test", ROOT / "node-updater/macos/install.py")


class SimulatedCrash(BaseException):
    pass


def write(file, value, mode=0o600):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    file.write_bytes(value if isinstance(value, bytes) else json.dumps(value).encode())
    file.chmod(mode)
    return file


class Processes:
    def __init__(self):
        self.table, self.arguments = {}, {}

    def add(self, pid, parent, executable, args):
        self.table[pid] = {"pid": pid, "parent": parent, "uid": os.getuid(), "group": pid}
        self.arguments[pid] = (executable, args)

    def rows(self):
        return dict(self.table)

    def argv(self, pid):
        if pid not in self.arguments:
            raise ProcessLookupError(pid)
        return self.arguments[pid]


class Fixture(native.Native):
    """Only OS/process/model I/O is fake; use real validators, journals and locks."""
    def __init__(self, home, *, target="macos-arm64", enrolled=True):
        # Production __init__/CLI always enforce Darwin; tests never invoke launchctl.
        self.home = home.resolve()
        self.root = self.home / ".local/share/codey-machine-macos"
        self.config_root = self.home / ".config/codey-machine-macos"
        self.file = self.config_root / "runtime.json"
        self.private = self.home / ".config/codey-updater"
        self.updater_root = self.home / ".local/share/codey-updater"
        self.local_state = self.home / ".local/share/codey-local-update"
        self.jobs = self.root / "local-updates"
        self.domain, self.target = f"gui/{os.getuid()}", target
        self.processes, self.live, self.disabled_jobs = Processes(), {}, set()
        self.mutations, self.events, self.model_calls = [], [], 0
        self.sessions, self.sockets, self.model_failure, self.health_failure = 0, False, False, False
        self.reject_signature, self.crash_start, self.crash_model, self.bootstrap_failure = False, False, False, False
        self.next_pid = 400
        self.after_stop = None
        for directory in (self.root, self.config_root, self.private, self.updater_root, self.local_state, self.jobs):
            directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        app = self.package(self.root / "releases/old/node_modules/codey", "0.1.2")
        cfg = {
            "schema": 2, "kind": "codey-macos-oneclick", "layout": "npm-codey-package", "platform": target,
            "ownerUid": os.getuid(), "ownerHome": str(self.home), "computer": "fixture-mac",
            "nodeId": "n-" + "a" * 24, "releaseId": "old-fixture",
            "runtimeRoot": str(self.root), "configRoot": str(self.config_root), "stateRoot": str(self.root / "state"),
            "codeyDirectory": str(app), "codeyBin": str(app / "bin/codey.mjs"),
            "pythonExe": str(write(self.root / "tools/python", b"fixture-python", 0o700)),
            "nodeExe": str(write(self.root / "tools/node", b"fixture-node", 0o700)),
            "devtunnelExe": str(write(self.root / "tools/devtunnel", b"fixture-tunnel", 0o700)),
            "codexExe": str(write(self.root / "tools/codex", b"fixture-codex", 0o700)),
            "workerPath": str(write(self.root / "supervisor/macos-service.py", b"fixture worker")),
            "helperPath": str(write(self.root / "supervisor/windows-runtime.mjs", b"fixture helper")),
            "identityFile": str(self.root / "identity.json"), "tunnelFile": str(write(self.root / "tunnel.json", {})),
            "certificate": str(write(self.config_root / "node.pem", b"fixture certificate")),
            "setupFile": str(write(self.config_root / "setup.json", {"preserved": True})),
            "codexHome": str(self.home / ".codex"), "portalOrigin": "https://portal.example.test",
            "serverName": "fixture.nodes.codey.internal", "modelKey": "m" * 43,
            "qualifiedTunnel": "fixture.usw2", "codeyEntrySha256": native.digest(app / "codey-build.json"),
            "state": "ready", "ready": True, "updater": "unsupported_platform",
        }
        identity = {"nodeId": cfg["nodeId"], "ownerUid": os.getuid(), "workspaceSubject": "owner-subject",
                    "workspaceUsername": "alice", "workspaceSsoKey": "S" * 43, "clientSigningKey": "T" * 43}
        write(Path(cfg["identityFile"]), identity)
        cfg["environment"] = {
            "HOME": str(self.home), "CODEX_HOME": cfg["codexHome"], "CODEY_CODEX_EXECUTABLE": cfg["codexExe"],
            "CODEY_PORTAL_NODE_ID": cfg["nodeId"], "CODEY_PORTAL_PRINCIPAL_ID": identity["workspaceSubject"],
            "CODEY_PORTAL_USERNAME": identity["workspaceUsername"], "CODEY_PORTAL_SSO_KEY": identity["workspaceSsoKey"],
            "CODEY_MODEL_API_KEY": cfg["modelKey"], "CODEY_PORTAL_TLS_CERT": cfg["certificate"],
            "COPILOT_API_CODEY_TLS_CERT": cfg["certificate"], "COPILOT_API_CODEY_NODE_ID": cfg["nodeId"],
            "COPILOT_API_CODEY_ALLOWED_ORIGIN": cfg["portalOrigin"],
            "COPILOT_API_CODEY_HTTPS_HOST": "127.0.0.1", "COPILOT_API_CODEY_HTTPS_PORT": "8443",
            "COPILOT_API_HOME": str(self.home / "gateway"),
            "CODEY_PORTAL_TLS_KEY": str(write(self.config_root / "node.key", b"fixture key")),
            "COPILOT_API_CODEY_TLS_KEY": str(self.config_root / "node.key"),
            "COPILOT_API_CODEY_SIGNING_KEY_FILE": str(write(self.config_root / "ticket.key", b"fixture ticket")),
            "DATABASE_PATH": str(write(self.root / "state/workspace.db", b"fixture database")),
        }
        write(self.home / ".codex/config.toml", b'model = "fixture"\n')
        write(self.home / ".codex/auth.json", {"preserved": "fixture auth"})
        write(self.home / "gateway/config.json", {"auth": {"apiKeys": [cfg["modelKey"]]}})
        cfg["fileHashes"] = {name: native.digest(cfg[name]) for name in ("nodeExe", "devtunnelExe", "workerPath", "helperPath")}
        write(self.file, cfg)
        self.initial = copy.deepcopy(cfg)
        self.agent_config = {
            "schema": 1, "protocol": 1, "nodeId": cfg["nodeId"], "platform": target,
            "ownerId": identity["workspaceSubject"], "username": identity["workspaceUsername"],
            "portalOrigin": cfg["portalOrigin"], "minimumSequence": 0, "credential": "A" * 43, "releasePublicKey": "fixture",
        }
        if enrolled:
            write(self.private / "config.json", self.agent_config)
        for component in native.COMPONENTS:
            name = native.label(cfg["nodeId"], component)
            file = self.home / "Library/LaunchAgents" / (name + ".plist")
            write(file, plistlib.dumps(native.agent_definition(cfg, self.file, component)))
            pid = 200 if component == "codey" else 300 if component == "tunnel" else 0
            self.live[name] = {"pid": pid, "file": file}
            if pid:
                self.processes.add(pid, 1, cfg["pythonExe"], native.agent_definition(cfg, self.file, component)["ProgramArguments"])
        self.add_codey(200, 201)

    def package(self, root, version):
        write(root / "bin/codey.mjs", b"// fixture, not executable")
        write(root / "package.json", {"name": "codey", "version": version})
        write(root / "codey-build.json", {"schema": 1, "name": "codey", "version": version,
                                        "runtimePlatforms": ["linux-x64", "windows-x64", self.target]})
        return root

    def add_codey(self, worker, child):
        cfg = native.read(self.file)
        self.processes.add(child, worker, cfg["nodeExe"], [cfg["nodeExe"], cfg["codeyBin"], "start", "--host",
                                                         "127.0.0.1", "--workspace-port", "3001", "--gateway-port", "4141"])

    def run(self, args, **options):
        args = list(map(str, args))
        out, err, code = "", "", 0
        if args[0].endswith("lsof"):
            out, code = ("p999\n", 0) if self.sockets else ("", 1)
        elif args[0] == "/bin/launchctl":
            action = args[1]
            name = args[2].split("/")[-1] if len(args) > 2 else ""
            if action == "print-disabled":
                out = "{\n" + "\n".join(f'"{name}" => true' for name in self.disabled_jobs) + "\n}"
            elif action == "print":
                if args[2] == self.domain:
                    out = self.domain + " = {}"
                elif name not in self.live:
                    code, err = 113, "Could not find service\n"
                else:
                    entry = self.live[name]
                    if name.startswith("com.codey.node-updater.") and (self.private / "stop.json").exists():
                        entry["pid"] = 0  # Simulated graceful host exit, never a force kill.
                    out = f'\tpath = {entry["file"]}\n'
                    if entry["pid"]:
                        out += f'\tpid = {entry["pid"]}\n'
            elif action in ("enable", "disable"):
                self.mutations.append((action, name))
                (self.disabled_jobs.add if action == "disable" else self.disabled_jobs.discard)(name)
            elif action == "bootout":
                self.mutations.append(("stop", name))
                if name in self.live:
                    entry = self.live.pop(name)
                    for number in native.descendants(self.processes.rows(), entry["pid"]):
                        self.processes.table.pop(number, None)
                        self.processes.arguments.pop(number, None)
                if self.after_stop and name.endswith(".codey"):
                    self.after_stop()
            elif action == "bootstrap":
                file = Path(args[3])
                job = plistlib.loads(file.read_bytes())
                name = job["Label"]
                if name.endswith(".codey") and self.crash_start:
                    self.crash_start = False
                    raise SimulatedCrash()
                if name.startswith("com.codey.node-updater.") and self.bootstrap_failure:
                    self.bootstrap_failure = False
                    raise native.UpdateError("operation_failed")
                self.mutations.append(("start", name))
                self.next_pid += 2
                self.live[name] = {"pid": self.next_pid, "file": file}
                self.processes.add(self.next_pid, 1, job["ProgramArguments"][0], job["ProgramArguments"])
                if name.endswith(".codey"):
                    self.add_codey(self.next_pid, self.next_pid + 1)
                else:
                    write(self.private / "agent.lock", {"pid": self.next_pid, "nonce": "a" * 32})
            else:
                raise AssertionError(args)
        elif args[0] == self.initial["nodeExe"] and "validate" in args:
            out = '{"valid":true}'
        else:
            raise AssertionError(args)
        if options.get("check", True) and code:
            raise native.UpdateError("operation_failed")
        return subprocess.CompletedProcess(args, code, stdout=out, stderr=err)

    def protected(self, cfg):
        paths = [cfg[name] for name in ("pythonExe", "nodeExe", "devtunnelExe", "codexExe", "workerPath", "helperPath",
                                        "identityFile", "certificate", "setupFile")]
        paths += [str(self.home / ".codex/config.toml"), str(self.home / ".codex/auth.json"),
                  str(self.home / "gateway/config.json"), str(self.config_root / "node.key")]
        return {file: native.digest(file) for file in paths}

    def probe(self, cfg, mode="health", version=None):
        if native.label(cfg["nodeId"], "codey") not in self.live:
            raise ConnectionRefusedError()
        if self.health_failure and cfg["releaseId"] != "old-fixture":
            raise native.UpdateError("health_failed")
        return {"healthy": True, "runningSessions": self.sessions}

    def health(self):
        return self.snapshot()  # No real-time retry sleeps in fixtures.

    def port_open(self, port):
        return False

    def js(self, cfg, script, args, **options):
        if str(script).endswith("/agent.mjs"):
            self.events.append(str(args[0]))
            native.require(not self.reject_signature, "signature_invalid")
            return {"verified": True}
        if str(script).endswith("/verify.mjs"):
            self.model_calls += 1
            if self.model_failure:
                raise native.UpdateError("model_failed")
            request = native.read(args[0])
            write(Path(request["job"]) / "model-proof.json", {
                "passed": True, "codeyModel": True, "codexModel": True, "syntheticSessionArchived": True,
                "jobId": request["jobId"], "digest": request["digest"],
            })
            if self.crash_model:
                raise SimulatedCrash()
            return {"passed": True}
        raise AssertionError((script, args))

    def job(self, *, changed=True):
        job = self.jobs / ("d" * 32)
        job.mkdir(mode=0o700)
        candidate = self.package(job / "app/node_modules/codey", "0.1.5") if changed else Path(self.initial["codeyDirectory"])
        request = {
            "schema": 1, "job": str(job), "jobId": job.name, "agentConfig": str(self.private / "config.json"),
            "plan": self.snapshot(), "candidate": str(candidate), "changed": changed, "digest": "f" * 64,
            "release": {"id": "codey-macos-fixture", "sequence": 9,
                        "components": {"codey": {"version": "0.1.5", "entrySha256": native.digest(candidate / "codey-build.json")}}},
        }
        write(job / "request.json", request)
        write(self.local_state / "active.json", {"job": str(job)})
        return job, request

    def bundle(self):
        root = self.home / "download/codey-updater"
        for name in installer.PACKAGE_FILES:
            if name in ("UPGRADE.md", "install.py"):
                file = ROOT / "node-updater/macos" / name
            elif name == "windows/lib/node-update-manifest.mjs":
                file = ROOT / "src/node-update-manifest.mjs"
            elif name.startswith("windows/lib/"):
                file = ROOT / "packages/codey/lib" / Path(name).name
            else:
                file = ROOT / "node-updater" / name
            write(root / name, file.read_bytes())
        manifest = {"schema": 1, "platform": self.target,
                    "files": {name: native.digest(root / name) for name in sorted(installer.PACKAGE_FILES)}}
        write(root / "agent-files.json", manifest)
        write(root / "config.json", self.agent_config)
        return root, manifest


class MacUpdaterTests(unittest.TestCase):
    def setUp(self):
        previous_umask = os.umask(0o077)
        self.addCleanup(os.umask, previous_umask)
        self.temp = tempfile.TemporaryDirectory(prefix="codey-mac-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.native = Fixture(self.home)

    def test_procargs_keeps_spaces_unicode_empty_arguments_and_discards_environment(self):
        argv = ["/Users/测试 User/python", "-I", "", "/Users/测试 User/worker.py"]
        data = struct.pack("=i", len(argv)) + argv[0].encode() + b"\0" * 8
        data += b"\0".join(arg.encode() for arg in argv) + b"\0SECRET=never-returned\0"
        executable, actual = native.parse_procargs(data)
        self.assertEqual((executable, actual), (argv[0], argv))
        self.assertNotIn("SECRET", repr(actual))
        for data in (b"", struct.pack("=i", -1) + b"a\0", struct.pack("=i", 4) + b"a\0a\0"):
            with self.assertRaises(native.UpdateError):
                native.parse_procargs(data)

    def test_path_symlinks_and_public_private_state_are_refused(self):
        linked = self.home / "linked"
        linked.symlink_to(self.home / ".codex", target_is_directory=True)
        with self.assertRaises(native.UpdateError):
            native.checked_path(linked / "config.toml", self.home)
        self.native.file.chmod(0o644)
        with self.assertRaises(native.UpdateError):
            self.native.config()

    def test_wrong_owner_platform_legacy_layout_and_changed_tools_are_refused(self):
        for patch in ({"ownerUid": os.getuid() + 1}, {"platform": "windows-x64"}, {"schema": 1},
                      {"kind": "legacy-split"}, {"ready": False}):
            write(self.native.file, {**self.native.initial, **patch})
            with self.assertRaises(native.UpdateError):
                self.native.config()
        write(self.native.file, self.native.initial)
        write(Path(self.native.initial["nodeExe"]), b"another native executable", 0o700)
        with self.assertRaises(native.UpdateError):
            self.native.config()

    def test_snapshot_checks_actual_worker_and_exact_plist_not_just_a_pid(self):
        self.assertEqual(self.native.snapshot()["pid"], 201)
        self.native.processes.arguments[200][1].append("--unexpected")
        with self.assertRaises(native.UpdateError):
            self.native.snapshot()

    def test_unrelated_launch_agent_definition_is_not_adopted(self):
        file = self.native.plist(self.native.config(), "codey")
        value = plistlib.loads(file.read_bytes())
        value["KeepAlive"] = False
        write(file, plistlib.dumps(value))
        with self.assertRaises(native.UpdateError):
            self.native.snapshot()
        self.assertEqual(self.native.mutations, [])

    def test_codey_sessions_model_connections_and_external_desktop_are_busy_without_kills(self):
        self.assertTrue(self.native.idle()["idle"])
        self.native.sessions = 1
        self.assertFalse(self.native.idle()["idle"])
        self.native.sessions, self.native.sockets = 0, True
        self.assertFalse(self.native.idle()["idle"])
        self.native.sockets = False
        self.native.processes.add(999, 1, "/Applications/Codex.app/Contents/Resources/codex", ["codex", "app-server"])
        self.assertFalse(self.native.idle()["idle"])
        self.assertEqual(self.native.mutations, [])

    def test_in_tree_cli_between_requests_is_busy_but_the_exact_idle_workspace_backend_is_not(self):
        cfg = self.native.initial
        self.native.processes.add(202, 201, cfg["nodeExe"],
                                  [cfg["nodeExe"], cfg["codeyBin"], "workspace", "--host", "127.0.0.1", "--port", "3001"])
        self.native.processes.add(203, 202, cfg["codexExe"], [cfg["codexExe"], "exec", "active user work"])
        self.assertFalse(self.native.idle()["idle"])
        self.native.processes.arguments[203] = (cfg["codexExe"], [cfg["codexExe"], "app-server"])
        self.assertTrue(self.native.idle()["idle"])
        self.native.processes.add(204, 202, "/bin/zsh", ["/bin/zsh"])
        self.native.processes.table[203]["parent"] = 204
        self.assertFalse(self.native.idle()["idle"], "A terminal's app-server is not tracked by the Workspace session API")
        self.assertEqual(self.native.mutations, [])

    def test_success_changes_only_package_fields_and_reconciles_without_models_or_restarts(self):
        job, request = self.native.job()
        before = copy.deepcopy(self.native.initial)
        self.assertEqual(self.native.activate(job / "request.json")["state"], "complete")
        current = native.read(self.native.file)
        changes = {key for key in current if current[key] != before[key]}
        self.assertEqual(changes, {"codeyDirectory", "codeyBin", "codeyEntrySha256", "releaseId"})
        self.assertEqual(self.native.model_calls, 1)
        actions = list(self.native.mutations)
        self.assertEqual([action for action, _ in actions], ["stop", "start"])
        self.assertTrue(all(name.endswith(".codey") for _, name in actions))
        self.assertEqual(self.native.recover(job / "local-update.json")["state"], "complete")
        self.assertEqual(self.native.model_calls, 1)
        self.assertEqual(self.native.mutations, actions)
        self.assertIn("receipt-expired", self.native.events)
        self.assertEqual(self.native.protected(current), request["plan"]["protected"])

    def test_model_failure_rolls_back_without_restoring_databases_or_changing_tunnel(self):
        before = self.native.file.read_bytes()
        job, _ = self.native.job()
        self.native.model_failure = True
        self.assertEqual(self.native.activate(job / "request.json")["state"], "rolled_back")
        self.assertEqual(self.native.file.read_bytes(), before)
        self.assertTrue(all(name.endswith(".codey") for _, name in self.native.mutations))
        self.assertEqual(self.native.model_calls, 1)

    def test_candidate_health_failure_rolls_back_before_a_model_call(self):
        job, _ = self.native.job()
        self.native.health_failure = True
        self.assertEqual(self.native.activate(job / "request.json")["state"], "rolled_back")
        self.assertEqual(self.native.model_calls, 0)
        self.assertEqual(native.read(self.native.file), self.native.initial)

    def test_busy_invalid_signature_or_config_drift_never_stops_the_app(self):
        for mode in ("busy", "signature", "drift"):
            with tempfile.TemporaryDirectory() as directory:
                fixture = Fixture(Path(directory))
                job, _ = fixture.job()
                if mode == "busy":
                    fixture.sessions = 1
                elif mode == "signature":
                    fixture.reject_signature = True
                else:
                    write(fixture.config_root / "node.key", b"changed concurrently")
                with self.assertRaises(native.UpdateError):
                    fixture.activate(job / "request.json")
                self.assertEqual(fixture.mutations, [])
                self.assertFalse((job / "local-update.json").exists())

    def test_original_installer_lock_blocks_activation(self):
        job, _ = self.native.job()
        with native.lock_file(self.native.config_root / "install.lock"):
            with self.assertRaises(native.UpdateError) as error:
                self.native.activate(job / "request.json")
        self.assertEqual(error.exception.code, "busy")
        self.assertEqual(self.native.mutations, [])

    def test_interrupted_start_recovers_locally_without_repeating_stage_or_models(self):
        job, _ = self.native.job()
        self.native.crash_start = True
        with self.assertRaises(SimulatedCrash):
            self.native.activate(job / "request.json")
        self.assertEqual(native.read(job / "local-update.json")["state"], "starting")
        self.assertEqual(self.native.recover(job / "local-update.json")["state"], "rolled_back")
        self.assertEqual(native.read(self.native.file), self.native.initial)
        self.assertEqual(self.native.model_calls, 0)

    def test_ambiguous_model_completion_rolls_back_but_never_resends_a_model(self):
        job, _ = self.native.job()
        self.native.crash_model = True
        with self.assertRaises(SimulatedCrash):
            self.native.activate(job / "request.json")
        self.assertEqual(self.native.recover(job / "local-update.json")["state"], "rolled_back")
        self.assertEqual(self.native.model_calls, 1)

    def test_recovery_defers_when_new_desktop_work_exists(self):
        job, _ = self.native.job()
        self.native.crash_model = True
        with self.assertRaises(SimulatedCrash):
            self.native.activate(job / "request.json")
        actions = list(self.native.mutations)
        self.native.processes.add(999, 1, "/Applications/Codex.app/Contents/Resources/codex", ["codex", "app-server"])
        with self.assertRaises(native.UpdateError) as error:
            self.native.recover(job / "local-update.json")
        self.assertEqual(error.exception.code, "busy")
        self.assertEqual(self.native.mutations, actions)
        self.assertEqual(self.native.model_calls, 1)

    def test_completed_journal_requires_bound_model_proof(self):
        job, _ = self.native.job()
        self.native.activate(job / "request.json")
        proof = native.read(job / "model-proof.json")
        write(job / "model-proof.json", {**proof, "digest": "wrong"})
        actions = list(self.native.mutations)
        with self.assertRaises(native.UpdateError):
            self.native.recover(job / "local-update.json")
        self.assertEqual(self.native.mutations, actions)

    def test_config_changed_after_stop_is_not_overwritten_by_rollback(self):
        job, _ = self.native.job()
        changed = {**self.native.initial, "concurrentOwnerSetting": "keep"}
        self.native.after_stop = lambda: write(self.native.file, changed)
        with self.assertRaises(native.UpdateError):
            self.native.activate(job / "request.json")
        self.assertEqual(native.read(self.native.file), changed)
        self.assertEqual([action for action, _ in self.native.mutations], ["stop"])

    def test_verification_only_failure_does_not_restart_or_change_code(self):
        job, _ = self.native.job(changed=False)
        self.native.model_failure = True
        with self.assertRaises(native.UpdateError):
            self.native.activate(job / "request.json", changed=False)
        self.assertEqual(native.read(job / "local-update.json")["state"], "aborted")
        self.assertEqual(self.native.mutations, [])

    def new_installer_fixture(self):
        directory = self.home / "unpaired owner"
        directory.mkdir(mode=0o700)
        fixture = Fixture(directory, enrolled=False)
        source, manifest = fixture.bundle()
        return fixture, source, manifest

    def test_enrollment_installs_only_an_independent_updater_without_models_or_app_restart(self):
        fixture, source, manifest = self.new_installer_fixture()
        original = fixture.file.read_bytes()
        result = installer.apply(fixture, source, fixture.agent_config, fixture.config(), manifest, fixture.snapshot())
        self.assertTrue(result["installed"])
        self.assertFalse(result["codeyServicesChanged"])
        self.assertEqual(fixture.model_calls, 0)
        self.assertEqual(fixture.file.read_bytes(), original)
        self.assertTrue(all(name.startswith("com.codey.node-updater.") for _, name in fixture.mutations))
        binding = native.read(fixture.private / "binding.json")
        self.assertEqual(binding["nodeExe"], fixture.initial["nodeExe"])
        definition = installer.definition(fixture, binding)
        self.assertFalse(definition["AbandonProcessGroup"])
        self.assertNotIn("codey.mjs", " ".join(definition["ProgramArguments"]))
        self.assertEqual(definition["ExitTimeOut"], 960)

    def test_reenrollment_retains_sequence_and_bootstrap_failure_restores_previous_updater(self):
        fixture, source, manifest = self.new_installer_fixture()
        before = fixture.snapshot()
        installer.apply(fixture, source, fixture.agent_config, fixture.config(), manifest, before)
        write(fixture.private / "installed.json", {"nodeId": fixture.initial["nodeId"], "platform": fixture.target,
                                                  "ownerId": fixture.agent_config["ownerId"], "sequence": 29})
        updated = {**fixture.agent_config, "credential": "B" * 43}
        installer.apply(fixture, source, updated, fixture.config(), manifest, before)
        self.assertEqual(native.read(fixture.private / "config.json")["minimumSequence"], 29)
        previous = (fixture.private / "config.json").read_bytes()
        previous_binding = (fixture.private / "binding.json").read_bytes()
        fixture.bootstrap_failure = True
        with self.assertRaises(Exception):
            installer.apply(fixture, source, {**updated, "credential": "C" * 43}, fixture.config(), manifest, before)
        self.assertEqual((fixture.private / "config.json").read_bytes(), previous)
        self.assertEqual((fixture.private / "binding.json").read_bytes(), previous_binding)
        self.assertIsNotNone(installer.task(fixture, native.read(fixture.private / "binding.json"), required=True)[1])
        self.assertEqual(fixture.file.read_bytes(), json.dumps(fixture.initial).encode())

    def test_pending_jobs_or_agent_label_collision_cannot_be_replaced(self):
        fixture, source, manifest = self.new_installer_fixture()
        write(fixture.private / "pending.json", {"id": "d" * 32})
        with self.assertRaises(Exception):
            installer.apply(fixture, source, fixture.agent_config, fixture.config(), manifest, fixture.snapshot())
        self.assertEqual(fixture.mutations, [])
        (fixture.private / "pending.json").unlink()
        label = installer.updater_label(fixture.initial["nodeId"])
        fixture.live[label] = {"pid": 999, "file": fixture.home / "unrelated.plist"}
        with self.assertRaises(Exception):
            installer.apply(fixture, source, fixture.agent_config, fixture.config(), manifest, fixture.snapshot())
        self.assertFalse((fixture.private / "binding.json").exists())
        self.assertEqual(fixture.mutations, [])

    def test_installer_copy_rejects_source_drift_before_launching_it(self):
        fixture, source, manifest = self.new_installer_fixture()
        write(source / "macos/host.py", b"tampered after validation")
        with self.assertRaises(Exception):
            installer.apply(fixture, source, fixture.agent_config, fixture.config(), manifest, fixture.snapshot())
        self.assertEqual(fixture.mutations, [])
        self.assertFalse((fixture.private / "binding.json").exists())

    def test_cli_has_no_environment_or_flag_to_bypass_non_macos_guard(self):
        if __import__("sys").platform == "darwin":
            self.skipTest("Non-macOS rejection test")
        result = subprocess.run([__import__("sys").executable, "-I", "-S", "-B",
                                 str(ROOT / "node-updater/macos/native.py"), "snapshot", str(self.native.file)],
                                capture_output=True, text=True, env={**os.environ, "CODEY_TEST_PLATFORM": "darwin"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["code"], "unsupported_platform")


if __name__ == "__main__":
    unittest.main()
