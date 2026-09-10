#!/usr/bin/env python3
"""Owner-only launchd entrypoints and scoped DevTunnel credential renewal."""
import base64
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


class ServiceError(RuntimeError):
    pass


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_private(file, value):
    file = Path(file)
    if file.is_symlink():
        raise ServiceError("Refusing a symbolic-link state file")
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=file.parent, prefix=file.name + ".", delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            stream.write(json.dumps(value, indent=2) + "\n" if not isinstance(value, str) else value)
        os.replace(temporary, file)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def private_json(file):
    file = Path(file)
    stat = file.lstat()
    if file.is_symlink() or stat.st_uid != os.getuid() or stat.st_mode & 0o077:
        raise ServiceError("Runtime configuration must be owned by this user and mode 0600")
    return json.loads(file.read_text())


def runtime(file):
    config = private_json(file)
    if config.get("schema") != 1 or config.get("uid") != os.getuid() or sys.platform != "darwin":
        raise ServiceError("This runtime belongs to another OS or owner")
    for kind in ("node", "devtunnel"):
        binary = Path(config[kind + "Exe"])
        if not binary.is_absolute() or not binary.is_file() or digest(binary) != config[kind + "Sha256"]:
            raise ServiceError(f"The reviewed {kind} executable is missing or changed")
    enrollment = private_json(config["enrollmentFile"])
    if enrollment.get("nodeId") != config["nodeId"]:
        raise ServiceError("Runtime and enrollment identity differ")
    if config.get("tunnelAuthProvider") == "github":
        helper = Path(config["tunnelHelper"])
        if helper != Path(config["configRoot"]) / "tunnel-client.py" or digest(helper) != config["tunnelHelperSha256"]:
            raise ServiceError("Reviewed tunnel helper changed")
    return config, enrollment


def tunnel_client():
    spec = importlib.util.spec_from_file_location("codey_macos_private_tunnel", Path(__file__).with_name("tunnel-client.py"))
    client = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client)
    return client


def environment(config, enrollment):
    # launchd does not inherit a terminal's provider environment. Carry only
    # explicitly referenced provider variables, never the installing Codex turn.
    env = {
        "HOME": config["home"], "USER": config["osUser"], "LOGNAME": config["osUser"],
        "PATH": config["servicePath"], "NODE_ENV": "production",
        "HOST": "127.0.0.1", "SERVER_PORT": "3001", "CODEY_MANAGED": "true",
        "CODEY_PORTAL_SSO": "true", "CODEY_PORTAL_NODE_ID": config["nodeId"],
        "CODEY_PORTAL_USERNAME": enrollment["username"],
        "CODEY_PORTAL_PRINCIPAL_ID": enrollment["principalId"],
        "CODEY_PORTAL_SSO_KEY": enrollment["workspaceSsoKey"],
        "CODEY_PORTAL_TLS_CERT": config["certificate"],
        "CODEY_PORTAL_TLS_KEY": config["privateKey"],
        "DATABASE_PATH": config["databasePath"], "CODEX_HOME": config["codexHome"],
        "CODEY_CODEX_DAEMON_SOCKET": config["codexSocket"],
        "CODEY_CODEX_EXECUTABLE": config["codexExe"], "WORKSPACES_ROOT": config["workspaceRoot"],
        "VITE_IS_PLATFORM": "false", "PYTHONUNBUFFERED": "1",
        "CODEY_RELAY_HOST": "127.0.0.1", "CODEY_RELAY_PORT": "8443",
        "CODEY_RELAY_NODE_ID": config["nodeId"], "CODEY_RELAY_NODE_NAME": config["name"],
        "CODEY_RELAY_ALLOWED_ORIGIN": enrollment["portalOrigin"],
        "CODEY_RELAY_UPSTREAM": config["usageUrl"], "CODEY_RELAY_UPSTREAM_KEY_FILE": config.get("usageKeyFile", ""),
        "CODEY_RELAY_SIGNING_KEY_FILE": config["ticketKeyFile"],
        "CODEY_RELAY_SESSION_ROOT": str(Path(config["codexHome"]) / "sessions"),
        "CODEY_RELAY_TLS_CERT": config["certificate"], "CODEY_RELAY_TLS_KEY": config["privateKey"],
    }
    env.update(config.get("providerEnv", {}))
    return env


def renew(config, enrollment, *, force=False, runner=subprocess.run, opener=None, now=None):
    client = tunnel_client()
    try:
        return client.renew(config, enrollment, force=force, runner=runner, opener=opener, now=now)
    except client.TunnelError as error:
        raise ServiceError(str(error)) from None


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("codex", "workspace", "data", "tunnel", "renew"):
        raise ServiceError("Usage: macos-service.py codex|workspace|data|tunnel|renew runtime.json")
    mode = sys.argv[1]
    config, enrollment = runtime(sys.argv[2])
    lock = open(Path(config["configRoot"]) / (mode + ".lock"), "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    if mode == "renew":
        status = renew(config, enrollment)
        print(json.dumps({"ok": status["ok"], "expiresAt": status["expiresAt"]}))
        return
    if mode == "codex":
        socket_path = Path(config["codexSocket"])
        expected = Path(f"/private/tmp/codey-{os.getuid()}") / (config["nodeId"] + ".sock")
        if socket_path != expected:
            raise ServiceError("Unexpected Codey-owned Codex socket")
        directory = socket_path.parent
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        if directory.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ServiceError("Codex socket directory must be private to this owner")
    commands = {
        "codex": [config["codexExe"], "app-server", "--listen", "unix://" + config["codexSocket"]],
        "workspace": [config["nodeExe"], config["workspaceEntry"]],
        "data": [config["nodeExe"], config["dataEntry"]],
        "tunnel": [config["devtunnelExe"], "host", config["tunnelId"] + "." + config["clusterId"],
                   "--host-header", "unchanged", "--origin-header", "unchanged"],
    }
    if mode == "tunnel" and config.get("tunnelAuthProvider") == "github":
        client = tunnel_client()
        try:
            client.require_github_login(config["devtunnelExe"])
            client.ensure_tunnel(config["devtunnelExe"], enrollment, config["configRoot"],
                                 reuse_only=True, inspect_only=True,
                                 expected_binding={key: config[key] for key in ("tunnelId", "clusterId")})
        except client.TunnelError as error:
            raise ServiceError(str(error)) from None
    os.set_inheritable(lock.fileno(), True)
    os.chdir(config["releaseRoot"])
    child_env = environment(config, enrollment)
    if mode == "tunnel":
        child_env = tunnel_client().cli_environment(child_env)
    os.execve(commands[mode][0], commands[mode], child_env)


if __name__ == "__main__":
    try:
        main()
    except (ServiceError, OSError, ValueError, subprocess.SubprocessError) as error:
        # Only our own sanitized errors are safe to print.
        print(str(error) if isinstance(error, ServiceError) else "Mac node service failed; check owner/runtime inputs", file=sys.stderr)
        sys.exit(1)
