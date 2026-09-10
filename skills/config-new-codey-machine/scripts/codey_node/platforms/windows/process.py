"""Hidden, bounded Windows child commands with protected build logs."""
from pathlib import Path
import subprocess

from ...common.errors import SetupError as Error
from . import helpers as windows
from .owner import CREATE_NO_WINDOW


def run(arguments, *, cwd=None, env=None, log=None, check=True, timeout=120):
    options = {
        "cwd": cwd, "env": env or windows.child_environment(), "text": True,
        "encoding": "utf-8", "errors": "replace", "stdin": subprocess.DEVNULL,
        "timeout": 1800 if log else timeout, "creationflags": CREATE_NO_WINDOW,
    }
    if log:
        with Path(log).open("a", encoding="utf-8") as output:
            result = subprocess.run([str(item) for item in arguments], stdout=output, stderr=subprocess.STDOUT, **options)
    else:
        result = subprocess.run([str(item) for item in arguments], capture_output=True, **options)
    if check and result.returncode:
        raise Error("command_failed_review_private_log" if log else "command_failed_existing_services_unchanged")
    return result
