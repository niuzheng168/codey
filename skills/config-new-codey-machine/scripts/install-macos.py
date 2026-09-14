#!/usr/bin/env python3
"""Install the shared npm artifact as a native Mac node and export registration."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import time
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("codey_macos_service", HERE / "macos-service.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
require, digest, write_private = service.require, service.digest, service.write_private
PLATFORMS = ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]


def parse_tunnel_json(text):
    try:
        text = text.lstrip("\ufeff")
        start = re.search(r"(?m)^\s*\{", text)
        value = json.loads(text[start.start():]) if start else None
        require(isinstance(value, dict))
        return value
    except (ValueError, RuntimeError):
        raise RuntimeError("DevTunnel did not return a valid JSON object") from None


def read_package(root, target):
    require(target in ("macos-arm64", "macos-x64"), "Use a native supported Mac architecture")
    assets = root / "assets"
    manifest = json.loads((assets / "manifest.json").read_text())
    setup = json.loads((assets / "setup.json").read_text())
    pins = json.loads((root / "dependencies.macos.json").read_text())
    require(manifest.get("schema") == 2 and manifest.get("name") == "codey"
            and manifest.get("runtimePlatforms") == PLATFORMS and manifest.get("platform") == "linux-x64"
            and manifest.get("dependencyMode") == "npm-codey-package", "A complete shared Codey installation Skill is required")
    require(set(setup) == {"schema", "portalOrigin", "releaseId", "platform", "network", "tunnelAuthProvider", "updater"}
            and setup["schema"] == 1 and setup["platform"] == "linux-x64"
            and setup["network"] == {"mode": "devtunnel"} and setup["tunnelAuthProvider"] == "github"
            and setup["releaseId"] == manifest.get("releaseId")
            and re.fullmatch(r"machine-[a-f0-9]{16}", setup["releaseId"]), "Invalid public setup metadata")
    origin = urlsplit(setup["portalOrigin"])
    require(origin.scheme == "https" and origin.hostname and not any(
        (origin.username, origin.password, origin.path, origin.query, origin.fragment)), "Invalid Portal origin")
    updater = setup["updater"]
    require(isinstance(updater, dict) and set(updater) == {"protocol", "releasePublicKey"}
            and updater["protocol"] == 1 and isinstance(updater["releasePublicKey"], str)
            and updater["releasePublicKey"].startswith("-----BEGIN PUBLIC KEY-----\n")
            and "PRIVATE KEY" not in updater["releasePublicKey"] and len(updater["releasePublicKey"]) <= 8192,
            "Setup must contain only the public updater key")
    artifacts = manifest.get("artifacts")
    require(isinstance(artifacts, list) and len(artifacts) == 1)
    artifact = artifacts[0]
    require(re.fullmatch(r"codey-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\.tgz", artifact.get("file", ""))
            and artifact["file"] == f"codey-{manifest['codey']['version']}.tgz")
    sums = {}
    for line in (assets / "SHA256SUMS").read_text().splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([a-zA-Z0-9.-]+)", line)
        require(match and match[2] not in sums, "Invalid Skill checksums")
        sums[match[2]] = match[1]
    require(set(sums) == {artifact["file"], "manifest.json", "setup.json"})
    for name, expected in sums.items():
        file = assets / name
        require(file.is_file() and not file.is_symlink() and digest(file) == expected, "Skill checksum mismatch")
    require(artifact["sha256"] == sums[artifact["file"]]
            and (assets / artifact["file"]).stat().st_size == artifact["size"])
    version = pins.get("nodeVersion", "")
    arch = target.removeprefix("macos-")
    selected = pins.get("platforms", {}).get(target, {})
    require(pins.get("schema") == 1 and re.fullmatch(r"\d+\.\d+\.\d+", version)
            and selected.get("node", {}).get("url") == f"https://nodejs.org/dist/v{version}/node-v{version}-darwin-{arch}.tar.gz"
            and selected.get("devTunnel", {}).get("url") == f"https://tunnelsassetsprod.blob.core.windows.net/cli/osx-{arch}-devtunnel"
            and all(re.fullmatch(r"[a-f0-9]{64}", selected[key].get("sha256", "")) for key in ("node", "devTunnel")))
    require(pins.get("codex") == {"url": "https://chatgpt.com/codex/install.sh", "release": "latest"})
    return manifest, {**setup, "platform": target}, pins


def model_configuration(models):
    return f'''model = "gpt-6-astra"
model_provider = "copilot_api"
model_reasoning_effort = "max"
model_reasoning_summary = "auto"
model_context_window = 872000
model_auto_compact_token_limit = 722000
model_catalog_json = {json.dumps(str(models), ensure_ascii=False)}
personality = "pragmatic"
approvals_reviewer = "user"
sandbox_mode = "danger-full-access"
approval_policy = "never"

[model_providers.copilot_api]
name = "OpenAI"
base_url = "http://127.0.0.1:4141"
env_key = "CODEY_MODEL_API_KEY"
requires_openai_auth = false
supports_websockets = false
wire_api = "responses"
request_max_retries = 3
stream_max_retries = 1
stream_idle_timeout_ms = 300000

[features]
remote_compaction_v2 = true
'''


class Installer:
    def __init__(self, root):
        require(sys.platform == "darwin" and os.getuid() != 0 and sys.version_info >= (3, 12),
                "Run native Python 3.12+ as the logged-on Mac owner, not root")
        self.target = {"arm64": "macos-arm64", "x86_64": "macos-x64"}.get(platform.machine())
        require(self.target, "Unsupported Mac architecture")
        translated = self.run(["/usr/sbin/sysctl", "-in", "sysctl.proc_translated"], check=False)
        require(translated.stdout.strip() != "1", "Use a native terminal/Python, not Rosetta")
        self.skill = Path(root).resolve()
        self.home = Path.home().resolve()
        self.root = self.home / ".local/share/codey-machine-macos"
        self.config_root = self.home / ".config/codey-machine-macos"
        self.file = self.config_root / "runtime.json"
        self.state = self.root / "state"
        self.agents = self.home / "Library/LaunchAgents"
        self.domain = f"gui/{os.getuid()}"
        self.computer = socket.gethostname()
        self.manifest, self.setup, self.pins = read_package(self.skill, self.target)

    def run(self, args, *, env=None, cwd=None, check=True, interactive=False, timeout=180):
        result = subprocess.run(list(map(str, args)), env=env, cwd=cwd, text=True,
                                capture_output=not interactive, timeout=timeout)
        if check and result.returncode:
            # Arguments/output may contain authentication material. Do not print them.
            raise RuntimeError(f"{Path(args[0]).name} failed (exit {result.returncode}); installation is not complete")
        return result

    def directory(self, path):
        path = service.checked_path(path, self.home)
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.chmod(0o700)
        return path

    def download(self, item, destination):
        self.run(["/usr/bin/curl", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
                  "--tlsv1.2", "--connect-timeout", "30", "--max-time", "300", "--output", destination, item["url"]], timeout=330)
        require(not item.get("sha256") or digest(destination) == item["sha256"], "Official runtime checksum mismatch")
        destination.chmod(0o700)

    def probe(self, cfg, operation):
        return self.run([cfg["nodeExe"], self.skill / "scripts/windows-runtime.mjs", operation, self.file],
                        env=cfg["environment"], cwd=cfg["codeyDirectory"], timeout=330)

    def verify_agents(self, cfg):
        disabled = self.run(["/bin/launchctl", "print-disabled", self.domain]).stdout
        for component in service.COMPONENTS:
            label = service.label(cfg["nodeId"], component)
            require(not re.search(r'"' + re.escape(label) + r'"\s*=>\s*true', disabled), "LaunchAgent is disabled")
            file = service.checked_path(self.agents / (label + ".plist"), self.home)
            require(plistlib.loads(file.read_bytes()) == service.agent_definition(cfg, self.file, component),
                    "LaunchAgent belongs to another installation")
            status = self.run(["/bin/launchctl", "print", self.domain + "/" + label]).stdout
            require(re.findall(r"^\s*path = (.+)$", status, re.M) == [str(file)], "LaunchAgent path mismatch")
            if component != "renew":
                require(re.search(r"^\s*pid = [1-9][0-9]*$", status, re.M), "LaunchAgent is not running")

    def export_registration(self, cfg):
        self.probe(cfg, "verify")
        self.verify_agents(cfg)
        self.probe(cfg, "registration")
        output = self.home / "codey-machine-registration.json"
        self.run([cfg["nodeExe"], self.skill / "scripts/registration.mjs", "check", output, self.target])
        return output

    def install_updater(self, cfg):
        bootstrap = self.directory(self.config_root / ("updater-bootstrap-" + secrets.token_hex(8)))
        try:
            self.run([cfg["nodeExe"], self.skill / "scripts/updater-bootstrap.mjs", self.file, bootstrap],
                     env=cfg["baseEnvironment"], cwd=self.home)
            self.run([cfg["pythonExe"], "-I", "-S", "-B", bootstrap / "install.py",
                      "--config", bootstrap / "config.json", "--apply"],
                     env=cfg["baseEnvironment"], cwd=self.home, timeout=330)
        finally:
            shutil.rmtree(bootstrap)

    def install_command(self, cfg):
        directory = self.directory(self.home / ".local/bin")
        file = directory / "codey"
        marker = "# CODEY_MACOS_MANAGED_LAUNCHER"
        if file.exists():
            require(not file.is_symlink() and (marker in file.read_text() or
                    "CODEY_SHARED_NPM_LAUNCHER" in file.read_text()), "Refusing to replace an unmanaged codey command")
        argv = [cfg["pythonExe"], "-I", "-S", cfg["workerPath"], "cli", str(self.file)]
        write_private(file, ("#!/bin/sh\n" + marker + "\nexec " + shlex.join(argv) + ' "$@"\n').encode())
        file.chmod(0o700)
        block = '\n# >>> Codey PATH >>>\ncase ":${PATH:-}:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) export PATH="$HOME/.local/bin${PATH:+:$PATH}" ;;\nesac\n# <<< Codey PATH <<<\n'
        for name in (".profile", ".bashrc", ".bash_profile", ".bash_login", ".zprofile", ".zshrc"):
            profile = self.home / name
            if name in (".bash_profile", ".bash_login") and not profile.exists():
                continue
            # Preserve the owner's shell file and any deliberate dotfile symlink.
            if not profile.exists() or "# >>> Codey PATH >>>" not in profile.read_text():
                with profile.open("a") as stream:
                    stream.write(block)

    def preflight(self, args):
        for path in (self.root, self.config_root, self.state, self.agents, self.file):
            service.checked_path(path, self.home)
        codex_home = service.checked_path(args.codex_home or os.environ.get("CODEX_HOME") or self.home / ".codex", self.home)
        previous = service.read_private(self.file) if self.file.exists() else None
        unfinished = False
        if previous:
            require(previous.get("schema") == 2 and previous.get("kind") == "codey-macos-oneclick"
                    and previous.get("layout") == "npm-codey-package" and previous.get("platform") == self.target
                    and previous.get("ownerUid") == os.getuid() and previous.get("ownerHome") == str(self.home)
                    and previous.get("runtimeRoot") == str(self.root) and previous.get("configRoot") == str(self.config_root)
                    and previous.get("portalOrigin") == self.setup["portalOrigin"], "Existing or legacy installation requires review")
        elif self.config_root.exists() and any(self.config_root.iterdir()):
            attempt = self.config_root / "attempt.json"
            require(attempt.is_file() and service.read_private(attempt) == self.attempt_identity(),
                    "Nonempty configuration directory is not owned by this installer")
            unfinished = True
        elif self.root.exists() and any(self.root.iterdir()):
            raise RuntimeError("Nonempty runtime directory has no recognized installation state")
        overwrites = [str(codex_home / name) for name in ("config.toml", "models.json") if (codex_home / name).exists()]
        plan = {"platform": self.target, "computer": self.computer, "mode": "apply" if args.apply else "plan",
                "releaseId": self.manifest["releaseId"], "replaceConfiguration": overwrites,
                "existingNode": bool(previous), "startup": "owner GUI logon LaunchAgents",
                "registrationFile": str(self.home / "codey-machine-registration.json"), "updater": "automatic"}
        if not args.apply:
            return plan, previous, codex_home
        require(args.network_approved and args.expected_computer == self.computer,
                "Apply requires --network-approved and --expected-computer matching this Mac exactly")
        self.run(["/bin/launchctl", "print", self.domain])
        if previous and previous.get("ready") and previous.get("state") == "ready":
            return plan, previous, codex_home
        require(not (previous or unfinished) or args.retry_failed, "Inspect the failed attempt, then use --retry-failed")
        require(not overwrites or args.replace_existing, "Existing Codex configuration requires --replace-existing")
        for name in ("config.toml", "models.json"):
            service.checked_path(codex_home / name, self.home)
        # Never stop another app/terminal or alter its live model key.
        codex = self.run(["/usr/bin/pgrep", "-u", str(os.getuid()), "-x", "codex"], check=False)
        require(codex.returncode == 1, "Close Codex/Desktop and run from an external Mac terminal first")
        for port in (3001, 4141, 8443):
            with socket.socket() as probe:
                try:
                    probe.bind(("127.0.0.1", port))
                except OSError:
                    raise RuntimeError("A service port is occupied; no foreign process will be stopped") from None
        self.run(["/usr/bin/openssl", "version"])
        require(shutil.disk_usage(self.home).free >= 8 * 1024 ** 3, "At least 8 GiB of free space is required")
        return plan, previous, codex_home

    def attempt_identity(self):
        return {"schema": 1, "kind": "codey-macos-oneclick", "ownerUid": os.getuid(),
                "ownerHome": str(self.home), "platform": self.target, "portalOrigin": self.setup["portalOrigin"]}

    def apply(self, args):
        plan, previous, codex_home = self.preflight(args)
        if not args.apply:
            print(json.dumps(plan, indent=2))
            return plan
        self.directory(self.config_root)
        lock = service.checked_path(self.config_root / "install.lock", self.home)
        with lock.open("a") as stream:
            os.chmod(lock, 0o600)
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            current = service.read_private(self.file) if self.file.exists() else None
            require(current == previous, "Installation state changed concurrently; rerun the plan")
            if previous and previous.get("ready") and previous.get("state") == "ready":
                cfg = previous
            else:
                for directory in (self.root, self.state, self.agents, self.root / "releases"):
                    self.directory(directory)
                write_private(self.config_root / "attempt.json", self.attempt_identity())
                cfg = self.deploy(args, codex_home, previous)
        # The native updater owns the same installation lock itself. Release our
        # lock before invoking it; keep verified apps/identity intact on failure.
        print("[5/5] Automatically install/start the updater and export registration")
        self.install_updater(cfg)
        output = self.export_registration(cfg)
        print(f"Codey macOS and its native updater are installed. Registration: {output}")
        print("Import this private file once; Portal binds the updater automatically. Delete the file after import.")
        return cfg

    def deploy(self, args, codex_home, previous):
        identity_file = self.state / "identity.json"
        if identity_file.exists():
            identity = service.read_private(identity_file)
            require(identity.get("ownerUid") == os.getuid() and identity.get("ownerHome") == str(self.home)
                    and re.fullmatch(r"n-[a-f0-9]{24}", identity.get("nodeId", "")), "Existing identity requires review")
        else:
            identity = {**self.attempt_identity(), "nodeId": "n-" + secrets.token_hex(12),
                        "workspaceSubject": "m-" + secrets.token_hex(12), "workspaceUsername": "owner",
                        **{key: secrets.token_urlsafe(32) for key in
                           ("clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey", "updaterCredential")}}
            write_private(identity_file, identity)
        if previous:
            require(previous["nodeId"] == identity["nodeId"])
        require(re.fullmatch(r"m-[a-f0-9]{24}", identity.get("workspaceSubject", ""))
                and re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", identity.get("workspaceUsername", ""))
                and all(re.fullmatch(r"[A-Za-z0-9_-]{43}", identity.get(key, "")) for key in
                        ("clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey", "updaterCredential")),
                "Existing identity credentials require review")
        # Refuse unrecognized LaunchAgents before creating any release or rotating keys.
        for component in service.COMPONENTS:
            file = self.agents / (service.label(identity["nodeId"], component) + ".plist")
            if file.exists():
                require(previous and plistlib.loads(file.read_bytes()) == service.agent_definition(previous, self.file, component),
                        "Existing LaunchAgent collision")
        release = self.directory(self.root / "releases" / (self.manifest["releaseId"] + "-" + secrets.token_hex(8)))
        selected = self.pins["platforms"][self.target]
        node_archive = release / "node.tar.gz"
        print("[1/5] Prepare the shared Codey npm package and native Mac tools")
        self.download(selected["node"], node_archive)
        distribution = f"node-v{self.pins['nodeVersion']}-darwin-{self.target.removeprefix('macos-')}"
        with tarfile.open(node_archive, "r:gz") as archive:
            members = archive.getmembers()
            require(sum(item.size for item in members) < 1024 ** 3 and all(
                PurePosixPath(item.name).parts[0] == distribution and ".." not in PurePosixPath(item.name).parts
                for item in members), "Unexpected official Node archive layout")
            archive.extractall(release, filter="data")
        node_archive.unlink()
        node = release / distribution / "bin/node"
        require(self.run([node, "--version"]).stdout.strip() == "v" + self.pins["nodeVersion"])
        base = {"HOME": str(self.home), "USER": os.environ.get("USER", "owner"), "LOGNAME": os.environ.get("LOGNAME", "owner"),
                "PATH": f"{node.parent}:/usr/bin:/bin:/usr/sbin:/sbin", "NODE_ENV": "production",
                "TMPDIR": os.environ.get("TMPDIR", "/tmp")}
        prefix = release / "app"
        artifact = self.manifest["artifacts"][0]
        self.run([node, self.skill / "scripts/install-runtime.mjs", "--package", self.skill / "assets" / artifact["file"],
                  "--sha256", artifact["sha256"], "--prefix", prefix, "--check"], env=base, timeout=1800)
        codey = prefix / "lib/node_modules/codey"
        require(digest(codey / "codey-build.json") == self.manifest["codey"]["entrySha256"]
                and digest(codey / "npm-shrinkwrap.json") == self.manifest["codey"]["lockSha256"])
        devtunnel = release / "devtunnel"
        self.download(selected["devTunnel"], devtunnel)
        print("[2/5] Configure this machine's private GitHub DevTunnel")
        shown = self.run([devtunnel, "user", "show", "--json"], env=base, check=False)
        user = parse_tunnel_json(shown.stdout) if shown.returncode == 0 else {}
        if user.get("status") == "Logged in":
            require(user.get("provider") == "github", "Do not switch an existing DevTunnel account/provider automatically")
        else:
            self.run([devtunnel, "user", "login", "--github", "--use-device-code-auth"], env=base, interactive=True, timeout=900)
            user = parse_tunnel_json(self.run([devtunnel, "user", "show", "--json"], env=base).stdout)
        require(user.get("status") == "Logged in" and user.get("provider") == "github")
        tunnel_id = "codey-" + identity["nodeId"]
        shown = self.run([devtunnel, "show", tunnel_id, "--json"], env=base, check=False)
        if shown.returncode:
            shown = self.run([devtunnel, "create", tunnel_id, "--description", "Codey macOS " + identity["nodeId"], "--json"], env=base)
        tunnel = parse_tunnel_json(shown.stdout)
        tunnel = tunnel.get("tunnel", tunnel)
        parts = tunnel.get("tunnelId", "").split(".")
        cluster = parts[1] if len(parts) == 2 else tunnel.get("clusterId", "")
        require(len(parts) <= 2 and parts[0] == tunnel_id and re.fullmatch(r"[a-z][a-z0-9]{1,15}", cluster))
        qualified = tunnel_id + "." + cluster
        for port in (3001, 8443):
            if not any(item.get("portNumber") == port and item.get("protocol") == "https" for item in tunnel.get("ports", [])):
                self.run([devtunnel, "port", "create", qualified, "--port-number", str(port), "--protocol", "https", "--json"], env=base)
        tunnel_file = self.state / "tunnel.json"
        write_private(tunnel_file, parse_tunnel_json(self.run([devtunnel, "show", qualified, "--json"], env=base).stdout))
        self.run([node, HERE / "windows-runtime.mjs", "check-tunnel", tunnel_file, tunnel_id], env=base)
        supervisor = self.directory(self.root / "supervisor")
        for name in ("macos-service.py", "windows-runtime.mjs", "registration.mjs"):
            write_private(supervisor / name, (HERE / name).read_bytes())
        cert, key = self.config_root / "node-cert.pem", self.config_root / "node-key.pem"
        server_name = identity["nodeId"] + ".nodes.codey.internal"
        # LibreSSL on macOS supports an openssl config file even without -addext.
        cert_config = self.config_root / "openssl.cnf"
        write_private(cert_config, (f"[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = leaf\n"
            f"[dn]\nCN = {server_name}\n[leaf]\nsubjectAltName = DNS:{server_name}\n"
            "basicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\n"
            "extendedKeyUsage = serverAuth\n").encode())
        self.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "365",
                  "-config", cert_config, "-keyout", key, "-out", cert])
        key.chmod(0o600)
        cert.chmod(0o600)
        signing = self.config_root / "client-signing.key"
        write_private(signing, (identity["clientSigningKey"] + "\n").encode())
        copilot = self.directory(self.root / "copilot-home")
        data = self.directory(self.root / "data")
        model_key = secrets.token_urlsafe(32)
        write_private(copilot / "config.json", {"auth": {"apiKeys": [model_key],
                      "adminApiKey": secrets.token_urlsafe(32), "sessionHistoryApiKey": secrets.token_urlsafe(32)}})
        codex_bin = self.directory(self.root / "codex-bin")
        environment = {**base, "CODEY_MANAGED": "true", "CODEY_PORTAL_SSO": "true", "CODEX_HOME": str(codex_home),
            "COPILOT_API_HOME": str(copilot), "CODEY_MODEL_API_KEY": model_key, "DATABASE_PATH": str(data / "auth.db"),
            "CODEY_CODEX_EXECUTABLE": str(codex_bin / "codex"), "COPILOT_API_CODEY_HTTPS_PORT": "8443",
            "COPILOT_API_CODEY_HTTPS_HOST": "127.0.0.1", "COPILOT_API_CODEY_TLS_CERT": str(cert),
            "COPILOT_API_CODEY_TLS_KEY": str(key), "COPILOT_API_CODEY_NODE_ID": identity["nodeId"],
            "COPILOT_API_CODEY_ALLOWED_ORIGIN": self.setup["portalOrigin"], "COPILOT_API_CODEY_SIGNING_KEY_FILE": str(signing),
            "CODEY_PORTAL_NODE_ID": identity["nodeId"], "CODEY_PORTAL_USERNAME": identity["workspaceUsername"],
            "CODEY_PORTAL_PRINCIPAL_ID": identity["workspaceSubject"], "CODEY_PORTAL_SSO_KEY": identity["workspaceSsoKey"],
            "CODEY_PORTAL_TLS_CERT": str(cert), "CODEY_PORTAL_TLS_KEY": str(key)}
        python = Path(sys.executable).resolve()
        require(python.stat().st_uid in (0, os.getuid()) and not python.stat().st_mode & 0o022)
        cfg = {**self.attempt_identity(), "schema": 2, "layout": "npm-codey-package", "computer": self.computer,
            "nodeId": identity["nodeId"], "releaseId": self.setup["releaseId"], "releaseDirectory": str(release),
            "runtimeRoot": str(self.root), "configRoot": str(self.config_root), "stateRoot": str(self.state),
            "nodeExe": str(node), "devtunnelExe": str(devtunnel), "pythonExe": str(python),
            "workerPath": str(supervisor / "macos-service.py"), "helperPath": str(supervisor / "windows-runtime.mjs"),
            "registrationHelper": str(supervisor / "registration.mjs"), "codeyDirectory": str(codey),
            "codeyBin": str(codey / "bin/codey.mjs"), "codeyEntrySha256": self.manifest["codey"]["entrySha256"],
            "codexExe": str(codex_bin / "codex"), "codexHome": str(codex_home), "modelKey": model_key,
            "identityFile": str(identity_file), "tunnelFile": str(tunnel_file), "qualifiedTunnel": qualified,
            "certificate": str(cert), "serverName": server_name, "setupFile": str(self.config_root / "setup.json"),
            "environment": environment, "baseEnvironment": base, "state": "installing", "ready": False,
            "updater": "automatic"}
        cfg["fileHashes"] = {name: digest(cfg[name]) for name in
                            ("nodeExe", "devtunnelExe", "workerPath", "helperPath", "registrationHelper")}
        write_private(Path(cfg["setupFile"]), self.setup)
        write_private(self.file, cfg)
        started = []
        try:
            print("[3/5] Authenticate Codey and prepare official Codex (retain auth and sessions)")
            if not (copilot / "github_token").exists() or not (copilot / "github_token").stat().st_size:
                self.run([node, cfg["codeyBin"], "auth", "login", "--provider", "copilot"],
                         env=environment, cwd=codey, interactive=True, timeout=900)
            installer = release / "codex-install.sh"
            self.download(self.pins["codex"], installer)
            require("https://releases.openai.com/codex" in installer.read_text(), "Unexpected official Codex installer")
            # Keep the official tool distribution inside this runtime, separate
            # from the owner's auth/sessions home. The official shim may be a
            # symlink; services/updaters pin its real, owned native executable.
            standalone_home = self.directory(self.root / "codex-install")
            self.run(["/bin/bash", installer], env={**environment, "CODEX_INSTALL_DIR": str(codex_bin),
                     "CODEX_HOME": str(standalone_home),
                     "CODEX_RELEASE": "latest", "CODEX_NON_INTERACTIVE": "true",
                     "CODEX_INSTALLER_USE_RELEASES_OPENAI_COM": "true"}, timeout=900)
            installed_codex = service.checked_path((codex_bin / "codex").resolve(strict=True), self.root)
            cfg["codexExe"] = environment["CODEY_CODEX_EXECUTABLE"] = str(installed_codex)
            require(self.run([cfg["codexExe"], "--version"], env=environment).stdout.startswith("codex-cli "))
            self.directory(codex_home)
            for name, content in (
                ("models.json", (self.skill / "templates/a100-models.json").read_bytes()),
                ("config.toml", model_configuration(codex_home / "models.json").encode()),
            ):
                destination = service.checked_path(codex_home / name, self.home)
                if destination.exists():
                    write_private(destination.with_name(name + "." + secrets.token_hex(8) + ".bak"), destination.read_bytes())
                write_private(destination, content)
            write_private(self.file, cfg)
            print("[4/5] Start owner LaunchAgents and verify real gateway/Workspace/Codex responses")
            for component in service.COMPONENTS:
                label = service.label(identity["nodeId"], component)
                file = self.agents / (label + ".plist")
                write_private(file, plistlib.dumps(service.agent_definition(cfg, self.file, component)))
                started.append(label)
                self.run(["/bin/launchctl", "enable", self.domain + "/" + label])
                self.run(["/bin/launchctl", "bootstrap", self.domain, file])
            for attempt in range(30):
                try:
                    self.probe(cfg, "verify")
                    break
                except RuntimeError:
                    if attempt == 29:
                        raise
                    time.sleep(2)
            answer = self.state / ("codex-answer-" + secrets.token_hex(8) + ".txt")
            self.run([cfg["codexExe"], "exec", "--skip-git-repo-check", "--output-last-message", answer,
                      "Reply with only CODEY_CODEX_OK. Do not use tools."], env=environment, cwd=self.home, timeout=330)
            require(answer.read_text().strip() == "CODEY_CODEX_OK", "Real Codex response mismatch")
            self.probe(cfg, "sdk-probe")
            self.install_command(cfg)
            cfg.update({"ready": True, "state": "ready"})
            write_private(self.file, cfg)
            return cfg
        except BaseException:
            for label in reversed(started):
                try:
                    self.run(["/bin/launchctl", "disable", self.domain + "/" + label], check=False)
                    self.run(["/bin/launchctl", "bootout", self.domain + "/" + label], check=False)
                except Exception:
                    print("Could not stop an owned LaunchAgent; inspect the private installation state.", file=sys.stderr)
            cfg.update({"ready": False, "state": "failed"})
            write_private(self.file, cfg)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--network-approved", action="store_true")
    parser.add_argument("--expected-computer", default="")
    parser.add_argument("--replace-existing", action="store_true", help="Back up and replace existing Codex config/models only")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--codex-home")
    args = parser.parse_args()
    os.umask(0o077)
    Installer(HERE.parent).apply(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Keep credential-bearing parser/child-process diagnostics private.
        print(str(error) if isinstance(error, RuntimeError) else "macOS installation failed; inspect the private installation state.",
              file=sys.stderr)
        sys.exit(1)
