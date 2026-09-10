"""Bounded macOS commands; no inherited installer output in errors."""
from pathlib import Path
import subprocess

from ...common.errors import ServiceError as Error


def run(args, *, cwd=None, env=None, log=None, check=True, timeout=180):
    if log:
        with Path(log).open("a") as stream:
            result = subprocess.run([str(x) for x in args], cwd=cwd, env=env, text=True,
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=1800)
    else:
        result = subprocess.run([str(x) for x in args], cwd=cwd, env=env, text=True,
                                capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise Error(f"{Path(args[0]).name} failed (exit {result.returncode}); existing services were not changed")
    return result
