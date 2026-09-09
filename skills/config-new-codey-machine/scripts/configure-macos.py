#!/usr/bin/env python3
"""Prepare an owner-bound macOS CloudCLI node without changing existing services."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import pwd
import re
import shutil
import socket
import subprocess
import sys
import time
import tomllib
import urllib.parse
import urllib.request

SKILL = Path(__file__).resolve().parents[1]
NODE_ID = re.compile(r"n-[a-f0-9]{24}")


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, SKILL / "scripts" / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


common = module("codey_machine_common", "configure-machine.py")
service = module("codey_macos_service", "macos-service.py")
Error = service.ServiceError
write_private = service.write_private
digest = service.digest


def run(args, *, cwd=None, env=None, log=None, check=True, timeout=180):
    if log:
        with Path(log).open("a") as stream:
            result = subprocess.run([str(x) for x in args], cwd=cwd, env=env, text=True,
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=1800)
    else:
        result = subprocess.run([str(x) for x in args], cwd=cwd, env=env, text=True,
                                capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise Error(f"{Path(args[0]).name} failed (exit {result.returncode}); existing services were not changed")
    return result


def validate(enrollment, manifest, target, *, ready=False):
    if target not in ("macos-arm64", "macos-x64"):
        raise Error("Unsupported Mac architecture")
    if enrollment.get("schema") != 1 or not NODE_ID.fullmatch(enrollment.get("nodeId", "")):
        raise Error("Download your personalized macOS package from Codey first")
    if not ready and enrollment.get("expiresAt", 0) <= time.time() * 1000:
        raise Error("The reserved identity has expired")
    if (enrollment.get("platform") != target or manifest.get("platform") != target
            or manifest.get("schema") != 1 or enrollment.get("releaseId") != manifest.get("releaseId")):
        raise Error("This package does not match this Mac's architecture or reserved identity")
    if not re.fullmatch(r"[a-z0-9-]{1,80}", enrollment.get("principalId", "")) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", enrollment.get("username", "")):
        raise Error("Invalid node owner")
    for key in ("clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey"):
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", enrollment.get(key, "")):
            raise Error("Missing node-specific enrollment credential")
    origin = urllib.parse.urlsplit(enrollment.get("portalOrigin", ""))
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment:
        raise Error("Portal origin must be an exact HTTPS origin")
    if enrollment.get("network") != {"mode": "devtunnel"}:
        raise Error("Mac nodes require the private DevTunnel enrollment, not Azure VNet files")
    version = manifest.get("node", "")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch(r"\d+\.\d+\.\d+", manifest.get("bunBuildTool", "")):
        raise Error("Runtime versions must be pinned")
    suffix = "darwin-arm64.tar.gz" if target == "macos-arm64" else "darwin-x64.tar.gz"
    file = f"node-v{version}-{suffix}"
    distribution = manifest.get("nodeDistribution", {})
    if (distribution.get("file") != file or distribution.get("url") != f"https://nodejs.org/dist/v{version}/{file}"
            or not re.fullmatch(r"[a-f0-9]{64}", distribution.get("sha256", ""))):
        raise Error("Expected a checksum-pinned official macOS Node distribution")
    artifacts = manifest.get("artifacts", [])
    if [item.get("file") for item in artifacts] != ["cloudcli-source.tar.gz", "copilot-api-source.tar.gz", "portal-node-source.tar.gz"]:
        raise Error("The complete reviewed Mac runtime sources are missing")
    if any(not re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", "")) or not isinstance(item.get("size"), int) or item["size"] <= 0 for item in artifacts):
        raise Error("Invalid source archive metadata")
    identity = "\n".join([version, manifest["bunBuildTool"], distribution["sha256"]] + [item["sha256"] for item in artifacts])
    if manifest.get("dependencyMode") != "install-on-target" or manifest["releaseId"] != "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]:
        raise Error("Release identity does not match its pinned dependencies")
    return artifacts


def normalize_registry(lock, registry):
    """Rebase registry tarball locations only; preserve every version/integrity."""
    target = urllib.parse.urlsplit(registry)
    if target.scheme != "https" or not target.hostname or target.username or target.password or target.query or target.fragment:
        raise Error("npm registry must be a credential-free HTTPS registry URL")
    value = json.loads(lock.read_text())
    allowed = {"registry.npmjs.org", "registry.npmmirror.com", "ms-feed-25.pkgs.visualstudio.com", target.hostname}
    for key, package in value.get("packages", {}).items():
        if not package.get("resolved"):
            continue
        source = urllib.parse.urlsplit(package["resolved"])
        if source.hostname not in allowed or source.scheme != "https" or not package.get("integrity"):
            raise Error("Unreviewed dependency source; refusing to weaken npm integrity or URL policy")
        # npm aliases retain their install-directory key, but tarballs use the
        # actual registry package name recorded in the lockfile.
        name = package.get("name", key.rsplit("node_modules/", 1)[-1])
        version = package.get("version", "")
        if (not isinstance(name, str) or not re.fullmatch(r"(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+", name)
                or not isinstance(version, str) or not re.fullmatch(r"\d[\w.+-]*", version)):
            raise Error("Invalid locked registry package")
        package["resolved"] = registry.rstrip("/") + "/" + name + "/-/" + name.rsplit("/", 1)[-1] + "-" + version + ".tgz"
    write_private(lock, value)


def build_runtime(manifest, root, release, registry, log):
    distribution = manifest["nodeDistribution"]
    archive = root / distribution["file"]
    if not archive.exists():
        part = archive.with_suffix(".part")
        run(["curl", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
             "--max-time", "180", "--output", str(part), distribution["url"]], log=log)
        if digest(part) != distribution["sha256"]:
            raise Error("Node distribution SHA-256 mismatch")
        os.replace(part, archive)
    if archive.is_symlink() or digest(archive) != distribution["sha256"]:
        raise Error("Cached Node distribution is invalid")
    release.mkdir(mode=0o700)
    prefix = distribution["file"].removesuffix(".tar.gz")
    common.unpack(archive, release, (prefix,))
    os.replace(release / prefix, release / "node")
    for component, name in (("cloudcli", "cloudcli-source.tar.gz"), ("portal-node", "portal-node-source.tar.gz")):
        destination = release / component
        destination.mkdir()
        common.unpack(SKILL / "assets" / name, destination, None)
    node = release / "node/bin/node"
    npm = release / "node/lib/node_modules/npm/bin/npm-cli.js"
    cloudcli = release / "cloudcli"
    normalize_registry(cloudcli / "package-lock.json", registry)
    env = {key: value for key, value in os.environ.items()
           if key in {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "DEVELOPER_DIR"}
           or key.lower() in {"http_proxy", "https_proxy", "no_proxy", "all_proxy"}}
    env.update({
        "PATH": str(node.parent) + ":" + os.environ.get("PATH", "/usr/bin:/bin"),
        "HUSKY": "0", "ELECTRON_SKIP_BINARY_DOWNLOAD": "1", "CI": "true",
        "npm_config_cache": str(root / "npm-cache"), "npm_config_registry": registry,
        "npm_config_audit": "false", "npm_config_fund": "false",
        "npm_config_maxsockets": "4", "npm_config_replace_registry_host": "never",
    })
    run([node, npm, "ci", "--no-audit", "--no-fund"], cwd=cloudcli, env=env, log=log)
    validation_home = root / "validation-home"
    validation_home.mkdir(exist_ok=True, mode=0o700)
    test_env = {**env, "HOME": str(validation_home), "TMPDIR": "/tmp",
                "CODEY_CODEX_DAEMON_SOCKET": ""}
    run([node, cloudcli / "node_modules/tsx/dist/cli.mjs", "--tsconfig", "server/tsconfig.json",
         "--test", "--test-concurrency=2",
         "server/modules/providers/tests/codex-windows-history.test.ts",
         "server/modules/providers/tests/codex-macos-transport.test.ts",
         "server/modules/providers/tests/codex-daemon-interop.test.ts",
         "server/modules/providers/tests/codex-steering.test.ts",
         "server/modules/auth/tests/portal-sso.service.test.ts",
         "server/modules/websocket/tests/portal-sso-websocket.test.ts",
         "server/modules/websocket/tests/shell-websocket.service.test.ts"],
        cwd=cloudcli, env=test_env, log=log)
    run([node, npm, "run", "typecheck"], cwd=cloudcli, env=test_env, log=log)
    run([node, npm, "run", "lint"], cwd=cloudcli, env=test_env, log=log)
    # Portal serves the already reviewed shared UI. Do not rebuild/replace it on this Mac.
    run([node, npm, "run", "build:server"], cwd=cloudcli, env=env, log=log)
    run([node, npm, "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=cloudcli, env=env, log=log)
    write_private(release / "release.json", manifest)


def port_busy(port):
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def desktop_codex(home):
    """Identify the installed Codex app by bundle ID, not a project/PATH shim."""
    for apps in (Path("/Applications"), home / "Applications"):
        for app in sorted(apps.glob("*.app")):
            try:
                with (app / "Contents/Info.plist").open("rb") as stream:
                    info = plistlib.load(stream)
                binary = app / "Contents/Resources/codex"
                if info.get("CFBundleIdentifier") == "com.openai.codex" and binary.is_file():
                    return binary
            except (OSError, ValueError, plistlib.InvalidFileException):
                continue
    raise Error("Provide --codex-bin pointing to the reviewed installed Codex native executable")


def normalize_tunnel(value):
    """Normalize CLI records, never token claims; require an explicit region."""
    record = value.get("tunnel", value) if isinstance(value, dict) else None
    if not isinstance(record, dict) or not isinstance(record.get("tunnelId"), str):
        raise Error("Invalid DevTunnel response")
    tunnel_id, cluster_id = record["tunnelId"], record.get("clusterId")
    if "." in tunnel_id:
        parts = tunnel_id.split(".")
        if len(parts) != 2:
            raise Error("Invalid qualified DevTunnel ID")
        tunnel_id, suffix = parts
        if "clusterId" in record and cluster_id != suffix:
            raise Error("DevTunnel returned conflicting regions")
        cluster_id = suffix
    if (not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,58}[a-z0-9]", tunnel_id)
            or not isinstance(cluster_id, str)
            or not re.fullmatch(r"[a-z][a-z0-9]{1,15}", cluster_id)):
        raise Error("Invalid DevTunnel coordinates")
    return {**record, "tunnelId": tunnel_id, "clusterId": cluster_id}


def token_bound_tunnel(executable, enrollment, config_root):
    state_file = config_root / "tunnel.json"
    requested = "codey-" + enrollment["nodeId"]
    description = "Codey macOS " + enrollment["nodeId"]
    pinned = None
    if state_file.exists():
        state = service.private_json(state_file)
        if not isinstance(state, dict) or state.get("requested") != requested:
            raise Error("Existing tunnel journal belongs to another node")
        if set(state) != {"requested"}:
            cluster = state.get("clusterId")
            if (state.get("tunnelId") != requested or not isinstance(cluster, str)
                    or not re.fullmatch(r"[a-z][a-z0-9]{1,15}", cluster)
                    or state.get("qualifiedId") != requested + "." + cluster):
                raise Error("Invalid existing tunnel journal; nothing was replaced")
            pinned = (requested, cluster)
        result = run([executable, "show", state.get("qualifiedId", requested), "--json"], check=False)
        if result.returncode:
            raise Error("The recorded tunnel is unavailable; do not create another identity")
    else:
        # Record intent first: if acknowledgement is lost, retry inspects this
        # exact name instead of creating a second tunnel.
        write_private(state_file, {"requested": requested})
        result = run([executable, "create", requested, "--description", description, "--json"])
    tunnel = normalize_tunnel(json.loads(result.stdout))
    tunnel_id, cluster_id = tunnel["tunnelId"], tunnel["clusterId"]
    if tunnel_id != requested or tunnel.get("description") != description:
        raise Error("The tunnel is not bound to this installation")
    if pinned is not None and pinned != (tunnel_id, cluster_id):
        raise Error("The recorded tunnel binding changed; nothing was replaced")
    qualified = tunnel_id + "." + cluster_id
    ports = tunnel.get("ports", [])
    if (not isinstance(ports, list) or any(not isinstance(entry, dict)
            or type(entry.get("portNumber")) is not int
            or entry["portNumber"] not in (3001, 8443) for entry in ports)):
        raise Error("This node tunnel contains unrelated ports")
    missing = []
    for port in (3001, 8443):
        matches = [entry for entry in ports if entry["portNumber"] == port]
        if len(matches) > 1 or (matches and matches[0].get("protocol") != "https"):
            raise Error("Existing tunnel port is not HTTPS")
        if not matches:
            missing.append(port)
    write_private(state_file, {"requested": requested, "qualifiedId": qualified, "tunnelId": tunnel_id, "clusterId": cluster_id})
    for port in missing:
        run([executable, "port", "create", qualified, "--port-number", str(port), "--protocol", "https", "--json"])
    return tunnel_id, cluster_id


def launch_agent(label, mode, config, runtime_path):
    agent = {
        "Label": label, "ProgramArguments": [str(Path(sys.executable).resolve()), "-I", config["worker"], mode, str(runtime_path)],
        "RunAtLoad": True, "ProcessType": "Background", "ThrottleInterval": 60, "Umask": 63,
        "WorkingDirectory": config["releaseRoot"],
        "StandardOutPath": str(Path(config["configRoot"]) / (mode + ".log")),
        "StandardErrorPath": str(Path(config["configRoot"]) / (mode + ".log")),
    }
    if mode == "renew":
        agent["StartInterval"] = 300
        agent["KeepAlive"] = {"SuccessfulExit": False}
    else:
        agent["KeepAlive"] = True
    return plistlib.dumps(agent).decode()


def verify_backend(config):
    # Exercise the actual production connector without loading/resuming a
    # conversation or sending a model prompt.
    script = """
import { pathToFileURL } from 'node:url';
const { CodexDaemonClient } = await import(pathToFileURL(process.argv[1]).href);
const client = await CodexDaemonClient.connect({socketPath: process.argv[2], timeoutMs: 3000});
try {
  if (!client) throw new Error('Missing configured backend');
  const result = await client.request('thread/loaded/list', {});
  if (!Array.isArray(result.data)) throw new Error('Invalid backend readiness response');
} finally { client?.close(); }
"""
    client = Path(config["releaseRoot"]) / "cloudcli/dist-server/server/modules/providers/list/codex/codex-daemon.client.js"
    run([config["nodeExe"], "--input-type=module", "-e", script, client, config["codexSocket"]], timeout=8)


def configure(args):
    if sys.platform != "darwin" or os.getuid() == 0:
        raise Error("Run this macOS installer as the signed-in owner, never root")
    target = "macos-arm64" if platform.machine() == "arm64" else "macos-x64" if platform.machine() == "x86_64" else ""
    enrollment = json.loads((SKILL / "assets/enrollment.json").read_text())
    manifest = json.loads((SKILL / "assets/manifest.json").read_text())
    node_id = enrollment.get("nodeId", "")
    if not NODE_ID.fullmatch(node_id):
        raise Error("Invalid reserved node ID")
    home = Path.home()
    root = home / ".local/share/codey-machine-macos" / node_id
    config_root = home / ".config/codey-machine-macos" / node_id
    runtime_path = config_root / "runtime.json"
    state_file = config_root / "installation.json"
    ready = state_file.is_file() and service.private_json(state_file).get("status") == "local-ready"
    artifacts = validate(enrollment, manifest, target, ready=ready)
    for artifact in artifacts:
        file = SKILL / "assets" / artifact["file"]
        if file.is_symlink() or file.stat().st_size != artifact["size"] or digest(file) != artifact["sha256"]:
            raise Error("Bundled source checksum mismatch")
    if ready:
        config, saved_enrollment = service.runtime(runtime_path)
        if config["releaseId"] != manifest["releaseId"]:
            raise Error("The first-install script cannot upgrade an existing node")
        common.verify(saved_enrollment, {"listenIp": "127.0.0.1"}, Path(config["certificate"]))
        verify_backend(config)
        write_private(args.out, service.private_json(config_root / "machine.json"))
        print(json.dumps({"ok": True, "reusedExistingServices": True, "output": str(args.out)}))
        return
    for port in (3001, 8443):
        if port_busy(port):
            raise Error(f"Port {port} is already used; no existing process will be stopped")
    if not port_busy(4141):
        raise Error("Configure/log in to your local model proxy first; this Mac installer will not replace it")
    if not args.name.strip() or len(args.name) > 80 or any(ord(c) < 32 for c in args.name):
        raise Error("Node name must be 1–80 characters without control characters")
    registry = urllib.parse.urlsplit(args.npm_registry)
    if registry.scheme != "https" or not registry.hostname or registry.username or registry.password or registry.query or registry.fragment:
        raise Error("npm registry must be a credential-free HTTPS registry")
    codex_home = Path(args.codex_home or home / ".codex").resolve()
    existing_config = tomllib.loads((codex_home / "config.toml").read_text())
    provider = existing_config.get("model_providers", {}).get(existing_config.get("model_provider"), {})
    auth = provider.get("auth", {})
    usage_key = args.usage_key_file
    if not usage_key and auth.get("command") == "cat" and len(auth.get("args", [])) == 1:
        usage_key = auth["args"][0]
    if not usage_key or not Path(usage_key).is_absolute() or not Path(usage_key).is_file():
        raise Error("Specify the existing local usage API key file; no provider key will be regenerated")
    codex = Path(args.codex_bin or desktop_codex(home)).resolve()
    devtunnel = Path(args.devtunnel_bin or shutil.which("devtunnel") or "").resolve()
    for file in (codex, devtunnel):
        if not file.is_file() or not os.access(file, os.X_OK):
            raise Error("Install/verify Codex and DevTunnel first; existing global tools will not be replaced")
    openssl = next((Path(p) for p in [
        args.openssl_bin, "/opt/homebrew/opt/openssl@3/bin/openssl",
        "/usr/local/opt/openssl@3/bin/openssl", shutil.which("openssl"),
    ] if p and Path(p).is_file() and os.access(p, os.X_OK)), None)
    if not openssl or not run([openssl, "version"]).stdout.startswith("OpenSSL 3."):
        raise Error("OpenSSL 3 is required; specify --openssl-bin or install Homebrew openssl@3")
    workspace = Path(args.workspace_root or (home / "code" if (home / "code").is_dir() else home / "Documents")).resolve()
    if not workspace.is_dir():
        raise Error("Workspace root must already exist")
    plan = {"platform": target, "nodeId": node_id, "mode": "private-devtunnel", "root": str(root),
            "loopbackPorts": [3001, 8443], "existingModelProxy": "127.0.0.1:4141 (unchanged)",
            "services": ["CloudCLI", "Codey-owned Codex backend", "read-only HTTPS data relay", "DevTunnel", "node-scoped token renewal"],
            "azurePermissionsRequiredByNode": False, "workspaceRoot": str(workspace), "npmRegistry": args.npm_registry}
    if not args.apply:
        print(json.dumps({"apply": False, "plan": plan}, indent=2))
        return
    logged_in = run([devtunnel, "user", "show"], check=False)
    if logged_in.returncode or "not logged in" in logged_in.stdout.lower():
        raise Error("Run devtunnel user login as this Mac owner before installing")
    if (root.exists() or config_root.exists()) and not args.retry_failed:
        raise Error("Installation files already exist; review them and use --retry-failed for this same unfinished identity")
    if args.retry_failed and (root.exists() or config_root.exists()):
        if not state_file.is_file():
            raise Error("Unrecognized installation directories will not be reused")
        previous = service.private_json(state_file)
        if previous.get("nodeId") != node_id or previous.get("uid") != os.getuid() or previous.get("status") not in ("building", "needs-attention"):
            raise Error("Retry is only allowed for this owner's unfinished installation")
        for mode in ("codex", "workspace", "data", "tunnel", "renew"):
            label = "com.codey." + node_id + "." + mode
            if run(["launchctl", "print", f"gui/{os.getuid()}/{label}"], check=False).returncode == 0:
                raise Error("A previous launchd job is still loaded; inspect it before retrying")
    for directory in (root, config_root):
        if directory.is_symlink():
            raise Error("Refusing an installation directory symlink")
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(directory, 0o700)
    write_private(state_file, {"status": "building", "nodeId": node_id, "uid": os.getuid()})
    log = config_root / "dependency-build.log"
    if log.is_symlink():
        raise Error("Refusing a symbolic-link dependency log")
    if not log.exists():
        write_private(log, "")
    created = []
    try:
        release = root / manifest["releaseId"]
        if release.exists():
            if not args.retry_failed:
                raise Error("Release directory already exists")
            shutil.rmtree(release)
        build_runtime(manifest, root, release, args.npm_registry, log)
        certificate, private_key = config_root / "node.pem", config_root / "node.key"
        if not certificate.exists() and not private_key.exists():
            dns = node_id + ".nodes.codey.internal"
            run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "365",
                 "-keyout", private_key, "-out", certificate, "-subj", "/CN=" + dns,
                 "-addext", "subjectAltName=DNS:" + dns, "-addext", "basicConstraints=critical,CA:FALSE",
                 "-addext", "keyUsage=critical,digitalSignature,keyEncipherment", "-addext", "extendedKeyUsage=serverAuth"])
            os.chmod(private_key, 0o600)
        if not certificate.is_file() or not private_key.is_file():
            raise Error("Incomplete TLS identity; existing certificate/key was not replaced")
        write_private(config_root / "enrollment.json", enrollment)
        write_private(config_root / "ticket.key", enrollment["clientSigningKey"])
        write_private(config_root / "macos-service.py", (SKILL / "scripts/macos-service.py").read_text())
        tunnel_id, cluster_id = token_bound_tunnel(devtunnel, enrollment, config_root)
        node = release / "node/bin/node"
        provider_env = {}
        if provider.get("env_key"):
            name = provider["env_key"]
            if (not re.fullmatch(r"[A-Z_][A-Z0-9_]*", name) or not os.environ.get(name)
                    or name.startswith("CODEY_") or name in {
                        "HOME", "PATH", "USER", "HOST", "NODE_ENV", "DATABASE_PATH",
                        "CODEX_HOME", "CODEX_THREAD_ID", "CODEX_PARENT_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
                    }):
                raise Error("A referenced provider environment credential is missing; existing configuration was not changed")
            provider_env[name] = os.environ[name]
        config = {
            "schema": 1, "uid": os.getuid(), "nodeId": node_id, "name": args.name, "releaseId": manifest["releaseId"],
            "home": str(home), "osUser": pwd.getpwuid(os.getuid()).pw_name, "releaseRoot": str(release), "configRoot": str(config_root),
            "enrollmentFile": str(config_root / "enrollment.json"), "worker": str(config_root / "macos-service.py"),
            "nodeExe": str(node), "nodeSha256": digest(node), "devtunnelExe": str(devtunnel), "devtunnelSha256": digest(devtunnel),
            "codexExe": str(codex), "codexHome": str(codex_home), "workspaceRoot": str(workspace),
            "codexSocket": f"/private/tmp/codey-{os.getuid()}/{node_id}.sock",
            "servicePath": ":".join([str(node.parent), str(codex.parent), str(Path(sys.executable).resolve().parent),
                                    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
            "workspaceEntry": str(release / "cloudcli/dist-server/server/index.js"),
            "dataEntry": str(release / "portal-node/node-relay/server.mjs"),
            "databasePath": str(config_root / "auth.db"), "certificate": str(certificate), "privateKey": str(private_key),
            "ticketKeyFile": str(config_root / "ticket.key"), "usageUrl": "http://127.0.0.1:4141/",
            "usageKeyFile": str(Path(usage_key).resolve()), "providerEnv": provider_env,
            "tunnelId": tunnel_id, "clusterId": cluster_id,
        }
        write_private(runtime_path, config)
        service.renew(config, enrollment, force=True)
        agents = home / "Library/LaunchAgents"
        agents.mkdir(parents=True, exist_ok=True)
        for mode in ("codex", "workspace", "data", "tunnel", "renew"):
            label = "com.codey." + node_id + "." + mode
            plist = agents / (label + ".plist")
            if plist.exists() or run(["launchctl", "print", f"gui/{os.getuid()}/{label}"], check=False).returncode == 0:
                raise Error("A LaunchAgent with this identity already exists; it was not replaced")
            write_private(plist, launch_agent(label, mode, config, runtime_path))
            # Include our file in rollback even if launchctl refuses bootstrap.
            created.append((label, plist))
            run(["launchctl", "bootstrap", f"gui/{os.getuid()}", plist])
        deadline = time.monotonic() + 45
        while True:
            try:
                common.verify(enrollment, {"listenIp": "127.0.0.1"}, certificate)
                verify_backend(config)
                break
            except (OSError, ValueError, common.SetupError, Error):
                if time.monotonic() >= deadline:
                    raise Error("Local authenticated HTTPS checks failed; inspect owner-only service logs")
                time.sleep(1)
        machine = {"schema": 1, "nodeId": node_id, "platform": target, "name": args.name, "region": "macOS · DevTunnel",
                   "networkMode": "devtunnel", "tlsCertificate": certificate.read_text(),
                   "devTunnel": {"tunnelId": tunnel_id, "clusterId": cluster_id}}
        write_private(config_root / "machine.json", machine)
        write_private(args.out, machine)
        write_private(state_file, {"status": "local-ready", "nodeId": node_id, "uid": os.getuid(), "releaseId": manifest["releaseId"],
                                   "launchAgents": [label for label, _ in created]})
        print(json.dumps({"ok": True, "localReady": True, "portalActivationRequired": True, "output": str(args.out)}, indent=2))
    except Exception:
        for label, plist in reversed(created):
            run(["launchctl", "bootout", f"gui/{os.getuid()}/{label}"], check=False)
            plist.unlink(missing_ok=True)
        write_private(state_file, {"status": "needs-attention", "nodeId": node_id, "uid": os.getuid(),
                                   "note": "Only this attempt's new LaunchAgents were stopped; existing services are unchanged"})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--name", default="Mac")
    parser.add_argument("--codex-home")
    parser.add_argument("--codex-bin")
    parser.add_argument("--devtunnel-bin")
    parser.add_argument("--openssl-bin")
    parser.add_argument("--usage-key-file")
    parser.add_argument("--workspace-root")
    parser.add_argument("--npm-registry", default="https://registry.npmjs.org/")
    parser.add_argument("--out", type=Path, default=SKILL / "output/codey-machine.json")
    try:
        configure(parser.parse_args())
    except (Error, common.SetupError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error) if isinstance(error, (Error, common.SetupError)) else "Mac node setup failed; inspect the owner-only installation state", file=sys.stderr)
        sys.exit(1)
