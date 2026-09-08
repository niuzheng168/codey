"""Fresh Windows x64 Codey node installer. Plan first; preserve existing services."""
import argparse
import base64
import ctypes
import hashlib
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import platform
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile

SCRIPT = Path(__file__).resolve().parent
SKILL = SCRIPT.parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SCRIPT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


common = load("codey_machine_common", "configure-machine.py")
service = load("codey_windows_service", "windows-service.py")
SetupError = common.SetupError


def native_powershell():
    folder = "Sysnative" if ctypes.sizeof(ctypes.c_void_p) == 4 else "System32"
    return Path(os.environ["WINDIR"]) / folder / "WindowsPowerShell/v1.0/powershell.exe"


def child_environment():
    return {key: value for key, value in os.environ.items()
            if key.upper() not in ("PSMODULEPATH", "CODEX_THREAD_ID", "CODEX_PARENT_THREAD_ID",
                                   "CODEX_INTERNAL_ORIGINATOR_OVERRIDE")}


def command(arguments, *, cwd=None, env=None, log=None):
    options = {"cwd": cwd, "env": env or child_environment(), "stdin": subprocess.DEVNULL,
               "text": True, "encoding": "utf-8", "errors": "replace", "timeout": 1800,
               "creationflags": service.CREATE_NO_WINDOW}
    if log:
        with Path(log).open("a", encoding="utf-8") as output:
            result = subprocess.run([str(arg) for arg in arguments], stdout=output,
                                    stderr=subprocess.STDOUT, **options)
    else:
        result = subprocess.run([str(arg) for arg in arguments], capture_output=True, **options)
    if result.returncode:
        raise SetupError(f"{Path(str(arguments[0])).name} failed; "
                         + ("inspect the owner-only build log" if log else "no policy or privilege fallback attempted"))
    return result


def within(file, root):
    resolved, parent = Path(file).resolve(), Path(root).resolve()
    if resolved == parent or not resolved.is_relative_to(parent):
        raise SetupError("A computed installation path escaped its named root")
    return resolved


def write_json(file, value):
    file = Path(file)
    if file.is_symlink():
        raise SetupError("Refusing a linked configuration file")
    temporary = file.with_name(file.name + "." + secrets.token_hex(6) + ".next")
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
    os.replace(temporary, file)


def private_directory(directory, sid):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    # This installer creates this exact directory; it does not edit an existing
    # tree's ACL, elevate, or change system/user security settings.
    icacls = Path(os.environ["WINDIR"]) / "System32/icacls.exe"
    command([icacls, directory, "/inheritance:r", "/grant:r",
             f"*{sid}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"])


def archive_name(name):
    value = PurePosixPath(name)
    reserved = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)
    if (value.is_absolute() or PureWindowsPath(name).drive or "\\" in name or ".." in value.parts
            or any(re.search(r'[<>:"|?*\x00-\x1f]', part) or part.rstrip(" .") != part or reserved.match(part)
                   for part in value.parts)):
        raise SetupError("Unsafe Windows archive member")
    return value


def extract_zip(archive, target, expected_root):
    target = Path(target)
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        if len(entries) > 100000 or sum(entry.file_size for entry in entries) > 768 * 1024 ** 2:
            raise SetupError("Unexpectedly large Node archive")
        seen = set()
        for entry in entries:
            name = archive_name(entry.filename)
            folded = str(name).casefold()
            if (not name.parts or name.parts[0] != expected_root or folded in seen
                    or stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1):
                raise SetupError("Unexpected, duplicate, linked, or encrypted Node archive member")
            seen.add(folded)
        package.extractall(target)


def extract_source(archive, target):
    with tarfile.open(archive) as package:
        entries = package.getmembers()
        if len(entries) > 200000 or sum(entry.size for entry in entries) > 8 * 1024 ** 3:
            raise SetupError("Unexpectedly large source archive")
        members = {}
        for entry in entries:
            name = str(archive_name(entry.name)).casefold()
            if name in members or not (entry.isfile() or entry.isdir() or entry.issym() or entry.islnk()):
                raise SetupError("Duplicate source path or special device")
            members[name] = entry
        # Git's CLAUDE.md -> AGENTS.md is a normal source-file link. Materialize
        # safe in-archive file links; do not require Windows Developer Mode,
        # create filesystem links, or resolve a link outside the checked archive.
        def file_target(entry, visited):
            if entry.isfile():
                return entry
            name = str(archive_name(entry.name)).casefold()
            if name in visited or len(visited) >= 8 or not (entry.issym() or entry.islnk()):
                raise SetupError("Source link must resolve to an ordinary in-archive file")
            relative = archive_name(entry.linkname)
            destination = PurePosixPath(entry.name).parent / relative if entry.issym() else relative
            linked = members.get(str(destination).casefold())
            if linked is None:
                raise SetupError("Source link target is missing")
            return file_target(linked, {*visited, name})
        links = [(entry, file_target(entry, set())) for entry in entries if entry.issym() or entry.islnk()]
        if sum(entry.size for entry in entries) + sum(linked.size for _, linked in links) > 8 * 1024 ** 3:
            raise SetupError("Expanded source links exceed the extraction limit")
        package.extractall(target, members=[entry for entry in entries if entry.isfile() or entry.isdir()], filter="data")
        for entry, linked in links:
            destination = within(Path(target) / PurePosixPath(entry.name), target)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with package.extractfile(linked) as source, destination.open("xb") as output:
                shutil.copyfileobj(source, output)


def runtime(manifest, enrollment, root, stage, log):
    distribution = manifest["nodeDistribution"]
    downloads = root / "downloads"
    downloads.mkdir(exist_ok=True)
    archive = downloads / distribution["file"]
    if not archive.exists():
        partial = archive.with_suffix(".part")
        with partial.open("xb") as output, urllib.request.urlopen(distribution["url"], timeout=120) as response:
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > 128 * 1024 ** 2:
                    raise SetupError("Unexpectedly large Node distribution")
                output.write(chunk)
        if common.digest(partial) != distribution["sha256"]:
            raise SetupError("Official Node checksum mismatch; partial download retained for inspection")
        os.replace(partial, archive)
    if archive.is_symlink() or common.digest(archive) != distribution["sha256"]:
        raise SetupError("Cached Node distribution checksum mismatch")
    prefix = f"node-v{manifest['node']}-win-x64"
    extract_zip(archive, stage, prefix)
    os.replace(within(stage / prefix, stage), within(stage / "node", stage))
    for component in ("cloudcli", "copilot-api"):
        target = stage / component
        target.mkdir()
        extract_source(SKILL / "assets" / f"{component}-source.tar.gz", target)
    node = stage / "node/node.exe"
    npm = stage / "node/node_modules/npm/bin/npm-cli.js"
    environment = {**child_environment(), "PATH": str(node.parent) + os.pathsep + os.environ.get("PATH", ""),
                   "HUSKY": "0", "SKIP_INSTALL_SIMPLE_GIT_HOOKS": "1", "CI": "true",
                   "ELECTRON_SKIP_BINARY_DOWNLOAD": "1", "npm_config_jobs": "2",
                   "npm_config_audit": "false", "npm_config_fund": "false",
                   "npm_config_cache": str(root / "npm-cache")}
    tools = stage / ".build-tools"
    command([node, npm, "install", "--prefix", tools, "--no-audit", "--no-fund",
             f"bun@{manifest['bunBuildTool']}"], env=environment, log=log)
    bun_root = tools / "node_modules/bun"
    bun_package = json.loads((bun_root / "package.json").read_text(encoding="utf-8"))
    relative = bun_package["bin"]["bun"] if isinstance(bun_package["bin"], dict) else bun_package["bin"]
    bun = within(bun_root / relative, bun_root)
    if bun.suffix.lower() != ".exe" or not bun.is_file():
        raise SetupError("Pinned Bun package did not provide a native Windows executable")
    copilot, cloudcli = stage / "copilot-api", stage / "cloudcli"
    for arguments in [("install", "--frozen-lockfile", "--ignore-scripts"), ("run", "build"),
                      ("install", "--frozen-lockfile", "--production", "--ignore-scripts")]:
        command([bun, *arguments], cwd=copilot, env=environment, log=log)
    command([node, npm, "ci", "--no-audit", "--no-fund"], cwd=cloudcli, env=environment, log=log)
    build_env = {**environment, "VITE_BASE_PATH": f"/cloudcli/{enrollment['nodeId']}/",
                 "VITE_CODEY_MANAGED": "true", "VITE_CODEY_PORTAL_SSO": "true"}
    command([node, npm, "run", "build"], cwd=cloudcli, env=build_env, log=log)
    command([node, npm, "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
            cwd=cloudcli, env=environment, log=log)
    # Keep the isolated build tools rather than recursively deleting a Windows
    # dependency tree. Future cleanup is a separate, confirmed operation.
    write_json(stage / "release.json", manifest)


def port_conflicts(network):
    conflicts = []
    for address, port in [(network["listenIp"], 3001), (network["listenIp"], 8443), ("127.0.0.1", 4141)]:
        try:
            with socket.socket() as probe:
                probe.bind((address, port))
        except OSError:
            conflicts.append(f"{address}:{port}")
    return conflicts


def approved_sources(network):
    sources = network.get("allowedSources")
    if not isinstance(sources, list) or not sources or len(sources) > 32:
        raise SetupError("The reviewed network file must list exact allowedSources for firewall review")
    ranges = [ipaddress.ip_network(value, strict=True) for value in sources]
    private = [ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]
    if any(value.version != 4 or not any(value.subnet_of(parent) for parent in private) for value in ranges):
        raise SetupError("Only explicit RFC1918 gateway source ranges are accepted; never Any/Internet")
    return [str(value) for value in ranges]


def machine_file(enrollment, network, certificate, output, name):
    output = Path(output).resolve()
    if output.exists():
        previous = json.loads(output.read_text(encoding="utf-8-sig"))
        if previous.get("nodeId") != enrollment["nodeId"] or previous.get("schema") != 1:
            raise SetupError("Output path belongs to another file or machine")
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json(output, {
        "schema": 1, "nodeId": enrollment["nodeId"], "platform": "windows-x64",
        "name": name or network["name"], "region": network["region"],
        "privateIp": network["privateIp"], "tlsCertificate": certificate.read_text(encoding="utf-8"),
        "networkMode": network["networkMode"], "vmResourceId": network["vmResourceId"],
    })
    return {"ok": True, "platform": "windows-x64", "nodeId": enrollment["nodeId"],
            "machineFile": str(output), "localTlsAndSsoVerified": True,
            "portalVerification": "required before the node is added",
            "modelAuthentication": "not tested; complete the owner's own login",
            "updater": "not supported on Windows yet; Workspace health is independent",
            "firewallChanged": False, "logonOnly": True, "rebootTested": False}


def configure(args):
    if os.name != "nt" or platform.machine().lower() not in ("amd64", "x86_64"):
        raise SetupError("Use the Windows x64 entry point on Windows, not WSL/Linux/macOS")
    if sys.version_info < (3, 12) or not hasattr(tarfile, "data_filter"):
        raise SetupError("An existing Python 3.12+ with safe archive extraction is required")
    context = service.owner_context()
    if context["elevated"] or context["sessionId"] <= 0:
        raise SetupError("Run as the original logged-on, non-elevated Windows owner")
    if args.apply and not args.network_approved:
        raise SetupError("Private listener/network changes need explicit --network-approved; no firewall changes are automatic")
    enrollment = json.loads(Path(args.enrollment).read_text(encoding="utf-8-sig"))
    manifest = json.loads((SKILL / "assets/manifest.json").read_text(encoding="utf-8-sig"))
    network = json.loads(Path(args.network_file).read_text(encoding="utf-8-sig"))
    artifacts = common.validate_inputs(enrollment, manifest, network, "windows-x64")
    if Path(args.out).is_symlink():
        raise SetupError("Refusing a linked machine output")
    output = Path(args.out).resolve()
    if output.exists():
        previous = json.loads(output.read_text(encoding="utf-8-sig"))
        if previous.get("nodeId") != enrollment["nodeId"] or previous.get("schema") != 1:
            raise SetupError("Output path belongs to another file or machine")
    sources = approved_sources(network)
    for artifact in artifacts:
        archive = SKILL / "assets" / artifact["file"]
        if archive.is_symlink() or archive.stat().st_size != artifact["size"] or common.digest(archive) != artifact["sha256"]:
            raise SetupError("Reviewed source archive checksum mismatch")
    home = Path.home().resolve()
    codex_home = Path(os.environ.get("CODEX_HOME") or home / ".codex")
    if not codex_home.is_absolute():
        raise SetupError("An existing CODEX_HOME must be absolute; the installer will not select a different login/config")
    root, config = home / ".local/share/codey-machine-windows", home / ".config/codey-machine-windows"
    state_file = config / "installation.json"
    state = json.loads(state_file.read_text(encoding="utf-8-sig")) if state_file.exists() else None
    network_hash = hashlib.sha256(json.dumps(network, sort_keys=True).encode()).hexdigest()
    if state and (state.get("nodeId") != enrollment["nodeId"] or state.get("ownerSid") != context["sid"]
                  or state.get("networkSha256") != network_hash or state.get("releaseId") != manifest["releaseId"]):
        raise SetupError("An existing Windows installation has a different identity/release/network; no takeover or upgrade")
    if state and not state.get("ready"):
        raise SetupError("A previous incomplete installation needs review; no automatic overwrite or cleanup")
    if not state and (root.exists() or config.exists()):
        raise SetupError("An unrecognized installation directory exists; no overwrite")
    conflicts = [] if state else port_conflicts(network)
    summary = {"nodeId": enrollment["nodeId"], "platform": "windows-x64", "releaseId": manifest["releaseId"],
               "ownerSid": context["sid"], "installationRoot": str(root), "configRoot": str(config),
               "privateListeners": [f"{network['listenIp']}:3001", f"{network['listenIp']}:8443"],
               "privateGatewaySources": sources, "modelListener": "127.0.0.1:4141",
               "azureHealthProbeSource": "168.63.129.16/32" if network["networkMode"] == "private-link" else None,
               "portConflicts": conflicts, "existingCodexConfig": "preserved", "codexHome": str(codex_home), "logonOnly": True,
               "networkApproved": args.network_approved, "firewallChanged": False,
               "windowsFirewall": "review/authorize the exact gateway sources separately; no global rule or port 22 is opened",
               "updater": "unsupported; no Linux updater is installed",
               "networkSha256": network_hash}
    if not args.apply:
        print(json.dumps(summary, indent=2))
        return
    if conflicts:
        raise SetupError("Required ports are occupied/not local; no existing process was stopped")
    if state:
        common.verify(enrollment, network, config / "node-cert.pem")
        print(json.dumps(machine_file(enrollment, network, config / "node-cert.pem", args.out, args.name), indent=2))
        return
    if shutil.disk_usage(home).free < 8 * 1024 ** 3:
        raise SetupError("At least 8 GiB free space is required")
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    openssl = Path(args.openssl or shutil.which("openssl") or "")
    if not pythonw.is_file() or not openssl.is_absolute() or not openssl.is_file() or openssl.suffix.lower() != ".exe":
        raise SetupError("Existing pythonw.exe and native OpenSSL are required; no global runtime or policy is changed")
    tasks_started = False
    private_directory(config, context["sid"])
    private_directory(root, context["sid"])
    state = {**summary, "ready": False}
    write_json(state_file, state)
    task_config = config / "runtime.json"
    log = config / "dependency-build.log"
    try:
        releases = root / "releases"
        releases.mkdir()
        stage = within(releases / (manifest["releaseId"] + ".prepare"), releases)
        release = within(releases / manifest["releaseId"], releases)
        stage.mkdir()
        runtime(manifest, enrollment, root, stage, log)
        # Both exact absolute directory targets have been checked under this
        # newly-created installation's releases root before the directory move.
        os.replace(within(stage, releases), within(release, releases))
        node, cloudcli, copilot = release / "node/node.exe", release / "cloudcli", release / "copilot-api"
        cert, key = config / "node-cert.pem", config / "node-key.pem"
        dns = f"{enrollment['nodeId']}.nodes.codey.internal"
        command([openssl, "req", "-x509", "-newkey", "rsa:3072", "-noenc", "-days", "365",
                 "-keyout", key, "-out", cert, "-subj", f"/CN={dns}", "-addext", f"subjectAltName=DNS:{dns}",
                 "-addext", "basicConstraints=critical,CA:FALSE",
                 "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
                 "-addext", "extendedKeyUsage=serverAuth"], log=log)
        client_key = config / "client-signing.key"
        client_key.write_text(enrollment["clientSigningKey"] + "\n", encoding="utf-8")
        data = root / "data"
        for folder in [data / "copilot-api", data / "cloudcli", root / "bin"]:
            folder.mkdir(parents=True, exist_ok=True)
        random_key = lambda: base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
        write_json(data / "copilot-api/config.json", {"auth": {
            "apiKeys": [random_key()], "adminApiKey": random_key(), "sessionHistoryApiKey": random_key()}})
        if args.codex_executable:
            codex = Path(args.codex_executable)
            if not codex.is_absolute() or not codex.is_file() or codex.suffix.lower() != ".exe":
                raise SetupError("Codex executable must be an explicit existing native executable")
        else:
            candidates = list((cloudcli / "node_modules/@openai").glob("codex*/vendor/**/codex.exe"))
            if len(candidates) != 1:
                raise SetupError("Use --codex-executable to select the owner's existing native Codex; no PATH fallback")
            codex = within(candidates[0], release)
        runner = root / "bin/windows-service.py"
        shutil.copyfile(SCRIPT / "windows-service.py", runner)
        environment = {"NODE_ENV": "production", "CODEX_HOME": str(codex_home),
                       "PATH": str(node.parent) + os.pathsep + str(codex.parent) + os.pathsep + os.environ.get("PATH", "")}
        config_value = {
            "schema": 1, "nodeId": enrollment["nodeId"], "ownerSid": context["sid"], "root": str(root),
            "nodeExe": str(node), "nodeSha256": common.digest(node), "pythonwExe": str(pythonw),
            "runnerPath": str(runner), "runnerSha256": common.digest(runner), "environment": environment,
            "services": {
                "copilot-api": {"entry": str(copilot / "dist/main.js"), "cwd": str(copilot),
                    "arguments": ["start", "--headless", "--host", "127.0.0.1", "--port", "4141"], "environment": {
                        "COPILOT_API_HOME": str(data / "copilot-api"), "COPILOT_API_CODEY_HTTPS_PORT": "8443",
                        "COPILOT_API_CODEY_HTTPS_HOST": network["listenIp"], "COPILOT_API_CODEY_TLS_CERT": str(cert),
                        "COPILOT_API_CODEY_TLS_KEY": str(key), "COPILOT_API_CODEY_NODE_ID": enrollment["nodeId"],
                        "COPILOT_API_CODEY_ALLOWED_ORIGIN": enrollment["portalOrigin"],
                        "COPILOT_API_CODEY_SIGNING_KEY_FILE": str(client_key)}},
                "workspace": {"entry": str(cloudcli / "dist-server/server/index.js"), "cwd": str(cloudcli), "environment": {
                    "CODEY_MANAGED": "true", "CODEY_PORTAL_SSO": "true", "SERVER_PORT": "3001", "HOST": network["listenIp"],
                    "DATABASE_PATH": str(data / "cloudcli/auth.db"), "CODEY_PORTAL_NODE_ID": enrollment["nodeId"],
                    "CODEY_PORTAL_USERNAME": enrollment["username"], "CODEY_PORTAL_PRINCIPAL_ID": enrollment["principalId"],
                    "CODEY_PORTAL_SSO_KEY": enrollment["workspaceSsoKey"], "CODEY_PORTAL_TLS_CERT": str(cert),
                    "CODEY_PORTAL_TLS_KEY": str(key), "CODEY_CODEX_EXECUTABLE": str(codex)}},
            },
        }
        write_json(task_config, config_value)
        for component in ("copilot-api", "workspace"):
            service.validate(config_value, component, context)
        command([native_powershell(), "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                 "-File", SCRIPT / "windows-tasks.ps1", "-ConfigPath", task_config, "-Operation", "Install"], log=log)
        tasks_started = True
        for attempt in range(20):
            try:
                common.verify(enrollment, network, cert)
                break
            except (OSError, ValueError, SetupError, http.client.HTTPException):
                if attempt == 19:
                    raise SetupError("Local TLS/owner/anonymous-denial probes failed; no machine file produced")
                time.sleep(2)
        # An output write failure must not leave a "ready" installation after
        # the failure handler rolls back this invocation's newly created tasks.
        report = machine_file(enrollment, network, cert, args.out, args.name)
        state["ready"] = True
        write_json(state_file, state)
        print(json.dumps(report, indent=2))
    except Exception:
        if tasks_started:
            command([native_powershell(), "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                     "-File", SCRIPT / "windows-tasks.ps1", "-ConfigPath", task_config,
                     "-Operation", "RemoveCreated"], log=log)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enrollment", default=str(SKILL / "assets/enrollment.json"))
    parser.add_argument("--network-file", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--name")
    parser.add_argument("--openssl")
    parser.add_argument("--codex-executable")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--network-approved", action="store_true")
    try:
        configure(parser.parse_args())
    except Exception as error:
        raise SystemExit(str(error) if isinstance(error, SetupError) else "Windows setup failed; no credentials or raw command output exported")
