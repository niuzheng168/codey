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


def install(source, runner):
    source = Path(source)
    config = source / "config.json"
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
