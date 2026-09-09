"""First Windows Codey attachment to an existing owner model proxy, via DevTunnel."""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request

SCRIPT = Path(__file__).resolve().parent
SKILL = SCRIPT.parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, SCRIPT / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


windows = module("codey_windows_install_helpers", "configure-windows.py")
tunnel = module("codey_windows_tunnel_client", "windows-tunnel-client.py")
worker = module("codey_windows_tunnel_worker", "windows-tunnel-service.py")
Error = windows.SetupError


def run(arguments, *, cwd=None, env=None, log=None, check=True, timeout=120):
    options = {
        "cwd": cwd, "env": env or windows.child_environment(), "text": True,
        "encoding": "utf-8", "errors": "replace", "stdin": subprocess.DEVNULL,
        "timeout": 1800 if log else timeout, "creationflags": worker.CREATE_NO_WINDOW,
    }
    if log:
        with Path(log).open("a", encoding="utf-8") as output:
            result = subprocess.run([str(item) for item in arguments], stdout=output, stderr=subprocess.STDOUT, **options)
    else:
        result = subprocess.run([str(item) for item in arguments], capture_output=True, **options)
    if check and result.returncode:
        raise Error("command_failed_review_private_log" if log else "command_failed_existing_services_unchanged")
    return result


def gateway_proof():
    """Inspect, never stop/reconfigure, the exact same-owner 4141 listener."""
    script = r"""
$ErrorActionPreference='Stop'
$listeners=@(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq 4141 })
$ids=@($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
if($ids.Count -ne 1){throw 'Expected one existing model service'}
$c=Get-CimInstance Win32_Process -Filter "ProcessId=$($ids[0])"
$p=Get-Process -Id $ids[0]
$sid=(Invoke-CimMethod -InputObject $c -MethodName GetOwnerSid).Sid
@{pid=$p.Id;executable=$p.Path;startedUtc=$p.StartTime.ToUniversalTime().ToString('o');
  ownerSid=$sid;mentionsCopilotApi=([string]$c.CommandLine -match 'copilot-api')} | ConvertTo-Json -Compress
"""
    result = run([windows.native_powershell(), "-NoProfile", "-NonInteractive", "-Command", script])
    value = json.loads(result.stdout)
    if (type(value.get("pid")) is not int or value["pid"] <= 0 or not value.get("executable")
            or not value.get("startedUtc") or value.get("mentionsCopilotApi") is not True):
        raise Error("existing_4141_service_is_not_a_verified_copilot_api")
    return value


def free_ports():
    occupied = []
    for port in (3001, 8443):
        try:
            with socket.socket() as connection:
                connection.bind(("127.0.0.1", port))
        except OSError:
            occupied.append(port)
    return occupied


def existing_tools(args, home):
    codex = Path(args.codex_executable) if args.codex_executable else None
    if codex is None:
        base = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData/Local"))) / "OpenAI/Codex/bin"
        candidates = list(base.glob("*/codex.exe")) if base.is_dir() else []
        if not candidates:
            raise Error("existing_native_codex_required")
        codex = max(candidates, key=lambda value: value.stat().st_mtime)
    openssl = Path(args.openssl) if args.openssl else None
    if openssl is None:
        candidates = [
            Path(shutil.which("openssl.exe") or "__missing__"),
            Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/usr/bin/openssl.exe",
        ]
        openssl = next((value for value in candidates if value.is_absolute() and value.is_file()), None)
    for value in (codex, openssl):
        if value is None or not value.is_absolute() or not value.is_file() or value.suffix.lower() != ".exe":
            raise Error("existing_absolute_native_codex_and_openssl_required")
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    if not pythonw.is_file():
        raise Error("pythonw_required_for_hidden_logon_tasks")
    return codex.resolve(), openssl.resolve(), pythonw.resolve()


def referenced_provider(codex_home):
    file = codex_home / "config.toml"
    if not file.exists():
        return {}, {}
    if file.stat().st_size > 1024 * 1024:
        raise Error("unexpected_codex_configuration_size")
    config = tomllib.loads(file.read_text(encoding="utf-8-sig"))
    provider = config.get("model_providers", {}).get(config.get("model_provider"), {})
    names = set()
    if isinstance(provider.get("env_key"), str):
        names.add(provider["env_key"])
    for name in provider.get("env_http_headers", {}).values():
        if isinstance(name, str):
            names.add(name)
    blocked = {
        "PATH", "HOME", "USERPROFILE", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED",
        "PYTHONPATH", "PYTHONHOME", "PSMODULEPATH", "CODEX_HOME",
        "CODEX_THREAD_ID", "CODEX_PARENT_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    }
    if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
           or name.upper() in blocked or name.upper().startswith("CODEY_") for name in names):
        raise Error("unsafe_provider_environment_reference")
    return provider, {name: os.environ[name] for name in names if name in os.environ}


def usage_key_file(explicit, provider, codex_home):
    if explicit:
        candidate = Path(explicit)
    else:
        endpoint = urllib.parse.urlsplit(provider.get("base_url", ""))
        if (endpoint.scheme not in ("http", "https") or endpoint.hostname not in ("127.0.0.1", "localhost", "::1")
                or endpoint.port != 4141 or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment):
            return None  # Never forward an unrelated provider's credential to a local service.
        auth = provider.get("auth", {})
        arguments = auth.get("args", [])
        candidate = Path(arguments[0]) if (auth.get("command") in ("cat", "cat.exe")
                                           and len(arguments) == 1 and isinstance(arguments[0], str)) else None
        if candidate is None:
            return None
    if not candidate.is_absolute() or not candidate.is_file() or candidate.stat().st_size > 8192:
        raise Error("existing_usage_key_file_required_no_key_is_regenerated")
    return candidate.resolve()


def verify_usage(key_file):
    headers = {"accept": "application/json"}
    if key_file:
        key = key_file.read_text(encoding="utf-8-sig").strip()
        if not key or "\n" in key or "\r" in key:
            raise Error("invalid_usage_key_file")
        headers["authorization"] = "Bearer " + key
    request = urllib.request.Request("http://127.0.0.1:4141/usage", headers=headers)
    try:
        # Inherited HTTP proxies must never receive a loopback model credential.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), tunnel.NoRedirect)
        with opener.open(request, timeout=10) as response:
            if response.status != 200:
                raise Error("existing_model_usage_unavailable")
            value = json.loads(response.read(1024 * 1024))
            if not isinstance(value, dict):
                raise ValueError()
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise Error("existing_usage_auth_required_use_UsageKeyFile_not_a_key_value") from None
        raise Error("existing_model_usage_unavailable") from None
    except (urllib.error.URLError, OSError, ValueError):
        raise Error("existing_model_usage_unavailable") from None


def download(url, destination, *, expected=None, limit=128 * 1024 ** 2):
    destination = Path(destination)
    if destination.is_symlink():
        raise Error("linked_download_path")
    if destination.exists():
        if expected and tunnel.digest(destination) != expected:
            raise Error("cached_download_checksum_mismatch")
        return
    part = destination.with_name(destination.name + ".part")
    if part.exists():
        raise Error("partial_download_needs_review")
    with urllib.request.urlopen(url, timeout=120) as response, part.open("xb") as output:
        if urllib.parse.urlsplit(response.geturl()).scheme != "https":
            raise Error("download_redirect_must_remain_https")
        size = 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                raise Error("download_too_large")
            output.write(chunk)
    if expected and tunnel.digest(part) != expected:
        raise Error("download_checksum_mismatch")
    os.replace(part, destination)


def logged_in(result):
    text = (result.stdout or "").lower()
    return result.returncode == 0 and "not logged in" not in text and "login required" not in text


def prepare_devtunnel(args, home, sid):
    if args.devtunnel_executable:
        candidate = Path(args.devtunnel_executable)
    elif shutil.which("devtunnel.exe"):
        candidate = Path(shutil.which("devtunnel.exe"))
    else:
        root = home / ".local/share/codey-windows-bootstrap"
        if not root.exists():
            windows.private_directory(root, sid)
            tunnel.write_state(root / "bootstrap.json", {"schema": 1, "ownerSid": sid})
        if root.is_symlink() or not root.resolve().is_relative_to(home):
            raise Error("unsafe_bootstrap_directory")
        marker = root / "bootstrap.json"
        if marker.is_symlink() or not marker.is_file() or json.loads(marker.read_text()).get("ownerSid") != sid:
            raise Error("unrecognized_bootstrap_directory")
        candidate = root / "devtunnel.exe"
        download("https://aka.ms/TunnelsCliDownload/win-x64", candidate, limit=96 * 1024 ** 2)
        # The official redirect is not version-pinned; require a valid Microsoft
        # signature before executing, then pin the actual bytes in this node.
        escaped = str(candidate).replace("'", "''")
        script = ("$ErrorActionPreference='Stop';$s=Get-AuthenticodeSignature -LiteralPath '" + escaped
                  + "';@{valid=($s.Status -eq 'Valid');subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress")
        value = json.loads(run([windows.native_powershell(), "-NoProfile", "-NonInteractive", "-Command", script]).stdout)
        if value.get("valid") is not True or not re.search(r"(?:^|,\s*)O=Microsoft Corporation(?:,|$)", value.get("subject", "")):
            raise Error("downloaded_devtunnel_must_have_a_valid_microsoft_signature")
    if not candidate.is_absolute() or not candidate.is_file() or candidate.suffix.lower() != ".exe":
        raise Error("native_devtunnel_required")
    result = tunnel.cli(candidate, ["user", "show"], check=False)
    if not logged_in(result):
        # This is the only interactive step. Never log credentials/device codes
        # or run login in a scheduled task/background worker.
        print("DevTunnel requires your own Microsoft/Entra login. Complete the browser sign-in.", flush=True)
        result = subprocess.run([str(candidate), "user", "login", "--entra"], timeout=300)
        if result.returncode:
            raise Error("devtunnel_owner_login_required")
        if not logged_in(tunnel.cli(candidate, ["user", "show"], check=False)):
            raise Error("devtunnel_owner_login_required")
    return candidate.resolve()


def build_runtime(manifest, root, stage, log):
    archive = root / manifest["nodeDistribution"]["file"]
    download(manifest["nodeDistribution"]["url"], archive, expected=manifest["nodeDistribution"]["sha256"])
    prefix = manifest["nodeDistribution"]["file"].removesuffix(".zip")
    windows.extract_zip(archive, stage, prefix)
    os.replace(windows.within(stage / prefix, root), windows.within(stage / "node", root))
    for name, file in (("cloudcli", "cloudcli-source.tar.gz"), ("portal-node", "portal-node-source.tar.gz")):
        target = stage / name
        target.mkdir()
        windows.extract_source(SKILL / "assets" / file, target)
    node = stage / "node/node.exe"
    npm = stage / "node/node_modules/npm/bin/npm-cli.js"
    cloudcli = stage / "cloudcli"
    allow = {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
        "PROGRAMFILES", "PROGRAMFILES(X86)", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE", "VSINSTALLDIR", "VCINSTALLDIR", "INCLUDE", "LIB", "LIBPATH",
        "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    }
    env = {key: value for key, value in windows.child_environment().items() if key.upper() in allow}
    env.update({
        "PATH": str(node.parent) + os.pathsep + str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
        "HUSKY": "0", "ELECTRON_SKIP_BINARY_DOWNLOAD": "1", "CI": "true",
        "npm_config_cache": str(root / "npm-cache"), "npm_config_audit": "false", "npm_config_fund": "false",
        "npm_config_maxsockets": "4",
    })
    run([node, npm, "ci", "--no-audit", "--no-fund"], cwd=cloudcli, env=env, log=log)
    # The shared Portal UI is independently deployed; build the node backend only.
    run([node, npm, "run", "build:server"], cwd=cloudcli, env=env, log=log)
    run([node, "-e", "const D=require('better-sqlite3');const d=new D(':memory:');d.exec('select 1');d.close();require('node-pty')"],
        cwd=cloudcli, env=env, log=log)
    run([node, npm, "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd=cloudcli, env=env, log=log)
    tunnel.write_state(stage / "release.json", manifest)


def export_machine(enrollment, config, output):
    output = Path(output)
    if output.is_symlink():
        raise Error("linked_machine_output")
    if output.exists():
        previous = json.loads(output.read_text(encoding="utf-8-sig"))
        if previous.get("schema") != 1 or previous.get("nodeId") != enrollment["nodeId"]:
            raise Error("output_belongs_to_another_machine")
    output.parent.mkdir(parents=True, exist_ok=True)
    tunnel.write_state(output, {
        "schema": 1, "nodeId": enrollment["nodeId"], "platform": "windows-x64", "name": config["name"],
        "region": "Windows Dev Box", "networkMode": "devtunnel",
        "tlsCertificate": Path(config["certificate"]).read_text(encoding="utf-8"),
        "devTunnel": {"tunnelId": config["tunnelId"], "clusterId": config["clusterId"]},
    })


def configure(args):
    if os.name != "nt" or platform.machine().lower() not in ("amd64", "x86_64") or sys.version_info < (3, 12):
        raise Error("native_windows_x64_and_python_3_12_required")
    computer = os.environ.get("COMPUTERNAME", "")
    if args.expected_computer_name and computer.casefold() != args.expected_computer_name.casefold():
        raise Error("wrong_computer_no_installation_attempted")
    context = windows.service.owner_context()
    if context["elevated"] or context["sessionId"] <= 0:
        raise Error("use_original_logged_on_non_elevated_owner")
    if args.apply and not args.network_approved:
        raise Error("review_private_outbound_tunnel_then_use_NetworkApproved_no_firewall_changes")
    enrollment = json.loads(Path(args.enrollment).read_text(encoding="utf-8-sig"))
    acceptance = enrollment.get("acceptance")
    if acceptance and (not isinstance(acceptance, dict)
                       or not isinstance(acceptance.get("expectedComputerName"), str)
                       or computer.casefold() != acceptance["expectedComputerName"].casefold()):
        raise Error("acceptance_package_is_bound_to_a_different_computer")
    manifest = json.loads((SKILL / "assets/manifest.json").read_text(encoding="utf-8-sig"))
    node_id = enrollment.get("nodeId", "")
    if not tunnel.NODE_ID.fullmatch(node_id):
        raise Error("personalized_windows_package_required")
    home = Path.home().resolve()
    root = home / ".local/share/codey-machine-windows" / node_id
    config_root = home / ".config/codey-machine-windows" / node_id
    if any(not folder.resolve().is_relative_to(home) or folder.is_symlink() for folder in (root, config_root)):
        raise Error("installation_path_escaped_owner_home")
    state_file, runtime_file = config_root / "installation.json", config_root / "runtime.json"
    state = json.loads(state_file.read_text(encoding="utf-8-sig")) if state_file.is_file() else None
    if state and (state.get("nodeId") != node_id or state.get("ownerSid") != context["sid"]
                  or state.get("computerName") != computer or state.get("releaseId") != manifest["releaseId"]):
        raise Error("existing_installation_identity_or_release_mismatch")
    artifacts = tunnel.validate_bundle(enrollment, manifest, ready=bool(state and state.get("ready")))
    for artifact in artifacts:
        file = SKILL / "assets" / artifact["file"]
        if file.is_symlink() or file.stat().st_size != artifact["size"] or tunnel.digest(file) != artifact["sha256"]:
            raise Error("source_archive_checksum_mismatch")
    if state and state.get("ready"):
        config = json.loads(runtime_file.read_text(encoding="utf-8-sig"))
        saved = worker.validate(config, "workspace", context)
        windows.common.verify(saved, {"listenIp": "127.0.0.1"}, Path(config["certificate"]))
        export_machine(saved, config, args.out)
        print(json.dumps({"ok": True, "alreadyConfigured": True, "servicesRestarted": False, "output": args.out}))
        return
    if state or root.exists() or config_root.exists():
        raise Error("unfinished_or_unrecognized_installation_requires_review_no_overwrite")
    codex_home = Path(os.environ.get("CODEX_HOME") or home / ".codex")
    if not codex_home.is_absolute():
        raise Error("existing_CODEX_HOME_must_be_absolute")
    codex, openssl, pythonw = existing_tools(args, home)
    proof = gateway_proof()
    if proof["ownerSid"] != context["sid"]:
        raise Error("4141_process_belongs_to_another_owner")
    occupied = free_ports()
    provider, provider_env = referenced_provider(codex_home)
    usage_key = usage_key_file(args.usage_key_file, provider, codex_home)
    verify_usage(usage_key)
    workspace = Path(args.workspace_root or (home / "Documents" if (home / "Documents").is_dir() else home)).resolve()
    name = args.name or computer
    if not name or len(name) > 80 or any(ord(char) < 32 for char in name):
        raise Error("invalid_machine_display_name")
    if not workspace.is_dir():
        raise Error("existing_workspace_directory_required")
    plan = {
        "nodeId": node_id, "platform": "windows-x64", "mode": "private-devtunnel-existing-model",
        "computerName": computer, "ownerSid": context["sid"], "releaseId": manifest["releaseId"],
        "protectedModelProcess": proof, "codexExecutable": str(codex), "codexHome": str(codex_home),
        "opensslExecutable": str(openssl), "privateListeners": ["127.0.0.1:3001", "127.0.0.1:8443"],
        "occupiedPorts": occupied, "services": list(worker.COMPONENTS),
        "networkChanges": "Create only a node-bound private DevTunnel with two HTTPS ports after approval",
        "firewallChanged": False, "azureArmPermissionsRequired": False, "existingModelServiceChanged": False,
        "logonOnly": True, "globalToolsChanged": False,
    }
    if not args.apply:
        print(json.dumps(plan, indent=2))
        return
    if occupied:
        raise Error("workspace_or_data_port_occupied_no_process_stopped")
    if shutil.disk_usage(home).free < 8 * 1024 ** 3:
        raise Error("eight_GiB_free_space_required")
    devtunnel = prepare_devtunnel(args, home, context["sid"])
    if gateway_proof() != proof:
        raise Error("protected_model_process_changed_before_installation")
    config_text = (codex_home / "config.toml").read_bytes() if (codex_home / "config.toml").exists() else None
    windows.private_directory(config_root, context["sid"])
    windows.private_directory(root, context["sid"])
    tunnel.write_state(state_file, {**plan, "ready": False})
    tasks_created = False
    try:
        releases = root / "releases"
        releases.mkdir()
        stage = windows.within(releases / (manifest["releaseId"] + ".prepare"), releases)
        release = windows.within(releases / manifest["releaseId"], releases)
        stage.mkdir()
        build_runtime(manifest, root, stage, config_root / "dependency-build.log")
        os.replace(windows.within(stage, releases), windows.within(release, releases))
        if gateway_proof() != proof:
            raise Error("protected_model_process_changed_during_build")
        cert, key = config_root / "node-cert.pem", config_root / "node-key.pem"
        dns = f"{node_id}.nodes.codey.internal"
        run([openssl, "req", "-x509", "-newkey", "rsa:3072", "-noenc", "-days", "365",
             "-keyout", key, "-out", cert, "-subj", f"/CN={dns}", "-addext", f"subjectAltName=DNS:{dns}",
             "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
             "-addext", "extendedKeyUsage=serverAuth"], log=config_root / "dependency-build.log")
        enrollment_file = config_root / "enrollment.json"
        tunnel.write_state(enrollment_file, enrollment)
        (config_root / "ticket.key").write_text(enrollment["clientSigningKey"], encoding="utf-8")
        binding = tunnel.ensure_tunnel(devtunnel, enrollment, config_root)
        binaries = root / "bin"
        binaries.mkdir()
        for name in ("windows-tunnel-service.py", "windows-tunnel-client.py", "windows-service.py"):
            shutil.copyfile(SCRIPT / name, binaries / name)
        node = release / "node/node.exe"
        config = {
            "schema": 1, "kind": "windows-devtunnel", "nodeId": node_id, "ownerSid": context["sid"],
            "computerName": computer, "root": str(root), "configRoot": str(config_root),
            "name": args.name or computer, "pythonwExe": str(pythonw), "nodeExe": str(node),
            "runnerPath": str(binaries / "windows-tunnel-service.py"),
            "ownerHelper": str(binaries / "windows-service.py"),
            "tunnelHelper": str(binaries / "windows-tunnel-client.py"),
            "codexExe": str(codex), "codexHome": str(codex_home), "devtunnelExe": str(devtunnel),
            "workspaceEntry": str(release / "cloudcli/dist-server/server/index.js"),
            "dataEntry": str(release / "portal-node/node-relay/server.mjs"),
            "databasePath": str(config_root / "auth.db"), "workspaceRoot": str(workspace),
            "enrollmentFile": str(enrollment_file), "certificate": str(cert), "privateKey": str(key),
            "ticketKeyFile": str(config_root / "ticket.key"), "usageKeyFile": str(usage_key) if usage_key else "",
            "providerEnv": provider_env, "protectedModelProcess": proof,
            "servicePath": os.pathsep.join([str(node.parent), str(Path(sys.executable).parent), str(codex.parent),
                                          os.environ.get("PATH", "")]),
            **binding,
        }
        config["fileHashes"] = {config[field]: tunnel.digest(config[field]) for field in (
            "runnerPath", "ownerHelper", "tunnelHelper", "nodeExe", "codexExe", "devtunnelExe", "workspaceEntry", "dataEntry",
        )}
        tunnel.write_state(runtime_file, config)
        for component in worker.COMPONENTS:
            worker.validate(config, component, context)
        # The Portal verifies Microsoft ownership/HTTPS ports/non-anonymous ACLs.
        tunnel.renew(config, enrollment, force=True)
        run([windows.native_powershell(), "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
             "-File", SCRIPT / "windows-tunnel-tasks.ps1", "-ConfigPath", runtime_file, "-Operation", "Install"],
            log=config_root / "dependency-build.log")
        tasks_created = True
        for attempt in range(30):
            try:
                windows.common.verify(enrollment, {"listenIp": "127.0.0.1"}, cert)
                break
            except (OSError, ValueError, windows.SetupError, http.client.HTTPException):
                if attempt == 29:
                    raise Error("local_TLS_SSO_usage_or_anonymous_denial_failed")
                time.sleep(2)
        if gateway_proof() != proof:
            raise Error("protected_model_process_changed")
        after = (codex_home / "config.toml").read_bytes() if (codex_home / "config.toml").exists() else None
        if after != config_text:
            raise Error("owner_codex_configuration_changed_no_rollback_of_user_changes")
        export_machine(enrollment, config, args.out)
        tunnel.write_state(state_file, {**plan, "ready": True})
        print(json.dumps({
            "ok": True, "localTlsAndSsoVerified": True, "existingModelServiceUnchanged": True,
            "existingCodexConfigUnchanged": True, "logonOnly": True, "firewallChanged": False,
            "portalActivationRequired": True, "realModelCallsTested": False, "reloginTested": False,
            "output": args.out, "runtimeConfig": str(runtime_file),
        }, indent=2))
    except BaseException:
        if tasks_created:
            run([windows.native_powershell(), "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                 "-File", SCRIPT / "windows-tunnel-tasks.ps1", "-ConfigPath", runtime_file,
                 "-Operation", "RemoveCreated"], check=False)
        # Preserve private diagnostics, the same identity/tunnel, and all old services.
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enrollment", default=str(SKILL / "assets/enrollment.json"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--name", default="")
    parser.add_argument("--expected-computer-name", default="")
    parser.add_argument("--codex-executable")
    parser.add_argument("--openssl")
    parser.add_argument("--devtunnel-executable")
    parser.add_argument("--usage-key-file")
    parser.add_argument("--workspace-root")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--network-approved", action="store_true")
    try:
        configure(parser.parse_args())
    except Exception as error:
        print(json.dumps({"ok": False, "code": str(error) if isinstance(error, (Error, tunnel.TunnelError))
                          else "windows_tunnel_setup_failed_review_private_log"}))
        raise SystemExit(1)
