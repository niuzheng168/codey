"""Prepare an owner-bound macOS node without replacing existing services."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import socket
import subprocess
import sys
import time
import tomllib
import urllib.parse

from ...common import verification as common
from ...common import codex_cli, config_defaults, model_test, registration
from ...common.files import digest, write_private
from ...devtunnel import auth, binding as tunnels, renewal
from ...service.bundle import install_bundle
from . import supervisor as service
from .build import build_runtime
from .process import run
from .launchd import launch_agent

SKILL = Path(__file__).resolve().parents[4]
Error = service.ServiceError


def validate(setup, manifest, target):
    if target not in ("macos-arm64", "macos-x64"):
        raise Error("Unsupported Mac architecture")
    registration.validate_setup(setup, target)
    if (manifest.get("platform") != target or manifest.get("schema") != 1
            or setup.get("releaseId") != manifest.get("releaseId")):
        raise Error("This static package does not match this Mac architecture or runtime release")
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


def port_busy(port):
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def token_bound_tunnel(executable, identity, config_root):
    def runner(args, **kwargs):
        return run(args, check=False, timeout=kwargs.get("timeout", 45))

    binding = tunnels.ensure_tunnel(executable, identity, config_root, runner=runner)
    return binding["tunnelId"], binding["clusterId"]


def connect_token(config):
    def runner(args, **kwargs):
        return run(args, check=False, timeout=kwargs.get("timeout", 45))

    return renewal.connect_token(config, runner=runner)


def export_registration(setup, identity, config, machine, output, token):
    output = Path(output)
    if output.resolve().is_relative_to(SKILL.resolve()):
        raise Error("Private registration output must stay outside the reusable Skill directory")
    if output.is_symlink():
        raise Error("Registration output must not be a symbolic link")
    if output.exists():
        previous = service.private_json(output)
        if previous.get("schema") != 2 or previous.get("machine", {}).get("nodeId") != identity["nodeId"]:
            raise Error("Registration output belongs to another machine")
    write_private(output, registration.document(setup, identity, machine, token))
    output.chmod(0o600)


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
    if not target:
        raise Error("Unsupported Mac architecture")
    setup = registration.load_setup(SKILL, target)
    manifest = json.loads((SKILL / "assets/manifest.json").read_text())
    home = Path.home()
    identity = (registration.load_or_create(
        home, setup, username=pwd.getpwuid(os.getuid()).pw_name,
    ) if args.apply else registration.existing(home, setup))
    node_id = identity["nodeId"] if identity else "n-" + "0" * 24
    root = home / ".local/share/codey-machine-macos" / node_id
    config_root = home / ".config/codey-machine-macos" / node_id
    runtime_path = config_root / "runtime.json"
    state_file = config_root / "installation.json"
    ready = state_file.is_file() and service.private_json(state_file).get("status") == "local-ready"
    artifacts = validate(setup, manifest, target)
    for artifact in artifacts:
        file = SKILL / "assets" / artifact["file"]
        if file.is_symlink() or file.stat().st_size != artifact["size"] or digest(file) != artifact["sha256"]:
            raise Error("Bundled source checksum mismatch")
    if ready:
        config, saved_identity = service.runtime(runtime_path)
        if config["releaseId"] != manifest["releaseId"]:
            raise Error("The first-install script cannot upgrade an existing node")
        common.verify(saved_identity, {"listenIp": "127.0.0.1"}, Path(config["certificate"]))
        verify_backend(config)
        model = model_test.codex(
            config["codexExe"], config["codexHome"],
            config["providerEnv"]["CODEY_MODEL_API_KEY"], home,
            config_root / "codex-model-test.log",
        )
        machine = service.private_json(config_root / "machine.json")
        export_registration(
            setup, saved_identity, config, machine, args.out, connect_token(config),
        )
        print(json.dumps({
            "ok": True, "reusedExistingServices": True, "realModelCallsTested": True,
            "modelTest": model, "output": str(args.out),
        }))
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
    defaults = config_defaults.prepare(
        SKILL, codex_home=args.codex_home,
        copilot_api_config=getattr(args, "copilot_api_config", None),
        model_key_file=getattr(args, "model_key_file", None), require_provider_key=True,
    )
    codex_home = defaults.codex_home
    existing_file = codex_home / "config.toml"
    existing_config = tomllib.loads(existing_file.read_text(encoding="utf-8-sig")) if existing_file.is_file() else {}
    provider = existing_config.get("model_providers", {}).get(existing_config.get("model_provider"), {})
    provider_auth = provider.get("auth", {})
    usage_key = args.usage_key_file
    if not usage_key and provider_auth.get("command") == "cat" and len(provider_auth.get("args", [])) == 1:
        usage_key = provider_auth["args"][0]
    if not usage_key or not Path(usage_key).is_absolute() or not Path(usage_key).is_file():
        raise Error("Specify the existing local usage API key file; no provider key will be regenerated")
    codex = codex_cli.require_cli(SKILL, args.codex_bin)
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
    plan = {"platform": target, "nodeId": node_id if identity else "generated-on-apply",
            "package": "static-no-secrets", "mode": "private-devtunnel", "root": str(root),
            "loopbackPorts": [3001, 8443], "existingModelProxy": "127.0.0.1:4141 (not restarted or replaced)",
            "services": ["CloudCLI", "Codey-owned Codex backend", "read-only HTTPS data relay", "DevTunnel", "node-scoped token renewal"],
            "azurePermissionsRequiredByNode": False, "workspaceRoot": str(workspace), "npmRegistry": args.npm_registry,
            "modelDefaults": defaults.report()}
    if not args.apply:
        print(json.dumps({"apply": False, "plan": plan}, indent=2))
        return
    defaults.require_ready()
    logged_in = auth.cli(devtunnel, ["user", "show", "--json"], check=False)
    if not auth.github_logged_in(logged_in):
        raise Error("Run devtunnel user login --github --use-browser-auth as this Mac owner. "
                    "No cached account was switched and no Entra fallback was started.")
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
        build_runtime(manifest, root, release, args.npm_registry, log, skill=SKILL)
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
        identity_file = config_root / "registration-secrets.json"
        write_private(identity_file, identity)
        write_private(config_root / "ticket.key", identity["clientSigningKey"])
        python_runtime = install_bundle(SKILL / "scripts", config_root / "service", "macos")
        tunnel_id, cluster_id = token_bound_tunnel(devtunnel, identity, config_root)
        node = release / "node/bin/node"
        defaults_result = defaults.apply()
        provider_env = defaults.provider_env
        config = {
            "schema": 1, "uid": os.getuid(), "nodeId": node_id, "name": args.name, "releaseId": manifest["releaseId"],
            "home": str(home), "osUser": pwd.getpwuid(os.getuid()).pw_name, "releaseRoot": str(release), "configRoot": str(config_root),
            "identityFile": str(identity_file), "worker": python_runtime["entrypoint"],
            "pythonRuntime": python_runtime,
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
            "tunnelId": tunnel_id, "clusterId": cluster_id, "tunnelAuthProvider": "github",
        }
        write_private(runtime_path, config)
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
                common.verify(identity, {"listenIp": "127.0.0.1"}, certificate)
                verify_backend(config)
                break
            except (OSError, ValueError, common.SetupError, Error):
                if time.monotonic() >= deadline:
                    raise Error("Local authenticated HTTPS checks failed; inspect owner-only service logs")
                time.sleep(1)
        model = model_test.codex(
            codex, codex_home, provider_env["CODEY_MODEL_API_KEY"], home,
            config_root / "codex-model-test.log",
        )
        machine = {"schema": 1, "nodeId": node_id, "platform": target, "name": args.name, "region": "macOS · DevTunnel",
                   "networkMode": "devtunnel", "tlsCertificate": certificate.read_text(),
                   "devTunnel": {"tunnelId": tunnel_id, "clusterId": cluster_id}}
        write_private(config_root / "machine.json", machine)
        export_registration(setup, identity, config, machine, args.out, connect_token(config))
        write_private(state_file, {"status": "local-ready", "nodeId": node_id, "uid": os.getuid(), "releaseId": manifest["releaseId"],
                                   "launchAgents": [label for label, _ in created]})
        print(json.dumps({"ok": True, "localReady": True, "portalActivationRequired": True,
                          "modelDefaults": defaults_result, "realModelCallsTested": True, "modelTest": model,
                          "output": str(args.out)}, indent=2))
    except Exception:
        for label, plist in reversed(created):
            run(["launchctl", "bootout", f"gui/{os.getuid()}/{label}"], check=False)
            plist.unlink(missing_ok=True)
        write_private(state_file, {"status": "needs-attention", "nodeId": node_id, "uid": os.getuid(),
                                   "note": "Only this attempt's new LaunchAgents were stopped; existing services are unchanged"})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--name", default="Mac")
    parser.add_argument("--codex-home")
    config_defaults.add_existing_gateway_arguments(parser)
    parser.add_argument("--codex-bin")
    parser.add_argument("--devtunnel-bin")
    parser.add_argument("--openssl-bin")
    parser.add_argument("--usage-key-file")
    parser.add_argument("--workspace-root")
    parser.add_argument("--npm-registry", default="https://registry.npmjs.org/")
    parser.add_argument("--out", type=Path, default=Path.home() / "codey-machine-registration.json")
    try:
        configure(parser.parse_args())
    except (Error, common.SetupError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error) if isinstance(error, (Error, common.SetupError)) else "Mac node setup failed; inspect the owner-only installation state", file=sys.stderr)
        sys.exit(1)
