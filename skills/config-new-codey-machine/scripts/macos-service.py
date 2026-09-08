#!/usr/bin/env python3
"""Owner-only launchd entrypoints and scoped DevTunnel credential renewal."""
import base64
import fcntl
import hashlib
import hmac
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
    return config, enrollment


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


def renew(config, enrollment, *, force=False, runner=subprocess.run, opener=urllib.request.urlopen, now=None):
    now = int(time.time() * 1000) if now is None else now
    state_file = Path(config["configRoot"]) / "renewal.json"
    if not force and state_file.exists():
        previous = private_json(state_file)
        if previous.get("nodeId") == config["nodeId"] and previous.get("expiresAt", 0) > now + 8 * 3600_000:
            return previous
    result = runner(
        [config["devtunnelExe"], "token", config["tunnelId"] + "." + config["clusterId"], "--scope", "connect", "--json"],
        capture_output=True, text=True, timeout=45,
    )
    if result.returncode:
        raise ServiceError("DevTunnel login or token issuance failed; run devtunnel user login as this owner")
    try:
        value = json.loads(result.stdout)
        token = value.get("token") or value.get("accessToken")
        claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
        if (claims["tunnelId"] != config["tunnelId"] or claims["clusterId"] != config["clusterId"]
                or claims["scp"] != "connect" or claims["exp"] * 1000 <= now + 600000):
            raise ValueError("invalid token")
    except (ValueError, KeyError, TypeError, AttributeError):
        raise ServiceError("DevTunnel did not issue a valid node-bound connect-only token") from None
    # No token is stored in the runtime, output machine file, command line, or log.
    body = json.dumps({"tunnelId": config["tunnelId"], "clusterId": config["clusterId"],
                       "connectToken": token}, separators=(",", ":")).encode()
    pathname = f"/api/machine-tunnels/{config['nodeId']}/token"
    nonce = base64.urlsafe_b64encode(secrets.token_bytes(16)).decode().rstrip("=")
    message = f"POST\n{pathname}\n{now}\n{nonce}\n{hashlib.sha256(body).hexdigest()}".encode()
    signature = base64.urlsafe_b64encode(hmac.new(
        base64.urlsafe_b64decode(enrollment["tunnelUpdateKey"] + "="), message, hashlib.sha256,
    ).digest()).decode().rstrip("=")
    request = urllib.request.Request(enrollment["portalOrigin"] + pathname, data=body, method="POST", headers={
        "content-type": "application/json", "authorization": f"CodeyTunnel {now}:{nonce}:{signature}",
    })
    # Redirects must not forward this request-bound credential to another host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    try:
        if opener is urllib.request.urlopen:
            opener = urllib.request.build_opener(NoRedirect).open
        with opener(request, timeout=30) as response:
            payload = json.loads(response.read(16384))
            if (response.status != 200 or payload.get("nodeId") != config["nodeId"] or not payload.get("ok")
                    or payload.get("expiresAt") != claims["exp"] * 1000):
                raise ServiceError("Portal rejected the node-bound tunnel credential")
    except (urllib.error.URLError, ValueError, OSError):
        raise ServiceError("Portal tunnel renewal failed; credentials were not printed or sent to a fallback host") from None
    status = {"ok": True, "nodeId": config["nodeId"], "renewedAt": now, "expiresAt": claims["exp"] * 1000}
    write_private(state_file, status)
    return status


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
    os.set_inheritable(lock.fileno(), True)
    os.chdir(config["releaseRoot"])
    os.execve(commands[mode][0], commands[mode], environment(config, enrollment))


if __name__ == "__main__":
    try:
        main()
    except (ServiceError, OSError, ValueError, subprocess.SubprocessError) as error:
        # Only our own sanitized errors are safe to print.
        print(str(error) if isinstance(error, ServiceError) else "Mac node service failed; check owner/runtime inputs", file=sys.stderr)
        sys.exit(1)
