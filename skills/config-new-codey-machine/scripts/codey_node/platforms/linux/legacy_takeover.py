"""Explicitly archive recognized owner systemd services before a fresh install."""
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import time

from ...common.config_files import Owner
from ...common.errors import SetupError
from ...common.files import protected_write
from . import codex_process


UNITS = (
    "codey-node-updater.service",
    "copilot-api-update.timer",
    "codey-devtunnel-renew.timer",
    "copilot-api-update.service",
    "codey-devtunnel-renew.service",
    "codey-devtunnel.service",
    "codey-node-relay.service",
    "codey-cloudcli.service",
    "codey-copilot-api.service",
    "copilot-api.service",
)
PORTS = (3001, 8443, 4141)
LEGACY_PATHS = (
    ("legacy-cloudcli-runtime", ".local/share/codey-cloudcli"),
    ("legacy-cloudcli-config", ".config/codey-cloudcli"),
    ("legacy-copilot-api-runtime", ".local/share/copilot-api"),
    ("legacy-updater-runtime", ".local/share/codey-updater"),
    ("legacy-updater-config", ".config/codey-updater"),
    ("legacy-relay-runtime", ".local/share/codey-node-relay"),
    ("legacy-relay-config", ".config/codey-node-relay"),
)


def _properties(text):
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


def _show(runner, name):
    result = runner([
        "systemctl", "--user", "show", name,
        "--property=Id,LoadState,ActiveState,MainPID,FragmentPath,DropInPaths",
    ], check=False)
    return _properties(result.stdout)


def _port_available(port):
    try:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def inspect(home, root, config, runner, *, port_available=_port_available):
    """Return a read-only takeover plan; unknown listeners still fail closed."""
    home, root, config = Path(home), Path(root), Path(config)
    service_dir = home / ".config/systemd/user"
    units = []
    for name in UNITS:
        record = _show(runner, name)
        fragment_text = record.get("FragmentPath", "")
        if not fragment_text:
            continue
        fragment = Path(fragment_text)
        expected = service_dir / name
        if (not fragment.is_absolute() or fragment != expected or fragment.resolve() != fragment
                or fragment.is_symlink()):
            raise SetupError(f"Existing {name} is not an ordinary unit owned by this user")
        info = fragment.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise SetupError(f"Existing {name} is not an ordinary unit owned by this user")
        if record.get("DropInPaths", "").strip():
            raise SetupError(f"Existing {name} has systemd drop-ins; review them before migration")
        pid = record.get("MainPID", "0")
        if not pid.isdigit():
            raise SetupError(f"Existing {name} has invalid runtime metadata")
        units.append({
            "name": name,
            "fragment": str(fragment),
            "active": record.get("ActiveState") == "active",
            "pid": int(pid),
        })
    occupied = [port for port in PORTS if not port_available(port)]
    if occupied and not any(unit["active"] and unit["pid"] > 0 for unit in units):
        raise SetupError("Required ports are occupied by an unknown process; --replace-existing cannot stop it")
    paths = []
    candidates = (("runtime", root), ("config", config),
                  *((label, home / relative) for label, relative in LEGACY_PATHS))
    for label, path in candidates:
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        if (path.resolve() != path or path.is_symlink() or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.getuid()):
            raise SetupError(f"Existing Codey {label} path is not an ordinary owner directory")
        paths.append({"label": label, "path": str(path)})
    processes = codex_process.inspect(home)
    return {
        "detected": bool(units or processes),
        "units": units,
        "codexProcesses": processes,
        "occupiedPorts": occupied,
        "archivePaths": paths,
        "action": "stop-disable-and-archive-then-install-fresh",
        "restoresOldServicesOnFailure": False,
    }


def public(plan):
    return {
        "detected": plan["detected"],
        "units": [{key: item[key] for key in ("name", "fragment", "active", "pid")}
                  for item in plan["units"]],
        "codexProcesses": list(plan["codexProcesses"]),
        "occupiedPorts": list(plan["occupiedPorts"]),
        "archivePaths": list(plan["archivePaths"]),
        "action": plan["action"],
        "restoresOldServicesOnFailure": False,
        "preserved": ["owner Home", ".codex", "Codex auth and sessions", "unlisted services and files"],
    }


def execute(home, root, config, node_id, runner, *, port_available=_port_available):
    """Stop the freshly revalidated list, archive exact paths, and never delete it."""
    home, root, config = Path(home), Path(root), Path(config)
    plan = inspect(home, root, config, runner, port_available=port_available)
    if not plan["detected"]:
        raise SetupError("No recognized legacy Codey user service is available for replacement")
    owner = Owner.target(home)
    backup_base = home / ".local/state/codey-service-backups"
    owner.mkdir(backup_base)
    backup_info = backup_base.stat()
    sources = [Path(item["fragment"]) for item in plan["units"]]
    sources.extend(Path(item["path"]) for item in plan["archivePaths"])
    device = backup_info.st_dev
    if any(path.lstat().st_dev != device for path in sources):
        raise SetupError("Legacy paths cannot be atomically archived on this filesystem")
    tag = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + node_id + "-" + secrets.token_hex(4)
    backup = backup_base / tag
    owner.mkdir(backup)

    for item in plan["units"]:
        result = runner(["systemctl", "--user", "disable", "--now", item["name"]], check=False)
        if result.returncode:
            raise SetupError(f"Could not stop the recognized legacy unit {item['name']}")
    runner(["systemctl", "--user", "daemon-reload"])
    for item in plan["units"]:
        record = _show(runner, item["name"])
        if record.get("ActiveState") == "active" or record.get("MainPID", "0") not in ("", "0"):
            raise SetupError(f"Legacy unit did not stop: {item['name']}")
    stopped_codex = codex_process.stop(home, plan["codexProcesses"]) if plan["codexProcesses"] else []
    if codex_process.inspect(home):
        raise SetupError("A new owner Codex app-server appeared during migration; stop its launcher and re-plan")
    remaining = [port for port in PORTS if not port_available(port)]
    if remaining:
        raise SetupError("A listener remains after stopping legacy Codey services: "
                         + ", ".join(str(port) for port in remaining))

    units_dir = backup / "units"
    owner.mkdir(units_dir)
    for item in plan["units"]:
        os.replace(item["fragment"], units_dir / item["name"])
    for item in plan["archivePaths"]:
        os.replace(item["path"], backup / item["label"])
    runner(["systemctl", "--user", "daemon-reload"])
    protected_write(backup / "takeover.json", json.dumps({
        "schema": 1, "nodeId": node_id, "archivedAt": tag.split("-", 1)[0],
        "plan": public(plan),
    }, indent=2) + "\n")
    return {"archive": str(backup), "stoppedCodexProcesses": stopped_codex, **public(plan)}
