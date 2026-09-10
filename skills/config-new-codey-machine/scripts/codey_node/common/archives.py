"""Bounded POSIX tar extraction shared by Linux and macOS builds."""
from pathlib import PurePosixPath
import tarfile

from .errors import SetupError


def unpack(archive, target, allowed_roots=("node", "cloudcli", "copilot-api", "release.json")):
    with tarfile.open(archive) as package:
        members = package.getmembers()
        if len(members) > 200000 or sum(member.size for member in members) > 8 * 1024 ** 3:
            raise SetupError("Unexpectedly large runtime archive")
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or member.isdev() or member.isfifo():
                raise SetupError("Unsafe runtime archive member")
            if allowed_roots is not None and name.parts and name.parts[0] not in allowed_roots:
                raise SetupError("Unexpected runtime archive root")
        package.extractall(target, members=members, filter="data")
