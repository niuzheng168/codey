"""Windows-only owner directories, commands and environment filtering."""
import ctypes
import os
from pathlib import Path
import subprocess

from ...common.errors import SetupError
from . import owner as service
from .archives import within


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


def private_directory(directory, sid):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    # This installer creates this exact directory; it does not edit an existing
    # tree's ACL, elevate, or change system/user security settings.
    icacls = Path(os.environ["WINDIR"]) / "System32/icacls.exe"
    command([icacls, directory, "/inheritance:r", "/grant:r",
             f"*{sid}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"])
