"""Rebind a ready Linux node to its owner Codex CLI and current model key."""
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request

from ...common.config_files import Change, Owner, commit
from ...common.errors import SetupError
from . import codex_process, login


def _text(data, label):
    try:
        return data.decode("utf-8-sig")
    except UnicodeError:
        raise SetupError(f"{label} must be UTF-8; original bytes were not changed") from None


def _replace(text, prefix, value):
    lines = text.splitlines()
    matches = [index for index, line in enumerate(lines) if line.startswith(prefix)]
    if len(matches) != 1:
        raise SetupError(f"Expected one {prefix} setting in the ready node")
    lines[matches[0]] = prefix + value
    return ("\n".join(lines) + "\n").encode()


def _provider_key(text):
    matches = [line.split("=", 1)[1].strip() for line in text.splitlines()
               if line.strip().startswith("CODEY_MODEL_API_KEY=")]
    if len(matches) != 1:
        raise SetupError("The ready node must have one CODEY_MODEL_API_KEY assignment")
    try:
        value = json.loads(matches[0]) if matches[0].startswith('"') else matches[0]
    except ValueError:
        raise SetupError("The ready node model key assignment is invalid") from None
    if not isinstance(value, str) or not value:
        raise SetupError("The ready node model key assignment is invalid")
    return value


def _gateway_key(text):
    try:
        keys = json.loads(text).get("auth", {}).get("apiKeys", [])
    except (ValueError, AttributeError):
        raise SetupError("The ready node gateway configuration is invalid") from None
    if not isinstance(keys, list) or len(keys) != 1 or not isinstance(keys[0], str) or not keys[0]:
        raise SetupError("The ready node gateway must have one model API key")
    return keys[0]


def _http_status(key):
    request = urllib.request.Request(
        "http://127.0.0.1:4141/models", headers={"Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except OSError:
        return 0


def _process_environment(pid):
    try:
        return dict(row.decode().split("=", 1) for row in
                    (Path("/proc") / str(pid) / "environ").read_bytes().split(b"\0") if b"=" in row)
    except (OSError, UnicodeError, ValueError):
        raise SetupError("Cannot verify the restarted CloudCLI environment") from None


def _login_environment():
    result = subprocess.run(
        ["bash", "-lc", "env -0"], capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=20)
    if result.returncode:
        raise SetupError("Cannot verify a fresh owner login shell")
    return dict(item.split("=", 1) for item in result.stdout.split("\0") if "=" in item)


def wrapper(codex, codex_home, provider_env):
    return (
        "#!/bin/sh\n"
        f"export CODEX_HOME=\"{codex_home}\"\n"
        f"if [ -r \"{provider_env}\" ]; then\n"
        f"  . \"{provider_env}\"\n"
        "  export CODEY_MODEL_API_KEY\n"
        "fi\n"
        f"exec \"{codex}\" \"$@\"\n"
    ).encode()


@dataclass(repr=False)
class Plan:
    owner: Owner
    node_id: str
    codex: Path
    codex_home: Path
    provider_env: Path
    key: str = field(repr=False)
    changes: list = field(repr=False)
    processes: list
    managed_codex: Path | None

    def report(self):
        return {
            "nodeId": self.node_id,
            "codexExecutable": str(self.codex),
            "codexVersionReused": True,
            "files": [{"path": str(change.before.path), "action": (
                "replace-with-backup" if change.before.data is not None else "create"
            ) if change.changed else "unchanged"} for change in self.changes],
            "codexProcessesToStop": list(self.processes),
            "managedCodexToArchive": str(self.managed_codex) if self.managed_codex else None,
            "serviceToRestart": "codey-cloudcli.service",
            "gatewayKeyProbe": 200,
            "sessionsAndAuthPreserved": True,
            "realChatVerification": "required after apply for both Codex CLI and Codey",
        }

    def apply(self, runner):
        backups = commit(self.owner, self.changes)
        stopped = codex_process.stop(self.owner.home, self.processes) if self.processes else []
        runner(["systemctl", "--user", "restart", "codey-cloudcli.service"])
        deadline = time.monotonic() + 30
        pid = 0
        while time.monotonic() < deadline:
            active = runner(["systemctl", "--user", "is-active", "codey-cloudcli.service"],
                            check=False).stdout.strip()
            value = runner(["systemctl", "--user", "show", "codey-cloudcli.service",
                            "-p", "MainPID", "--value"], check=False).stdout.strip()
            pid = int(value) if value.isdigit() else 0
            if active == "active" and pid > 0:
                break
            time.sleep(1)
        if pid <= 0:
            raise SetupError("CloudCLI did not restart after the client repair")
        environment = _process_environment(pid)
        if (environment.get("CODEY_CODEX_EXECUTABLE") != str(self.codex)
                or environment.get("CODEY_MODEL_API_KEY") != self.key):
            raise SetupError("CloudCLI did not load the selected Codex CLI and current model key")
        login_env = _login_environment()
        if login_env.get("CODEY_MODEL_API_KEY") != self.key:
            raise SetupError("A fresh owner login shell did not load the current model key")
        if _http_status(self.key) != 200:
            raise SetupError("The current model key was rejected after client repair")
        if codex_process.inspect(self.owner.home, self.key):
            raise SetupError("An old-key Codex app-server restarted after client repair")
        archive = None
        if self.managed_codex and self.managed_codex.is_dir():
            base = self.owner.home / ".local/state/codey-service-backups"
            self.owner.mkdir(base)
            archive = base / (time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
                              + "-" + self.node_id + "-managed-codex")
            self.owner.mkdir(archive)
            os.replace(self.managed_codex, archive / self.managed_codex.name)
        return {
            **self.report(), "applied": True, "backups": backups, "stoppedCodexProcesses": stopped,
            "cloudcliPid": pid, "freshLoginKeyVerified": True,
            "managedCodexArchive": str(archive) if archive else None,
        }


def prepare(home, root, config, state_file, state, codex, managed_codex=None):
    owner = Owner.target(home)
    root, config = owner.check(root), owner.check(config)
    codex, state_file = Path(codex), owner.check(state_file)
    if not codex.is_absolute() or not codex.is_file():
        raise SetupError("The selected owner Codex CLI is missing")
    provider_env = owner.check(config / "provider.env")
    gateway = owner.check(root / "data/copilot-api/config.json")
    provider_before = owner.read(provider_env)
    gateway_before = owner.read(gateway)
    if provider_before.data is None or gateway_before.data is None:
        raise SetupError("The ready node model configuration is incomplete")
    key = _provider_key(_text(provider_before.data, "provider.env"))
    if key != _gateway_key(_text(gateway_before.data, "gateway config")) or _http_status(key) != 200:
        raise SetupError("The ready node provider key does not match its healthy gateway")
    cloud = owner.read(config / "cloudcli.env")
    saved = owner.read(state_file)
    wrapper_before = owner.read(root / "bin/codex")
    if cloud.data is None or saved.data is None or wrapper_before.data is None:
        raise SetupError("The ready node client configuration is incomplete")
    cloud_data = _replace(_text(cloud.data, "cloudcli.env"), "CODEY_CODEX_EXECUTABLE=", str(codex))
    try:
        updated_state = json.loads(_text(saved.data, "installation state"))
    except ValueError:
        raise SetupError("The ready node installation state is invalid") from None
    if not updated_state.get("ready") or updated_state.get("nodeId") != state.get("nodeId"):
        raise SetupError("The ready node identity changed before client repair")
    updated_state["codexExecutable"] = str(codex)
    codex_home = Path(os.environ.get("CODEX_HOME") or owner.home / ".codex").resolve()
    if state.get("modelDefaults", {}).get("codexHome"):
        codex_home = Path(state["modelDefaults"]["codexHome"])
    codex_home = owner.check(codex_home)
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(codex_home)):
        raise SetupError("The ready node Codex home is unsafe for a service wrapper")
    changes = [
        Change(cloud, cloud_data),
        Change(saved, (json.dumps(updated_state, indent=2) + "\n").encode()),
        Change(wrapper_before, wrapper(codex, codex_home, provider_env)),
    ]
    shell_owner, shell_changes = login.prepare(owner.home, provider_env)
    if shell_owner != owner:
        raise SetupError("The shell environment belongs to another owner")
    changes.extend(shell_changes)
    managed = Path(managed_codex) if managed_codex else None
    if managed:
        if not managed.exists() or codex.is_relative_to(managed):
            managed = None
        else:
            managed = owner.check(managed)
            if not managed.is_dir():
                raise SetupError("The managed Codex archive source is not an ordinary directory")
    return Plan(owner, state["nodeId"], codex, codex_home, provider_env, key, changes,
                codex_process.inspect(owner.home, key), managed)
