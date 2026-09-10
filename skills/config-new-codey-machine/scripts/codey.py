#!/usr/bin/env python3
"""Dispatch to exactly one native installer; use setup-*.sh/ps1 as the normal entry."""
import argparse
import importlib
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parent
MODULES = {"defaults": "codey_node.common.config_defaults"}
for platform in ("linux", "macos", "windows"):
    if (SCRIPTS / f"codey_node/platforms/{platform}/install.py").is_file():
        MODULES[platform] = f"codey_node.platforms.{platform}.install"
if (SCRIPTS / "codey_node/common/codex_cli.py").is_file():
    MODULES["codex"] = "codey_node.common.codex_cli"


def main():
    if sys.version_info < (3, 12):
        raise SystemExit("Use an existing Python 3.12+ interpreter; do not replace the system Python.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=MODULES)
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    # -I excludes CWD/PYTHONPATH/user-site. Add only this reviewed distribution,
    # not the caller's current directory; imports have no deployment side effects.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.argv = [sys.argv[0], *args.arguments]
    importlib.import_module(MODULES[args.command]).main()


if __name__ == "__main__":
    main()
