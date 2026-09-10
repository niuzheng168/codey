"""Owner-only atomic state and SHA-256; no platform/service lifecycle."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import time

from .errors import SetupError, ServiceError, TunnelError


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_state(file, value):
    """The caller owns the private parent; files stay private on every OS."""
    file = Path(file)
    if file.is_symlink():
        raise TunnelError("linked_state_file")
    temporary = file.with_name(file.name + "." + secrets.token_hex(8) + ".next")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        for attempt in range(6):
            try:
                os.replace(temporary, file)
                break
            except OSError as error:
                if os.name != "nt" or getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 5:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        temporary.unlink(missing_ok=True)


def protected_write(file, text):
    file = Path(file)
    if file.is_symlink():
        raise SetupError(f"Refusing symbolic link: {file}")
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = file.with_name(file.name + ".next")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        mode = "wb" if isinstance(text, bytes) else "w"
        options = {} if mode == "wb" else {"encoding": "utf-8", "newline": "\n"}
        with os.fdopen(descriptor, mode, **options) as stream:
            stream.write(text)
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


def private_json(file):
    file = Path(file)
    info = file.lstat()
    if file.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ServiceError("Node state must be owner-only, not linked")
    return json.loads(file.read_text(encoding="utf-8"))



def write_private(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if isinstance(value, str):
        protected_write(file, value)
    else:
        write_state(file, value)
