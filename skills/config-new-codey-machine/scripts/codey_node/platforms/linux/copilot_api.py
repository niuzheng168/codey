"""Interactive GitHub Copilot login and local model endpoint verification."""
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

from ...common.errors import SetupError


def login(executable, working_directory, token_file, environment):
    token_file = Path(token_file)
    if token_file.is_file() and token_file.stat().st_size > 0:
        return {"action": "reuse", "provider": "github-copilot"}
    print("GitHub Copilot login is required; complete the device authorization shown below.", flush=True)
    try:
        result = subprocess.run(
            [str(executable), "auth", "login", "--provider", "copilot"],
            cwd=working_directory, env=environment, timeout=900,
        )
    except (OSError, subprocess.SubprocessError):
        raise SetupError("GitHub Copilot login could not be completed") from None
    if result.returncode or not token_file.is_file() or token_file.stat().st_size <= 0:
        raise SetupError("GitHub Copilot login did not complete; rerun this installer after authorizing the device")
    return {"action": "login", "provider": "github-copilot"}


def wait_ready(key):
    status = 0
    for _ in range(30):
        request = urllib.request.Request(
            "http://127.0.0.1:4141/models", headers={"Authorization": "Bearer " + key})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
        except OSError:
            status = 0
        if status == 200:
            return {"modelsStatus": 200}
        time.sleep(1)
    raise SetupError(f"Copilot API did not become ready after login (HTTP {status})")
