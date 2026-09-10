"""Owner-only macOS service modes using shared tunnel auth and renewal."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys

from ...common.errors import ServiceError, TunnelError
from ...common.files import digest, private_json, write_private  # noqa: F401 - compatibility helper used by tests/tools
from ...devtunnel import auth, binding as tunnels, renewal
from ...service.launcher import validate_files


def runtime(file):
    config = private_json(file)
    if config.get("schema") != 1 or config.get("uid") != os.getuid() or sys.platform != "darwin":
        raise ServiceError("This runtime belongs to another OS or owner")
    for kind in ("node", "devtunnel"):
        binary = Path(config[kind + "Exe"])
        if not binary.is_absolute() or not binary.is_file() or digest(binary) != config[kind + "Sha256"]:
            raise ServiceError(f"The reviewed {kind} executable is missing or changed")
    identity = private_json(config["identityFile"])
    if (identity.get("nodeId") != config["nodeId"]
            or identity.get("platform") not in ("macos-arm64", "macos-x64")):
        raise ServiceError("Runtime and local registration identity differ")
    validate_files(config["pythonRuntime"], "macos")
    if config["worker"] != config["pythonRuntime"]["entrypoint"]:
        raise ServiceError("Unexpected macOS service entrypoint")
    return config, identity


def environment(config, identity):
    # launchd does not inherit a terminal's provider environment. Carry only
    # explicitly referenced provider variables, never the installing Codex turn.
    env = {
        "HOME": config["home"], "USER": config["osUser"], "LOGNAME": config["osUser"],
        "PATH": config["servicePath"], "NODE_ENV": "production",
        "HOST": "127.0.0.1", "SERVER_PORT": "3001", "CODEY_MANAGED": "true",
        "CODEY_PORTAL_SSO": "true", "CODEY_PORTAL_NODE_ID": config["nodeId"],
        "CODEY_PORTAL_USERNAME": identity["workspaceUsername"],
        "CODEY_PORTAL_PRINCIPAL_ID": identity["workspaceSubject"],
        "CODEY_PORTAL_SSO_KEY": identity["workspaceSsoKey"],
        "CODEY_PORTAL_TLS_CERT": config["certificate"],
        "CODEY_PORTAL_TLS_KEY": config["privateKey"],
        "DATABASE_PATH": config["databasePath"], "CODEX_HOME": config["codexHome"],
        "CODEY_CODEX_DAEMON_SOCKET": config["codexSocket"],
        "CODEY_CODEX_EXECUTABLE": config["codexExe"], "WORKSPACES_ROOT": config["workspaceRoot"],
        "VITE_IS_PLATFORM": "false", "PYTHONUNBUFFERED": "1",
        "CODEY_RELAY_HOST": "127.0.0.1", "CODEY_RELAY_PORT": "8443",
        "CODEY_RELAY_NODE_ID": config["nodeId"], "CODEY_RELAY_NODE_NAME": config["name"],
        "CODEY_RELAY_ALLOWED_ORIGIN": identity["portalOrigin"],
        "CODEY_RELAY_UPSTREAM": config["usageUrl"], "CODEY_RELAY_UPSTREAM_KEY_FILE": config.get("usageKeyFile", ""),
        "CODEY_RELAY_SIGNING_KEY_FILE": config["ticketKeyFile"],
        "CODEY_RELAY_SESSION_ROOT": str(Path(config["codexHome"]) / "sessions"),
        "CODEY_RELAY_TLS_CERT": config["certificate"], "CODEY_RELAY_TLS_KEY": config["privateKey"],
    }
    env.update(config.get("providerEnv", {}))
    return env


def renew(config, identity, *, force=False, runner=subprocess.run, opener=None, now=None):
    try:
        return renewal.renew(config, identity, force=force, runner=runner, opener=opener, now=now)
    except TunnelError as error:
        raise ServiceError(str(error)) from None


def serve(config_file, mode):
    config, identity = runtime(config_file)
    lock = open(Path(config["configRoot"]) / (mode + ".lock"), "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    if mode == "renew":
        status = renew(config, identity)
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
        try:
            auth.require_github_login(config["devtunnelExe"])
            tunnels.ensure_tunnel(config["devtunnelExe"], identity, config["configRoot"],
                                 reuse_only=True, inspect_only=True,
                                 expected_binding={key: config[key] for key in ("tunnelId", "clusterId")})
        except TunnelError as error:
            raise ServiceError(str(error)) from None
    os.set_inheritable(lock.fileno(), True)
    os.chdir(config["releaseRoot"])
    child_env = environment(config, identity)
    if mode == "tunnel":
        child_env = auth.cli_environment(child_env)
    os.execve(commands[mode][0], commands[mode], child_env)
