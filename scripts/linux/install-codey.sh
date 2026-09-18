#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# A machine release fills this filename, not an embedded application payload.
DEFAULT_PACKAGE_FILE=""
usage() {
  cat <<'HELP'
Usage: bash install-codey-linux.sh --package FILE.tgz|HTTPS_URL [options]
       bash install-codey-linux.sh --package codey@VERSION --registry HTTPS_URL

  --prefix DIR     New private npm prefix; never overwrite an existing prefix.
  --node-dir DIR   Reuse a Node.js 22.13+ installation instead of downloading Node.
  --config FILE    Public Portal setup JSON (otherwise use the package's config).
  --check          Read-only preflight; no downloads, installation or services.
  --expected-computer NAME  Required for setup; must match hostname exactly.
  --replace-existing       Back up existing Codex/gateway settings before configuring.

No ZIP extraction is required. npm installs one Codey package; the shared installer
configures the gateway, workspace and private DevTunnel. Port ownership is checked
before downloads. Same-release managed nodes are verified and reused, not reinstalled.
Foreign/unverified listeners stop installation; no process is killed to free a port.
Do not install the unrelated public npm package named codey.
HELP
}
die() { echo "ERROR: $*" >&2; exit 1; }
# BEGIN_CODEY_PREFLIGHT
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)/skills/config-new-codey-machine/scripts/linux-preflight.sh"
# END_CODEY_PREFLIGHT
PACKAGE_SPEC=""
REGISTRY=""
PREFIX=""
NODE_DIR=""
SETUP_ARGS=()
CHECK=false
EXPECTED_COMPUTER=""
REPLACE_EXISTING=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --check) CHECK=true; shift ;;
    --replace-existing) REPLACE_EXISTING=true; SETUP_ARGS+=(--replace-existing); shift ;;
    --package|--registry|--prefix|--node-dir|--config|--expected-computer)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "Missing value for $1"
      case "$1" in
        --package) PACKAGE_SPEC="$2" ;;
        --registry) REGISTRY="$2" ;;
        --prefix) PREFIX="$2" ;;
        --node-dir) NODE_DIR="$2" ;;
        --config) SETUP_ARGS+=(--config "$(realpath -- "$2")") ;;
        --expected-computer) EXPECTED_COMPUTER="$2"; SETUP_ARGS+=(--expected-computer "$2") ;;
      esac
      shift 2 ;;
    *) die "Unknown option: $1" ;;
  esac
done
if [[ -z "$PACKAGE_SPEC" && -n "$DEFAULT_PACKAGE_FILE" ]]; then
  PACKAGE_SPEC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$DEFAULT_PACKAGE_FILE"
fi
[[ -n "$PACKAGE_SPEC" ]] || { usage >&2; die "Provide a Codey npm package file or HTTPS URL."; }
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die "Linux x64 is required."
[[ "$(id -u)" != 0 ]] || die "Run as the target user, not root."
[[ "$CHECK" == true || "$EXPECTED_COMPUTER" == "$(hostname)" ]] ||
  die "Use --expected-computer with this machine's exact hostname."
codey_linux_preflight || exit 1
[[ -f "$PACKAGE_SPEC" || "$PACKAGE_SPEC" == https://* ||
   ( "$PACKAGE_SPEC" =~ ^codey@[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ && -n "$REGISTRY" ) ]] ||
  die "Use a local .tgz, an HTTPS .tgz URL, or a pinned version with an explicit private registry."

# A complete Skill has the same Node workflow as Windows/macOS. Keep this shell
# responsible only for the native preflight and a missing Node bootstrap.
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/install-machine.mjs" && -f "$PACKAGE_SPEC" && -z "$PREFIX$REGISTRY$NODE_DIR" &&
      "$(realpath -- "$PACKAGE_SPEC")" == "$(realpath -- "$HERE/../assets")/"* ]]; then
  COMMON_ARGS=(--check)
  if [[ "$CHECK" != true ]]; then
    COMMON_ARGS=(--apply --network-approved --expected-computer "$EXPECTED_COMPUTER")
    [[ "$REPLACE_EXISTING" != true ]] || COMMON_ARGS+=(--replace-existing)
  fi
  # An explicit setup override must be honored by the npm/setup entry below.
  if [[ ! " ${SETUP_ARGS[*]} " == *" --config "* ]]; then
    AVAILABLE_NODE="${CODEY_EXISTING_NODE:-}"
    [[ -z "$NODE_DIR" ]] || AVAILABLE_NODE="$NODE_DIR/bin/node"
    [[ -n "$AVAILABLE_NODE" ]] || AVAILABLE_NODE="$(command -v node || true)"
    if [[ -n "$AVAILABLE_NODE" ]] &&
       "$AVAILABLE_NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=13?0:1)' >/dev/null 2>&1; then
      exec "$AVAILABLE_NODE" "$HERE/install-machine.mjs" "${COMMON_ARGS[@]}"
    fi
    if [[ "$CHECK" == true ]]; then
      echo 'Read-only check: owner/host/ports checked. No downloads or filesystem changes.'
      echo 'Deferred: Node/npm missing; full package/config checks, login, native dependencies and services require Node/apply.'
      exit 0
    fi
    BOOTSTRAP="$(mktemp -d)"
    trap 'rm -rf -- "$BOOTSTRAP"' EXIT
    curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
      'https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz' --output "$BOOTSTRAP/node.tar.xz"
    printf '%s  %s\n' '2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2' "$BOOTSTRAP/node.tar.xz" | sha256sum -c -
    tar -xJf "$BOOTSTRAP/node.tar.xz" -C "$BOOTSTRAP"
    CODEY_BOOTSTRAP_NODE_ARCHIVE="$BOOTSTRAP/node.tar.xz" \
      "$BOOTSTRAP/node-v24.20.0-linux-x64/bin/node" "$HERE/install-machine.mjs" "${COMMON_ARGS[@]}"
    exit "$?"
  fi
fi

# Standalone npm bootstrap compatibility: compare the requested archive with
# the running package BEFORE making a prefix, downloading Node or invoking npm.
if [[ -n "$CODEY_EXISTING_PACKAGE" ]]; then
  [[ -z "$PREFIX" || ( -d "$PREFIX" &&
    "$(realpath -- "$PREFIX")" == "$(realpath -- "$CODEY_EXISTING_PACKAGE/../../..")" ) ]] ||
    die "An existing node cannot be moved to a new --prefix."
  [[ -z "$NODE_DIR" || ( -x "$NODE_DIR/bin/node" &&
    "$(readlink -f "$NODE_DIR/bin/node")" == "$(readlink -f "$CODEY_EXISTING_NODE")" ) ]] ||
    die "The requested Node differs from this installation; setup is not a tool updater."
  [[ -f "$PACKAGE_SPEC" ]] ||
    die "Use the local release .tgz to verify an existing node; no remote install/update was attempted."
  "$CODEY_EXISTING_NODE" --input-type=module - "$CODEY_EXISTING_PACKAGE" "$(realpath -- "$PACKAGE_SPEC")" <<'NODE'
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, file] = process.argv.slice(2);
const { inspectPackageArchive, verifyStagedPackage } = await import(pathToFileURL(path.join(root, "lib/package-archive.mjs")).href);
try { await verifyStagedPackage(root, await inspectPackageArchive(file)); }
catch { console.error("Requested release differs from the installed package; no download, reinstall or update was attempted."); process.exit(1); }
NODE
  [[ -f "$CODEY_EXISTING_PACKAGE/lib/install.mjs" ]] ||
    die "This release uses a retired installation entrypoint; use its matching installer, not a new installation to upgrade it."
  [[ "$CHECK" != true ]] || SETUP_ARGS+=(--check)
  exec "$CODEY_EXISTING_NODE" "$CODEY_EXISTING_PACKAGE/lib/install.mjs" "${SETUP_ARGS[@]}"
fi
if [[ "$CHECK" == true ]]; then
  if [[ -f "$PACKAGE_SPEC" ]]; then
    tar -tzf "$PACKAGE_SPEC" >/dev/null || die "Cannot read the requested npm archive."
  fi
  [[ -z "$PREFIX" || ( ! -e "$PREFIX" && ! -L "$PREFIX" ) ]] || die "Refusing to overwrite an existing npm prefix."
  echo 'Read-only check: owner/host/ports checked. No downloads, npm, file changes, services or model requests.'
  echo 'Deferred: remote artifact/full package integrity, Node/npm, native dependencies, login and live acceptance are checked during apply.'
  exit 0
fi
if [[ "$CHECK" != true && -z "$CODEY_EXISTING_PACKAGE" && "$REPLACE_EXISTING" != true ]]; then
  [[ ! -e "$HOME/.codex/config.toml" && ! -e "$HOME/.codex/models.json" &&
     ! -e "$HOME/.local/share/copilot-api/config.json" ]] ||
    die "Existing Codex/gateway configuration requires --replace-existing."
fi
for command in curl sha256sum tar mktemp realpath; do
  command -v "$command" >/dev/null 2>&1 || die "Missing command: $command"
done

# Only Node's official distribution is extracted. Application files are managed by npm.
if [[ -z "$NODE_DIR" ]]; then
  NODE_VERSION="24.20.0"
  NODE_SHA256="2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2"
  TOOLS="$HOME/.local/share/codey-tools"
  NODE_DIR="$TOOLS/node-v$NODE_VERSION"
  mkdir -p "$TOOLS"
  if [[ ! -x "$NODE_DIR/bin/node" ]]; then
    NODE_WORK="$(mktemp -d "$TOOLS/.node-download-XXXXXX")"
    curl --fail --location --proto '=https' --tlsv1.2 \
      "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
      --output "$NODE_WORK/node.tar.xz"
    printf '%s  %s\n' "$NODE_SHA256" "$NODE_WORK/node.tar.xz" | sha256sum -c -
    tar -xJf "$NODE_WORK/node.tar.xz" -C "$NODE_WORK"
    mv -T "$NODE_WORK/node-v$NODE_VERSION-linux-x64" "$NODE_DIR"
    rm -- "$NODE_WORK/node.tar.xz"
    rmdir "$NODE_WORK"
  fi
  [[ "$("$NODE_DIR/bin/node" --version)" == "v$NODE_VERSION" ]] || die "Unexpected Node runtime."
fi
NODE_DIR="$(realpath -- "$NODE_DIR")"
NODE="$NODE_DIR/bin/node"
NPM="$NODE_DIR/bin/npm"
[[ -x "$NODE" && -x "$NPM" ]] || die "Node and npm are required."
"$NODE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)' ||
  die "Node.js 22.13+ is required."

if [[ -f "$PACKAGE_SPEC" ]]; then
  PACKAGE_SPEC="$(realpath -- "$PACKAGE_SPEC")"
elif [[ "$PACKAGE_SPEC" == https://* ]]; then
  "$NODE" - "$PACKAGE_SPEC" <<'NODE'
const url = new URL(process.argv[2]);
if (url.protocol !== "https:" || url.username || url.password || !url.pathname.endsWith(".tgz") || url.hash) process.exit(1);
NODE
elif [[ "$PACKAGE_SPEC" =~ ^codey@[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ && -n "$REGISTRY" ]]; then
  :
else
  die "Use a local npm .tgz, an HTTPS .tgz URL, or a pinned codey version with an explicit private --registry."
fi
NPM_ARGS=()
if [[ -n "$REGISTRY" ]]; then
  "$NODE" - "$REGISTRY" <<'NODE'
const url = new URL(process.argv[2]);
if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    ["registry.npmjs.org", "registry.npmjs.com"].includes(url.hostname.toLowerCase().replace(/\.$/, ""))) process.exit(1);
NODE
  NPM_ARGS+=(--registry "$REGISTRY")
fi
if [[ -n "$PREFIX" ]]; then
  [[ ! -e "$PREFIX" && ! -L "$PREFIX" ]] || die "Refusing to overwrite an existing npm prefix."
  mkdir -p -- "$PREFIX"
  PREFIX="$(realpath -- "$PREFIX")"
else
  RELEASES="$HOME/.local/share/codey-machine/releases"
  mkdir -p "$RELEASES"
  PREFIX="$(mktemp -d "$RELEASES/npm-XXXXXXXX")"
fi
chmod 700 "$PREFIX"
export PATH="$NODE_DIR/bin:$PATH"
echo "Installing Codey through npm into $PREFIX"
"$NPM" install --global --prefix "$PREFIX" --omit=dev --ignore-scripts \
  --no-audit --no-fund --strict-ssl=true "${NPM_ARGS[@]}" "$PACKAGE_SPEC"
APP="$PREFIX/lib/node_modules/codey"
"$NODE" - "$APP" <<'NODE'
const fs = require("node:fs"), path = require("node:path");
const root = process.argv[2], pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
if (pkg.name !== "codey" || pkg.bin?.codey !== "bin/codey.mjs" ||
    !fs.existsSync(path.join(root, "lib/install.mjs")) ||
    !fs.existsSync(path.join(root, "npm-shrinkwrap.json"))) process.exit(1);
NODE
# Validate identity, fingerprints and public setup config before running install hooks.
"$NODE" "$APP/lib/install.mjs" --check "${SETUP_ARGS[@]}"
"$NPM" rebuild --prefix "$APP" --omit=dev --no-audit --no-fund --strict-ssl=true "${NPM_ARGS[@]}"
if [[ "$CHECK" == true ]]; then SETUP_ARGS+=(--check); fi
"$NODE" "$APP/lib/install.mjs" "${SETUP_ARGS[@]}"
