#!/usr/bin/env python3
"""Install the bundled Codey services; preserve existing workloads and identities."""
import argparse
import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import tarfile
import time
import urllib.request
from urllib.parse import urlsplit

SKILL = Path(__file__).resolve().parents[1]
SERVICES = ["codey-copilot-api.service", "codey-cloudcli.service"]
NODE_ID = re.compile(r"^n-[a-f0-9]{24}$")


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


def validate_inputs(enrollment, manifest, network):
    node_id = enrollment.get("nodeId", "")
    if enrollment.get("schema") != 1 or not NODE_ID.fullmatch(node_id):
        raise SetupError("The ZIP must contain a real, reserved enrollment.json")
    if enrollment.get("expiresAt", 0) <= time.time() * 1000:
        raise SetupError("The enrollment has expired; download a fresh skill")
    if not re.fullmatch(r"[a-z0-9-]{1,80}", enrollment.get("principalId", "")) or not re.fullmatch(r"[a-z][a-z0-9_-]{2,31}", enrollment.get("username", "")):
        raise SetupError("Invalid enrollment owner")
    for name in ["clientSigningKey", "workspaceSsoKey"]:
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", enrollment.get(name, "")):
            raise SetupError(f"Invalid enrollment field: {name}")
    origin = urlsplit(enrollment.get("portalOrigin", ""))
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment:
        raise SetupError("Portal origin must be an exact HTTPS origin")
    if manifest.get("schema") != 1 or manifest.get("platform") != "linux-x64" or manifest.get("releaseId") != enrollment.get("releaseId"):
        raise SetupError("Enrollment and runtime release do not match")
    if network.get("schema") != 1 or network.get("nodeId") != node_id or network.get("networkMode") not in ("same-vnet", "peering", "private-link"):
        raise SetupError("Run azure-vnet.py for this invitation first; do not reuse another node's network file")
    for name in ["listenIp", "privateIp"]:
        try:
            ip = ipaddress.ip_address(network[name])
            if not any(ip in ipaddress.ip_network(prefix) for prefix in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
                raise ValueError("Not RFC1918")
        except (ValueError, KeyError):
            raise SetupError("The node listener and gateway must use RFC1918 IPv4")
    version = manifest.get("node", "")
    bun = manifest.get("bunBuildTool", "")
    distribution = manifest.get("nodeDistribution", {})
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch(r"\d+\.\d+\.\d+", bun):
        raise SetupError("Runtime versions must be pinned")
    expected_file = f"node-v{version}-linux-x64.tar.xz"
    if distribution.get("file") != expected_file or distribution.get("url") != f"https://nodejs.org/dist/v{version}/{expected_file}" or not re.fullmatch(r"[a-f0-9]{64}", distribution.get("sha256", "")):
        raise SetupError("Node must come from the pinned official distribution and checksum")
    artifacts = manifest.get("artifacts", [])
    if [item.get("file") for item in artifacts] != ["cloudcli-source.tar.gz", "copilot-api-source.tar.gz"]:
        raise SetupError("The reviewed Codey source packages are missing")
    if any(not re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", "")) or not isinstance(item.get("size"), int) or item["size"] <= 0 for item in artifacts):
        raise SetupError("Source checksum metadata is invalid")
    identity = "\n".join([version, bun, distribution["sha256"]] + [item["sha256"] for item in artifacts])
    if manifest.get("dependencyMode") != "install-on-target" or manifest["releaseId"] != "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]:
        raise SetupError("Dependency release identity is inconsistent")
    return artifacts


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


def verify(enrollment, network, cert):
    node_id = enrollment["nodeId"]
    server_name = f"{node_id}.nodes.codey.internal"
    ip = network["listenIp"]
    now = int(time.time())
    ticket = signed({"v": 1, "aud": node_id, "sub": enrollment["principalId"], "scope": ["history", "usage"],
                     "iat": now, "exp": now + 60}, enrollment["clientSigningKey"].encode())
    if local_probe(ip, 8443, server_name, cert, "/healthz")[0] != 200:
        raise SetupError("HTTPS health probe failed")
    for path in ["/usage", "/session-history?state=all&limit=1"]:
        status = local_probe(ip, 8443, server_name, cert, path, {"authorization": "Bearer " + ticket})[0]
        if status != 200:
            raise SetupError(f"Authenticated probe failed: {path} returned HTTP {status}")
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


def unit(description, command, directory, environment, service_path):
    return f"""[Unit]
Description={description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=%h
Environment=PATH={service_path}
Environment=NODE_ENV=production
EnvironmentFile={environment}
WorkingDirectory={directory}
ExecStart={command}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
Nice=5
CPUWeight=50

[Install]
WantedBy=default.target
"""


def emit_machine(enrollment, network, cert, output, name=None, already_configured=False):
    machine = {
        "schema": 1, "nodeId": enrollment["nodeId"], "name": name or network["name"],
        "region": network["region"], "privateIp": network["privateIp"],
        "tlsCertificate": cert.read_text(), "networkMode": network["networkMode"],
        "vmResourceId": network["vmResourceId"],
    }
    protected_write(output, json.dumps(machine, indent=2) + "\n")
    print(json.dumps({
        "ok": True, "nodeId": enrollment["nodeId"], "machineFile": str(output),
        "localHttps": True, "usageHistory": True, "workspaceSso": True, "anonymousDenied": True,
        "alreadyConfigured": already_configured,
        "next": "Import codey-machine.json in Codey; Portal must verify the actual VNet path and WebSocket before adding",
        "modelAuthentication": "not tested; use the owner's existing Codex login or the bundled copilot-api auth login",
        "rebootTested": False,
    }, indent=2))


def configure(args):
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64") or os.geteuid() == 0:
        raise SetupError("Run as the target owner (not root), on Linux x64; Windows Codex can orchestrate this over SSH/Azure")
    if not hasattr(tarfile, "data_filter"):
        raise SetupError("Python with safe tar extraction is required (Python 3.12 on Ubuntu 24.04)")
    home = Path.home().resolve()
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(home)):
        raise SetupError("This systemd installer requires a home path without whitespace or systemd specifiers")
    os.umask(0o077)
    enrollment_file = Path(args.enrollment).resolve()
    enrollment = json.loads(enrollment_file.read_text())
    manifest = json.loads((SKILL / "assets/manifest.json").read_text())
    network = json.loads(Path(args.network_file).read_text())
    artifacts = validate_inputs(enrollment, manifest, network)
    for artifact in artifacts:
        archive = SKILL / "assets" / artifact["file"]
        if archive.stat().st_size != artifact["size"] or digest(archive) != artifact["sha256"]:
            raise SetupError("A reviewed source package is missing, truncated or has the wrong checksum")
    root = home / ".local/share/codey-machine"
    config = home / ".config/codey-machine"
    state_file = config / "installation.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else None
    network_hash = hashlib.sha256(json.dumps(network, sort_keys=True).encode()).hexdigest()
    if state and (state.get("nodeId") != enrollment["nodeId"] or state.get("networkSha256") != network_hash):
        raise SetupError("This OS account already has a different Codey machine/release; do not overwrite its identity")
    if state and state.get("releaseId") != manifest["releaseId"] and (state.get("ready") or not args.retry_failed):
        raise SetupError("A different release exists; only an unfinished installation may be retried with --retry-failed")
    service_dir = home / ".config/systemd/user"
    if not state:
        if config.exists() and any(config.iterdir()):
            raise SetupError("An unrecognized Codey configuration exists; review instead of overwriting")
        for name in SERVICES + ["copilot-api.service"]:
            existing = run(["systemctl", "--user", "show", name, "-p", "FragmentPath", "--value"], check=False)
            if existing.stdout.strip():
                raise SetupError(f"An existing {name} must be reviewed before any takeover")
        for host, port in [(network["listenIp"], 8443), (network["listenIp"], 3001), ("127.0.0.1", 4141)]:
            try:
                with socket.socket() as probe:
                    probe.bind((host, port))
            except OSError:
                raise SetupError(f"Required listener {host}:{port} is occupied or not local; no process was stopped")
    summary = {
        "nodeId": enrollment["nodeId"], "releaseId": manifest["releaseId"],
        "services": SERVICES, "listenIp": network["listenIp"], "modelApi": "127.0.0.1:4141",
        "installationRoot": str(root), "configRoot": str(config),
        "enableLinger": args.enable_linger, "existingCodexConfig": "preserved",
        "dependencyInstallation": f"Download verified Node {manifest['node']}; install locked npm/Bun dependencies and build in a separate release",
        "providerLogin": "Owner authentication is separate; no shared provider credentials are bundled",
    }
    if not args.apply:
        print(json.dumps(summary, indent=2))
        return
    if shutil.disk_usage(home).free < 8 * 1024 ** 3:
        raise SetupError("At least 8 GiB free disk space is required for isolated dependency installation/build")
    if state and state.get("ready"):
        verify(enrollment, network, config / "node-cert.pem")
        emit_machine(enrollment, network, config / "node-cert.pem", Path(args.out).resolve(), args.name, True)
        return
    lock = home / ".codey-machine-install.lock"
    with lock.open("x") as handle:
        handle.write(str(os.getpid()))
    started = []
    was_ready = state and state.get("ready")
    try:
        enrollment_file.chmod(0o600)
        config.mkdir(parents=True, exist_ok=True, mode=0o700)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not state:
            state = {**summary, "ready": False, "networkSha256": network_hash}
            protected_write(state_file, json.dumps(state, indent=2) + "\n")
        elif state.get("releaseId") != manifest["releaseId"]:
            for service in SERVICES:
                if run(["systemctl", "--user", "is-active", service], check=False).stdout.strip() == "active":
                    raise SetupError("Stop/review the unfinished Codey service before changing its release")
            state["previousFailedRelease"] = state["releaseId"]
            state["releaseId"] = manifest["releaseId"]
            protected_write(state_file, json.dumps(state, indent=2) + "\n")
        release = root / "releases" / manifest["releaseId"]
        if not release.exists():
            stage = release.with_name(release.name + ".staging")
            if stage.exists():
                if not args.retry_failed or stage.is_symlink():
                    raise SetupError("A partial runtime stage exists; review then use --retry-failed to rebuild only that stage")
                shutil.rmtree(stage)
            stage.mkdir(parents=True)
            prepare_runtime(manifest, enrollment, root, stage, config / "dependency-build.log")
            os.replace(stage, release)
        node = release / "node/bin/node"
        cloudcli = release / "cloudcli"
        copilot = release / "copilot-api"
        for file in [node, cloudcli / "dist-server/server/index.js", copilot / "dist/main.js"]:
            if not file.is_file():
                raise SetupError("Incomplete offline runtime")
        run([node, "-e",
             "require('better-sqlite3')(':memory:').close();"
             "const p=require('node-pty').spawn('/bin/sh',['-c','exit 0'],{env:process.env});"
             "p.onExit(e=>process.exit(e.exitCode));setTimeout(()=>process.exit(1),5000).unref();"],
            cwd=cloudcli)
        cert, key = config / "node-cert.pem", config / "node-key.pem"
        if not cert.exists() and not key.exists():
            server_name = f"{enrollment['nodeId']}.nodes.codey.internal"
            run(["openssl", "req", "-x509", "-newkey", "rsa:3072", "-noenc", "-days", "365",
                 "-keyout", key, "-out", cert, "-subj", f"/CN={server_name}",
                 "-addext", f"subjectAltName=DNS:{server_name}",
                 "-addext", "basicConstraints=critical,CA:FALSE",
                 "-addext", "keyUsage=critical,digitalSignature,keyEncipherment", "-addext", "extendedKeyUsage=serverAuth"])
        if not cert.exists() or not key.exists():
            raise SetupError("Incomplete node TLS material; do not replace only one half of a keypair")
        cert.chmod(0o600)
        key.chmod(0o600)
        protected_write(config / "client-signing.key", enrollment["clientSigningKey"] + "\n")
        data = root / "data"
        (data / "copilot-api").mkdir(parents=True, exist_ok=True)
        provider_config = data / "copilot-api/config.json"
        if not provider_config.exists():
            protected_write(provider_config, json.dumps({"auth": {
                "apiKeys": [b64(secrets.token_bytes(32))], "adminApiKey": b64(secrets.token_bytes(32)),
                "sessionHistoryApiKey": b64(secrets.token_bytes(32)),
            }}, indent=2) + "\n")
        protected_write(config / "copilot.env", "\n".join([
            f"COPILOT_API_HOME={data}/copilot-api", "COPILOT_API_CODEY_HTTPS_PORT=8443",
            f"COPILOT_API_CODEY_HTTPS_HOST={network['listenIp']}",
            f"COPILOT_API_CODEY_TLS_CERT={cert}", f"COPILOT_API_CODEY_TLS_KEY={key}",
            f"COPILOT_API_CODEY_NODE_ID={enrollment['nodeId']}",
            f"COPILOT_API_CODEY_ALLOWED_ORIGIN={enrollment['portalOrigin']}",
            f"COPILOT_API_CODEY_SIGNING_KEY_FILE={config}/client-signing.key", "",
        ]))
        protected_write(config / "cloudcli.env", "\n".join([
            "CODEY_MANAGED=true", "CODEY_PORTAL_SSO=true", "SERVER_PORT=3001",
            f"HOST={network['listenIp']}", f"DATABASE_PATH={data}/cloudcli/auth.db",
            f"CODEY_PORTAL_NODE_ID={enrollment['nodeId']}", f"CODEY_PORTAL_USERNAME={enrollment['username']}",
            f"CODEY_PORTAL_PRINCIPAL_ID={enrollment['principalId']}", f"CODEY_PORTAL_SSO_KEY={enrollment['workspaceSsoKey']}",
            f"CODEY_PORTAL_TLS_CERT={cert}", f"CODEY_PORTAL_TLS_KEY={key}", "",
        ]))
        (data / "cloudcli").mkdir(exist_ok=True)
        bins = root / "bin"
        bins.mkdir(exist_ok=True)
        existing_codex = shutil.which("codex")
        if existing_codex and Path(existing_codex).resolve() == (bins / "codex").resolve():
            existing_codex = None
        codex = Path(existing_codex) if existing_codex else cloudcli / "node_modules/@openai/codex/bin/codex.js"
        protected_write(bins / "codex", f"#!/bin/sh\nexec \"{codex}\" \"$@\"\n")
        (bins / "codex").chmod(0o700)
        protected_write(bins / "copilot-api", f"#!/bin/sh\nexport COPILOT_API_HOME=\"{data}/copilot-api\"\nexec \"{node}\" \"{copilot}/dist/main.js\" \"$@\"\n")
        (bins / "copilot-api").chmod(0o700)
        service_path = f"{bins}:{release}/node/bin:{home}/.local/bin:/usr/local/bin:/usr/bin:/bin"
        # Only referenced provider variables from the invoking owner's environment.
        # No sourcing .bashrc, exporting all env, or copying another user's config.
        provider_env = config / "provider.env"
        if not provider_env.exists():
            values = []
            codex_config = home / ".codex/config.toml"
            if codex_config.exists():
                import tomllib
                parsed = tomllib.loads(codex_config.read_text())
                for provider in parsed.get("model_providers", {}).values():
                    name = provider.get("env_key")
                    if name and re.fullmatch(r"[A-Z_][A-Z0-9_]*", name) and name in os.environ:
                        value = os.environ[name]
                        if "\n" in value or "\r" in value or "\0" in value:
                            raise SetupError("Provider environment value must be a single line")
                        values.append(name + "=" + json.dumps(value))
            protected_write(provider_env, "\n".join(values) + "\n")
        for name, content in [
            (SERVICES[0], unit("Codey machine Copilot API (owner login required for models)",
             f"{node} {copilot}/dist/main.js start --headless --host 127.0.0.1 --port 4141",
             copilot, config / "copilot.env", service_path)),
            (SERVICES[1], unit("Codey machine CloudCLI Workspace",
             f"{node} {cloudcli}/dist-server/server/index.js", cloudcli, config / "cloudcli.env", service_path)
             .replace("WorkingDirectory=", f"EnvironmentFile={provider_env}\nWorkingDirectory=")),
        ]:
            protected_write(service_dir / name, content)
        if args.enable_linger:
            run(["loginctl", "enable-linger", run(["id", "-un"]).stdout.strip()])
        if not was_ready:
            run(["systemctl", "--user", "daemon-reload"])
            for service in SERVICES:
                started.append(service)
                run(["systemctl", "--user", "enable", "--now", service])
        error = None
        for _ in range(20):
            try:
                verify(enrollment, network, cert)
                error = None
                break
            except (SetupError, OSError, http.client.HTTPException, ValueError) as failure:
                error = failure
                time.sleep(2)
        if error:
            raise SetupError(f"Local TLS/authentication verification failed ({error}); no machine import file was produced")
        output = Path(args.out).resolve()
        state["ready"] = True
        state["machineFile"] = str(output)
        protected_write(state_file, json.dumps(state, indent=2) + "\n")
        emit_machine(enrollment, network, cert, output, args.name)
    except Exception:
        if not was_ready:
            for service in reversed(started):
                run(["systemctl", "--user", "disable", "--now", service], check=False)
        raise
    finally:
        lock.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enrollment", default=str(SKILL / "assets/enrollment.json"))
    parser.add_argument("--network-file", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--name")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--retry-failed", action="store_true", help="Retry only this same, unfinished machine identity; never upgrade a ready service")
    parser.add_argument("--enable-linger", action="store_true", help="Explicitly enable this owner's user services after SSH logout")
    try:
        configure(parser.parse_args())
    except (SetupError, FileExistsError, KeyError, ValueError) as error:
        raise SystemExit(str(error))
