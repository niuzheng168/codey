"""Owner-scoped Linux package transactions. Never updates Node/Codex or identity."""
import base64
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import socket
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import tomllib
import traceback

PROTOCOL = 1
RELEASE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
HASH = re.compile(r"^[a-f0-9]{64}$")
COMPONENTS = ("cloudcli", "copilotApi")


class UpdateError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def require(condition, code="operation_failed"):
    if not condition:
        raise UpdateError(code)


def sha(file):
    digest = hashlib.sha256()
    with Path(file).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def save(file, value):
    file = Path(file)
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = file.with_name(file.name + ".next")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, file)


def run(arguments, *, env=None, cwd=None, timeout=60, log=None):
    result = subprocess.run([str(arg) for arg in arguments], env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                            capture_output=True, timeout=timeout)
    if log:
        Path(log).write_bytes(result.stdout + result.stderr)
        Path(log).chmod(0o600)
    require(result.returncode == 0, "operation_failed")
    return result.stdout.decode("utf-8", errors="replace").strip()


def verify_envelope(envelope, public_key, work, now=None):
    now = int(time.time() * 1000) if now is None else now
    require(set(envelope) == {"payload", "signature"}, "signature_invalid")
    try:
        payload = base64.b64decode(envelope["payload"], validate=True)
        signature = base64.urlsafe_b64decode(envelope["signature"] + "==")
    except (ValueError, TypeError):
        raise UpdateError("signature_invalid") from None
    require(len(payload) <= 75000 and len(signature) == 64, "signature_invalid")
    try:
        pem = re.fullmatch(r"-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----\s*", public_key)
        der = base64.b64decode(re.sub(r"\s+", "", pem[1]), validate=True) if pem else b""
    except (ValueError, TypeError):
        der = b""
    require(len(der) == 44 and der[:12] == bytes.fromhex("302a300506032b6570032100"), "signature_invalid")
    with tempfile.TemporaryDirectory(prefix="verify-", dir=work) as temporary:
        temporary = Path(temporary)
        (temporary / "public.pem").write_text(public_key)
        (temporary / "payload").write_bytes(payload)
        (temporary / "signature").write_bytes(signature)
        try:
            run(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", temporary / "public.pem",
                 "-rawin", "-in", temporary / "payload", "-sigfile", temporary / "signature"], timeout=10)
        except (UpdateError, FileNotFoundError):
            raise UpdateError("signature_invalid") from None
    try:
        manifest = json.loads(payload)
    except ValueError:
        raise UpdateError("signature_invalid") from None
    require(manifest.get("schema") == 1 and manifest.get("kind") == "codey-node-release"
            and RELEASE_ID.fullmatch(manifest.get("id", "")) and manifest.get("protocol") == PROTOCOL
            and manifest.get("configSchema") == 1 and manifest.get("rollback") == "code-only"
            and isinstance(manifest.get("sequence"), int) and manifest["sequence"] > 0
            and isinstance(manifest.get("createdAt"), int) and manifest["createdAt"] <= now + 60000
            and isinstance(manifest.get("expiresAt"), int) and manifest["expiresAt"] > now
            and 0 < manifest["expiresAt"] - manifest["createdAt"] <= 90 * 86400000,
            "signature_invalid")
    require(manifest.get("platform") == "linux-x64", "unsupported_platform")
    require(isinstance(manifest.get("migrations"), list) and len(manifest["migrations"]) <= 20
            and all(isinstance(item, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", item)
                    for item in manifest["migrations"]), "signature_invalid")
    require(isinstance(manifest.get("components"), dict) and manifest["components"]
            and set(manifest["components"]).issubset(COMPONENTS), "signature_invalid")
    for name, component in manifest["components"].items():
        require(component.get("file") == ("cloudcli.tar.gz" if name == "cloudcli" else "gateway.tar.gz")
                and HASH.fullmatch(component.get("sha256", "")) and HASH.fullmatch(component.get("entrySha256", ""))
                and re.fullmatch(r"[a-f0-9]{40}", component.get("commit", ""))
                and isinstance(component.get("size"), int) and 0 < component["size"] <= 512 * 1024 * 1024
                and isinstance(component.get("nodeMajors"), list) and component["nodeMajors"]
                and all(isinstance(major, int) and 20 <= major <= 40 for major in component["nodeMajors"])
                and (name != "cloudcli" or HASH.fullmatch(component.get("lockSha256", ""))), "signature_invalid")
    return manifest, hashlib.sha256(payload).hexdigest()


def extract(archive, destination):
    destination = Path(destination)
    require(not destination.exists(), "stage_failed")
    with tarfile.open(archive, "r:gz") as source:
        members = []
        names = set()
        expanded = 0
        for member in source:
            members.append(member)
            require(len(members) <= 100000 and len(member.name) <= 500, "stage_failed")
            name = PurePosixPath(member.name)
            require(name.parts and not name.is_absolute() and ".." not in name.parts
                    and "\\" not in member.name and ":" not in member.name
                    and (member.isfile() or member.isdir()) and name.as_posix() not in names, "stage_failed")
            names.add(name.as_posix())
            expanded += member.size
            require(expanded <= 4 * 1024 ** 3, "stage_failed")
        destination.mkdir(mode=0o700, parents=True)
        root = destination.resolve()
        for member in members:
            target = destination / member.name
            require(target.resolve().is_relative_to(root), "stage_failed")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as content, target.open("xb") as output:
                shutil.copyfileobj(content, output)
            target.chmod(member.mode & 0o777 & ~0o6000)


def environment(pid):
    return dict(item.decode().split("=", 1) for item in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
                if b"=" in item)


def service(name):
    output = run(["systemctl", "--user", "show", name,
                  "--property=MainPID,ActiveState,FragmentPath"], timeout=10)
    values = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    require(values.get("ActiveState") == "active" and int(values.get("MainPID", "0")) > 0, "configuration_changed")
    return int(values["MainPID"]), Path(values["FragmentPath"])


def config_hash(file, probe_path=None):
    raw = Path(file).read_bytes()
    if Path(file).name == "config.toml":
        raw = re.sub(rb'(?m)^last_updated\s*=\s*"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"\r?\n?', b"", raw)
        if probe_path is not None:
            document = tomllib.loads(raw.decode("utf-8-sig"))
            projects = document.get("projects", {})
            # Codex records trust for the synthetic probe on first use. Only that
            # exact, empty owner-controlled directory is metadata, not all projects.
            if projects.get(str(probe_path)) == {"trust_level": "trusted"}:
                projects.pop(str(probe_path))
                if not projects:
                    document.pop("projects", None)
            raw = json.dumps(document, sort_keys=True, default=lambda value: {
                "tomlType": type(value).__name__, "value": str(value)}).encode()
    return hashlib.sha256(raw).hexdigest()


def gateway_config_hash(file):
    """Hash all gateway settings, accepting only equal-valued transport aliases."""
    document = read(file)
    require(isinstance(document, dict), "configuration_changed")

    def encoded(value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def transport(value):
        require(isinstance(value, dict), "configuration_changed")
        result = dict(value)
        if "headersTimeoutMsV2" in result:
            previous = result.pop("headersTimeoutMsV2")
            if "headersTimeoutMs" in result:
                require(encoded(previous) == encoded(result["headersTimeoutMs"]), "configuration_changed")
            else:
                result["headersTimeoutMs"] = previous
        return result

    # copilot-api 2.5.3 persists these two field renames at startup. Do not
    # ignore either block: conflicting aliases must fail before any switch.
    if "responsesTransport" in document:
        previous = transport(document.pop("responsesTransport"))
        if "upstreamTransport" in document:
            current = transport(document["upstreamTransport"])
            require(encoded(previous) == encoded(current), "configuration_changed")
        else:
            current = previous
        document["upstreamTransport"] = current
    elif "upstreamTransport" in document:
        document["upstreamTransport"] = transport(document["upstreamTransport"])
    return hashlib.sha256(encoded(document)).hexdigest()


def install_fingerprint(directory):
    directory = Path(directory)
    package = read(directory / "package.json")
    result = {"lock": sha(directory / "package-lock.json"), "scripts": package.get("scripts", {})}
    for relative in ["scripts/fix-node-pty.js", "scripts/postinstall.js"]:
        file = directory / relative
        if file.is_file():
            result[relative] = sha(file)
    return hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()


class Runtime:
    """Only discovery-derived paths and two allowlisted services may be mutated."""
    def __init__(self, config, home=None, create=True):
        self.config = config
        self.home = Path(home or Path.home()).resolve()
        self.root = self.home / ".local/share/codey-updater"
        self.private = self.home / ".config/codey-updater"
        self.create = create
        if create:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            self.private.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.profile_file = self.private / "profile.json"
        self.profile = read(self.profile_file) if self.profile_file.exists() else None

    def model_config_paths(self, cloudcli_env):
        config_home = Path(cloudcli_env.get("CODEX_HOME", str(self.home / ".codex")))
        files = [self.home / ".codex/config.toml", config_home / "config.toml",
                 self.home / ".config/codey-model-auth/api-key"]
        require(all(file.resolve().is_relative_to(self.home) for file in files), "configuration_changed")
        config_file = config_home / "config.toml"
        if config_file.is_file():
            document = tomllib.loads(config_file.read_text(encoding="utf-8-sig"))
            reference = document.get("model_catalog_json")
            if reference is not None:
                require(isinstance(reference, str) and reference.strip() and "\0" not in reference,
                        "configuration_changed")
                if reference.startswith("~/"):
                    catalog = self.home / reference[2:]
                else:
                    require(not reference.startswith("~"), "configuration_changed")
                    catalog = Path(reference)
                    if not catalog.is_absolute():
                        catalog = config_home / catalog
                catalog = catalog.resolve()
                # Never follow a configured path into another owner's data, or silently omit a missing catalog.
                require(catalog.is_relative_to(self.home) and catalog.is_file(), "configuration_changed")
                files.append(catalog)
        return list(dict.fromkeys(files))

    def snapshot(self):
        require(platform.system() == "Linux" and platform.machine() == "x86_64", "unsupported_platform")
        require(os.getuid() != 0 and self.config["nodeId"] != "local", "unsupported_platform")
        cc_pid, cc_unit = service("codey-cloudcli.service")
        cp_name = self.profile["copilotService"] if self.profile else "codey-copilot-api.service"
        try:
            cp_pid, cp_unit = service(cp_name)
        except UpdateError:
            require(self.profile is None, "configuration_changed")
            cp_name = "copilot-api.service"
            cp_pid, cp_unit = service(cp_name)
        for pid in [cc_pid, cp_pid]:
            require(Path(f"/proc/{pid}").stat().st_uid == os.getuid(), "configuration_changed")
        cc_env, cp_env = environment(cc_pid), environment(cp_pid)
        require(cc_env.get("CODEY_PORTAL_NODE_ID") == cp_env.get("COPILOT_API_CODEY_NODE_ID") == self.config["nodeId"],
                "configuration_changed")
        require(cc_env.get("CODEY_PORTAL_PRINCIPAL_ID") == self.config["ownerId"], "configuration_changed")
        cloudcli = Path(f"/proc/{cc_pid}/cwd").resolve(strict=True)
        require(read(cloudcli / "package.json")["name"] == "@cloudcli-ai/cloudcli", "configuration_changed")
        command = Path(f"/proc/{cp_pid}/cmdline").read_bytes().decode().split("\0")
        candidates = []
        for item in command[1:]:
            file = Path(item) if item.startswith("/") else None
            if file and file.is_file():
                file = file.resolve()
                if file.name == "main.js" and file.parent.name == "dist":
                    candidates.append(file.parent.parent)
        require(len(candidates) == 1, "configuration_changed")
        copilot = candidates[0]
        require(read(copilot / "package.json")["name"] == "@jeffreycao/copilot-api", "configuration_changed")
        allowed = [self.home / name for name in [".local/share", ".local/lib/node_modules",
                                                  ".npm-global/lib/node_modules", ".nvm/versions/node"]]
        for directory in [cloudcli, copilot]:
            require(any(directory.is_relative_to(root) for root in allowed), "configuration_changed")
            require(directory.stat().st_uid == os.getuid(), "configuration_changed")
        for unit in [cc_unit, cp_unit]:
            require(unit.resolve().is_relative_to(self.home / ".config/systemd/user"), "configuration_changed")
        managed = cloudcli.is_relative_to(self.home / ".local/share/codey-machine") or (
            self.profile and self.profile["layout"] == "managed")
        if self.profile:
            require(self.profile["nodeId"] == self.config["nodeId"] and self.profile["ownerId"] == self.config["ownerId"],
                    "configuration_changed")
            cc_anchor, cp_anchor = Path(self.profile["cloudcliAnchor"]), Path(self.profile["copilotAnchor"])
            require(cc_anchor.resolve() == cloudcli and cp_anchor.resolve() == copilot, "configuration_changed")
        else:
            legacy_link = self.home / ".local/share/codey-cloudcli/current"
            cc_anchor = legacy_link if legacy_link.is_symlink() and legacy_link.resolve() == cloudcli else cloudcli
            cp_anchor = copilot
            for item in command[1:]:
                launch = Path(item) if item.startswith("/") and Path(item).name == "copilot-api" else None
                if launch:
                    guessed = launch.parent.parent / "lib/node_modules/@jeffreycao/copilot-api"
                    if guessed.exists() and guessed.resolve() == copilot:
                        cp_anchor = guessed
            profile = {"schema": 1, "nodeId": self.config["nodeId"], "ownerId": self.config["ownerId"],
                       "layout": "managed" if managed else "legacy", "copilotService": cp_name,
                       "cloudcliAnchor": str(cc_anchor), "copilotAnchor": str(cp_anchor)}
            if self.create:
                save(self.profile_file, profile)
            self.profile = profile
        data = Path(cp_env.get("COPILOT_API_HOME", str(self.home / ".local/share/copilot-api"))).resolve()
        database = Path(cc_env["DATABASE_PATH"]).resolve()
        require(data.is_relative_to(self.home) and database.is_relative_to(self.home), "configuration_changed")
        require(not any(data.is_relative_to(directory) or database.is_relative_to(directory)
                        for directory in [cloudcli, copilot]), "configuration_changed")
        protected = [cc_unit, cp_unit, data / "config.json", *self.model_config_paths(cc_env)]
        for key in ["COPILOT_API_CODEY_TLS_CERT", "COPILOT_API_CODEY_TLS_KEY", "COPILOT_API_CODEY_SIGNING_KEY_FILE"]:
            if cp_env.get(key):
                protected.append(Path(cp_env[key]))
        for folder in [".config/codey-cloudcli", ".config/codey-machine"]:
            directory = self.home / folder
            if directory.is_dir():
                protected.extend(directory.glob("*.env"))
                protected.extend(directory.glob("*.key"))
                protected.extend(directory.glob("*.pem"))
        versions = {}
        for name, directory, process in [("cloudcli", cloudcli, cc_pid), ("copilotApi", copilot, cp_pid)]:
            node = str(Path(f"/proc/{process}/exe").resolve(strict=True))
            version = run([node, "-p", "process.versions.node"], timeout=10)
            metadata = read(directory / "package.json")
            marker = directory / "codey-release.json"
            source_commit = read(marker).get("sourceCommit") if marker.is_file() else None
            if not source_commit:
                machine_manifest = directory.parent / "release.json"
                if machine_manifest.is_file():
                    source_commit = read(machine_manifest).get("cloudcli" if name == "cloudcli" else "copilotApi", {}).get("commit")
                elif name == "copilotApi" and (data / "portal-build.json").is_file():
                    source_commit = read(data / "portal-build.json").get("sourceCommit")
            entry = "dist-server/server/index.js" if name == "cloudcli" else "dist/main.js"
            versions[name] = {"version": metadata["version"], "commit": source_commit,
                              "entrySha256": sha(directory / entry), "nodeMajor": int(version.split(".")[0])}
        installed = read(self.private / "installed.json") if (self.private / "installed.json").exists() else {}
        keys = read(data / "config.json").get("auth", {}).get("apiKeys", [])
        return {
            **self.profile, "cloudcliPid": cc_pid, "copilotPid": cp_pid,
            "cloudcliPath": str(cloudcli), "copilotPath": str(copilot),
            "cloudcliNode": str(Path(f"/proc/{cc_pid}/exe").resolve(strict=True)),
            "copilotNode": str(Path(f"/proc/{cp_pid}/exe").resolve(strict=True)),
            "components": versions, "copilotHome": str(data), "database": str(database),
            "pinHash": sha(data / "portal-build.json") if (data / "portal-build.json").is_file() else None,
            "protected": {str(file): (gateway_config_hash(file) if file == data / "config.json"
                                     else config_hash(file, self.root / "probe"))
                          for file in protected if file.is_file()},
            "platform": "linux-x64", "currentRelease": installed.get("releaseId"),
            "highestSequence": installed.get("sequence", 0),
            "installedDigest": installed.get("digest"),
            "readyMigrations": ["gateway-api-key-v1"] if isinstance(keys, list) and any(isinstance(key, str) and len(key) >= 32 for key in keys) else [],
        }

    def report(self):
        before = self.snapshot()
        probe = self.root / "probe"
        probe.mkdir(mode=0o700, exist_ok=True)
        return {**{key: before[key] for key in ["platform", "layout", "components", "currentRelease", "highestSequence", "readyMigrations"]},
                "busy": not self.idle(before, probe)}

    def assert_unchanged(self, before, after=None, package_paths=True):
        after = after or self.snapshot()
        keys = ["protected", "cloudcliNode", "copilotNode", "nodeId", "ownerId", "copilotService"]
        if package_paths:
            keys += ["cloudcliPid", "copilotPid", "cloudcliPath", "copilotPath", "pinHash"]
        require(all(before[key] == after[key] for key in keys), "configuration_changed")

    def probe(self, mode, snapshot, job):
        config_home = Path(environment(snapshot["cloudcliPid"]).get("CODEX_HOME", str(self.home / ".codex")))
        require(config_home.resolve().is_relative_to(self.home), "configuration_changed")
        model_config = tomllib.loads((config_home / "config.toml").read_text()) if (config_home / "config.toml").is_file() else {}
        arguments = {
            "mode": mode, "nodeId": self.config["nodeId"], "ownerId": self.config["ownerId"],
            "username": self.config["username"], "portalOrigin": self.config["portalOrigin"],
            "cloudcliPid": snapshot["cloudcliPid"], "cloudcliPath": snapshot["cloudcliPath"],
            "probePath": str(self.root / "probe"),
            "model": model_config.get("model"), "effort": model_config.get("model_reasoning_effort"),
        }
        (self.root / "probe").mkdir(mode=0o700, exist_ok=True)
        result = subprocess.run([snapshot["cloudcliNode"], str(Path(__file__).with_name("probe.mjs"))],
                                input=json.dumps(arguments), capture_output=True, text=True, timeout=100)
        log = Path(job) / f"probe-{mode}.private.log"
        log.write_text(result.stdout + result.stderr)
        log.chmod(0o600)
        require(result.returncode == 0, "model_failed" if mode == "verify" else "health_failed")
        return json.loads(result.stdout)

    def model_connections(self, process):
        inodes = set()
        for file in Path(f"/proc/{process}/fd").iterdir():
            try:
                target = os.readlink(file)
                if target.startswith("socket:["):
                    inodes.add(target[8:-1])
            except FileNotFoundError:
                pass
        count = 0
        for filename in ["tcp", "tcp6"]:
            for line in Path(f"/proc/net/{filename}").read_text().splitlines()[1:]:
                fields = line.split()
                if fields[9] not in inodes or fields[3] != "01" or int(fields[1].rsplit(":", 1)[1], 16) != 4141:
                    continue
                raw = bytes.fromhex(fields[2].rsplit(":", 1)[0])
                raw = b"".join(raw[index:index + 4][::-1] for index in range(0, len(raw), 4))
                address = ipaddress.ip_address(socket.inet_ntop(socket.AF_INET if filename == "tcp" else socket.AF_INET6, raw))
                if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
                    address = address.ipv4_mapped
                if str(address) != "168.63.129.16":
                    count += 1
        return count

    def idle(self, before, job):
        self.assert_unchanged(before)
        if self.probe("idle", before, job)["runningSessions"] or self.model_connections(before["copilotPid"]):
            return False
        # Do not interrupt an independently running Codex CLI command.
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                if entry.stat().st_uid != os.getuid():
                    continue
                args = (entry / "cmdline").read_bytes().decode().split("\0")
                if any(Path(arg).name == "codex" for arg in args[:2]) and "exec" in args[1:4]:
                    return False
            except (OSError, UnicodeError):
                pass
        time.sleep(2)
        return self.model_connections(before["copilotPid"]) == 0

    def health(self, snapshot):
        config = read(Path(snapshot["copilotHome"]) / "config.json")
        keys = config.get("auth", {}).get("apiKeys", [])
        def status(key):
            connection = http.client.HTTPConnection("127.0.0.1", 4141, timeout=5)
            try:
                connection.request("GET", "/v1/models", headers={"Authorization": "Bearer " + key} if key else {})
                response = connection.getresponse()
                body = response.read(4 * 1024 * 1024)
                return response.status, body
            finally:
                connection.close()
        good, payload = status(keys[0] if keys else None)
        require(good == 200 and json.loads(payload).get("data"), "health_failed")
        if keys:
            require(status(None)[0] == status("invalid-updater-probe")[0] == 401, "health_failed")
        return True

    def model(self, snapshot, job):
        self.probe("verify", snapshot, job)
        env = environment(snapshot["cloudcliPid"])
        config_home = Path(env.get("CODEX_HOME", str(self.home / ".codex")))
        require(config_home.resolve().is_relative_to(self.home), "configuration_changed")
        config_file = config_home / "config.toml"
        config = tomllib.loads(config_file.read_text()) if config_file.is_file() else {}
        cli = shutil.which("codex", path=env.get("PATH", ""))
        require(cli is not None, "model_login_required")
        child_env = {"HOME": str(self.home), "PATH": env["PATH"], "CODEX_HOME": str(config_home)}
        for provider in config.get("model_providers", {}).values():
            key = provider.get("env_key")
            if key and key in env:
                child_env[key] = env[key]
        marker = "CODEX_NODE_UPDATE_OK"
        answer = Path(job) / "codex-answer.txt"
        arguments = [cli, "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json",
                     "--config", 'approval_policy="never"', "--output-last-message", str(answer)]
        for name in config.get("mcp_servers", {}):
            require(re.fullmatch(r"[A-Za-z0-9_-]+", name), "configuration_changed")
            arguments += ["--config", f"mcp_servers.{name}.enabled=false"]
        arguments.append(f"Authorized model connectivity check. Reply with exactly {marker}. "
                         "Do not use tools, browse, read files, or make changes.")
        run(arguments, cwd=self.root / "probe", env=child_env, timeout=90, log=Path(job) / "codex-model.private.log")
        require(answer.is_file() and answer.read_text().strip() == marker, "model_failed")
        answer.chmod(0o600)

    def candidate(self, name, release_id, attempt):
        release_id = release_id + "-" + attempt[:8]
        if name == "cloudcli" and self.profile["layout"] == "legacy":
            return self.home / ".local/share/codey-cloudcli/releases" / ("updater-" + release_id)
        return self.root / "releases" / release_id / name

    def prepare_dependencies(self, before, candidate, job):
        old = Path(before["cloudcliPath"])
        if install_fingerprint(old) == install_fingerprint(candidate) and (old / "node_modules").is_dir():
            actual = (old / "node_modules").resolve()
            if actual.is_relative_to(old) and not Path(before["cloudcliAnchor"]).is_symlink():
                abi = run([before["cloudcliNode"], "-p", "process.versions.modules"], timeout=10)
                cache = self.root / "dependencies" / (install_fingerprint(old) + "-" + abi)
                if not (cache / "ready.json").exists():
                    require(not cache.exists(), "stage_failed")
                    staging = cache.with_name(cache.name + ".staging-" + Path(job).name[:8])
                    require(not staging.exists(), "stage_failed")
                    staging.mkdir(mode=0o700, parents=True)
                    run(["cp", "-a", "--reflink=auto", str(actual), str(staging / "node_modules")], timeout=120)
                    save(staging / "ready.json", {"source": str(actual), "abi": abi})
                    os.rename(staging, cache)
                actual = cache / "node_modules"
            (candidate / "node_modules").symlink_to(actual, target_is_directory=True)
        else:
            node = before["cloudcliNode"]
            npm = Path(node).parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
            if not npm.is_file():
                npm = Path("/usr/share/nodejs/npm/bin/npm-cli.js")
            require(npm.is_file(), "runtime_incompatible")
            temporary_home = Path(job) / "build-home"
            temporary_home.mkdir(mode=0o700, exist_ok=True)
            env = {"HOME": str(temporary_home), "PATH": str(Path(node).parent) + ":/usr/bin:/bin",
                   "CI": "true", "HUSKY": "0", "ELECTRON_SKIP_BINARY_DOWNLOAD": "1",
                   "DATABASE_PATH": ":memory:", "CODEY_MANAGED": "false", "CODEY_PORTAL_SSO": "false"}
            package_file, lock_file = candidate / "package.json", candidate / "package-lock.json"
            original = package_file.read_bytes()
            package = json.loads(original)
            lock_hash = sha(lock_file)
            # HUSKY=0 cannot help when --omit=dev removes the husky executable.
            # Only this known development hook is omitted; native install hooks still run.
            omit_prepare = (package.get("name") == "@cloudcli-ai/cloudcli"
                            and package.get("scripts", {}).get("prepare") == "husky"
                            and "husky" in package.get("devDependencies", {})
                            and not any("husky" in package.get(group, {})
                                        for group in ["dependencies", "optionalDependencies", "peerDependencies"]))
            backup = None
            try:
                if omit_prepare:
                    with tempfile.NamedTemporaryFile(prefix=".codey-package-", dir=candidate, delete=False) as stream:
                        stream.write(original)
                        stream.flush()
                        os.fsync(stream.fileno())
                    backup = Path(stream.name)
                    backup.chmod(package_file.stat().st_mode & 0o777)
                    del package["scripts"]["prepare"]
                    save(package_file, package)
                run([node, npm, "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=candidate, env=env,
                    timeout=180, log=Path(job) / "dependency-install.private.log")
            finally:
                if backup is not None:
                    os.replace(backup, package_file)
                require(not package_file.is_symlink() and package_file.is_file() and package_file.read_bytes() == original
                        and not lock_file.is_symlink() and lock_file.is_file() and sha(lock_file) == lock_hash, "stage_failed")
        for name in ["dist", ".codey-bin"]:
            if (old / name).is_dir() and not (candidate / name).exists():
                shutil.copytree(old / name, candidate / name, symlinks=True)

    def switch(self, anchors, job):
        save(Path(job) / "transaction.json", {"state": "applying", "anchors": anchors})
        units = list(dict.fromkeys(item["service"] for item in anchors))
        run(["systemctl", "--user", "stop", *units], timeout=35, log=Path(job) / "stop.private.log")
        for item in anchors:
            anchor, target, backup = Path(item["anchor"]), Path(item["target"]), Path(item["backup"])
            require(anchor.parent.resolve().is_relative_to(self.home), "configuration_changed")
            require(target.resolve().is_relative_to(self.home), "configuration_changed")
            if item["kind"] == "directory":
                require(anchor.is_dir() and not anchor.is_symlink() and not backup.exists(), "configuration_changed")
                backup.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                require(anchor.stat().st_dev == backup.parent.stat().st_dev, "stage_failed")
                os.rename(anchor, backup)
            else:
                require(anchor.is_symlink() and str(anchor.resolve()) == item["previousTarget"], "configuration_changed")
            temporary = anchor.with_name(anchor.name + ".updater-next")
            require(not temporary.exists() and not temporary.is_symlink(), "configuration_changed")
            temporary.symlink_to(target, target_is_directory=True)
            os.replace(temporary, anchor)
        save(Path(job) / "transaction.json", {"state": "verifying", "anchors": anchors})
        run(["systemctl", "--user", "start", *units], timeout=35, log=Path(job) / "start.private.log")

    def prepare_metadata(self, manifest, before, changed, job):
        records = []
        pairs = [(self.private / "installed.json", "installed-before.json")]
        if "copilotApi" in changed:
            pairs.append((Path(before["copilotHome"]) / "portal-build.json", "pin-before.json"))
        for file, backup_name in pairs:
            record = {"file": str(file), "backup": str(Path(job) / backup_name),
                      "beforeHash": sha(file) if file.is_file() else None, "releaseId": manifest["id"]}
            if file.is_file():
                shutil.copy2(file, record["backup"])
                Path(record["backup"]).chmod(0o600)
            records.append(record)
        save(Path(job) / "metadata-rollback.json", records)

    def update_pin(self, manifest, before, changed):
        if "copilotApi" not in changed:
            return
        component = manifest["components"]["copilotApi"]
        save(Path(before["copilotHome"]) / "portal-build.json", {
            "artifactId": "codey-updater-" + manifest["id"], "releaseId": manifest["id"],
            "version": component["version"], "sourceCommit": component["commit"],
            "sha256": component["sha256"], "label": "Owner-confirmed Codey node release",
            "buildDate": time.strftime("%Y-%m-%d", time.gmtime()),
        })

    def check_metadata_rollback(self, job, restore=False):
        file = Path(job) / "metadata-rollback.json"
        if not file.exists():
            return
        for record in read(file):
            target, backup = Path(record["file"]), Path(record["backup"])
            require(target.resolve().is_relative_to(self.home) and backup.resolve().is_relative_to(Path(job).resolve()),
                    "rollback_failed")
            current_hash = sha(target) if target.is_file() else None
            if current_hash == record["beforeHash"]:
                continue
            require(target.is_file() and read(target).get("releaseId") == record["releaseId"], "rollback_failed")
            if restore:
                if record["beforeHash"]:
                    require(backup.is_file() and sha(backup) == record["beforeHash"], "rollback_failed")
                    temporary = target.with_name(target.name + ".updater-restore-" + Path(job).name[:8])
                    with temporary.open("wb") as stream:
                        stream.write(backup.read_bytes())
                        stream.flush()
                        os.fsync(stream.fileno())
                    temporary.chmod(0o600)
                    os.replace(temporary, target)
                else:
                    target.unlink()

    def rollback(self, anchors, job):
        # Check ownership before stopping anything, including during crash recovery.
        for item in anchors:
            anchor, target, backup = Path(item["anchor"]), Path(item["target"]), Path(item["backup"])
            require(anchor.parent.resolve().is_relative_to(self.home) and target.resolve().is_relative_to(self.home)
                    and backup.resolve().is_relative_to(Path(job).resolve())
                    and item["service"] in {"codey-cloudcli.service", "copilot-api.service", "codey-copilot-api.service"},
                    "rollback_failed")
            if anchor.exists() or anchor.is_symlink():
                require(str(anchor.resolve()) in {str(target.resolve()), item["previousTarget"]}, "rollback_failed")
            else:
                require(item["kind"] == "directory" and backup.is_dir(), "rollback_failed")
        self.check_metadata_rollback(job)
        units = list(dict.fromkeys(item["service"] for item in anchors))
        run(["systemctl", "--user", "stop", *units], timeout=35)
        for item in reversed(anchors):
            anchor, target, backup = Path(item["anchor"]), Path(item["target"]), Path(item["backup"])
            if anchor.is_symlink():
                actual = str(anchor.resolve())
                if actual == item["previousTarget"]:
                    continue
                require(actual == str(target.resolve()), "rollback_failed")
                if item["kind"] == "directory":
                    require(backup.is_dir(), "rollback_failed")
                    anchor.unlink()
                    os.rename(backup, anchor)
                else:
                    temporary = anchor.with_name(anchor.name + ".rollback-next")
                    require(not temporary.exists() and not temporary.is_symlink(), "rollback_failed")
                    temporary.symlink_to(item["previousTarget"], target_is_directory=True)
                    os.replace(temporary, anchor)
            elif item["kind"] == "directory" and not anchor.exists() and backup.is_dir():
                os.rename(backup, anchor)
            else:
                require(anchor.exists() and str(anchor.resolve()) == item["previousTarget"], "rollback_failed")
        self.check_metadata_rollback(job, restore=True)
        run(["systemctl", "--user", "start", *units], timeout=35)
        save(Path(job) / "transaction.json", {"state": "rolled_back", "anchors": anchors})


class Upgrade:
    def __init__(self, runtime, notify, download):
        self.runtime, self.notify, self.download = runtime, notify, download

    def execute(self, manifest, digest, job):
        runtime, job = self.runtime, Path(job)
        job.mkdir(mode=0o700, parents=True, exist_ok=True)
        before = runtime.snapshot()
        save(job / "before.private.json", before)
        require(manifest["sequence"] >= before["highestSequence"], "signature_invalid")
        if manifest["sequence"] == before["highestSequence"] and before["highestSequence"] > 0:
            require(before.get("installedDigest") == digest, "signature_invalid")
        require(manifest["platform"] == before["platform"], "unsupported_platform")
        for migration in manifest["migrations"]:
            if migration not in before["readyMigrations"]:
                raise UpdateError("model_auth_migration_required" if migration == "gateway-api-key-v1" else "migration_unsupported")
        changed = []
        for name, component in manifest["components"].items():
            require(before["components"][name]["nodeMajor"] in component["nodeMajors"], "runtime_incompatible")
            if any(before["components"][name].get(key) != component[key]
                   for key in ["version", "commit", "entrySha256"]):
                changed.append(name)
        if not changed:
            require(int(time.time() * 1000) < manifest["expiresAt"], "signature_invalid")
            # No application is stopped for an unchanged package. Verification can
            # coexist with user work; idle is mandatory only before a real switch.
            self.notify("verifying", "ok")
            runtime.health(before)
            runtime.model(before, job)
            runtime.assert_unchanged(before)
            save(runtime.private / "installed.json", {"releaseId": manifest["id"], "sequence": manifest["sequence"],
                 "digest": digest, "components": before["components"], "updatedAt": int(time.time() * 1000)})
            save(job / "transaction.json", {"state": "succeeded", "anchors": []})
            self.notify("succeeded", "up_to_date")
            return {"state": "succeeded", "changed": []}
        require(shutil.disk_usage(runtime.root).free > 1024 ** 3, "stage_failed")
        self.notify("downloading", "ok")
        for name in changed:
            artifact = manifest["components"][name]
            file = job / artifact["file"]
            self.download(manifest["id"], artifact, file)
            require(file.stat().st_size == artifact["size"] and sha(file) == artifact["sha256"], "signature_invalid")
        self.notify("staging", "ok")
        anchors = []
        for name in changed:
            component = manifest["components"][name]
            candidate = runtime.candidate(name, manifest["id"], job.name)
            extract(job / component["file"], candidate)
            entry = "dist-server/server/index.js" if name == "cloudcli" else "dist/main.js"
            require(sha(candidate / entry) == component["entrySha256"], "signature_invalid")
            require(read(candidate / "package.json")["version"] == component["version"], "signature_invalid")
            if name == "cloudcli":
                require(sha(candidate / "package-lock.json") == component["lockSha256"], "signature_invalid")
                runtime.prepare_dependencies(before, candidate, job)
            save(candidate / "codey-release.json", {"release": manifest["id"], "sourceCommit": component["commit"]})
            anchor = Path(before["cloudcliAnchor" if name == "cloudcli" else "copilotAnchor"])
            anchors.append({"component": name, "anchor": str(anchor), "target": str(candidate),
                            "kind": "symlink" if anchor.is_symlink() else "directory",
                            "previousTarget": str(anchor.resolve()), "backup": str(job / "backup" / name),
                            "service": "codey-cloudcli.service" if name == "cloudcli" else before["copilotService"]})
        runtime.assert_unchanged(before)
        self.notify("waiting_idle", "busy")
        deadline = time.monotonic() + 120
        while not runtime.idle(before, job):
            require(time.monotonic() < deadline, "busy")
            time.sleep(3)
            self.notify("waiting_idle", "busy")
        # Back up databases online; rollback never restores stale user data.
        for source, name in [(Path(before["database"]), "cloudcli.sqlite"),
                             (Path(before["copilotHome"]) / "copilot-api.sqlite", "copilot.sqlite")]:
            if source.is_file():
                destination = job / "backup" / name
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with sqlite3.connect("file:" + str(source) + "?mode=ro", uri=True, timeout=5) as original:
                    with sqlite3.connect(destination) as copied:
                        deadline = time.monotonic() + 20
                        def progress(*_):
                            require(time.monotonic() < deadline, "stage_failed")
                        original.backup(copied, pages=512, progress=progress, sleep=0.03)
                destination.chmod(0o600)
        runtime.assert_unchanged(before)
        require(runtime.idle(before, job), "busy")
        require(int(time.time() * 1000) < manifest["expiresAt"], "signature_invalid")
        runtime.prepare_metadata(manifest, before, changed, job)
        self.notify("applying", "ok")  # Revalidates owner and lease immediately before stopping anything.
        try:
            runtime.switch(anchors, job)
            runtime.update_pin(manifest, before, changed)
            self.notify("verifying", "ok")
            deadline = time.monotonic() + 40
            while True:
                try:
                    after = runtime.snapshot()
                    runtime.health(after)
                    break
                except (UpdateError, OSError, ValueError):
                    require(time.monotonic() < deadline, "health_failed")
                    time.sleep(1)
            runtime.assert_unchanged(before, after, package_paths=False)
            for name in changed:
                require(after["components"][name]["entrySha256"] == manifest["components"][name]["entrySha256"], "health_failed")
            runtime.model(after, job)
            # Both probes must preserve configuration and the just-verified package/runtime.
            runtime.assert_unchanged(after)
            save(runtime.private / "installed.json", {"releaseId": manifest["id"], "sequence": manifest["sequence"],
                 "digest": digest, "components": after["components"], "updatedAt": int(time.time() * 1000)})
            save(job / "transaction.json", {"state": "succeeded", "anchors": anchors})
        except Exception:
            diagnostic = job / "failure.private.log"
            diagnostic.write_text(traceback.format_exc())
            diagnostic.chmod(0o600)
            try:
                runtime.rollback(anchors, job)
                runtime.health(runtime.snapshot())
            except Exception:
                raise UpdateError("rollback_failed") from None
            self.notify("rolled_back", "health_failed")
            return {"state": "rolled_back", "changed": changed}
        self.notify("succeeded", "ok")
        return {"state": "succeeded", "changed": changed}
