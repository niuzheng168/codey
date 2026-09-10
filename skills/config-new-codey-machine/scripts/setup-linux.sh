#!/usr/bin/env bash
# Native Linux entry point. Use --apply for the one-command replacement install.
set -euo pipefail
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Use setup-windows.ps1 on Windows or setup-macos.sh on macOS." >&2
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "${CODEY_PYTHON:-python3}" -I -B "$script_dir/codey.py" linux "$@"
