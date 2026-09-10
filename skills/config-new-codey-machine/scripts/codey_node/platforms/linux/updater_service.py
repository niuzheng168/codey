"""Install the signed updater and verify every required user-level supervisor."""
from pathlib import Path
import sys

from ...common.errors import SetupError


UNITS = (
    "codey-copilot-api.service",
    "codey-cloudcli.service",
    "codey-devtunnel.service",
    "codey-devtunnel-renew.timer",
    "codey-node-updater.service",
)


def install(source, config, runner):
    source, config = Path(source), Path(config)
    if (source / "config.json").exists() or (source / "config.json").is_symlink():
        raise SetupError("Legacy bundled updater config is forbidden")
    if not config.is_file() or config.is_symlink() or config.resolve().is_relative_to(source.resolve()):
        raise SetupError("Updater config must be generated in this owner's private local state")
    config.chmod(0o600)
    runner([sys.executable, source / "install.py", "--config", config, "--apply"])
    result = {}
    for name in UNITS:
        enabled = runner(["systemctl", "--user", "is-enabled", name], check=False).stdout.strip()
        active = runner(["systemctl", "--user", "is-active", name], check=False).stdout.strip()
        if enabled != "enabled" or active != "active":
            raise SetupError(f"Required updater/supervisor unit is not enabled and active: {name}")
        result[name] = {"enabled": True, "active": True}
    return result
