"""Logon-only Windows Workspace/relay/tunnel supervision; never manage 4141."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time

COMPONENTS = ("workspace", "data", "tunnel", "renew")
CREATE_NO_WINDOW = 0x08000000


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate(config, component, context):
    if (config.get("schema") != 1 or config.get("kind") != "windows-devtunnel"
            or not re.fullmatch(r"n-[a-f0-9]{24}", config.get("nodeId", ""))
            or config.get("ownerSid") != context["sid"] or context["elevated"]
            or context["sessionId"] <= 0 or component not in COMPONENTS):
        raise RuntimeError("original_logged_on_unelevated_owner_required")
    root, config_root = Path(config["root"]).resolve(), Path(config["configRoot"]).resolve()
    if root == config_root or not root.is_absolute() or not config_root.is_absolute():
        raise RuntimeError("invalid_runtime_roots")
    for file, expected in config["fileHashes"].items():
        candidate = Path(file)
        if (not candidate.is_absolute() or not candidate.is_file() or candidate.is_symlink()
                or not re.fullmatch(r"[a-f0-9]{64}", expected)):
            raise RuntimeError("invalid_pinned_runtime_file")
        with candidate.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                raise RuntimeError("pinned_runtime_input_changed")
    for field in ("runnerPath", "ownerHelper", "tunnelHelper", "nodeExe", "workspaceEntry", "dataEntry"):
        file = Path(config[field])
        if str(file) not in config["fileHashes"] or not file.resolve().is_relative_to(root):
            raise RuntimeError("runtime_entry_outside_installation")
    for field in ("devtunnelExe", "codexExe"):
        if config[field] not in config["fileHashes"]:
            raise RuntimeError("unpinned_owner_executable")
    for field in ("enrollmentFile", "certificate", "privateKey", "ticketKeyFile"):
        file = Path(config[field])
        if not file.is_file() or file.is_symlink() or not file.resolve().is_relative_to(config_root):
            raise RuntimeError("invalid_private_runtime_input")
    enrollment = json.loads(Path(config["enrollmentFile"]).read_text(encoding="utf-8-sig"))
    if enrollment.get("nodeId") != config["nodeId"] or enrollment.get("platform") != "windows-x64":
        raise RuntimeError("runtime_enrollment_mismatch")
    return enrollment


def environment(config, enrollment):
    allowed = {
        "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
        "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES",
        "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
        "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    }
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    protected = {
        "PATH", "HOME", "USERPROFILE", "CODEX_HOME", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED",
        "PYTHONPATH", "PYTHONHOME", "PSMODULEPATH", "CODEX_THREAD_ID", "CODEX_PARENT_THREAD_ID",
        "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    }
    provider_env = config.get("providerEnv", {})
    if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) or name.upper() in protected
           or name.upper().startswith("CODEY_") or name.upper() in {key.upper() for key in env}
           or not isinstance(value, str) for name, value in provider_env.items()):
        raise RuntimeError("unsafe_provider_environment_reference")
    env.update({
        "PATH": config["servicePath"], "NODE_ENV": "production",
        "HOST": "127.0.0.1", "SERVER_PORT": "3001", "CODEY_MANAGED": "true",
        "CODEY_PORTAL_SSO": "true", "CODEY_PORTAL_NODE_ID": config["nodeId"],
        "CODEY_PORTAL_USERNAME": enrollment["username"],
        "CODEY_PORTAL_PRINCIPAL_ID": enrollment["principalId"],
        "CODEY_PORTAL_SSO_KEY": enrollment["workspaceSsoKey"],
        "CODEY_PORTAL_TLS_CERT": config["certificate"], "CODEY_PORTAL_TLS_KEY": config["privateKey"],
        "DATABASE_PATH": config["databasePath"], "CODEX_HOME": config["codexHome"],
        "CODEY_CODEX_EXECUTABLE": config["codexExe"], "CODEY_CODEX_RUNTIME_TRANSPORT": "stdio",
        "WORKSPACES_ROOT": config["workspaceRoot"],
        "CODEY_RELAY_HOST": "127.0.0.1", "CODEY_RELAY_PORT": "8443",
        "CODEY_RELAY_NODE_ID": config["nodeId"], "CODEY_RELAY_NODE_NAME": config["name"],
        "CODEY_RELAY_ALLOWED_ORIGIN": enrollment["portalOrigin"],
        "CODEY_RELAY_UPSTREAM": "http://127.0.0.1:4141/",
        "CODEY_RELAY_UPSTREAM_KEY_FILE": config.get("usageKeyFile", ""),
        "CODEY_RELAY_SIGNING_KEY_FILE": config["ticketKeyFile"],
        "CODEY_RELAY_SESSION_ROOT": str(Path(config["codexHome"]) / "sessions"),
        "CODEY_RELAY_TLS_CERT": config["certificate"], "CODEY_RELAY_TLS_KEY": config["privateKey"],
        # Only names explicitly referenced by the owner's Codex provider are carried.
        **config.get("providerEnv", {}),
    })
    return env


class ChildJob:
    """Closing this job stops only children launched by this supervisor."""
    def __init__(self, child):
        class Basic(ctypes.Structure):
            _fields_ = [
                ("processTime", ctypes.c_longlong), ("jobTime", ctypes.c_longlong),
                ("flags", wintypes.DWORD), ("minWorkingSet", ctypes.c_size_t),
                ("maxWorkingSet", ctypes.c_size_t), ("activeProcesses", wintypes.DWORD),
                ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD),
            ]
        class Extended(ctypes.Structure):
            _fields_ = [
                ("basic", Basic), ("io", ctypes.c_ulonglong * 6),
                ("processMemory", ctypes.c_size_t), ("jobMemory", ctypes.c_size_t),
                ("peakProcessMemory", ctypes.c_size_t), ("peakJobMemory", ctypes.c_size_t),
            ]
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.kernel.CreateJobObjectW(None, None)
        info = Extended()
        info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (not self.handle or not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info))
                or not self.kernel.AssignProcessToJobObject(self.handle, wintypes.HANDLE(int(child._handle)))):
            self.close()
            child.terminate()  # Exact Popen child, never a looked-up/adopted PID.
            child.wait(timeout=10)
            raise RuntimeError("cannot_isolate_owned_child")

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--component", choices=COMPONENTS, required=True)
    args = parser.parse_args()
    if os.name != "nt":
        raise RuntimeError("native_windows_required")
    config = json.loads(args.config.read_text(encoding="utf-8-sig"))
    # Verify helper bytes before importing them, even if they share our directory.
    for field in ("ownerHelper", "tunnelHelper"):
        file = Path(config[field])
        if (not file.is_file() or file.is_symlink() or not file.resolve().is_relative_to(Path(config["root"]).resolve())
                or hashlib.sha256(file.read_bytes()).hexdigest() != config["fileHashes"].get(str(file))):
            raise RuntimeError("pinned_helper_changed")
    owner = load("codey_windows_owner", config["ownerHelper"])
    tunnel = load("codey_windows_tunnel", config["tunnelHelper"])
    enrollment = validate(config, args.component, owner.owner_context())
    import msvcrt
    lock = Path(config["configRoot"]) / (args.component + ".lock")
    with lock.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return
        status_file = Path(config["configRoot"]) / (args.component + "-health.json")

        def status(state, **fields):
            tunnel.write_state(status_file, {
                "nodeId": config["nodeId"], "component": args.component,
                "state": state, "checkedAt": int(time.time() * 1000), **fields,
            })

        if args.component == "renew":
            delay = 30
            while True:
                validate(config, args.component, owner.owner_context())
                try:
                    result = tunnel.renew(config, enrollment)
                    status("healthy", expiresAt=result["expiresAt"])
                    delay = 900
                except Exception:
                    status("renewal_failed", userLoginMayBeRequired=True)
                    delay = min(900, max(30, delay * 2))
                time.sleep(delay)
        commands = {
            "workspace": [config["nodeExe"], config["workspaceEntry"]],
            "data": [config["nodeExe"], config["dataEntry"]],
            "tunnel": [config["devtunnelExe"], "host", config["tunnelId"] + "." + config["clusterId"],
                       "--host-header", "unchanged", "--origin-header", "unchanged"],
        }
        delay = 5
        while True:
            validate(config, args.component, owner.owner_context())
            # No 4141 process, default Codex daemon, or existing host is adopted.
            with subprocess.Popen(
                commands[args.component], cwd=config["workspaceRoot"], env=environment(config, enrollment),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW,
            ) as child:
                job = ChildJob(child)
                started, disconnected = time.monotonic(), None
                try:
                    status("started", pid=child.pid)
                    while child.poll() is None:
                        time.sleep(15)
                        if args.component == "tunnel" and time.monotonic() - started > 30:
                            count = tunnel.host_connections(config)
                            status("unknown" if count is None else "connected" if count else "disconnected",
                                   pid=child.pid, hostConnections=count)
                            disconnected = (disconnected or time.monotonic()) if count == 0 else None
                            if disconnected and time.monotonic() - disconnected >= 120:
                                status("restarting_owned_disconnected_host", pid=child.pid)
                                job.close()
                                child.wait(timeout=15)
                                break
                finally:
                    job.close()
                    child.wait(timeout=15)
            delay = 5 if time.monotonic() - started >= 60 else min(60, delay * 2)
            status("restart_pending", delaySeconds=delay)
            time.sleep(delay)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit(1)  # Never echo credentials or raw CLI/config errors.
