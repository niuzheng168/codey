"""Install or replace a Linux x64 Codey node via private GitHub DevTunnel."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import sys
import tarfile
import time

from ...common import config_defaults, registration
from ...common.errors import SetupError, TunnelError
from ...common.files import digest, protected_write
from ...common.verification import verify
from ...devtunnel import auth, binding as tunnels, renewal
from ...service.bundle import install_bundle
from . import cli, codex_latest, copilot_api, login, replacement, supervisor as worker, updater_service
from .build import prepare_runtime, run
from .systemd import unit

SKILL = Path(__file__).resolve().parents[4]
SERVICES = ["codey-copilot-api.service", "codey-cloudcli.service"]


def validate_inputs(setup, manifest, target_platform="linux-x64"):
    suffix = "linux-x64.tar.xz"
    if (target_platform != "linux-x64" or manifest.get("schema") != 1 or manifest.get("platform") != target_platform
            or manifest.get("releaseId") != setup.get("releaseId")):
        raise SetupError("Static setup and runtime release do not match")
    version = manifest.get("node", "")
    bun = manifest.get("bunBuildTool", "")
    distribution = manifest.get("nodeDistribution", {})
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch(r"\d+\.\d+\.\d+", bun):
        raise SetupError("Runtime versions must be pinned")
    expected_file = f"node-v{version}-{suffix}"
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


def emit_registration(setup, identity, network, cert, output, connect_token,
                      name=None, verification=None):
    machine = {
        "schema": 1, "nodeId": identity["nodeId"], "name": name or network["name"],
        "region": "Linux · DevTunnel", "platform": "linux-x64",
        "tlsCertificate": cert.read_text(), "networkMode": "devtunnel",
        "devTunnel": network["devTunnel"],
    }
    output = Path(output)
    if output.resolve().is_relative_to(SKILL.resolve()):
        raise SetupError("Private registration output must stay outside the reusable Skill directory")
    if output.exists() and not output.is_symlink():
        try:
            previous = json.loads(output.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as error:
            raise SetupError("Existing registration output is not valid JSON") from error
        if previous.get("schema") != 2 or previous.get("machine", {}).get("nodeId") != identity["nodeId"]:
            raise SetupError("Existing registration output belongs to another machine")
    value = registration.document(setup, identity, machine, connect_token)
    protected_write(output, json.dumps(value, indent=2) + "\n")
    output.chmod(0o600)
    print(json.dumps({
        "ok": True, "nodeId": identity["nodeId"], "registrationFile": str(output),
        "registrationFilePrivate": True,
        "localHttps": True, "usageHistory": True, "workspaceSso": True, "anonymousDenied": True,
        "next": "Upload the private codey-machine-registration.json to Codey, then delete transferred copies",
        "modelAuthentication": "GitHub Copilot login and a real Codex model request passed",
        "rebootTested": False, "verification": verification,
    }, indent=2))


def configure(args):
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64") or os.geteuid() == 0:
        raise SetupError("Run as the target owner (not root), on Linux x64; a remote controller can use SSH")
    if sys.version_info < (3, 12) or not hasattr(tarfile, "data_filter"):
        raise SetupError("Use an existing Python 3.12+ via CODEY_PYTHON; do not replace the system Python")
    home = Path.home().resolve()
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(home)):
        raise SetupError("This systemd installer requires a home path without whitespace or systemd specifiers")
    os.umask(0o077)
    setup = registration.load_setup(SKILL, "linux-x64")
    updater = SKILL / "assets/codey-updater"
    for name in ["install.py", "updater.py", "engine.py", "probe.mjs", "UPGRADE.md"]:
        if not (updater / name).is_file():
            raise SetupError("The static Linux package is missing its public updater program")
    manifest = json.loads((SKILL / "assets/manifest.json").read_text())
    artifacts = validate_inputs(setup, manifest)
    for artifact in artifacts:
        archive = SKILL / "assets" / artifact["file"]
        if archive.is_symlink() or not archive.is_file() or archive.stat().st_size != artifact["size"] or digest(archive) != artifact["sha256"]:
            raise SetupError("A reviewed source package is missing, truncated or has the wrong checksum")
    if args.apply and shutil.disk_usage(home).free < 8 * 1024 ** 3:
        raise SetupError("At least 8 GiB free disk space is required for isolated dependency installation/build")
    identity = registration.load_or_create(home, setup) if args.apply else registration.existing(home, setup)
    node_id = identity["nodeId"] if identity else "generated-on-apply"
    network = {"schema": 1, "nodeId": node_id, "networkMode": "devtunnel",
               "listenIp": "127.0.0.1", "name": platform.node()}
    root = home / ".local/share/codey-machine"
    config = home / ".config/codey-machine"
    if any(path.resolve() != path or not path.is_relative_to(home) for path in (root, config)):
        raise SetupError("Installation/configuration paths must not be linked or leave this owner home")
    state_file = config / "installation.json"
    state = None
    if state_file.exists():
        try:
            state = worker.private_json(state_file)
        except (worker.ServiceError, ValueError):
            state = None
    network_hash = hashlib.sha256(json.dumps(network, sort_keys=True).encode()).hexdigest()
    service_dir = home / ".config/systemd/user"
    def port_available(port):
        try:
            with socket.socket() as probe:
                probe.bind((network["listenIp"], port))
            return True
        except OSError:
            return False
    replacement_plan = replacement.inspect(home, root, config, run, port_available=port_available)
    if not replacement_plan["detected"]:
        occupied = [port for port in replacement.PORTS if not port_available(port)]
        if occupied:
            raise SetupError("Required listeners are occupied by an unknown process; no process was stopped")
    defaults = None
    shell_owner = None
    shell_changes = None
    if replacement_plan["detected"]:
        preflight_root = home / (".codey-replacement-preflight-" + node_id)
        try:
            preflight_root.lstat()
        except FileNotFoundError:
            pass
        else:
            raise SetupError("Reserved replacement preflight path already exists")
        preflight = config_defaults.prepare(
            SKILL, codex_home=args.codex_home,
            copilot_api_config=preflight_root / "copilot-api-config.json",
            provider_env_file=preflight_root / "provider.env", new_gateway=True,
        )
        preflight.require_ready()
        target_codex_home = preflight.codex_home
    else:
        defaults = config_defaults.prepare(
            SKILL, codex_home=args.codex_home,
            copilot_api_config=root / "data/copilot-api/config.json",
            provider_env_file=config / "provider.env", new_gateway=True,
        )
        target_codex_home = defaults.codex_home
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(target_codex_home)):
        raise SetupError("This systemd installer requires a Codex home without whitespace or systemd specifiers")
    codex_update = codex_latest.prepare(home, target_codex_home, args.codex_bin, skill=SKILL)
    codex = codex_update.executable
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(codex)):
        raise SetupError("This systemd installer requires a Codex path without whitespace or systemd specifiers")
    shell_owner, shell_changes = login.prepare(home, config / "provider.env")
    summary = {
        "nodeId": node_id, "releaseId": manifest["releaseId"],
        "package": "static-no-secrets", "credentials": "generated locally on apply and reused after failure",
        "services": SERVICES + ["codey-node-updater.service", "codey-devtunnel.service", "codey-devtunnel-renew.timer"],
        "listenIp": network["listenIp"], "modelApi": "127.0.0.1:4141",
        "installationRoot": str(root), "configRoot": str(config),
        "enableLinger": True, "existingCodexConfig": "only approved defaults merged; other values and credentials preserved",
        "modelDefaults": (
            defaults.report() if defaults else
            {"mode": "fresh defaults will be prepared after the existing installation is archived"}
            if replacement_plan["detected"] else
            {"mode": "fresh defaults will be installed"}
        ),
        "codexExecutable": str(codex),
        "dependencyInstallation": f"Download verified Node {manifest['node']}; install locked npm/Bun dependencies and build in a separate release",
        "providerLogin": "GitHub Copilot device login runs during installation when no active token exists",
        "transport": "private-devtunnel", "tunnelLogin": "GitHub only",
        "azurePermissionsRequired": False, "inboundFirewallChanges": False,
        "supervisor": "systemd; Restart=always; 5-second restart delay",
        "bootAutostart": "requires this owner's linger; enabled services survive SSH logout",
        "replacement": replacement.public(replacement_plan),
        "shellModelEnvironment": login.report(shell_changes),
        "codexUpdate": codex_update.report(),
    }
    if not args.apply:
        print(json.dumps(summary, indent=2))
        return
    owner = run(["id", "-un"]).stdout.strip()
    if owner != identity["workspaceUsername"]:
        raise SetupError("The generated Workspace username no longer matches the current OS user")
    linger = run(["loginctl", "show-user", owner, "-p", "Linger", "--value"], check=False)
    linger_enabled = linger.stdout.strip().lower() == "yes"
    executable = cli.prepare_cli(args.devtunnel_bin or shutil.which("devtunnel"), SKILL, identity["nodeId"])
    tunnel_login = auth.login_github_device(executable)
    existing_binding = None
    if (replacement_plan["detected"] and state
            and state.get("nodeId") == identity["nodeId"] and (config / "tunnel.json").is_file()):
        try:
            existing_binding = tunnels.ensure_tunnel(executable, identity, config, inspect_only=True)
        except TunnelError as error:
            raise SetupError("The existing node's DevTunnel could not be verified before replacement") from error
    lock = home / ".codey-machine-install.lock"
    with lock.open("x") as handle:
        handle.write(str(os.getpid()))
    started = []
    try:
        if replacement_plan["detected"]:
            result = replacement.execute(
                home, root, config, identity["nodeId"], run, port_available=port_available)
            summary["replacement"] = result
            defaults = config_defaults.prepare(
                SKILL, codex_home=args.codex_home,
                copilot_api_config=root / "data/copilot-api/config.json",
                provider_env_file=config / "provider.env", new_gateway=True,
            )
            summary["modelDefaults"] = defaults.report()
        config.mkdir(parents=True, exist_ok=True, mode=0o700)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        config.chmod(0o700)
        root.chmod(0o700)
        if existing_binding:
            requested = "codey-" + identity["nodeId"]
            protected_write(config / "tunnel.json", json.dumps({
                "requested": requested,
                "qualifiedId": requested + "." + existing_binding["clusterId"],
                **existing_binding,
            }, indent=2) + "\n")
        binding = tunnels.ensure_tunnel(
            executable, identity, config,
            expected_binding=existing_binding if existing_binding else None,
        )
        network["devTunnel"] = binding
        summary["devTunnel"] = {**binding, "provider": "github", "ports": [3001, 8443]}
        summary["devTunnel"]["login"] = tunnel_login
        identity_file = config / "registration-secrets.json"
        protected_write(identity_file, json.dumps(identity, indent=2) + "\n")
        state = {**summary, "ready": False, "networkSha256": network_hash}
        protected_write(state_file, json.dumps(state, indent=2) + "\n")
        release = root / "releases" / manifest["releaseId"]
        if release.exists() and (release.is_symlink() or
                json.loads((release / "release.json").read_text()) != manifest):
            raise SetupError("Existing runtime receipt does not match this same unfinished release")
        if not release.exists():
            stage = release.with_name(release.name + ".staging")
            if stage.exists():
                if stage.is_symlink():
                    raise SetupError("A partial runtime stage is linked")
                shutil.rmtree(stage)
            stage.mkdir(parents=True)
            prepare_runtime(manifest, identity, root, stage, config / "dependency-build.log", skill=SKILL)
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
            server_name = f"{identity['nodeId']}.nodes.codey.internal"
            run(["openssl", "req", "-x509", "-newkey", "rsa:3072", "-noenc", "-days", "365",
                 "-keyout", key, "-out", cert, "-subj", f"/CN={server_name}",
                 "-addext", f"subjectAltName=DNS:{server_name}",
                 "-addext", "basicConstraints=critical,CA:FALSE",
                 "-addext", "keyUsage=critical,digitalSignature,keyEncipherment", "-addext", "extendedKeyUsage=serverAuth"])
        if not cert.exists() or not key.exists():
            raise SetupError("Incomplete node TLS material; do not replace only one half of a keypair")
        cert.chmod(0o600)
        key.chmod(0o600)
        protected_write(config / "client-signing.key", identity["clientSigningKey"] + "\n")
        data = root / "data"
        # The new COPILOT_API_HOME supplies the gateway config and CloudCLI model
        # key. Old services/data were archived and are not used by the new process.
        defaults.apply()
        shell_result = login.apply(shell_owner, shell_changes)
        state["shellModelEnvironment"] = shell_result
        provider_env = config / "provider.env"
        protected_write(config / "copilot.env", "\n".join([
            f"COPILOT_API_HOME={data}/copilot-api", "COPILOT_API_CODEY_HTTPS_PORT=8443",
            f"COPILOT_API_CODEY_HTTPS_HOST={network['listenIp']}",
            f"COPILOT_API_CODEY_TLS_CERT={cert}", f"COPILOT_API_CODEY_TLS_KEY={key}",
            f"COPILOT_API_CODEY_NODE_ID={identity['nodeId']}",
            f"COPILOT_API_CODEY_ALLOWED_ORIGIN={setup['portalOrigin']}",
            f"COPILOT_API_CODEY_SIGNING_KEY_FILE={config}/client-signing.key", "",
        ]))
        protected_write(config / "cloudcli.env", "\n".join([
            "CODEY_MANAGED=true", "CODEY_PORTAL_SSO=true", "SERVER_PORT=3001",
            f"HOST={network['listenIp']}", f"DATABASE_PATH={data}/cloudcli/auth.db",
            f"CODEY_PORTAL_NODE_ID={identity['nodeId']}",
            f"CODEY_PORTAL_USERNAME={identity['workspaceUsername']}",
            f"CODEY_PORTAL_PRINCIPAL_ID={identity['workspaceSubject']}",
            f"CODEY_PORTAL_SSO_KEY={identity['workspaceSsoKey']}",
            f"CODEY_PORTAL_TLS_CERT={cert}", f"CODEY_PORTAL_TLS_KEY={key}", "",
            f"CODEY_CODEX_EXECUTABLE={codex}", f"CODEX_HOME={defaults.codex_home}", "",
        ]))
        (data / "cloudcli").mkdir(exist_ok=True)
        bins = root / "bin"
        bins.mkdir(exist_ok=True)
        protected_write(bins / "codex", codex_latest.wrapper(codex, defaults.codex_home, provider_env))
        (bins / "codex").chmod(0o700)
        protected_write(bins / "copilot-api", f"#!/bin/sh\nexport COPILOT_API_HOME=\"{data}/copilot-api\"\nexec \"{node}\" \"{copilot}/dist/main.js\" \"$@\"\n")
        (bins / "copilot-api").chmod(0o700)
        service_path = f"{bins}:{release}/node/bin:{home}/.local/bin:/usr/local/bin:/usr/bin:/bin"
        for name, content in [
            (SERVICES[0], unit("Codey machine Copilot API (owner login required for models)",
             f"{node} {copilot}/dist/main.js start --headless --host 127.0.0.1 --port 4141",
             copilot, config / "copilot.env", service_path)),
            (SERVICES[1], unit("Codey machine CloudCLI Workspace",
             f"{node} {cloudcli}/dist-server/server/index.js", cloudcli, config / "cloudcli.env", service_path)
             .replace("WorkingDirectory=", f"EnvironmentFile={provider_env}\nWorkingDirectory=")),
        ]:
            protected_write(service_dir / name, content)
        if not linger_enabled:
            run(["loginctl", "enable-linger", owner])
            if run(["loginctl", "show-user", owner, "-p", "Linger", "--value"]).stdout.strip().lower() != "yes":
                raise SetupError("Linger did not become enabled; boot autostart was not verified")
        run(["systemctl", "--user", "daemon-reload"])

        # Copilot API: start the new build, complete GitHub login if needed,
        # restart it under systemd, then prove the authenticated model endpoint.
        started.append(SERVICES[0])
        run(["systemctl", "--user", "enable", "--now", SERVICES[0]])
        provider_values = defaults.provider_env
        model_key = provider_values["CODEY_MODEL_API_KEY"]
        copilot_environment = {
            **os.environ,
            "HOME": str(home),
            "COPILOT_API_HOME": str(data / "copilot-api"),
            "PATH": service_path,
        }
        provider_login = copilot_api.login(
            bins / "copilot-api", copilot, data / "copilot-api/github_token", copilot_environment)
        run(["systemctl", "--user", "restart", SERVICES[0]])
        copilot_test = copilot_api.wait_ready(model_key)
        state["copilotApi"] = {"login": provider_login, "test": copilot_test}

        # Codex: stop old app-server processes, update/install the official
        # latest CLI in the owner's existing bin location, then make a real call.
        codex_result = codex_update.apply()
        state["codexUpdate"] = codex_result
        codex_test = codex_latest.test_model(codex, defaults.codex_home, model_key, home)
        state["codexTest"] = codex_test

        # CloudCLI: only start after Copilot API and Codex have passed.
        started.append(SERVICES[1])
        run(["systemctl", "--user", "enable", "--now", SERVICES[1]])
        error = None
        for _ in range(20):
            try:
                verification = verify(identity, network, cert)
                error = None
                break
            except (SetupError, OSError, http.client.HTTPException, ValueError) as failure:
                error = failure
                time.sleep(2)
        if error:
            raise SetupError(f"Local TLS/authentication verification failed ({error}); no machine import file was produced")
        python_runtime = install_bundle(SKILL / "scripts", config / "service", "linux")
        runtime = {
            "schema": 1, "uid": os.geteuid(), "nodeId": identity["nodeId"],
            "ownerId": identity["workspaceSubject"], "configRoot": str(config), "tunnelAuthProvider": "github",
            "identityFile": str(identity_file), "devtunnelExe": str(executable),
            "devtunnelSha256": digest(executable), "worker": python_runtime["entrypoint"],
            "pythonRuntime": python_runtime,
            **binding,
        }
        runtime_file = config / "tunnel-runtime.json"
        protected_write(runtime_file, json.dumps(runtime, indent=2) + "\n")
        protected_write(config / "tunnel.env", "")
        for mode, name in (("host", "codey-devtunnel.service"), ("renew", "codey-devtunnel-renew.service")):
            content = unit("Codey private GitHub tunnel " + mode,
                           f"{Path(sys.executable).resolve()} -I -B {runtime['worker']} --component {mode} --config {runtime_file}",
                           root, config / "tunnel.env", service_path)
            if mode == "renew":
                content = content.replace("Type=simple", "Type=oneshot").replace("Restart=always\n", "")
            protected_write(service_dir / name, content)
        protected_write(service_dir / "codey-devtunnel-renew.timer",
                        "[Unit]\nDescription=Renew this Codey node's private tunnel token\n"
                        "[Timer]\nOnBootSec=60\nOnUnitInactiveSec=300\nUnit=codey-devtunnel-renew.service\n"
                        "[Install]\nWantedBy=timers.target\n")
        run(["systemctl", "--user", "daemon-reload"])
        started.append("codey-devtunnel-renew.service")
        for name in ("codey-devtunnel.service", "codey-devtunnel-renew.timer"):
            started.append(name)
            run(["systemctl", "--user", "enable", "--now", name])
        # Register a separate pull agent only after both newly-created services are healthy.
        # Pending nodes cannot claim jobs until the owner completes Portal activation.
        started.append("codey-node-updater.service")
        updater_config = config / "updater-bootstrap.json"
        protected_write(
            updater_config,
            json.dumps(registration.updater_config(setup, identity), indent=2) + "\n",
        )
        state["supervision"] = updater_service.install(updater, updater_config, run)
        connect_token = renewal.connect_token(runtime)
        output = Path(args.out).resolve()
        emit_registration(
            setup, identity, network, cert, output, connect_token,
            args.name, verification=verification,
        )
        state.update(ready=True, registrationFile=str(output))
        protected_write(state_file, json.dumps(state, indent=2) + "\n")
    except Exception:
        for service in reversed(started):
            run(["systemctl", "--user", "disable", "--now", service], check=False)
        raise
    finally:
        lock.unlink()


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(Path.home() / "codey-machine-registration.json"))
    parser.add_argument("--name")
    parser.add_argument("--devtunnel-bin")
    parser.add_argument("--codex-bin", help="Optional existing owner Codex command whose bin directory should be updated")
    parser.add_argument("--codex-home", help="Absolute target Codex home; otherwise the owner's CODEX_HOME or .codex")
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args(argv)


def main():
    try:
        configure(arguments())
    except (SetupError, worker.ServiceError, TunnelError, FileExistsError, KeyError, ValueError) as error:
        raise SystemExit(str(error))
