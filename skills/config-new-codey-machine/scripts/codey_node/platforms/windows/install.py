"""Orchestrate Windows attachment; shared logic and native operations stay separate."""
import argparse
import http.client
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import time

from ...common.errors import SetupError as Error, TunnelError
from ...common.files import digest, write_state
from ...common import verification as checks
from ...common import config_defaults, model_test, registration
from ...devtunnel import binding as tunnels, renewal
from ...service.bundle import install_bundle, bundle_hashes
from . import helpers as windows, supervisor as worker, codex_runtime as native
from . import build, cli, preflight
from .package import validate_bundle
from .process import run

SCRIPT = Path(__file__).resolve().parent
SKILL = Path(__file__).resolve().parents[4]


def setup_error(error):
    result = {"ok": False, "code": str(error) if isinstance(error, (Error, TunnelError, native.NativeCodexError))
              else "windows_tunnel_setup_failed_review_private_log"}
    if isinstance(error, cli.DevTunnelBrowserLoginRequired):
        result["userAction"] = error.user_action
    return result


def export_registration(setup, identity, config, output, token, context):
    output = Path(output)
    if output.resolve().is_relative_to(SKILL.resolve()):
        raise Error("private_registration_output_must_stay_outside_reusable_skill")
    if output.is_symlink():
        raise Error("linked_machine_output")
    if output.exists():
        previous = json.loads(output.read_text(encoding="utf-8-sig"))
        if previous.get("schema") != 2 or previous.get("machine", {}).get("nodeId") != identity["nodeId"]:
            raise Error("output_belongs_to_another_machine")
    output.parent.mkdir(parents=True, exist_ok=True)
    machine = {
        "schema": 1, "nodeId": identity["nodeId"], "platform": "windows-x64", "name": config["name"],
        "region": "Windows Dev Box", "networkMode": "devtunnel",
        "tlsCertificate": Path(config["certificate"]).read_text(encoding="utf-8"),
        "devTunnel": {"tunnelId": config["tunnelId"], "clusterId": config["clusterId"]},
    }
    windows.write_private_json(
        output, registration.document(setup, identity, machine, token), context["sid"],
    )


def configure(args):
    if os.name != "nt" or platform.machine().lower() not in ("amd64", "x86_64") or sys.version_info < (3, 12):
        raise Error("native_windows_x64_and_python_3_12_required")
    computer = os.environ.get("COMPUTERNAME", "")
    if args.expected_computer_name and computer.casefold() != args.expected_computer_name.casefold():
        raise Error("wrong_computer_no_installation_attempted")
    setup = registration.load_setup(SKILL, "windows-x64")
    manifest = json.loads((SKILL / "assets/manifest.json").read_text(encoding="utf-8-sig"))
    artifacts = validate_bundle(setup, manifest)
    for artifact in artifacts:
        file = SKILL / "assets" / artifact["file"]
        if file.is_symlink() or file.stat().st_size != artifact["size"] or digest(file) != artifact["sha256"]:
            raise Error("source_archive_checksum_mismatch")
    acceptance = setup.get("acceptance")
    if acceptance and computer.casefold() != acceptance["expectedComputerName"].casefold():
        raise Error("acceptance_package_is_bound_to_a_different_computer")
    context = windows.service.owner_context()
    if context["elevated"] or context["sessionId"] <= 0:
        raise Error("use_original_logged_on_non_elevated_owner")
    if args.apply and not args.network_approved:
        raise Error("review_private_outbound_tunnel_then_use_NetworkApproved_no_firewall_changes")
    if (SKILL / "LOCAL-RESUME.json").exists():
        raise Error("legacy_recovery_package_is_not_a_first_install_package")
    home = Path.home().resolve()
    if args.apply:
        bootstrap = registration.state_path(home, setup)
        if not bootstrap.parent.exists():
            windows.private_directory(bootstrap.parent, context["sid"])
        identity = registration.load_or_create(home, setup)
        windows.private_file(bootstrap, context["sid"])
    else:
        identity = registration.existing(home, setup)
    node_id = identity["nodeId"] if identity else "n-" + "0" * 24
    root = home / ".local/share/codey-machine-windows" / node_id
    config_root = home / ".config/codey-machine-windows" / node_id
    if any(not folder.resolve().is_relative_to(home) or folder.is_symlink() or folder.is_junction()
           for folder in (root, config_root)):
        raise Error("installation_path_escaped_owner_home")
    state_file, runtime_file = config_root / "installation.json", config_root / "runtime.json"
    if state_file.is_symlink() or runtime_file.is_symlink():
        raise Error("linked_installation_state")
    state = json.loads(state_file.read_text(encoding="utf-8-sig")) if state_file.is_file() else None
    if state is not None and not isinstance(state, dict):
        raise Error("invalid_installation_state")
    if state and (state.get("nodeId") != node_id or state.get("ownerSid") != context["sid"]
                  or state.get("computerName") != computer or state.get("releaseId") != manifest["releaseId"]):
        raise Error("existing_installation_identity_or_release_mismatch")
    if state and state.get("ready"):
        config = json.loads(runtime_file.read_text(encoding="utf-8-sig"))
        saved_identity = worker.validate(config, "workspace", context)
        verification = checks.verify(saved_identity, {"listenIp": "127.0.0.1"}, Path(config["certificate"]))
        model = model_test.codex(
            config["codexExe"], config["codexHome"],
            config["providerEnv"]["CODEY_MODEL_API_KEY"], home,
            config_root / "codex-model-test.log",
        )
        export_registration(
            setup, saved_identity, config, args.out, renewal.connect_token(config), context,
        )
        print(json.dumps({
            "ok": True, "alreadyConfigured": True, "servicesRestarted": False,
            "realModelCallsTested": True, "modelTest": model,
            "verification": verification, "output": args.out,
        }))
        return
    if state or root.exists() or config_root.exists():
        raise Error("unfinished_or_unrecognized_installation_requires_review_no_overwrite")
    defaults = config_defaults.prepare(
        SKILL, codex_home=getattr(args, "codex_home", None),
        copilot_api_config=getattr(args, "copilot_api_config", None),
        model_key_file=getattr(args, "model_key_file", None), require_provider_key=True,
    )
    codex_home = defaults.codex_home
    codex, openssl, pythonw = preflight.existing_tools(args, home, SKILL)
    native_codex = native.pin(codex, root, node_id)
    proof = preflight.gateway_proof()
    if proof["ownerSid"] != context["sid"]:
        raise Error("4141_process_belongs_to_another_owner")
    occupied = preflight.free_ports()
    provider, _previous_environment = preflight.referenced_provider(codex_home)
    provider_env = defaults.provider_env
    usage_key = preflight.usage_key_file(args.usage_key_file, provider, codex_home)
    proxy_preflight = preflight.verify_usage(usage_key)
    workspace = Path(args.workspace_root or (home / "Documents" if (home / "Documents").is_dir() else home)).resolve()
    name = args.name or computer
    if not name or len(name) > 80 or any(ord(char) < 32 for char in name):
        raise Error("invalid_machine_display_name")
    if acceptance and name.casefold() != acceptance["expectedComputerName"].casefold():
        raise Error("acceptance_package_machine_name_must_match_target")
    if not workspace.is_dir():
        raise Error("existing_workspace_directory_required")
    plan = {
        "nodeId": node_id if identity else "generated-on-apply", "package": "static-no-secrets",
        "platform": "windows-x64", "mode": "private-devtunnel-existing-model", "name": name,
        "computerName": computer, "ownerSid": context["sid"], "releaseId": manifest["releaseId"],
        "protectedModelProcess": proof, "codexExecutable": native_codex["executable"], "codexHome": str(codex_home),
        "sourceCodexExecutable": native_codex["sourceExecutable"], "nativeCodex": native_codex,
        "opensslExecutable": str(openssl), "privateListeners": ["127.0.0.1:3001", "127.0.0.1:8443"],
        "occupiedPorts": occupied, "services": list(worker.COMPONENTS),
        "networkChanges": "Create only a node-bound private DevTunnel with two HTTPS ports after approval",
        "firewallChanged": False, "azureArmPermissionsRequired": False, "existingModelServiceChanged": False,
        "logonOnly": True, "globalToolsChanged": False, "proxyPreflight": proxy_preflight,
        "modelDefaults": defaults.report(),
    }
    if not args.apply:
        print(json.dumps(plan, indent=2))
        return
    defaults.require_ready()
    if occupied:
        raise Error("workspace_or_data_port_occupied_no_process_stopped")
    if shutil.disk_usage(home).free < 8 * 1024 ** 3:
        raise Error("eight_GiB_free_space_required")
    devtunnel = cli.prepare_devtunnel(args, home, context["sid"])
    if preflight.gateway_proof() != proof:
        raise Error("protected_model_process_changed_before_installation")
    windows.private_directory(config_root, context["sid"])
    windows.private_directory(root, context["sid"])
    tasks_created = False
    try:
        pinned = native.pin(codex, root, node_id, apply=True)
        if pinned != native_codex:
            raise Error("selected_native_codex_changed_since_plan_no_tasks_created")
        native.verify(native_codex, root, node_id)
        codex = Path(native_codex["executable"])
        write_state(state_file, {**plan, "ready": False})
        releases = root / "releases"
        release = windows.within(releases / manifest["releaseId"], releases)
        releases.mkdir()
        stage = windows.within(releases / (manifest["releaseId"] + ".prepare"), releases)
        stage.mkdir()
        build.build_runtime(manifest, root, stage, config_root / "dependency-build.log", skill=SKILL)
        os.replace(windows.within(stage, releases), windows.within(release, releases))
        if preflight.gateway_proof() != proof:
            raise Error("protected_model_process_changed_during_build")
        cert, key = config_root / "node-cert.pem", config_root / "node-key.pem"
        dns = f"{node_id}.nodes.codey.internal"
        identity_file = config_root / "registration-secrets.json"
        run([openssl, "req", "-x509", "-newkey", "rsa:3072", "-noenc", "-days", "365",
             "-keyout", key, "-out", cert, "-subj", f"/CN={dns}", "-addext", f"subjectAltName=DNS:{dns}",
             "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
             "-addext", "extendedKeyUsage=serverAuth"], log=config_root / "dependency-build.log")
        write_state(identity_file, identity)
        (config_root / "ticket.key").write_text(identity["clientSigningKey"], encoding="utf-8")
        binding = tunnels.ensure_tunnel(devtunnel, identity, config_root)
        binaries = root / "bin"
        binaries.mkdir()
        python_runtime = install_bundle(SKILL / "scripts", binaries / "service", "windows")
        node = release / "node/node.exe"
        defaults_result = defaults.apply()
        config_text = next(item.data for item in defaults.changes if item.before.path == codex_home / "config.toml")
        config = {
            "schema": 1, "kind": "windows-devtunnel", "nodeId": node_id, "ownerSid": context["sid"],
            "computerName": computer, "root": str(root), "configRoot": str(config_root),
            "name": name, "pythonwExe": str(pythonw), "nodeExe": str(node),
            "runnerPath": python_runtime["entrypoint"], "pythonRuntime": python_runtime,
            "tunnelAuthProvider": "github",
            "codexExe": str(codex), "nativeCodex": native_codex,
            "codexHome": str(codex_home), "devtunnelExe": str(devtunnel),
            "workspaceEntry": str(release / "cloudcli/dist-server/server/index.js"),
            "dataEntry": str(release / "portal-node/node-relay/server.mjs"),
            "databasePath": str(config_root / "auth.db"), "workspaceRoot": str(workspace),
            "identityFile": str(identity_file), "certificate": str(cert), "privateKey": str(key),
            "ticketKeyFile": str(config_root / "ticket.key"), "usageKeyFile": str(usage_key) if usage_key else "",
            "providerEnv": provider_env, "protectedModelProcess": proof,
            "servicePath": os.pathsep.join([str(node.parent), str(Path(sys.executable).parent), str(codex.parent),
                                          os.environ.get("PATH", "")]),
            **binding,
        }
        config["fileHashes"] = {config[field]: digest(config[field]) for field in (
            "runnerPath", "nodeExe", "codexExe", "devtunnelExe", "workspaceEntry", "dataEntry",
        )}
        config["fileHashes"].update(bundle_hashes(python_runtime))
        config["fileHashes"].update(native.hashes(native_codex))
        write_state(runtime_file, config)
        for component in worker.COMPONENTS:
            worker.validate(config, component, context)
        run([windows.native_powershell(), "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
             "-File", SCRIPT / "windows-tunnel-tasks.ps1", "-ConfigPath", runtime_file, "-Operation", "Install"],
            log=config_root / "dependency-build.log")
        tasks_created = True
        for attempt in range(30):
            try:
                verification = checks.verify(identity, {"listenIp": "127.0.0.1"}, cert)
                break
            except (OSError, ValueError, windows.SetupError, http.client.HTTPException):
                if attempt == 29:
                    raise Error("local_TLS_SSO_authenticated_data_or_anonymous_denial_failed")
                time.sleep(2)
        if preflight.gateway_proof() != proof:
            raise Error("protected_model_process_changed")
        after = (codex_home / "config.toml").read_bytes() if (codex_home / "config.toml").exists() else None
        if after != config_text:
            raise Error("owner_codex_configuration_changed_no_rollback_of_user_changes")
        model = model_test.codex(
            codex, codex_home, provider_env["CODEY_MODEL_API_KEY"], home,
            config_root / "codex-model-test.log",
        )
        export_registration(
            setup, identity, config, args.out, renewal.connect_token(config), context,
        )
        write_state(state_file, {**plan, "ready": True})
        print(json.dumps({
            "ok": True, "localTlsAndSsoVerified": True, "existingModelServiceUnchanged": True,
            "existingCodexConfigUnchanged": str(codex_home / "config.toml") not in defaults_result["changedFiles"],
            "unrelatedCodexConfigPreserved": True, "modelDefaults": defaults_result,
            "logonOnly": True, "firewallChanged": False,
            "portalActivationRequired": True, "realModelCallsTested": True, "modelTest": model,
            "reloginTested": False,
            "verification": verification,
            "output": args.out, "runtimeConfig": str(runtime_file),
        }, indent=2))
    except BaseException:
        if tasks_created:
            run([windows.native_powershell(), "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                 "-File", SCRIPT / "windows-tunnel-tasks.ps1", "-ConfigPath", runtime_file,
                 "-Operation", "RemoveCreated"], check=False)
        # Preserve private diagnostics, the same identity/tunnel, and all old services.
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(Path.home() / "codey-machine-registration.json"))
    parser.add_argument("--name", default="")
    parser.add_argument("--expected-computer-name", default="")
    parser.add_argument("--codex-executable")
    parser.add_argument("--codex-home")
    config_defaults.add_existing_gateway_arguments(parser)
    parser.add_argument("--openssl")
    parser.add_argument("--devtunnel-executable")
    parser.add_argument("--usage-key-file")
    parser.add_argument("--workspace-root")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--network-approved", action="store_true")
    try:
        configure(parser.parse_args())
    except Exception as error:
        print(json.dumps(setup_error(error)))
        raise SystemExit(1)
