#!/usr/bin/env bash
# Native Linux entry point. Planning is the default; --apply is explicit.
set -euo pipefail
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This is the Linux installer. Use setup-windows.ps1 on Windows; macOS is not implemented." >&2
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "${CODEY_PYTHON:-python3}" -I -B "$script_dir/configure-machine.py" "$@"
