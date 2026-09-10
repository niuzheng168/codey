"""Prepare a reviewed Linux DevTunnel binary, never change its login."""
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.request

from ...common.errors import ServiceError
from ...common.files import digest


def prepare_cli(explicit, skill, node_id):
    """Reuse a reviewed executable or download only the checksum-pinned CLI."""
    if explicit:
        executable = Path(explicit)
        if not executable.is_absolute() or not executable.is_file() or not os.access(executable, os.X_OK):
            raise ServiceError("--devtunnel-bin must be an existing absolute executable")
        return executable.resolve()
    pin = json.loads((Path(skill) / "dependencies.json").read_text())["devTunnelCli"]["linux-x64"]
    if (pin.get("url") != "https://tunnelsassetsprod.blob.core.windows.net/cli/linux-x64-devtunnel"
            or not re.fullmatch(r"[a-f0-9]{64}", pin.get("sha256", ""))):
        raise ServiceError("A reviewed official Linux DevTunnel checksum is required")
    home = Path.home().resolve()
    root = home / ".local/share/codey-tunnel-cli" / node_id
    if root.resolve() != root or not root.is_relative_to(home):
        raise ServiceError("CLI bootstrap path is linked or outside the owner home")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise ServiceError("CLI bootstrap directory must belong only to this owner")
    executable = root / "devtunnel"
    if not executable.exists():
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=root, prefix="download-", delete=False) as output:
                temporary = Path(output.name)
                os.chmod(temporary, 0o600)
                with urllib.request.urlopen(pin["url"], timeout=120) as response:
                    if response.geturl() != pin["url"]:
                        raise ServiceError("Unexpected CLI download redirect")
                    size = 0
                    while chunk := response.read(1024 * 1024):
                        size += len(chunk)
                        if size > 96 * 1024 ** 2:
                            raise ServiceError("Unexpectedly large CLI download")
                        output.write(chunk)
            if digest(temporary) != pin["sha256"]:
                raise ServiceError("DevTunnel SHA-256 mismatch; no unpinned fallback was executed")
            os.chmod(temporary, 0o700)
            os.replace(temporary, executable)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
    if executable.is_symlink() or digest(executable) != pin["sha256"]:
        raise ServiceError("Cached DevTunnel executable changed")
    return executable
