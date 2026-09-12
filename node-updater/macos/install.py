#!/usr/bin/env python3
"""Adopt an existing Mac npm node. --apply installs only its independent updater."""
import os
import sys
if __name__ == "__main__" and (not sys.flags.isolated or not sys.flags.no_site):
    os.execv(sys.executable, [sys.executable, "-I", "-S", "-B", os.path.abspath(__file__), *sys.argv[1:]])

import argparse
import importlib.util
import json
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import time

SOURCE = Path(__file__).resolve().parent
MAC = SOURCE / "macos" if (SOURCE / "macos/native.py").exists() else SOURCE
spec = importlib.util.spec_from_file_location("codey_macos_native", MAC / "native.py")
native_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native_module)
Native, require, read, save = native_module.Native, native_module.require, native_module.read, native_module.save
checked_path, digest, lock_file = native_module.checked_path, native_module.digest, native_module.lock_file
UpdateError = native_module.UpdateError

PACKAGE_FILES = {
    "install.py", "UPGRADE.md", "probe.mjs",
    *("macos/" + name for name in ("agent.mjs", "runtime.mjs", "verify.mjs", "native.py", "host.py")),
    *("windows/" + name for name in ("agent.mjs", "client.mjs", "runtime.mjs", "verify.mjs")),
    *("windows/lib/" + name for name in ("node-update-manifest.mjs", "update-probe.mjs", "update-files.mjs",
                                       "update-archive.mjs", "package-info.mjs")),
}


def updater_label(node_id):
    require(native_module.NODE_ID.fullmatch(node_id))
    return "com.codey.node-updater." + node_id


def definition(native, binding):
    return {
        "Label": updater_label(binding["nodeId"]),
        "ProgramArguments": [binding["pythonExe"], "-I", "-S", "-B",
                             str(Path(binding["agentDirectory"]) / "macos/host.py"),
                             "--config", str(native.private / "config.json"), "run"],
        "WorkingDirectory": str(native.updater_root), "RunAtLoad": True, "KeepAlive": True,
        "ProcessType": "Background", "ThrottleInterval": 15, "Umask": 63, "ExitTimeOut": 960,
        "AbandonProcessGroup": False,
        "StandardOutPath": str(native.private / "agent.log"), "StandardErrorPath": str(native.private / "agent.log"),
    }


def no_jobs(native):
    require(not any((native.private / name).exists() for name in ("pending.json", "blocked.json")), "busy")
    require(not (native.local_state / "active.json").exists() and not (native.local_state / "lock").exists(), "busy")


def validate_bundle(source, config, native):
    manifest = read(checked_path(source / "agent-files.json", native.home, private=True, exists=True))
    require(manifest.get("schema") == 1 and manifest.get("platform") == native.target
            and set(manifest.get("files", {})) == PACKAGE_FILES)
    for name, checksum in manifest["files"].items():
        require(native_module.HASH.fullmatch(checksum)
                and digest(checked_path(source / name, native.home, private=True, exists=True)) == checksum)
    cfg = native.config()
    require(Path(sys.executable).resolve() == Path(cfg["pythonExe"]).resolve(), "runtime_incompatible")
    require(config.get("schema") == 1 and config.get("protocol") == 1 and config.get("platform") == native.target
            and config.get("nodeId") == cfg["nodeId"] and config.get("portalOrigin") == cfg["portalOrigin"]
            and config.get("ownerId") == cfg["environment"]["CODEY_PORTAL_PRINCIPAL_ID"]
            and config.get("username") == cfg["environment"]["CODEY_PORTAL_USERNAME"])
    # Actual Node crypto verifies Ed25519/origin/token structure. No model/login.
    native.run([cfg["nodeExe"], source / "macos/agent.mjs", "validate", "--config", source / "config.json"])
    return cfg, manifest


def task(native, binding, *, required=False):
    file = checked_path(native.home / "Library/LaunchAgents" / (updater_label(binding["nodeId"]) + ".plist"), native.home)
    if not file.exists():
        require(not required)
        result = native.run(["/bin/launchctl", "print", native.domain + "/" + updater_label(binding["nodeId"])], check=False)
        require(result.returncode != 0)
        native.run(["/bin/launchctl", "print", native.domain])
        require("Could not find service" in result.stderr or "Could not find specified service" in result.stderr)
        return file, None
    checked_path(file, native.home, private=True)
    require(plistlib.loads(file.read_bytes()) == definition(native, binding))
    result = native.run(["/bin/launchctl", "print", native.domain + "/" + updater_label(binding["nodeId"])], check=False)
    if result.returncode:
        native.run(["/bin/launchctl", "print", native.domain])
        require("Could not find service" in result.stderr or "Could not find specified service" in result.stderr)
        return file, None
    require(re.findall(r"^\s*path = (.+)$", result.stdout, re.M) == [str(file)])
    pids = re.findall(r"^\s*pid = ([1-9][0-9]*)$", result.stdout, re.M)
    require(len(pids) <= 1)
    return file, int(pids[0]) if pids else 0


def disabled(native, binding):
    output = native.run(["/bin/launchctl", "print-disabled", native.domain]).stdout
    values = re.findall(r'"' + re.escape(updater_label(binding["nodeId"])) + r'"\s*=>\s*(true|false)', output)
    require(len(values) <= 1)
    return values == ["true"]


def stop_updater(native, binding):
    _, pid = task(native, binding, required=True)
    if pid is None:
        return
    target = native.domain + "/" + updater_label(binding["nodeId"])
    native.run(["/bin/launchctl", "disable", target])
    save(native.private / "stop.json", {"stop": True})
    deadline = time.monotonic() + 120
    # Do not force a live updater out of a transaction. Its current queue step
    # finishes before it releases this kernel lock.
    while True:
        try:
            with lock_file(native.private / "agent.lock"):
                _, current = task(native, binding, required=True)
                if not current:
                    break
        except UpdateError as error:
            require(error.code == "busy")
        require(time.monotonic() < deadline, "busy")
        time.sleep(0.5)
    no_jobs(native)
    native.run(["/bin/launchctl", "bootout", target], timeout=60)
    require(task(native, binding, required=True)[1] is None)
    (native.private / "stop.json").unlink()


def apply(native, source, incoming, cfg, manifest, before):
    for directory in (native.private, native.updater_root, native.jobs):
        checked_path(directory, native.home)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        checked_path(directory, native.home, private=True)
    checked_path(native.private / "agent.log", native.home, private=True)
    with lock_file(native.private / "installer.lock"), lock_file(native.config_root / "install.lock"):
        no_jobs(native)
        native.unchanged(before)
        previous, previous_bytes, previous_config, previous_plist = None, None, None, None
        old_loaded, old_disabled = False, False
        config_file, binding_file = native.private / "config.json", native.private / "binding.json"
        require(config_file.exists() == binding_file.exists())
        if binding_file.exists():
            previous = read(binding_file)
            previous_bytes, previous_config = binding_file.read_bytes(), config_file.read_bytes()
            old = read(config_file)
            require(previous.get("schema") == 1 and previous.get("nodeId") == cfg["nodeId"]
                    and previous.get("ownerHome") == str(native.home) and previous.get("ownerUid") == os.getuid()
                    and previous.get("platform") == native.target and previous.get("ownerId") == incoming["ownerId"])
            require(all(old.get(name) == incoming.get(name)
                        for name in ("nodeId", "platform", "ownerId", "username", "portalOrigin", "releasePublicKey")))
            file, running = task(native, previous, required=True)
            previous_plist = file.read_bytes()
            old_loaded, old_disabled = running is not None, disabled(native, previous)
        installed = read(native.private / "installed.json") if (native.private / "installed.json").exists() else {}
        if installed:
            require(installed.get("nodeId") == cfg["nodeId"] and installed.get("ownerId") == incoming["ownerId"]
                    and installed.get("platform") == native.target and isinstance(installed.get("sequence"), int)
                    and not isinstance(installed["sequence"], bool) and installed["sequence"] >= 0)
        incoming = {**incoming, "minimumSequence": max(incoming["minimumSequence"], installed.get("sequence", 0))}
        destination = checked_path(native.updater_root / ("agent-macos-v1-" + secrets.token_hex(8)), native.home)
        destination.mkdir(mode=0o700)
        for name in sorted(PACKAGE_FILES | {"agent-files.json"}):
            file = destination / name
            file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copyfile(source / name, file)
            file.chmod(0o600)
            if name == "agent-files.json":
                require(read(file) == manifest)
            else:
                require(digest(file) == manifest["files"][name])
        binding = {
            "schema": 1, "nodeId": cfg["nodeId"], "platform": native.target,
            "ownerUid": os.getuid(), "ownerHome": str(native.home), "ownerId": incoming["ownerId"],
            "pythonExe": cfg["pythonExe"], "pythonSha256": digest(cfg["pythonExe"]),
            "nodeExe": cfg["nodeExe"], "nodeSha256": digest(cfg["nodeExe"]),
            "agentDirectory": str(destination), "files": manifest["files"],
            "manifestSha256": digest(destination / "agent-files.json"),
        }
        file = native.home / "Library/LaunchAgents" / (updater_label(cfg["nodeId"]) + ".plist")
        if previous is None:
            require(not file.exists())
            require(task(native, binding)[1] is None)
        new_written = False
        try:
            if previous:
                stop_updater(native, previous)
            no_jobs(native)
            native.unchanged(before)
            save(config_file, incoming)
            binding["configSha256"] = digest(config_file)
            save(binding_file, binding)
            save(file, plistlib.dumps(definition(native, binding)))
            new_written = True
            target = native.domain + "/" + updater_label(cfg["nodeId"])
            native.run(["/bin/launchctl", "enable", target])
            native.run(["/bin/launchctl", "bootstrap", native.domain, file], timeout=60)
            deadline = time.monotonic() + 25
            while True:
                _, pid = task(native, binding, required=True)
                if pid and (native.private / "agent.lock").exists() and read(native.private / "agent.lock").get("pid") == pid:
                    break
                require(time.monotonic() < deadline, "operation_failed")
                time.sleep(0.5)
            native.unchanged(before)
            return {"installed": True, "platform": native.target, "nodeId": cfg["nodeId"],
                    "service": updater_label(cfg["nodeId"]), "codeyServicesChanged": False,
                    "modelRequests": False, "heartbeatRequiresPortalConnectivity": True}
        except Exception:
            # Restore only our known updater, only while there is no app
            # transaction. Unknown/colliding state is left for inspection.
            no_jobs(native)
            native.unchanged(before)
            if new_written:
                require(digest(config_file) == binding["configSha256"]
                        and read(binding_file) == binding)
                stop_updater(native, binding)
            if previous:
                save(config_file, previous_config)
                save(binding_file, previous_bytes)
                save(file, previous_plist)
                (native.private / "stop.json").unlink(missing_ok=True)
                target = native.domain + "/" + updater_label(cfg["nodeId"])
                native.run(["/bin/launchctl", "disable" if old_disabled else "enable", target])
                if old_loaded and task(native, previous, required=True)[1] is None:
                    native.run(["/bin/launchctl", "bootstrap", native.domain, file], timeout=60)
            elif new_written:
                file.unlink()
                config_file.unlink()
                binding_file.unlink()
                (native.private / "stop.json").unlink(missing_ok=True)
            raise


def install(args):
    native = Native()
    source = Path(args.config).resolve(strict=True).parent
    require(source == SOURCE and Path(args.config).resolve() == source / "config.json")
    checked_path(source, native.home, exists=True)
    incoming = read(checked_path(source / "config.json", native.home, private=True, exists=True))
    cfg, manifest = validate_bundle(source, incoming, native)
    no_jobs(native)
    native.run(["/bin/launchctl", "print", native.domain])
    before = native.snapshot()
    plan = {"platform": native.target, "nodeId": cfg["nodeId"], "ownerId": incoming["ownerId"],
            "layout": cfg["layout"], "service": updater_label(cfg["nodeId"]), "apply": args.apply,
            "nodeServicesRestarted": False, "toolsInstalled": False, "modelRequests": False}
    if not args.apply:
        print(json.dumps(plan, indent=2))
        return
    old_mask = os.umask(0o077)
    try:
        print(json.dumps(apply(native, source, incoming, cfg, manifest, before), indent=2))
    finally:
        os.umask(old_mask)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(SOURCE / "config.json"))
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--apply", action="store_true")
    operation.add_argument("--check", action="store_true", help="Read-only preflight (also the default)")
    try:
        install(parser.parse_args())
    except Exception as error:
        print(json.dumps({"ok": False, "code": error.code if isinstance(error, UpdateError) else "configuration_changed",
                          "note": "Use the existing installer Python as the original Mac owner; never sudo or reinstall the node."}),
              file=sys.stderr)
        sys.exit(1)
