#!/usr/bin/env python3
"""Independent owner LaunchAgent host; its lock covers the entire agent lifetime."""
import os
import sys
if __name__ == "__main__" and (not sys.flags.isolated or not sys.flags.no_site):
    os.execv(sys.executable, [sys.executable, "-I", "-S", "-B", os.path.abspath(__file__), *sys.argv[1:]])

import argparse
import importlib.util
import json
from pathlib import Path
import secrets
import signal
import subprocess
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("codey_macos_native", HERE / "native.py")
native_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native_module)
Native, require, read, digest = native_module.Native, native_module.require, native_module.read, native_module.digest
checked_path, lock_file = native_module.checked_path, native_module.lock_file


def binding(native):
    cfg = native.config()
    file = checked_path(native.private / "binding.json", native.home, private=True, exists=True)
    saved = read(file)
    source = checked_path(saved["agentDirectory"], native.home, private=True, exists=True)
    require(source == HERE.parent and saved.get("schema") == 1 and saved.get("platform") == native.target
            and saved.get("nodeId") == cfg["nodeId"] and saved.get("ownerUid") == os.getuid()
            and saved.get("ownerHome") == str(native.home) and saved.get("ownerId") == cfg["environment"]["CODEY_PORTAL_PRINCIPAL_ID"]
            and saved.get("nodeExe") == cfg["nodeExe"] and saved.get("pythonExe") == cfg["pythonExe"]
            and Path(sys.executable).resolve() == Path(cfg["pythonExe"]).resolve()
            and digest(cfg["pythonExe"]) == saved["pythonSha256"]
            and digest(cfg["nodeExe"]) == saved["nodeSha256"])
    manifest_file = checked_path(source / "agent-files.json", native.home, private=True, exists=True)
    require(digest(manifest_file) == saved["manifestSha256"])
    manifest = read(manifest_file)
    require(manifest["platform"] == native.target and manifest["files"] == saved["files"])
    for name, checksum in manifest["files"].items():
        require(name and not Path(name).is_absolute() and ".." not in Path(name).parts)
        require(digest(checked_path(source / name, native.home, private=True, exists=True)) == checksum)
    config_file = checked_path(native.private / "config.json", native.home, private=True, exists=True)
    require(digest(config_file) == saved["configSha256"])
    return cfg, saved


def serve(config_file, mode):
    native = Native()
    require(Path(config_file) == native.private / "config.json")
    cfg, saved = binding(native)
    if mode == "run":
        # launchd gives this job its own process group. Every ordinary child
        # inherits it; AbandonProcessGroup=false also cleans up after a hard
        # host crash. Never join a shell's/Codey/Desktop's process group.
        require(os.getppid() == 1 and os.getpgrp() == os.getpid())
        if (native.private / "stop.json").exists():
            return
    with lock_file(checked_path(native.private / "agent.lock", native.home)) as fd:
        nonce = secrets.token_hex(16)
        os.ftruncate(fd, 0)
        os.write(fd, (json.dumps({"pid": os.getpid(), "nonce": nonce}) + "\n").encode())
        os.fsync(fd)
        env = native_module.control_environment(native.home)
        env.update({"PATH": str(Path(cfg["nodeExe"]).parent) + ":/usr/bin:/bin:/usr/sbin:/sbin",
                    "CODEY_UPDATER_HOST_TOKEN": nonce})
        args = [cfg["nodeExe"], HERE / "agent.mjs", mode, "--config", config_file]
        # One-off recovery gets its own group too; launchd already owns the
        # normal group and will not terminate the separately launched app jobs.
        child = subprocess.Popen([str(arg) for arg in args], cwd=native.home, env=env,
                                 stdin=subprocess.DEVNULL, start_new_session=mode != "run")
        stopping = False

        def stop(_signal, _frame):
            nonlocal stopping
            if not stopping and child.poll() is None:
                stopping = True
                child.send_signal(signal.SIGTERM)  # Node finishes its current durable transaction.

        old = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            while child.poll() is None:
                time.sleep(0.2)
            require(child.returncode == 0, "operation_failed")
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=930)
            for sig, handler in old.items():
                signal.signal(sig, handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("mode", choices=("run", "recover"))
    args = parser.parse_args()
    serve(args.config, args.mode)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"code": error.code if isinstance(error, native_module.UpdateError) else "configuration_changed"}),
              file=sys.stderr)
        sys.exit(1)
