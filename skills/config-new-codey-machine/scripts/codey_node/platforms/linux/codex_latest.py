"""Install or update the owner's Codex CLI with OpenAI's official installer."""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.error
import urllib.request

from ...common.config_files import Owner
from ...common.errors import SetupError
from ...common.files import protected_write
from ...common import model_test
from . import codex_process


INSTALLER_URL = "https://chatgpt.com/codex/install.sh"
INSTALLER_FINAL_URL = "https://releases.openai.com/codex/install.sh"
INSTALLER_LIMIT = 512 * 1024


def wrapper(codex, codex_home, provider_env):
    return (
        "#!/bin/sh\n"
        f"export CODEX_HOME=\"{codex_home}\"\n"
        f"if [ -r \"{provider_env}\" ]; then\n"
        f"  . \"{provider_env}\"\n"
        "  export CODEY_MODEL_API_KEY\n"
        "fi\n"
        f"exec \"{codex}\" \"$@\"\n"
    ).encode()


def test_model(executable, codex_home, key, home):
    log = Path(home) / ".config/codey-machine/codex-model-test.log"
    return model_test.codex(executable, codex_home, key, home, log)


def _version(executable):
    try:
        result = subprocess.run(
            [str(executable), "--version"], stdin=subprocess.DEVNULL,
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.fullmatch(
        r"codex(?:-cli)? (\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)(?:[^\r\n]*)",
        (result.stdout or "").strip(),
    )
    return match[1] if not result.returncode and match else None


def _entry(home, explicit=None):
    candidates = [explicit, shutil.which("codex"), home / ".local/bin/codex", home / ".npm-global/bin/codex"]
    seen = set()
    for value in candidates:
        if not value:
            continue
        path = Path(value).absolute()
        if str(path) in seen:
            continue
        seen.add(str(path))
        try:
            exists = path.exists()
        except OSError:
            continue
        if exists:
            return path
    return None


def _bin_directory(owner, existing):
    managed = (
        owner.home / ".local/share/codey-machine",
        owner.home / ".local/share/codey-tools/codex",
    )
    if existing and existing.name == "codex" and existing.parent.name == "bin":
        try:
            if (existing.parent.is_relative_to(owner.home)
                    and not any(existing.is_relative_to(root) for root in managed)):
                return owner.check(existing.parent)
        except (OSError, ValueError):
            pass
    return owner.check(owner.home / ".local/bin")


def _download_installer():
    request = urllib.request.Request(INSTALLER_URL, headers={"User-Agent": "codey-node-installer/1"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.geturl() not in {INSTALLER_URL, INSTALLER_FINAL_URL}:
                raise SetupError("The official Codex installer redirected unexpectedly")
            chunks, size = [], 0
            while chunk := response.read(64 * 1024):
                size += len(chunk)
                if size > INSTALLER_LIMIT:
                    raise SetupError("The official Codex installer is unexpectedly large")
                chunks.append(chunk)
    except SetupError:
        raise
    except (OSError, urllib.error.URLError):
        raise SetupError("The official Codex installer could not be downloaded") from None
    data = b"".join(chunks)
    if (not data.startswith(b"#!/bin/sh\n") or
            b'RELEASES_BASE_URL="https://releases.openai.com/codex"' not in data or
            b"CODEX_INSTALL_DIR" not in data):
        raise SetupError("The official Codex installer has an unexpected format")
    return data


@dataclass(repr=False)
class Plan:
    owner: Owner
    codex_home: Path
    bin_directory: Path
    executable: Path
    existing: Path | None
    current_version: str | None
    processes: list

    def report(self):
        return {
            "action": "update" if self.existing else "install",
            "source": INSTALLER_URL,
            "release": "latest",
            "existingExecutable": str(self.existing) if self.existing else None,
            "currentVersion": self.current_version,
            "targetExecutable": str(self.executable),
            "codexHome": str(self.codex_home),
            "processesToStop": list(self.processes),
            "sessionsAndAuthPreserved": True,
        }

    def apply(self):
        stopped = codex_process.stop(self.owner.home, codex_process.inspect(self.owner.home))
        self.owner.mkdir(self.bin_directory)
        self.owner.mkdir(self.codex_home)
        cache = self.owner.home / ".cache/codey-machine"
        self.owner.mkdir(cache)
        installer = cache / f"codex-install-{os.getpid()}.sh"
        if installer.exists():
            raise SetupError("Reserved Codex installer path already exists")
        data = _download_installer()
        protected_write(installer, data)
        installer.chmod(0o700)
        environment = {
            **os.environ,
            "HOME": str(self.owner.home),
            "CODEX_HOME": str(self.codex_home),
            "CODEX_INSTALL_DIR": str(self.bin_directory),
            "CODEX_NON_INTERACTIVE": "true",
            "PATH": str(self.bin_directory) + os.pathsep + os.environ.get("PATH", ""),
        }
        environment.pop("CODEX_RELEASE", None)
        try:
            try:
                result = subprocess.run(
                    ["/bin/sh", str(installer)], stdin=subprocess.DEVNULL,
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                    env=environment, timeout=900,
                )
            except (OSError, subprocess.SubprocessError):
                raise SetupError("Official Codex installation did not complete") from None
        finally:
            installer.unlink(missing_ok=True)
        if result.returncode:
            log = self.owner.home / ".config/codey-machine/codex-install.log"
            self.owner.mkdir(log.parent)
            protected_write(log, ((result.stdout or "") + (result.stderr or "")).encode())
            raise SetupError(f"Official Codex installation failed; protected diagnostic: {log}")
        version = _version(self.executable)
        if not version:
            raise SetupError("The updated Codex executable did not pass codex --version")
        return {
            **self.report(),
            "applied": True,
            "version": version,
            "stoppedProcesses": stopped,
            "installerSha256": hashlib.sha256(data).hexdigest(),
        }


def prepare(home, codex_home, explicit=None, skill=None):
    if skill:
        configured = json.loads((Path(skill) / "dependencies.json").read_text(encoding="utf-8"))[
            "linuxCodexInstaller"]
        if configured != {"url": INSTALLER_URL, "release": "latest"}:
            raise SetupError("Linux Codex must use the reviewed official latest installer")
    owner = Owner.target(home)
    codex_home = owner.check(codex_home)
    existing = _entry(owner.home, explicit)
    bin_directory = _bin_directory(owner, existing)
    return Plan(
        owner, codex_home, bin_directory, bin_directory / "codex",
        existing, _version(existing) if existing else None, codex_process.inspect(owner.home),
    )
