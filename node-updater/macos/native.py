#!/usr/bin/env python3
"""Owner-only launchd transactions for the existing schema-2 npm Mac layout.

No installer, shell command, tool update, node registration or inbound listener.
The original installation lock spans candidate validation, activation and probes.
"""
import os
import sys
if __name__ == "__main__" and (not sys.flags.isolated or not sys.flags.no_site):
    os.execv(sys.executable, [sys.executable, "-I", "-S", "-B", os.path.abspath(__file__), *sys.argv[1:]])

import contextlib
import ctypes
import fcntl
import hashlib
import json
from pathlib import Path
import platform
import plistlib
import re
import socket
import stat
import struct
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
NODE_ID = re.compile(r"n-[a-f0-9]{24}")
JOB_ID = re.compile(r"[a-f0-9]{32}")
HASH = re.compile(r"[a-f0-9]{64}")
COMPONENTS = ("codey", "tunnel", "renew")


class UpdateError(RuntimeError):
    def __init__(self, code="configuration_changed"):
        super().__init__(code)
        self.code = code


def require(value, code="configuration_changed"):
    if not value:
        raise UpdateError(code)


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def object_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def checked_path(file, home, *, private=False, exists=False):
    home, file = Path(home).resolve(strict=True), Path(os.path.abspath(file))
    require(file != home and file.is_relative_to(home))
    for entry in (file, *file.parents):
        if not entry.is_relative_to(home):
            break
        require(not entry.is_symlink())
        if entry.exists():
            info = entry.stat()
            require(info.st_uid == os.getuid() and not info.st_mode & 0o022)
    require(not exists or file.exists())
    if private and file.exists():
        info = file.stat()
        require(not info.st_mode & 0o077 and (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)))
    return file


def read(file):
    file = Path(file)
    info = file.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077
            and info.st_size <= 4 * 1024 * 1024)
    return json.loads(file.read_text(encoding="utf-8"))


def save(file, value):
    file = Path(file)
    require(not file.is_symlink())
    if file.exists():
        info = file.stat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077)
    data = value if isinstance(value, bytes) else (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=file.parent, prefix="." + file.name + ".", delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
        fd = os.open(file.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


@contextlib.contextmanager
def lock_file(file):
    file = Path(file)
    require(not file.is_symlink())
    fd = os.open(file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise UpdateError("busy") from None
        yield fd
    finally:
        os.close(fd)


def control_environment(home):
    # Native control tools and package/probe children must not inherit the
    # installing Codex task, arbitrary Python/Node preload hooks or npm config.
    result = {"HOME": str(home), "USER": Path(home).name, "LOGNAME": Path(home).name,
              "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"}
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"):
        if name in os.environ:
            result[name] = os.environ[name]
    return result


def run(args, *, home, timeout=30, input=None, check=True):
    result = subprocess.run([str(arg) for arg in args], input=input, capture_output=True, text=True,
                            env=control_environment(home), cwd=home, timeout=timeout, shell=False)
    require(not check or result.returncode == 0, "operation_failed")
    require(len(result.stdout) <= 4 * 1024 * 1024)
    return result


def label(node_id, component):
    require(NODE_ID.fullmatch(node_id) and component in COMPONENTS)
    return f"com.codey.machine.{node_id}.{component}"


def agent_definition(config, config_file, component):
    """The existing schema-2 worker contract; never load unreviewed Python code."""
    value = {
        "Label": label(config["nodeId"], component),
        "ProgramArguments": [config["pythonExe"], "-I", "-S", config["workerPath"], component, str(config_file)],
        "RunAtLoad": True, "ProcessType": "Background", "ThrottleInterval": 15, "Umask": 63,
        "WorkingDirectory": config["runtimeRoot"],
        "StandardOutPath": str(Path(config["stateRoot"]) / (component + ".log")),
        "StandardErrorPath": str(Path(config["stateRoot"]) / (component + ".log")),
        "KeepAlive": True,
    }
    if component == "renew":
        value.update({"StartInterval": 21600, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 120})
    return value


def parse_procargs(data):
    """Darwin KERN_PROCARGS2: argc, executable, NUL padding, argc argv strings."""
    require(len(data) >= 6)
    argc = struct.unpack_from("=i", data)[0]
    require(0 < argc <= 16384)
    end = data.find(b"\0", 4)
    require(end > 4)
    executable = os.fsdecode(data[4:end])
    cursor = end
    while cursor < len(data) and data[cursor] == 0:
        cursor += 1
    argv = []
    for _ in range(argc):
        end = data.find(b"\0", cursor)
        require(end >= cursor)
        argv.append(os.fsdecode(data[cursor:end]))
        cursor = end + 1
    require(argv[0])
    return executable, argv


class DarwinProcesses:
    def __init__(self, home):
        self.home = home
        self.libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        self.libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
                                    ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
        self.libc.sysctl.restype = ctypes.c_int

    def rows(self):
        rows = {}
        output = run(["/bin/ps", "-axo", "pid=,ppid=,uid=,pgid="], home=self.home).stdout
        for line in output.splitlines():
            values = line.split()
            require(len(values) == 4 and all(value.isdigit() for value in values))
            pid, parent, uid, group = map(int, values)
            rows[pid] = {"pid": pid, "parent": parent, "uid": uid, "group": group}
        return rows

    def argv(self, pid):
        # CTL_KERN=1, KERN_PROCARGS2=49 in the XNU sysctl ABI. No environment
        # bytes are exposed: parse only argc arguments and discard the buffer.
        mib = (ctypes.c_int * 3)(1, 49, pid)
        size = ctypes.c_size_t(512 * 1024)
        buffer = ctypes.create_string_buffer(size.value)
        if self.libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
            raise ProcessLookupError(pid)
        return parse_procargs(buffer.raw[:size.value])


def descendants(rows, pid):
    result = {pid}
    while True:
        added = {number for number, row in rows.items() if row["parent"] in result}
        if added.issubset(result):
            return result
        result.update(added)


def same_argv(actual, expected):
    return (len(actual) == len(expected) and Path(actual[0]).resolve() == Path(expected[0]).resolve()
            and actual[1:] == expected[1:])


class Native:
    def __init__(self, *, home=None, target=None, processes=None):
        require(sys.platform == "darwin" and os.getuid() != 0 and sys.version_info >= (3, 12), "unsupported_platform")
        self.home = Path(home or Path.home()).resolve(strict=True)
        self.target = target or {"arm64": "macos-arm64", "x86_64": "macos-x64"}.get(platform.machine())
        require(self.target in ("macos-arm64", "macos-x64"), "unsupported_platform")
        self.root = self.home / ".local/share/codey-machine-macos"
        self.config_root = self.home / ".config/codey-machine-macos"
        self.file = self.config_root / "runtime.json"
        self.private = self.home / ".config/codey-updater"
        self.updater_root = self.home / ".local/share/codey-updater"
        self.local_state = self.home / ".local/share/codey-local-update"
        self.jobs = self.root / "local-updates"
        self.domain = f"gui/{os.getuid()}"
        self.processes = processes or DarwinProcesses(self.home)

    def run(self, args, **options):
        return run(args, home=self.home, **options)

    def config(self):
        checked_path(self.file, self.home, private=True, exists=True)
        cfg = read(self.file)
        require(cfg.get("schema") == 2 and cfg.get("kind") == "codey-macos-oneclick"
                and cfg.get("layout") == "npm-codey-package" and cfg.get("platform") == self.target
                and cfg.get("ownerUid") == os.getuid() and cfg.get("ownerHome") == str(self.home)
                and cfg.get("runtimeRoot") == str(self.root) and cfg.get("configRoot") == str(self.config_root)
                and cfg.get("ready") is True and cfg.get("state") == "ready"
                and NODE_ID.fullmatch(cfg.get("nodeId", "")), "unsupported_platform")
        for name in ("codeyDirectory", "codeyBin", "stateRoot", "workerPath", "helperPath", "nodeExe",
                     "devtunnelExe", "codexExe", "identityFile", "tunnelFile"):
            checked_path(cfg[name], self.root, exists=True)
        for name in ("certificate", "setupFile", "codexHome"):
            checked_path(cfg[name], self.home, exists=True)
        for name in ("nodeExe", "devtunnelExe", "workerPath", "helperPath"):
            require(HASH.fullmatch(cfg.get("fileHashes", {}).get(name, "")) and digest(cfg[name]) == cfg["fileHashes"][name])
        python = Path(cfg["pythonExe"]).resolve(strict=True)
        info = python.stat()
        require(python.is_absolute() and info.st_uid in (0, os.getuid()) and not info.st_mode & 0o022
                and os.access(python, os.X_OK))
        require(cfg["codeyBin"] == str(Path(cfg["codeyDirectory"]) / "bin/codey.mjs"))
        build_file = checked_path(Path(cfg["codeyDirectory"]) / "codey-build.json", self.root, exists=True)
        require(digest(build_file) == cfg["codeyEntrySha256"])
        build = json.loads(build_file.read_text())
        require(build.get("schema") == 1 and build.get("name") == "codey"
                and self.target in build.get("runtimePlatforms", [build.get("platform")]))
        identity = read(cfg["identityFile"])
        env = cfg["environment"]
        require(identity.get("nodeId") == cfg["nodeId"] and identity.get("ownerUid") == os.getuid()
                and cfg["portalOrigin"].startswith("https://")
                and env["HOME"] == str(self.home) and env["CODEX_HOME"] == cfg["codexHome"]
                and env["CODEY_CODEX_EXECUTABLE"] == cfg["codexExe"]
                and env["CODEY_PORTAL_NODE_ID"] == cfg["nodeId"]
                and env["CODEY_PORTAL_PRINCIPAL_ID"] == identity["workspaceSubject"]
                and env["CODEY_PORTAL_USERNAME"] == identity["workspaceUsername"]
                and env["CODEY_PORTAL_SSO_KEY"] == identity["workspaceSsoKey"]
                and env["CODEY_MODEL_API_KEY"] == cfg["modelKey"]
                and env["CODEY_PORTAL_TLS_CERT"] == cfg["certificate"]
                and env["COPILOT_API_CODEY_TLS_CERT"] == cfg["certificate"]
                and env["COPILOT_API_CODEY_NODE_ID"] == cfg["nodeId"]
                and env["COPILOT_API_CODEY_ALLOWED_ORIGIN"] == cfg["portalOrigin"]
                and env["COPILOT_API_CODEY_HTTPS_HOST"] == "127.0.0.1"
                and env["COPILOT_API_CODEY_HTTPS_PORT"] == "8443")
        require(not any(name in env for name in ("NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
                                                 "PYTHONPATH", "PYTHONHOME", "CODEX_THREAD_ID", "CODEX_PARENT_THREAD_ID")))
        for name in ("COPILOT_API_HOME", "CODEY_PORTAL_TLS_KEY", "COPILOT_API_CODEY_TLS_KEY",
                     "COPILOT_API_CODEY_SIGNING_KEY_FILE", "DATABASE_PATH"):
            checked_path(env[name], self.home, exists=True)
        require(env["CODEY_PORTAL_TLS_KEY"] == env["COPILOT_API_CODEY_TLS_KEY"])
        if (self.private / "config.json").exists():
            agent = read(self.private / "config.json")
            require(agent["nodeId"] == cfg["nodeId"] and agent["platform"] == self.target
                    and agent["portalOrigin"] == cfg["portalOrigin"]
                    and agent["ownerId"] == identity["workspaceSubject"] and agent["username"] == identity["workspaceUsername"])
        return cfg

    def plist(self, cfg, component):
        file = checked_path(self.home / "Library/LaunchAgents" / (label(cfg["nodeId"], component) + ".plist"),
                            self.home, private=True, exists=True)
        require(plistlib.loads(file.read_bytes()) == agent_definition(cfg, self.file, component))
        return file

    def loaded(self, cfg, component):
        file = self.plist(cfg, component)
        result = self.run(["/bin/launchctl", "print", self.domain + "/" + label(cfg["nodeId"], component)], check=False)
        if result.returncode:
            # A missing job and an inaccessible GUI domain are not interchangeable.
            self.run(["/bin/launchctl", "print", self.domain])
            require("Could not find service" in result.stderr or "Could not find specified service" in result.stderr)
            return None
        text = result.stdout
        paths = re.findall(r"^\s*path = (.+)$", text, re.M)
        require(paths == [str(file)])
        pids = re.findall(r"^\s*pid = ([1-9][0-9]*)$", text, re.M)
        require(len(pids) <= 1)
        return {"pid": int(pids[0]) if pids else 0, "plistSha256": digest(file)}

    def service_processes(self, cfg, *, require_ready=True):
        loaded = self.loaded(cfg, "codey")
        if not loaded or not loaded["pid"]:
            require(not require_ready, "health_failed")
            return {"worker": 0, "pid": 0, "tree": set()}
        rows = self.processes.rows()
        pid = loaded["pid"]
        require(rows.get(pid, {}).get("uid") == os.getuid())
        executable, argv = self.processes.argv(pid)
        require(Path(executable).resolve() == Path(cfg["pythonExe"]).resolve()
                and same_argv(argv, agent_definition(cfg, self.file, "codey")["ProgramArguments"]))
        tree = descendants(rows, pid)
        candidates = []
        expected = [cfg["nodeExe"], cfg["codeyBin"], "start", "--host", "127.0.0.1",
                    "--workspace-port", "3001", "--gateway-port", "4141"]
        for number in tree - {pid}:
            require(rows[number]["uid"] == os.getuid())
            try:
                executable, argv = self.processes.argv(number)
            except ProcessLookupError:
                continue
            if Path(executable).resolve() == Path(cfg["nodeExe"]).resolve() and same_argv(argv, expected):
                candidates.append(number)
        require(len(candidates) <= 1 and (not require_ready or len(candidates) == 1), "health_failed")
        return {"worker": pid, "pid": candidates[0] if candidates else 0, "tree": tree}

    def other_tasks(self, cfg):
        result = {}
        for component in ("tunnel", "renew"):
            loaded = self.loaded(cfg, component)
            require(loaded is not None, "health_failed")
            result[component] = {"definition": digest(self.plist(cfg, component))}
            if component == "tunnel":
                require(loaded["pid"] > 0, "health_failed")
                rows = self.processes.rows()
                require(rows.get(loaded["pid"], {}).get("uid") == os.getuid())
                _, argv = self.processes.argv(loaded["pid"])
                require(same_argv(argv, agent_definition(cfg, self.file, component)["ProgramArguments"]))
                result[component]["pid"] = loaded["pid"]
        # Natural renewal runs may change PID; definitions and the long-lived
        # tunnel must remain unchanged. We never disable either job.
        return result

    def js(self, cfg, script, args, *, input=None, timeout=90):
        result = self.run([cfg["nodeExe"], script, *args], input=input, timeout=timeout, check=False)
        fallback = "health_failed" if Path(script).name == "verify.mjs" else "configuration_changed"
        if Path(script).name == "agent.mjs" and args and args[0] in ("receipt", "receipt-expired", "candidate"):
            fallback = "signature_invalid"
        if result.returncode:
            try:
                code = json.loads(result.stdout).get("code")
            except (ValueError, AttributeError):
                code = None
            raise UpdateError(code if code in ("signature_invalid", "unsupported_platform", "configuration_changed",
                                              "health_failed", "lease_lost") else fallback)
        return json.loads(result.stdout)

    def protected(self, cfg):
        return self.js(cfg, HERE / "agent.mjs", ["hashes", self.file, self.updater_root / "probe"])

    def probe(self, cfg, mode="health", version=None):
        if mode == "idle":
            value = {"mode": "idle", "nodeId": cfg["nodeId"],
                     "ownerId": cfg["environment"]["CODEY_PORTAL_PRINCIPAL_ID"],
                     "username": cfg["environment"]["CODEY_PORTAL_USERNAME"], "portalOrigin": cfg["portalOrigin"],
                     "runtimeFile": str(self.file), "cloudcliPath": cfg["codeyDirectory"]}
            return self.js(cfg, HERE.parent / "probe.mjs", [], input=json.dumps(value))
        bundled = HERE.parent / "windows/lib/update-probe.mjs"
        script = bundled if bundled.exists() else HERE.parents[1] / "packages/codey/lib/update-probe.mjs"
        return self.js(cfg, script, [self.file, "health", version] if version else [self.file, "health"])

    def snapshot(self, *, require_ready=True):
        cfg = self.config()
        process = self.service_processes(cfg, require_ready=require_ready)
        if require_ready:
            version = json.loads((Path(cfg["codeyDirectory"]) / "package.json").read_text())["version"]
            require(self.probe(cfg, version=version).get("healthy"), "health_failed")
        return {"ok": True, "kind": "macos-managed", "platform": self.target, "nodeId": cfg["nodeId"],
                "root": cfg["codeyDirectory"], "node": cfg["nodeExe"], "pid": process["pid"], "workerPid": process["worker"],
                "jobsRoot": str(self.jobs), "configHash": digest(self.file),
                "otherTasks": self.other_tasks(cfg), "protected": self.protected(cfg)}

    def idle(self, *, allow_unhealthy=False):
        cfg = self.config()
        process = self.service_processes(cfg, require_ready=False)
        rows = self.processes.rows()
        for pid, row in rows.items():
            if row["uid"] != os.getuid():
                continue
            try:
                executable, argv = self.processes.argv(pid)
            except ProcessLookupError:
                # Disappeared processes are harmless; a still-live opaque owner
                # process is not proof of idle.
                if pid in self.processes.rows():
                    return {"ok": True, "idle": False}
                continue
            name = Path(executable).name.lower()
            if name == "codex" or name.startswith("codex-"):
                # A CLI in a Workspace terminal is also inside the Codey tree.
                # It can be busy between model sockets without appearing in
                # /sessions/running. Exempt ONLY the direct, pinned app-server
                # of the actual Workspace child; never a shell/CLI/Desktop.
                parent = rows.get(row["parent"])
                managed_backend = (pid in process["tree"] and len(argv) > 1 and argv[1] == "app-server"
                                   and Path(executable).resolve() == Path(cfg["codexExe"]).resolve()
                                   and parent is not None and parent["parent"] == process["pid"])
                if managed_backend:
                    try:
                        parent_exe, parent_argv = self.processes.argv(parent["pid"])
                        managed_backend = (Path(parent_exe).resolve() == Path(cfg["nodeExe"]).resolve()
                                           and same_argv(parent_argv, [cfg["nodeExe"], cfg["codeyBin"], "workspace",
                                                                      "--host", "127.0.0.1", "--port", "3001"]))
                    except ProcessLookupError:
                        managed_backend = False
                if not managed_backend:
                    return {"ok": True, "idle": False}
        sockets = self.run(["/usr/sbin/lsof", "-nP", "-a", "-u", str(os.getuid()),
                            "-iTCP:4141", "-sTCP:ESTABLISHED", "-Fp"], check=False)
        require(sockets.returncode in (0, 1) and not sockets.stderr, "health_failed")
        if sockets.returncode == 0:
            return {"ok": True, "idle": False}
        try:
            idle = self.probe(cfg, "idle").get("runningSessions") == 0
        except Exception:
            # Never infer idle from an unauthenticated/unreachable but listening
            # Workspace. Only a wholly stopped/unbound application can recover.
            idle = allow_unhealthy and not any(self.port_open(port) for port in (3001, 4141, 8443))
        return {"ok": True, "idle": bool(idle)}

    @staticmethod
    def port_open(port):
        with socket.socket() as connection:
            connection.settimeout(0.3)
            return connection.connect_ex(("127.0.0.1", port)) == 0

    def assert_host(self):
        host = read(self.private / "agent.lock")
        require(isinstance(host.get("pid"), int) and JOB_ID.fullmatch(host.get("nonce", "")))
        rows, ancestors = self.processes.rows(), set()
        pid = os.getpid()
        while pid in rows and pid not in ancestors:
            ancestors.add(pid)
            pid = rows[pid]["parent"]
        require(host["pid"] in ancestors and rows[host["pid"]]["uid"] == os.getuid())
        _, argv = self.processes.argv(host["pid"])
        require(str(HERE / "host.py") in argv and str(self.private / "config.json") in argv)
        try:
            with lock_file(self.private / "agent.lock"):
                raise UpdateError()
        except UpdateError as error:
            require(error.code == "busy")

    def receipt(self, request_file, *, expired=False, candidate=False):
        cfg = self.config()
        mode = "candidate" if candidate else "receipt-expired" if expired else "receipt"
        require(self.js(cfg, HERE / "agent.mjs", [mode, request_file]).get("verified"), "signature_invalid")

    def request(self, file, *, expired=False):
        checked_path(file, self.home, private=True, exists=True)
        value = read(file)
        job_id = value.get("jobId", "")
        require(JOB_ID.fullmatch(job_id))
        job = self.jobs / job_id
        require(Path(file) == job / "request.json" and value.get("job") == str(job)
                and value.get("agentConfig") == str(self.private / "config.json"))
        checked_path(job, self.home, private=True, exists=True)
        require(read(self.local_state / "active.json").get("job") == str(job), "busy")
        self.receipt(file, expired=expired)
        config = read(self.private / "config.json")
        installed = read(self.private / "installed.json") if (self.private / "installed.json").exists() else {}
        floor = config["minimumSequence"]
        require(isinstance(floor, int) and not isinstance(floor, bool) and floor >= 0)
        if installed:
            require(installed.get("nodeId") == config["nodeId"] and installed.get("ownerId") == config["ownerId"]
                    and installed.get("platform") == self.target and installed.get("sequence", -1) >= floor)
        sequence = max(floor, installed.get("sequence", 0))
        require(value["release"]["sequence"] >= sequence and
                (value["release"]["sequence"] != sequence or not installed.get("digest")
                 or installed["digest"] == value["digest"]), "signature_invalid")
        require(value["plan"]["nodeId"] == config["nodeId"])
        return value

    def unchanged(self, plan, *, require_ready=True, package=True):
        current = self.snapshot(require_ready=require_ready)
        require(current["protected"] == plan["protected"] and current["otherTasks"] == plan["otherTasks"])
        if package:
            require(current["configHash"] == plan["configHash"] and current["root"] == plan["root"]
                    and current["pid"] == plan["pid"])
        return current

    def stop_codey(self, cfg):
        process = self.service_processes(cfg, require_ready=False)
        if self.loaded(cfg, "codey") is None:
            return
        self.run(["/bin/launchctl", "bootout", self.domain + "/" + label(cfg["nodeId"], "codey")], timeout=60)
        deadline = time.monotonic() + 45
        while True:
            rows = self.processes.rows()
            if self.loaded(cfg, "codey") is None and not process["tree"].intersection(rows):
                return
            require(time.monotonic() < deadline, "health_failed")
            time.sleep(0.5)

    def start_codey(self, cfg):
        require(self.loaded(cfg, "codey") is None)
        self.run(["/bin/launchctl", "bootstrap", self.domain, self.plist(cfg, "codey")], timeout=60)

    def health(self):
        deadline = time.monotonic() + 75
        while True:
            try:
                return self.snapshot()
            except Exception:
                require(time.monotonic() < deadline, "health_failed")
                time.sleep(1)

    def proof(self, request):
        health_only = "acceptance" in request
        require(not health_only or request["acceptance"] == "authenticated-health-v1")
        code = "health_failed" if health_only else "model_failed"
        try:
            value = read(Path(request["job"]) / ("health-proof.json" if health_only else "model-proof.json"))
        except (OSError, ValueError) as error:
            raise UpdateError(code) from error
        require(value.get("passed") is True and value.get("digest") == request["digest"]
                and value.get("jobId") == request["jobId"], code)
        if health_only:
            component = request["release"]["components"]["codey"]
            require(request.get("version") == component["version"] and
                    request.get("entrySha256") == component["entrySha256"], "signature_invalid")
            require(value.get("schema") == 1 and value.get("acceptance") == request["acceptance"] and
                    value.get("healthy") is True and value.get("authenticated") is True and
                    value.get("modelRequests") is False and value.get("version") == component["version"] and
                    value.get("entrySha256") == component["entrySha256"] and
                    type(value.get("checkedAt")) is int and value["checkedAt"] > 0, code)
        else:
            require(value.get("codeyModel") is True and value.get("codexModel") is True and
                    value.get("syntheticSessionArchived") is True, code)

    def rollback(self, journal, request):
        job = Path(request["job"])
        before = read(job / "runtime.before.json")
        before_hash = digest(job / "runtime.before.json")
        after_hash = digest(job / "runtime.after.json")
        current_hash = digest(self.file)
        require(current_hash in (before_hash, after_hash))
        cfg = self.config()
        require(self.protected(cfg) == request["plan"]["protected"]
                and self.other_tasks(cfg) == request["plan"]["otherTasks"])
        if current_hash == after_hash and after_hash != before_hash:
            require(self.idle(allow_unhealthy=True)["idle"], "busy")
            self.stop_codey(cfg)
            require(digest(self.file) == after_hash)
            save(self.file, (job / "runtime.before.json").read_bytes())
        # Old code may already be healthy after an interruption before the switch.
        if self.loaded(before, "codey") is None:
            self.start_codey(before)
        self.health()
        self.unchanged(request["plan"], package=False)
        journal["state"] = "rolled_back"
        save(job / "local-update.json", journal)
        return {"ok": True, "state": "rolled_back", "code": "health_failed"}

    def activate(self, file, *, changed=True):
        with lock_file(checked_path(self.config_root / "install.lock", self.home)):
            request = self.request(file)
            require(request.get("changed") is changed)
            require(request.get("acceptance") == "authenticated-health-v1")
            job = Path(request["job"])
            require(not (job / "local-update.json").exists())
            self.unchanged(request["plan"])
            cfg = self.config()
            if changed:
                require(request["candidate"] == str(job / "app/node_modules/codey"))
                self.receipt(file, candidate=True)
                require(self.idle()["idle"], "busy")
            else:
                require(request["candidate"] == cfg["codeyDirectory"])
            self.unchanged(request["plan"])
            after = dict(cfg)
            if changed:
                after.update({"codeyDirectory": request["candidate"],
                              "codeyBin": str(Path(request["candidate"]) / "bin/codey.mjs"),
                              "codeyEntrySha256": request["release"]["components"]["codey"]["entrySha256"],
                              "releaseId": request["release"]["id"]})
            save(job / "runtime.before.json", self.file.read_bytes())
            save(job / "runtime.after.json", after if changed else self.file.read_bytes())
            journal = {"schema": 1, "kind": "macos-managed", "state": "prepared",
                       "nodeId": cfg["nodeId"], "jobId": request["jobId"], "changed": changed}
            save(job / "local-update.json", journal)
            try:
                if changed:
                    journal["state"] = "stopping"
                    save(job / "local-update.json", journal)
                    self.stop_codey(cfg)
                    require(digest(self.file) == digest(job / "runtime.before.json"))
                    require(self.protected(cfg) == request["plan"]["protected"]
                            and self.other_tasks(cfg) == request["plan"]["otherTasks"])
                    save(self.file, (job / "runtime.after.json").read_bytes())
                    journal["state"] = "starting"
                    save(job / "local-update.json", journal)
                    self.start_codey(after)
                self.health()
                self.unchanged(request["plan"], package=False)
                journal["state"] = "verifying"
                save(job / "local-update.json", journal)
                self.js(after, HERE / "verify.mjs", [file], timeout=240)
                self.proof(request)
                self.unchanged(request["plan"], package=False)
                journal["state"] = "complete"
                save(job / "local-update.json", journal)
                return {"ok": True, "state": "complete"}
            except Exception as original:
                if not changed:
                    # Verification-only cannot justify a restart or rollback.
                    journal["state"] = "aborted"
                    save(job / "local-update.json", journal)
                    raise
                result = self.rollback(journal, request)
                result["code"] = original.code if isinstance(original, UpdateError) else "health_failed"
                return result

    def recover(self, file):
        with lock_file(checked_path(self.config_root / "install.lock", self.home)):
            checked_path(file, self.home, private=True, exists=True)
            journal = read(file)
            require(journal.get("schema") == 1 and journal.get("kind") == "macos-managed"
                    and JOB_ID.fullmatch(journal.get("jobId", "")) and isinstance(journal.get("changed"), bool))
            job = self.jobs / journal["jobId"]
            require(Path(file) == job / "local-update.json")
            request = self.request(job / "request.json", expired=True)
            require(journal["nodeId"] == self.config()["nodeId"] and journal["changed"] == request["changed"])
            if journal["state"] == "complete":
                self.proof(request)
                require(digest(self.file) == digest(job / "runtime.after.json"))
                self.unchanged(request["plan"], package=False)
                return {"ok": True, "state": "complete"}
            if journal["state"] in ("aborted", "rolled_back"):
                require(digest(self.file) == digest(job / "runtime.before.json"))
                return {"ok": True, "state": journal["state"]}
            require(journal["state"] in ("prepared", "stopping", "starting", "verifying"))
            if not journal["changed"]:
                journal["state"] = "aborted"
                save(file, journal)
                return {"ok": True, "state": "aborted"}
            return self.rollback(journal, request)


def main():
    require(len(sys.argv) == 3)
    operation, file = sys.argv[1:]
    require(operation in ("snapshot", "recovery-snapshot", "idle", "apply", "verify", "recover"))
    native = Native()
    if operation in ("apply", "verify", "recover"):
        native.assert_host()
        result = native.recover(Path(file)) if operation == "recover" else native.activate(Path(file), changed=operation == "apply")
    else:
        require(Path(file) == native.file)
        result = native.idle() if operation == "idle" else native.snapshot(require_ready=operation == "snapshot")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = error.code if isinstance(error, UpdateError) else "configuration_changed"
        # Never print subprocess output, runtime JSON, argv or credentials.
        print(json.dumps({"ok": False, "code": code}))
        sys.exit(1)
