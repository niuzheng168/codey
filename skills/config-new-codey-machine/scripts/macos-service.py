#!/usr/bin/env python3
"""Owner-only LaunchAgent worker for the single Codey npm application."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile

COMPONENTS = ("codey", "tunnel", "renew")


def require(value, message="Invalid private Codey macOS runtime"):
    if not value:
        raise RuntimeError(message)


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked_path(file, home):
    file, home = Path(os.path.abspath(file)), Path(home).resolve(strict=True)
    require(file != home and file.is_relative_to(home), "Path must remain under the original owner's home")
    for entry in (file, *file.parents):
        if not entry.is_relative_to(home):
            break
        require(not entry.is_symlink(), "Linked installation paths require manual review")
        if entry.exists():
            info = entry.stat()
            require(info.st_uid == os.getuid() and not info.st_mode & 0o022, "Unowned or writable installation path")
    return file


def read_private(file):
    file = Path(file)
    info = file.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077
            and info.st_size <= 4 * 1024 * 1024)
    return json.loads(file.read_text(encoding="utf-8"))


def write_private(file, value):
    file = Path(file)
    require(not file.is_symlink(), "Refusing to replace a symlink")
    if file.exists():
        require(file.is_file() and file.stat().st_uid == os.getuid(), "Refusing to replace an unowned file")
    data = value if isinstance(value, bytes) else (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=file.parent, prefix="." + file.name + ".", delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def label(node_id, component):
    require(re.fullmatch(r"n-[a-f0-9]{24}", node_id) and component in COMPONENTS)
    return f"com.codey.machine.{node_id}.{component}"


def agent_definition(config, config_file, component):
    # This schema-2 contract is also validated by the independently enrolled updater.
    value = {
        "Label": label(config["nodeId"], component),
        "ProgramArguments": [config["pythonExe"], "-I", "-S", config["workerPath"], component, str(config_file)],
        "RunAtLoad": True, "ProcessType": "Background", "ThrottleInterval": 15, "Umask": 63,
        "WorkingDirectory": config["runtimeRoot"],
        "StandardOutPath": str(Path(config["stateRoot"]) / (component + ".log")),
        "StandardErrorPath": str(Path(config["stateRoot"]) / (component + ".log")),
        "KeepAlive": True,
    }
    if component == "renew":
        value.update({"StartInterval": 21600, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 120})
    return value


def runtime(file):
    home = Path.home().resolve()
    checked_path(file, home)
    cfg = read_private(file)
    require(cfg.get("schema") == 2 and cfg.get("kind") == "codey-macos-oneclick"
            and cfg.get("layout") == "npm-codey-package" and cfg.get("ownerUid") == os.getuid()
            and cfg.get("ownerHome") == str(home) and cfg.get("platform") in ("macos-arm64", "macos-x64")
            and cfg.get("state") in ("installing", "ready"))
    require(Path(file) == home / ".config/codey-machine-macos/runtime.json"
            and cfg["runtimeRoot"] == str(home / ".local/share/codey-machine-macos"))
    for name in ("nodeExe", "devtunnelExe", "workerPath", "helperPath", "registrationHelper"):
        checked_path(cfg[name], cfg["runtimeRoot"])
        require(digest(cfg[name]) == cfg["fileHashes"][name], "Native worker/tool fingerprint mismatch")
    require(cfg["workerPath"] == str(Path(__file__).resolve()))
    checked_path(cfg["codeyBin"], cfg["runtimeRoot"])
    require(digest(Path(cfg["codeyDirectory"]) / "codey-build.json") == cfg["codeyEntrySha256"])
    return cfg


def command(config, component, file):
    if component == "codey":
        return [config["nodeExe"], config["codeyBin"], "start", "--host", "127.0.0.1",
                "--workspace-port", "3001", "--gateway-port", "4141"]
    if component == "tunnel":
        return [config["devtunnelExe"], "host", config["qualifiedTunnel"],
                "--host-header", "unchanged", "--origin-header", "unchanged"]
    require(component == "renew")
    return [config["nodeExe"], config["helperPath"], "renew", str(file)]


def main():
    require(sys.platform == "darwin" and os.getuid() != 0 and sys.version_info >= (3, 12))
    require(len(sys.argv) >= 3 and sys.argv[1] in (*COMPONENTS, "cli"))
    component, file = sys.argv[1:3]
    cfg = runtime(file)
    if component == "cli":
        os.execve(cfg["nodeExe"], [cfg["nodeExe"], cfg["codeyBin"], *sys.argv[3:]], cfg["environment"])
    require(len(sys.argv) == 3)
    env = cfg["environment"] if component == "codey" else cfg["baseEnvironment"]
    # Own a separate process group. Only this worker's children are signalled.
    child = subprocess.Popen(command(cfg, component, file), env=env, cwd=cfg["runtimeRoot"], start_new_session=True)
    stopping = False

    def stop(_number, _frame):
        nonlocal stopping
        if not stopping:
            stopping = True
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while True:
            try:
                return child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                if stopping:
                    try:
                        return child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        return child.wait()
    finally:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Codey macOS worker failed; inspect the owner-only runtime state.", file=sys.stderr)
        sys.exit(1)
