"""Shared archive, runtime-build and authenticated HTTPS checks for native installers."""
import base64
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import shutil
import socket
import ssl
import subprocess
import tarfile
import time
import urllib.request

SKILL = Path(__file__).resolve().parents[1]


class SetupError(RuntimeError):
    pass


def run(args, check=True, cwd=None, env=None, log=None):
    command = [str(value) for value in args]
    if log:
        if shutil.which("nice"):
            command = ["nice", "-n", "15", *command]
        with Path(log).open("a") as output:
            result = subprocess.run(command, text=True, stdout=output, stderr=subprocess.STDOUT,
                                    cwd=cwd, env=env, timeout=1800)
    else:
        result = subprocess.run(command, text=True, capture_output=True, cwd=cwd, env=env, timeout=180)
    if check and result.returncode:
        # Never echo environment files, command output containing credentials,
        # complete process environments, or provider login output.
        if not log:
            log = Path.home() / ".config/codey-machine/last-command-error.log"
            protected_write(log, (result.stderr or "") + (result.stdout or ""))
        raise SetupError(f"{Path(str(args[0])).name} failed (exit {result.returncode}); protected diagnostic: {log}")
    return result


def protected_write(file, text):
    if file.is_symlink():
        raise SetupError(f"Refusing symbolic link: {file}")
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = file.with_name(file.name + ".next")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(text)
    os.replace(temporary, file)


def digest(file):
    value = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def unpack(archive, target, allowed_roots=("node", "cloudcli", "copilot-api", "release.json")):
    with tarfile.open(archive) as package:
        members = package.getmembers()
        if len(members) > 200000 or sum(member.size for member in members) > 8 * 1024 ** 3:
            raise SetupError("Unexpectedly large runtime archive")
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or member.isdev() or member.isfifo():
                raise SetupError("Unsafe runtime archive member")
            if allowed_roots is not None and name.parts and name.parts[0] not in allowed_roots:
                raise SetupError("Unexpected runtime archive root")
        package.extractall(target, members=members, filter="data")


def prepare_runtime(manifest, enrollment, root, stage, log):
    distribution = manifest["nodeDistribution"]
    downloads = root / "downloads"
    downloads.mkdir(exist_ok=True)
    archive = downloads / distribution["file"]
    if not archive.exists():
        temporary = archive.with_suffix(".part")
        try:
            with urllib.request.urlopen(distribution["url"], timeout=120) as response, temporary.open("wb") as output:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > 128 * 1024 * 1024:
                        raise SetupError("Unexpectedly large Node distribution")
                    output.write(chunk)
            if digest(temporary) != distribution["sha256"]:
                raise SetupError("Official Node checksum mismatch")
            os.replace(temporary, archive)
        finally:
            temporary.unlink(missing_ok=True)
    if archive.is_symlink() or digest(archive) != distribution["sha256"]:
        raise SetupError("Cached Node distribution checksum mismatch")
    prefix = f"node-v{manifest['node']}-linux-x64"
    unpack(archive, stage, (prefix,))
    os.replace(stage / prefix, stage / "node")
    for component in ["cloudcli", "copilot-api"]:
        target = stage / component
        target.mkdir()
        unpack(SKILL / "assets" / f"{component}-source.tar.gz", target, None)
    env = {
        **os.environ, "PATH": str(stage / "node/bin") + os.pathsep + os.environ.get("PATH", ""),
        "HUSKY": "0", "SKIP_INSTALL_SIMPLE_GIT_HOOKS": "1", "CI": "true",
        "ELECTRON_SKIP_BINARY_DOWNLOAD": "1", "npm_config_jobs": "2",
        "npm_config_audit": "false", "npm_config_fund": "false",
        "npm_config_cache": str(root / "npm-cache"),
    }
    node, npm = stage / "node/bin/node", stage / "node/bin/npm"
    tools = stage / ".build-tools"
    run([npm, "install", "--prefix", tools, "--no-audit", "--no-fund",
         f"bun@{manifest['bunBuildTool']}"], env=env, log=log)
    bun = tools / "node_modules/.bin/bun"
    copilot = stage / "copilot-api"
    run([bun, "install", "--frozen-lockfile", "--ignore-scripts"], cwd=copilot, env=env, log=log)
    run([bun, "run", "build"], cwd=copilot, env=env, log=log)
    run([bun, "install", "--frozen-lockfile", "--production", "--ignore-scripts"], cwd=copilot, env=env, log=log)
    cloudcli = stage / "cloudcli"
    run([npm, "ci", "--no-audit", "--no-fund"], cwd=cloudcli, env=env, log=log)
    build_env = {
        **env, "VITE_BASE_PATH": f"/cloudcli/{enrollment['nodeId']}/",
        "VITE_CODEY_MANAGED": "true", "VITE_CODEY_PORTAL_SSO": "true",
    }
    run([npm, "run", "build"], cwd=cloudcli, env=build_env, log=log)
    run([npm, "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=cloudcli, env=env, log=log)
    run([node, cloudcli / "node_modules/@openai/codex/bin/codex.js", "--version"], env=env, log=log)
    shutil.rmtree(tools)
    protected_write(stage / "release.json", json.dumps(manifest, indent=2) + "\n")


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def signed(payload, key):
    encoded = b64(json.dumps(payload, separators=(",", ":")).encode())
    return encoded + "." + b64(hmac.new(key, encoded.encode(), hashlib.sha256).digest())


def local_probe(ip, port, server_name, cert, pathname, headers=None):
    context = ssl.create_default_context(cafile=str(cert))
    # Connect to the private listener, but validate the exact reserved DNS SAN.
    class Connection(http.client.HTTPSConnection):
        def connect(self):
            self.sock = context.wrap_socket(socket.create_connection((ip, port), timeout=5), server_hostname=server_name)
    connection = Connection(server_name, port, timeout=5, context=context)
    try:
        connection.request("GET", pathname, headers=headers or {})
        response = connection.getresponse()
        body = response.read(1024 * 1024)
        return response.status, json.loads(body)
    finally:
        connection.close()


def quota_available(status, body):
    """Quota telemetry is not model health. Authentication/protocol failures stay fatal."""
    if status == 200 and isinstance(body, dict) and "error" not in body:
        return True
    if (status == 200 and body is None) or status in (404, 429) or 500 <= status <= 599:
        return False
    raise SetupError(f"Authenticated quota probe failed: HTTP {status}")


def verify(enrollment, network, cert):
    node_id = enrollment["nodeId"]
    server_name = f"{node_id}.nodes.codey.internal"
    ip = network["listenIp"]
    now = int(time.time())
    ticket = signed({"v": 1, "aud": node_id, "sub": enrollment["principalId"], "scope": ["history", "usage"],
                     "iat": now, "exp": now + 60}, enrollment["clientSigningKey"].encode())
    health_status, health = local_probe(ip, 8443, server_name, cert, "/healthz")
    if health_status != 200:
        raise SetupError("HTTPS health probe failed")
    headers = {"authorization": "Bearer " + ticket}
    usage_status, usage_body = local_probe(ip, 8443, server_name, cert, "/usage", headers)
    if enrollment.get("network") != {"mode": "devtunnel"}:
        raise SetupError("The active installer requires a private DevTunnel package")
    usage = quota_available(usage_status, usage_body)
    if not usage:
        owner_bound = isinstance(health, dict) and (
            health.get("relay") == "codey-node-relay" or (
                enrollment.get("platform") == "linux-x64"
                and health.get("service") == "copilot-api-codey-https"))
        if (not owner_bound
                or health.get("nodeId") != node_id):
            raise SetupError(f"Authenticated probe failed: /usage returned HTTP {usage_status}")
        status, body = local_probe(ip, 8443, server_name, cert, "/token-usage", headers)
        if status != 200 or not isinstance(body, dict) or "error" in body:
            raise SetupError(f"Authenticated token usage probe failed: HTTP {status}")
        if local_probe(ip, 8443, server_name, cert, "/token-usage")[0] != 401:
            raise SetupError("Anonymous token usage must be denied")
    status = local_probe(ip, 8443, server_name, cert, "/session-history?state=all&limit=1", headers)[0]
    if status != 200:
        raise SetupError(f"Authenticated History probe failed: HTTP {status}")
    if local_probe(ip, 8443, server_name, cert, "/usage")[0] != 401:
        raise SetupError("Anonymous Usage must be denied")
    pathname = "/api/auth/status"
    assertion = signed({
        "iss": "codey-portal", "aud": node_id, "sub": enrollment["principalId"], "username": enrollment["username"],
        "sid": secrets.token_hex(32), "method": "GET", "path": pathname,
        "iat": now, "exp": now + 20, "nonce": b64(secrets.token_bytes(16)),
    }, base64.urlsafe_b64decode(enrollment["workspaceSsoKey"] + "="))
    status, body = local_probe(ip, 3001, server_name, cert, pathname, {"x-codey-workspace-assertion": assertion})
    if status != 200 or body.get("managedAuthentication") is not True or body.get("user", {}).get("username") != enrollment["username"]:
        raise SetupError("Workspace SSO binding probe failed")
    if local_probe(ip, 3001, server_name, cert, pathname)[0] != 401:
        raise SetupError("Anonymous Workspace must be denied")
    return {
        "usage": usage, "usageHttpStatus": usage_status, "history": True, "workspaceSso": True,
        "anonymousDenied": True, **({"tokenUsage": True} if not usage else {}),
        "warnings": [] if usage else ["copilot_quota_unavailable_model_inference_not_tested"],
    }


def unit(description, command, directory, environment, service_path):
    return f"""[Unit]
Description={description}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
Environment=HOME=%h
Environment=PATH={service_path}
Environment=NODE_ENV=production
EnvironmentFile={environment}
WorkingDirectory={directory}
ExecStart={command}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
Nice=5
CPUWeight=50

[Install]
WantedBy=default.target
"""
