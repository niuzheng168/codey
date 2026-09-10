#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(uname -s)" == Darwin ]] || { echo 'This installer is for macOS only.' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { echo 'Run as the signed-in owner, not sudo/root.' >&2; exit 1; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for candidate in "${CODEY_PYTHON:-}" /opt/homebrew/bin/python3.14 /usr/local/bin/python3.14 "$(command -v python3 || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]] && "$candidate" -c 'import sys;sys.exit(sys.version_info < (3,12))'; then
    exec "$candidate" -I -B "$script_dir/codey.py" macos "$@"
  fi
done
echo 'Python 3.12+ is required. Install an owner-approved Python runtime, then rerun this same package.' >&2
exit 1
