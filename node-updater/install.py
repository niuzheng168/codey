#!/usr/bin/env python3
"""Adopt one existing node into the independent updater; never upgrade its apps."""
import os
import sys
if __name__ == "__main__" and not sys.flags.isolated:
    os.execv(sys.executable, [sys.executable, "-I", "-S", os.path.abspath(__file__), *sys.argv[1:]])

import argparse
from pathlib import Path
import shutil

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import Runtime, read, require, run, save
from updater import load_config


def install(args):
    require(sys.platform == "linux" and sys.version_info >= (3, 12) and os.getuid() != 0, "unsupported_platform")
    source = Path(__file__).resolve().parent
    config = load_config(args.config)
    home = Path.home().resolve()
    require(" " not in str(home) and "%" not in str(home), "unsupported_platform")
    runtime = Runtime(config, create=args.apply)
    before = runtime.snapshot()
    print(__import__("json").dumps({
        "nodeId": config["nodeId"], "layout": before["layout"], "ownerId": config["ownerId"],
        "serviceToInstall": "codey-node-updater.service", "nodeServicesRestarted": False,
        "nodeIdentityTlsAndProviderConfigurationChanged": False,
        "scope": "Pull and execute only explicitly confirmed signed Codey releases; never arbitrary commands",
    }, indent=2))
    if not args.apply:
        return
    require(shutil.which("openssl") is not None, "signature_invalid")
    destination = runtime.root / "agent-v1"
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    agent_config = runtime.private / "config.json"
    if agent_config.exists():
        previous = read(agent_config)
        require(previous["nodeId"] == config["nodeId"] and previous["ownerId"] == config["ownerId"],
                "configuration_changed")
        require(previous["releasePublicKey"] == config["releasePublicKey"], "configuration_changed")
    unit = home / ".config/systemd/user/codey-node-updater.service"
    if unit.exists():
        content = unit.read_text()
        require("# Managed by Codey node updater" in content and str(destination) in content, "configuration_changed")
        run(["systemctl", "--user", "stop", "codey-node-updater.service"], timeout=120)
    for name in ["updater.py", "engine.py", "probe.mjs"]:
        target = destination / name
        shutil.copy2(source / name, target)
        target.chmod(0o600)
    save(agent_config, config)
    unit.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    unit.write_text(f"""# Managed by Codey node updater
[Unit]
Description=Codey owner-confirmed node updater
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME={home}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
WorkingDirectory={runtime.root}
ExecStart={Path(sys.executable).resolve()} -I -S {destination}/updater.py --config {agent_config} run
Restart=always
RestartSec=15
TimeoutStopSec=900
KillMode=mixed
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
""")
    unit.chmod(0o600)
    runtime.assert_unchanged(before)
    run(["systemctl", "--user", "daemon-reload"])
    run(["systemctl", "--user", "enable", "--now", "codey-node-updater.service"])
    require(run(["systemctl", "--user", "is-active", "codey-node-updater.service"]) == "active", "operation_failed")
    runtime.assert_unchanged(before)
    print("UPDATER_INSTALLED_NODE_SERVICES_UNCHANGED")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(Path(__file__).with_name("config.json")))
    parser.add_argument("--apply", action="store_true")
    install(parser.parse_args())
