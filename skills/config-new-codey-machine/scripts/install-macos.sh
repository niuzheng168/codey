#!/usr/bin/env bash
# Thin Node bootstrap only. All installation, identity and service logic is JS.
set -euo pipefail
umask 077
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin && "$(id -u)" != 0 ]] || die "Use the logged-on Mac owner, not root."
apply=false check=false network=false expected=""
case "${1:-}" in
    --help|-h) printf '%s\n' 'Usage: bash scripts/install-macos.sh [--check]' \
      '       bash scripts/install-macos.sh --apply --network-approved --expected-computer NAME' \
      '                                    [--replace-existing] [--retry-failed] [--codex-home DIR]' \
      'No Python or updater is required. Without --apply, no tools or files are installed.'; exit 0 ;;
esac
# Parse a function's positional arguments so the original argv survives on Bash 3.2.
bootstrap_options() {
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) apply=true ;;
    --network-approved) network=true ;;
    --expected-computer) [[ $# -ge 2 ]] || die "Missing computer name"; expected="$2"; shift ;;
    --codex-home) [[ $# -ge 2 ]] || die "Missing Codex home"; shift ;;
    --check) check=true ;;
    --replace-existing|--retry-failed) ;;
    *) die "Unknown option; use --help." ;;
  esac
  shift
done
}
bootstrap_options "$@"
[[ "$apply" != true || "$check" != true ]] || die "--check cannot be combined with --apply."
if command -v node >/dev/null 2>&1 &&
   node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=13?0:1)' >/dev/null 2>&1; then
  exec node "$HERE/install-macos.mjs" "$@"
fi
# A managed node already has Node even when the owner has no global Node/PATH.
# Reuse only its private, checksummed executable; never download on a rerun.
runtime="$HOME/.config/codey-machine-macos/runtime.json"
if [[ ! -f "$runtime" && -f "$HOME/.config/codey-machine-macos/application.json" ]]; then
  runtime="$HOME/.config/codey-machine-macos/application.json"
fi
if [[ -f "$runtime" ]]; then
  [[ ! -L "$runtime" && "$(/usr/bin/stat -f '%u:%Lp' "$runtime")" == "$(id -u):600" ]] ||
    die "Existing runtime ownership/permissions require review."
  node="$(/usr/bin/plutil -extract nodeExe raw -o - "$runtime")"
  checksum="$(/usr/bin/plutil -extract fileHashes.nodeExe raw -o - "$runtime" 2>/dev/null || true)"
  [[ -n "$checksum" || "$runtime" == "$HOME/.config/codey-machine-macos/application.json" ]] ||
    die "Existing runtime has no verified Node fingerprint."
  if [[ -n "$checksum" ]]; then
  [[ "$node" == "$HOME/.local/share/codey-machine-macos/releases/"* && "$checksum" =~ ^[a-f0-9]{64}$ ]] ||
    die "Existing runtime requires explicit migration."
  cursor="$node"
  while [[ "$cursor" != "$HOME" ]]; do
    [[ ! -L "$cursor" && "$(/usr/bin/stat -f '%u' "$cursor")" == "$(id -u)" ]] ||
      die "Existing Node path is linked or belongs to another owner."
    mode="$(/usr/bin/stat -f '%Lp' "$cursor")"
    (( (8#$mode & 022) == 0 )) || die "Existing Node path is writable by others."
    cursor="$(dirname -- "$cursor")"
  done
  [[ "$(/usr/bin/shasum -a 256 "$node" | awk '{print $1}')" == "$checksum" ]] || die "Existing Node fingerprint mismatch."
  exec "$node" "$HERE/install-macos.mjs" "$@"
  fi
fi
if [[ "$apply" != true ]]; then
  printf '%s\n' 'Node 22.13+ with npm is not installed. Apply will prepare the pinned official Node, then run the complete preflight.' \
    "Computer: $(hostname)" 'No downloads, files, services or model requests were made. Full package preflight requires Node.'
  exit 0
fi
[[ "$network" == true && "$expected" == "$(hostname)" ]] ||
  die "Apply requires --network-approved and --expected-computer matching this Mac exactly."
[[ "$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || true)" != 1 ]] || die "Use a native terminal, not Rosetta."
case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) die "Unsupported Mac architecture." ;; esac
pins="$HERE/../dependencies.macos.json"
version="$(/usr/bin/plutil -extract nodeVersion raw -o - "$pins")"
url="$(/usr/bin/plutil -extract "platforms.macos-$arch.node.url" raw -o - "$pins")"
checksum="$(/usr/bin/plutil -extract "platforms.macos-$arch.node.sha256" raw -o - "$pins")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$checksum" =~ ^[a-f0-9]{64}$ &&
   "$url" == "https://nodejs.org/dist/v$version/node-v$version-darwin-$arch.tar.gz" ]] || die "Invalid official Node pin."
temporary="$(mktemp -d "${TMPDIR:-/tmp}/codey-node.XXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT
/usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --connect-timeout 30 --max-time 300 --output "$temporary/node.tar.gz" "$url"
[[ "$(/usr/bin/shasum -a 256 "$temporary/node.tar.gz" | awk '{print $1}')" == "$checksum" ]] || die "Node checksum mismatch."
/usr/bin/tar -xzf "$temporary/node.tar.gz" -C "$temporary"
CODEY_BOOTSTRAP_NODE_ARCHIVE="$temporary/node.tar.gz" \
  "$temporary/node-v$version-darwin-$arch/bin/node" "$HERE/install-macos.mjs" "$@"
