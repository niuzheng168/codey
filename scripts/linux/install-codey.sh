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
  --check          Install and validate only; do not stop processes/configure services.

No ZIP extraction is required. npm installs one Codey package; codey setup then
configures the gateway, workspace and updater. Setup retains auth/session files
but replaces service/model settings and stops the current user's old Codex processes.
Do not install the unrelated public npm package named codey.
HELP
}
die() { echo "ERROR: $*" >&2; exit 1; }
PACKAGE_SPEC=""
REGISTRY=""
PREFIX=""
NODE_DIR=""
SETUP_ARGS=()
CHECK=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --check) CHECK=true; shift ;;
    --package|--registry|--prefix|--node-dir|--config)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "Missing value for $1"
      case "$1" in
        --package) PACKAGE_SPEC="$2" ;;
        --registry) REGISTRY="$2" ;;
        --prefix) PREFIX="$2" ;;
        --node-dir) NODE_DIR="$2" ;;
        --config) SETUP_ARGS+=(--config "$(realpath -- "$2")") ;;
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
    !fs.existsSync(path.join(root, "lib/setup.mjs")) ||
    !fs.existsSync(path.join(root, "npm-shrinkwrap.json"))) process.exit(1);
NODE
# Validate identity, fingerprints and public setup config before running install hooks.
"$NODE" "$APP/bin/codey.mjs" setup --check "${SETUP_ARGS[@]}"
"$NPM" rebuild --prefix "$APP" --omit=dev --no-audit --no-fund --strict-ssl=true "${NPM_ARGS[@]}"
if [[ "$CHECK" == true ]]; then SETUP_ARGS+=(--check); fi
"$NODE" "$APP/bin/codey.mjs" setup "${SETUP_ARGS[@]}"
