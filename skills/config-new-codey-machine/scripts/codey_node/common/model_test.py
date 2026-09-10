"""Run one real owner Codex request through the configured local model provider."""
import os
from pathlib import Path
import subprocess

from .errors import SetupError
from .files import protected_write


MARKER = "CODEY_INSTALL_OK"


def codex(executable, codex_home, model_key, home, log_file):
    executable = Path(executable)
    codex_home = Path(codex_home)
    home = Path(home)
    environment = {
        **os.environ,
        "HOME": str(home),
        "CODEX_HOME": str(codex_home),
        "CODEY_MODEL_API_KEY": model_key,
        "PATH": str(executable.parent) + os.pathsep + os.environ.get("PATH", ""),
    }
    try:
        result = subprocess.run(
            [str(executable), "exec", "--skip-git-repo-check", f"Reply with only {MARKER}"],
            cwd=home,
            env=environment,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
    except (OSError, subprocess.SubprocessError):
        raise SetupError("Codex real model test could not be completed") from None
    output = (result.stdout or "") + (result.stderr or "")
    if result.returncode or MARKER not in output:
        protected_write(log_file, output)
        raise SetupError(f"Codex real model test failed; protected diagnostic: {log_file}")
    return {"marker": MARKER, "passed": True}
