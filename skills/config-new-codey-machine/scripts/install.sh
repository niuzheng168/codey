#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

log() { printf '\n[%s/5] %s\n' "$1" "$2"; }
die() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }
parse_devtunnel_json() {
  # The pinned CLI writes its welcome banner to stdout even with --json.
  # Keep one complete JSON object, and never echo credential-bearing parse errors.
  "$1" -e '
const fs = require("node:fs");
try {
  const output = fs.readFileSync(0, "utf8").replace(/^\uFEFF/, "");
  const start = output.search(/^\s*\{/m);
  if (start < 0) throw new Error();
  const value = JSON.parse(output.slice(start));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  process.stdout.write(JSON.stringify(value) + "\n");
} catch {
  console.error("DevTunnel did not return a valid JSON object");
  process.exitCode = 1;
}
'
}
CODEX_PROCESS_PATTERN='(^|/)[c]odex([.]js)?([[:space:]]|$)'
codex_processes_running() {
  pgrep -u "$(id -u)" -x codex >/dev/null 2>&1 ||
    pgrep -u "$(id -u)" -f "$CODEX_PROCESS_PATTERN" >/dev/null 2>&1
}
require_closed_codex() {
  ! codex_processes_running || die "Close Codex/Desktop yourself and use an external terminal; no Codex process will be killed."
}
write_unit() {
  local name="$1"
  cat >"$SYSTEMD_DIR/$name"
  chmod 600 "$SYSTEMD_DIR/$name"
}
configure_codey_path() {
  local home="$1" bin="$1/.local/bin" profile
  local profiles=("$home/.profile" "$home/.bashrc")
  # Existing Bash login profiles take precedence over .profile. Do not create
  # a new one, which would prevent the user's .profile from being loaded.
  for profile in "$home/.bash_profile" "$home/.bash_login"; do
    [[ ! -f "$profile" ]] || profiles+=("$profile")
  done
  for profile in "${profiles[@]}"; do
    touch "$profile"
    # Append once, preserving the user's settings and dotfile symlinks.
    if ! grep -Fqx '# >>> Codey PATH >>>' "$profile"; then
      cat >>"$profile" <<'EOF'

# >>> Codey PATH >>>
case ":${PATH:-}:" in
  *":$HOME/.local/bin:"*) ;;
  *) PATH="$HOME/.local/bin${PATH:+:$PATH}" ;;
esac
export PATH
# <<< Codey PATH <<<
EOF
    fi
  done
  case ":${PATH:-}:" in
    *":$bin:"*) ;;
    *) PATH="$bin${PATH:+:$PATH}" ;;
  esac
  export PATH
}
write_codey_cli() {
  local destination="$1/.local/bin/codey" shim
  shim="$(mktemp "$1/.local/bin/.codey-XXXXXX")"
  cat >"$shim" <<EOF
#!/bin/sh
exec "$2" "$3/bin/codey.mjs" "\$@"
EOF
  chmod 700 "$shim"
  # npm may already own this path as a symlink. Replace the link atomically,
  # never redirect shell text through it into the installed JavaScript entry.
  mv -f "$shim" "$destination"
  configure_codey_path "$1"
}
verify_services() {
  local unit
  for unit in codey-copilot-api.service codey-cloudcli.service codey-devtunnel.service \
    codey-devtunnel-renew.timer codey-devtunnel-health.timer; do
    [[ "$(systemctl --user is-enabled "$unit")" == enabled ]] || die "$unit is not enabled."
    [[ "$(systemctl --user is-active "$unit")" == active ]] || die "$unit is not active."
  done
  [[ "$(loginctl show-user "$(id -un)" -p Linger --value)" == yes ]] || die "User linger is not enabled."
}
export_registration() {
  local TOKEN_FILE
  TOKEN_FILE="$(mktemp "$STATE_ROOT/connect-token-XXXXXX")"
  "$DEVTUNNEL" token "$QUALIFIED_TUNNEL" --scope connect --json |
    parse_devtunnel_json "$NODE" >"$TOKEN_FILE"
  OUTPUT="$HOME_DIR/codey-machine-registration.json"
  "$NODE" --input-type=module - "$ASSETS/setup.json" "$IDENTITY" "$CONFIG_ROOT/tunnel.json" \
    "$TOKEN_FILE" "$CERT" "$OUTPUT" "$(hostname)" "$ROOT/scripts/registration.mjs" <<'NODE'
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const [setupFile, identityFile, tunnelFile, tokenFile, certFile, output, hostname, helper] = process.argv.slice(2);
const { registrationDocument, writeRegistration } = await import(pathToFileURL(helper).href);
const setup = JSON.parse(fs.readFileSync(setupFile, "utf8"));
const id = JSON.parse(fs.readFileSync(identityFile, "utf8"));
const raw = JSON.parse(fs.readFileSync(tunnelFile, "utf8"));
const tunnel = raw.tunnel || raw;
let tunnelId = tunnel.tunnelId, clusterId = tunnel.clusterId;
if (tunnelId.includes(".")) [tunnelId, clusterId] = tunnelId.split(".");
const issued = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
await writeRegistration(output, registrationDocument(setup, id, {tunnelId, clusterId},
  issued.token || issued.accessToken, fs.readFileSync(certFile, "utf8"), hostname));
NODE
  rm -f "$TOKEN_FILE"
}

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] ||
  die "This package supports Linux x86_64 only."
[[ "$(id -u)" != 0 ]] || die "Run as the target user; the script uses sudo only where required."
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# The full Skill and installed npm package use the same deployment path.
# Calling this file from a Skill delegates to npm rather than maintaining a
# second downloader, staging layout and live-directory switch.
if [[ -z "${CODEY_INSTALLED_PACKAGE:-}" ]]; then
  [[ -f "$ROOT/scripts/install-npm.sh" ]] || die "Use codey setup for an installed package, or the complete Skill's install-npm.sh."
  packages=("$ROOT"/assets/codey-*.tgz)
  [[ "${#packages[@]}" == 1 && -f "${packages[0]}" ]] || die "The complete Skill must contain exactly one Codey npm package."
  (cd "$ROOT/assets" && grep -Fqx "$(sha256sum -- "${packages[0]##*/}")" SHA256SUMS) ||
    die "The Skill's Codey npm package checksum does not match."
  exec bash "$ROOT/scripts/install-npm.sh" --package "${packages[0]}" "$@"
fi
source "$ROOT/scripts/linux-preflight.sh"
EXPECTED_COMPUTER="" REPLACE_EXISTING=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expected-computer) [[ $# -ge 2 ]] || die "Missing computer name."; EXPECTED_COMPUTER="$2"; shift 2 ;;
    --replace-existing) REPLACE_EXISTING=true; shift ;;
    *) die "Use --expected-computer NAME [--replace-existing]." ;;
  esac
done
[[ "$EXPECTED_COMPUTER" == "$(hostname)" ]] || die "--expected-computer must match this machine exactly."
codey_linux_preflight || exit 1
if [[ -z "$CODEY_EXISTING_PACKAGE" ]]; then
  require_closed_codex
  [[ -z "${CODEX_HOME:-}" || "$CODEX_HOME" == "$HOME/.codex" ]] ||
    die "Linux setup uses the original owner's .codex directory; review a custom CODEX_HOME explicitly."
  if [[ -e "$HOME/.codex/config.toml" || -e "$HOME/.codex/models.json" ||
        -e "$HOME/.local/share/copilot-api/config.json" ]]; then
    [[ "$REPLACE_EXISTING" == true ]] || die "Existing Codex/gateway configuration requires --replace-existing."
  fi
  for file in "$HOME/.config/codey-machine" "$HOME/.local/state/codey-machine"; do
    [[ ! -e "$file" || -z "$(ls -A -- "$file")" ]] ||
      die "Incomplete or unrecognized Codey configuration; review it before retrying."
  done
fi
for command in curl openssl sha256sum systemctl loginctl pgrep seq timeout; do need "$command"; done
if [[ -z "$CODEY_EXISTING_PACKAGE" ]]; then
  need sudo
  sudo -n true || die "Administrator access is required. Run sudo -v, then rerun this script."
fi

APP="$CODEY_INSTALLED_PACKAGE"
NODE="${CODEY_SETUP_NODE:-}"
ASSETS="${CODEY_SETUP_ASSETS:-}"
[[ -d "$APP" && -x "$NODE" && -d "$ASSETS" ]] || die "Run through codey setup; installed package, Node and validated metadata are required."
MODELS_SOURCE="$ROOT/templates/a100-models.json"
MODEL_CONFIG="$ROOT/templates/codex-config.toml"
[[ -f "$ASSETS/manifest.json" && -f "$ASSETS/setup.json" && -f "$ASSETS/SHA256SUMS" ]] ||
  die "Package metadata is incomplete."
[[ -f "$MODELS_SOURCE" && -f "$MODEL_CONFIG" && -f "$ROOT/scripts/registration.mjs" ]] ||
  die "Model templates or registration helper are missing."
[[ -f "$ROOT/scripts/install-devtunnel-health.sh" && -f "$ROOT/scripts/linux-devtunnel-health.mjs" ]] ||
  die "DevTunnel health monitoring helpers are missing."
(cd "$ASSETS" && sha256sum -c SHA256SUMS)

HOME_DIR="$HOME"
TOOLS="$HOME_DIR/.local/share/codey-tools"
RUNTIME_ROOT="$HOME_DIR/.local/share/codey-machine"
CONFIG_ROOT="$HOME_DIR/.config/codey-machine"
COPILOT_HOME="$HOME_DIR/.local/share/copilot-api"
DATA_ROOT="$HOME_DIR/.local/share/codey-data"
STATE_ROOT="$HOME_DIR/.local/state/codey-machine"
SYSTEMD_DIR="$HOME_DIR/.config/systemd/user"
CACHE_ROOT="$HOME_DIR/.cache/codey-machine"
IDENTITY="$STATE_ROOT/identity.json"
CERT="$CONFIG_ROOT/node-cert.pem"
KEY="$CONFIG_ROOT/node-key.pem"
for file in "$TOOLS" "$RUNTIME_ROOT" "$CONFIG_ROOT" "$COPILOT_HOME" "$DATA_ROOT" \
  "$STATE_ROOT" "$SYSTEMD_DIR" "$CACHE_ROOT" "$HOME_DIR/.codex"; do
  codey_owned_path "$file" || die "Unowned, linked or writable-by-others installation path."
done
if [[ -z "$CODEY_EXISTING_PACKAGE" ]]; then
  mkdir -p "$TOOLS" "$RUNTIME_ROOT" "$CONFIG_ROOT" "$COPILOT_HOME" \
    "$DATA_ROOT/cloudcli" "$STATE_ROOT" "$SYSTEMD_DIR" "$CACHE_ROOT" "$HOME_DIR/.local/bin"
  chmod 700 "$TOOLS" "$RUNTIME_ROOT" "$CONFIG_ROOT" "$COPILOT_HOME" \
    "$DATA_ROOT" "$DATA_ROOT/cloudcli" "$STATE_ROOT" "$SYSTEMD_DIR" "$CACHE_ROOT"
fi

# Node/npm and the application have already been prepared by the public entry.
PORTAL_ORIGIN="$("$NODE" - "$ASSETS/manifest.json" "$ASSETS/setup.json" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const setup = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (manifest.schema !== 2 || manifest.name !== "codey" || setup.schema !== 1 ||
    manifest.platform !== "linux-x64" || setup.platform !== "linux-x64" ||
    manifest.node !== process.versions.node ||
    !/^machine-[a-f0-9]{16}$/.test(manifest.releaseId ?? "") ||
    manifest.releaseId !== setup.releaseId ||
    manifest.dependencyMode !== "npm-installed" || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 0 ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.codey?.version ?? "") ||
    JSON.stringify(manifest.bundledRuntimes) !== JSON.stringify(["cloudcli", "copilot-api"])) process.exit(2);
const origin = new URL(setup.portalOrigin);
if (origin.protocol !== "https:" || origin.origin !== setup.portalOrigin) process.exit(2);
console.log(setup.portalOrigin);
NODE
)" || die "Invalid package metadata."
if [[ -n "$CODEY_EXISTING_PACKAGE" ]]; then
  # Repeat acceptance, not an overwrite/update path. Keep the active package,
  # node ID, certificate, keys, model config and all sessions untouched.
  for file in "$IDENTITY" "$CERT" "$KEY" "$CONFIG_ROOT/tunnel.json" \
    "$COPILOT_HOME/config.json" "$CONFIG_ROOT/copilot.env" "$CONFIG_ROOT/cloudcli.env"; do
    [[ -f "$file" ]] && codey_owned_path "$file" || die "Existing node state is incomplete or unowned."
  done
  readarray -t EXISTING < <("$NODE" --input-type=module - "$ROOT/scripts/windows-runtime.mjs" \
    "$ASSETS/manifest.json" "$CODEY_EXISTING_PACKAGE" "$CONFIG_ROOT" "$IDENTITY" "$COPILOT_HOME/config.json" "$PORTAL_ORIGIN" <<'NODE'
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
try {
  const [helper, manifestFile, root, configRoot, identityFile, providerFile, origin] = process.argv.slice(2);
  const { verifyLocal, validateTunnel } = await import(pathToFileURL(helper).href);
  const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
  const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const manifest = read(manifestFile), build = read(path.join(root, "codey-build.json")), identity = read(identityFile);
  if (hash(path.join(root, "codey-build.json")) !== manifest.codey.entrySha256 ||
      hash(path.join(root, "npm-shrinkwrap.json")) !== manifest.codey.lockSha256 ||
      hash(path.join(root, "gateway/main.js")) !== build.gatewayEntrySha256 ||
      hash(path.join(root, "dist-server/server/index.js")) !== build.workspaceEntrySha256) throw new Error();
  const environment = fs.readFileSync(path.join(configRoot, "copilot.env"), "utf8").split("\n");
  if (!environment.includes("COPILOT_API_CODEY_ALLOWED_ORIGIN=" + origin) ||
      !environment.includes("COPILOT_API_CODEY_NODE_ID=" + identity.nodeId)) throw new Error();
  const certificate = path.join(configRoot, "node-cert.pem");
  const leaf = new X509Certificate(fs.readFileSync(certificate));
  const der = key => key.export({ type: "spki", format: "der" });
  if (leaf.ca || Date.parse(leaf.validTo) <= Date.now() + 86400000 ||
      !der(leaf.publicKey).equals(der(createPublicKey(fs.readFileSync(path.join(configRoot, "node-key.pem")))))) throw new Error();
  const coordinates = validateTunnel(read(path.join(configRoot, "tunnel.json")), "codey-" + identity.nodeId);
  await verifyLocal({ modelKey: read(providerFile).auth.apiKeys[0], identityFile,
    certificate, serverName: identity.nodeId + ".nodes.codey.internal" });
  console.log(identity.nodeId);
  console.log(coordinates.tunnelId + "." + coordinates.clusterId);
} catch {
  console.error("Existing node differs from this release/configuration or failed TLS/auth checks; no reinstall or certificate rotation was attempted.");
  process.exitCode = 1;
}
NODE
  )
  [[ "${#EXISTING[@]}" == 2 ]] || die "Existing Codey node requires review, not an automatic upgrade."
  NODE_ID="${EXISTING[0]}" QUALIFIED_TUNNEL="${EXISTING[1]}"
  DEVTUNNEL="$TOOLS/devtunnel/devtunnel"
  codey_owned_path "$DEVTUNNEL" && [[ -x "$DEVTUNNEL" ]] || die "Missing owned DevTunnel."
  codey_check_ports || exit 1
  verify_services
  export_registration
  echo "Codey already installed and verified; no reinstall, service restart or key rotation."
  echo "Registration file: $OUTPUT"
  exit 0
fi
if [[ ! -f "$IDENTITY" ]]; then
  NODE_ID="n-$(openssl rand -hex 12)"
  SUBJECT="m-$(openssl rand -hex 12)"
  CLIENT_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  SSO_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  TUNNEL_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  "$NODE" - "$IDENTITY" "$NODE_ID" "$SUBJECT" "$(id -un)" \
    "$CLIENT_KEY" "$SSO_KEY" "$TUNNEL_KEY" <<'NODE'
const fs = require("node:fs");
const [file, nodeId, subject, username, clientSigningKey, workspaceSsoKey,
  tunnelUpdateKey] = process.argv.slice(2);
const value = {schema: 1, nodeId, workspaceSubject: subject, workspaceUsername: username,
  clientSigningKey, workspaceSsoKey, tunnelUpdateKey};
fs.writeFileSync(file + ".next", JSON.stringify(value, null, 2) + "\n", {mode: 0o600, flag: "wx"});
fs.renameSync(file + ".next", file);
NODE
fi
chmod 600 "$IDENTITY"
readarray -t ID < <("$NODE" - "$IDENTITY" <<'NODE'
const d = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
for (const name of ["nodeId", "workspaceSubject", "workspaceUsername", "clientSigningKey",
  "workspaceSsoKey", "tunnelUpdateKey"]) console.log(d[name]);
NODE
)
[[ "${#ID[@]}" -eq 6 ]] || die "Invalid local machine identity."
NODE_ID="${ID[0]}"
WORKSPACE_SUBJECT="${ID[1]}"
WORKSPACE_USER="${ID[2]}"
CLIENT_KEY="${ID[3]}"
SSO_KEY="${ID[4]}"
TUNNEL_KEY="${ID[5]}"

# Check native dependencies before configuring any service; do not reinstall.
for file in package.json npm-shrinkwrap.json bin/codey.mjs codey-build.json \
  dist-server/server/index.js gateway/main.js; do
  [[ -f "$APP/$file" ]] || die "Codey npm package is incomplete: $file"
done
"$NODE" - "$APP" "$ASSETS/manifest.json" <<'NODE'
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const root = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
const manifest = JSON.parse(fs.readFileSync(process.argv[3]));
const hash = name => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex");
if (pkg.name !== "codey" || pkg.version !== manifest.codey.version ||
    hash("codey-build.json") !== manifest.codey.entrySha256 ||
    hash("npm-shrinkwrap.json") !== manifest.codey.lockSha256) process.exit(2);
for (const name of ["@cloudcli-ai/cloudcli", "@jeffreycao/copilot-api", "@openai/codex"]) {
  if (pkg.dependencies?.[name] || fs.existsSync(path.join(root, "node_modules", name))) process.exit(2);
}
const requireFromPackage = require("node:module").createRequire(path.join(root, "package.json"));
requireFromPackage("better-sqlite3")(":memory:").close();
const pty = requireFromPackage("node-pty").spawn("/bin/sh", ["-c", "exit 0"], {env: process.env});
pty.onExit(event => process.exit(event.exitCode));
setTimeout(() => process.exit(1), 5000).unref();
NODE

log 1 "Install and configure private GitHub DevTunnel"
codey_check_ports || exit 1

DEVTUNNEL_URL="https://tunnelsassetsprod.blob.core.windows.net/cli/linux-x64-devtunnel"
DEVTUNNEL_SHA256="ff6911548907b5abaea4ed5baa36b2420be7c5debcb637a4f50f7a4002b10b60"
DEVTUNNEL_DIR="$TOOLS/devtunnel"
DEVTUNNEL="$DEVTUNNEL_DIR/devtunnel"
mkdir -p "$DEVTUNNEL_DIR"
if [[ ! -x "$DEVTUNNEL" ]] ||
    [[ "$(sha256sum "$DEVTUNNEL" | awk '{print $1}')" != "$DEVTUNNEL_SHA256" ]]; then
  tmp="$DEVTUNNEL.next"
  curl --fail --location --proto '=https' --tlsv1.2 --output "$tmp" "$DEVTUNNEL_URL"
  echo "$DEVTUNNEL_SHA256  $tmp" | sha256sum -c -
  chmod 700 "$tmp"
  mv -f "$tmp" "$DEVTUNNEL"
fi

if ! "$DEVTUNNEL" user show --json 2>/dev/null |
   parse_devtunnel_json "$NODE" >"$STATE_ROOT/devtunnel-user.json" ||
   ! "$NODE" - "$STATE_ROOT/devtunnel-user.json" <<'NODE'
const d = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
process.exit(String(d.status).toLowerCase() === "logged in" &&
  String(d.provider).toLowerCase() === "github" ? 0 : 1);
NODE
then
  "$DEVTUNNEL" user login --github --use-device-code-auth
  "$DEVTUNNEL" user show --json |
    parse_devtunnel_json "$NODE" >"$STATE_ROOT/devtunnel-user.json"
fi

TUNNEL_ID="codey-$NODE_ID"
if ! "$DEVTUNNEL" show "$TUNNEL_ID" --json 2>/dev/null |
   parse_devtunnel_json "$NODE" >"$STATE_ROOT/tunnel-show.json"; then
  "$DEVTUNNEL" create "$TUNNEL_ID" --description "Codey Linux $NODE_ID" --json \
    | parse_devtunnel_json "$NODE" >"$STATE_ROOT/tunnel-show.json"
fi
readarray -t TUNNEL < <("$NODE" - "$STATE_ROOT/tunnel-show.json" "$TUNNEL_ID" <<'NODE'
const fs = require("node:fs");
const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = process.argv[3];
const t = d.tunnel || d;
let id = t.tunnelId, cluster = t.clusterId;
if (id && id.includes(".")) [id, cluster] = id.split(".");
if (id !== expected || !/^[a-z][a-z0-9]{1,15}$/.test(cluster || "")) process.exit(2);
console.log(id);
console.log(cluster);
NODE
)
[[ "${#TUNNEL[@]}" -eq 2 ]] || die "DevTunnel coordinates are invalid."
TUNNEL_ID="${TUNNEL[0]}"
TUNNEL_CLUSTER="${TUNNEL[1]}"
QUALIFIED_TUNNEL="$TUNNEL_ID.$TUNNEL_CLUSTER"

for port in 3001 8443; do
  if ! "$NODE" - "$STATE_ROOT/tunnel-show.json" "$port" <<'NODE'
const fs = require("node:fs");
const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const t = d.tunnel || d;
const port = Number(process.argv[3]);
process.exit((t.ports || []).some(p => p.portNumber === port && p.protocol === "https") ? 0 : 1);
NODE
  then
    "$DEVTUNNEL" port create "$QUALIFIED_TUNNEL" --port-number "$port" --protocol https --json >/dev/null
  fi
done
"$DEVTUNNEL" show "$QUALIFIED_TUNNEL" --json |
  parse_devtunnel_json "$NODE" >"$CONFIG_ROOT/tunnel.json"
"$NODE" "$ROOT/scripts/windows-runtime.mjs" check-tunnel "$CONFIG_ROOT/tunnel.json" "$TUNNEL_ID" "$TUNNEL_CLUSTER" >/dev/null
chmod 600 "$CONFIG_ROOT/tunnel.json"

SERVER_NAME="$NODE_ID.nodes.codey.internal"
openssl req -x509 -newkey rsa:3072 -noenc -days 365 \
  -keyout "$KEY" -out "$CERT" -subj "/CN=$SERVER_NAME" \
  -addext "subjectAltName=DNS:$SERVER_NAME" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
printf '%s\n' "$CLIENT_KEY" >"$CONFIG_ROOT/client-signing.key"
chmod 600 "$CERT" "$KEY" "$CONFIG_ROOT/client-signing.key"

log 2 "Configure and start the new Codey gateway"
codey_check_ports || exit 1
require_closed_codex

MODEL_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
ADMIN_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
HISTORY_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
if [[ -e "$COPILOT_HOME/config.json" ]]; then
  [[ "$REPLACE_EXISTING" == true ]] || die "Gateway configuration appeared during installation; review --replace-existing."
  codey_owned_path "$COPILOT_HOME/config.json" || die "Refusing to replace unowned or linked gateway configuration."
  cp -p -- "$COPILOT_HOME/config.json" "$(mktemp "$COPILOT_HOME/config.json.XXXXXX.bak")"
fi
"$NODE" - "$COPILOT_HOME/config.json" "$MODEL_KEY" "$ADMIN_KEY" "$HISTORY_KEY" <<'NODE'
const fs = require("node:fs");
const [file, apiKey, adminApiKey, sessionHistoryApiKey] = process.argv.slice(2);
const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const value = {
  ...previous, auth: {...previous.auth, apiKeys: [apiKey], adminApiKey, sessionHistoryApiKey}
};
fs.writeFileSync(file + ".next", JSON.stringify(value, null, 2) + "\n", {mode: 0o600});
fs.renameSync(file + ".next", file);
NODE
chmod 600 "$COPILOT_HOME/config.json"
printf 'CODEY_MODEL_API_KEY=%s\n' "$MODEL_KEY" >"$CONFIG_ROOT/provider.env"
cat >"$CONFIG_ROOT/copilot.env" <<EOF
COPILOT_API_HOME=$COPILOT_HOME
COPILOT_API_CODEY_HTTPS_PORT=8443
COPILOT_API_CODEY_HTTPS_HOST=127.0.0.1
COPILOT_API_CODEY_TLS_CERT=$CERT
COPILOT_API_CODEY_TLS_KEY=$KEY
COPILOT_API_CODEY_NODE_ID=$NODE_ID
COPILOT_API_CODEY_ALLOWED_ORIGIN=$PORTAL_ORIGIN
COPILOT_API_CODEY_SIGNING_KEY_FILE=$CONFIG_ROOT/client-signing.key
EOF
chmod 600 "$CONFIG_ROOT/provider.env" "$CONFIG_ROOT/copilot.env"

write_unit codey-copilot-api.service <<EOF
[Unit]
Description=Codey copilot-api
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
Environment=HOME=$HOME_DIR
Environment=NODE_ENV=production
Environment=NODE_USE_SYSTEM_CA=1
EnvironmentFile=$CONFIG_ROOT/copilot.env
WorkingDirectory=$APP
ExecStart=$NODE $APP/bin/codey.mjs gateway start --headless --host 127.0.0.1 --port 4141
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
EOF
if [[ ! -s "$COPILOT_HOME/github_token" ]]; then
  HOME="$HOME_DIR" COPILOT_API_HOME="$COPILOT_HOME" \
    "$NODE" "$APP/bin/codey.mjs" auth login --provider copilot
fi
codey_check_ports || exit 1
systemctl --user daemon-reload
systemctl --user start codey-copilot-api.service
for _ in $(seq 1 60); do
  if curl -fsS -H "Authorization: Bearer $MODEL_KEY" \
    http://127.0.0.1:4141/models >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS -H "Authorization: Bearer $MODEL_KEY" http://127.0.0.1:4141/models >/dev/null ||
  die "copilot-api model endpoint did not become ready."

log 3 "Install official Codex CLI, configure and test it"
require_closed_codex
existing_codex="$(command -v codex 2>/dev/null || true)"
if [[ -n "$existing_codex" ]]; then
  CODEX_BIN_DIR="$(dirname "$existing_codex")"
else
  CODEX_BIN_DIR="$HOME_DIR/.local/bin"
fi
mkdir -p "$CODEX_BIN_DIR"
codex_installer="$CACHE_ROOT/codex-install.sh"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$codex_installer.next" https://chatgpt.com/codex/install.sh
grep -q 'RELEASES_BASE_URL="https://releases.openai.com/codex"' "$codex_installer.next" ||
  die "Unexpected official Codex installer."
mv -f "$codex_installer.next" "$codex_installer"
chmod 700 "$codex_installer"
if [[ -w "$CODEX_BIN_DIR" ]]; then
  HOME="$HOME_DIR" CODEX_INSTALL_DIR="$CODEX_BIN_DIR" CODEX_NON_INTERACTIVE=true \
    /bin/sh "$codex_installer"
else
  sudo -n env HOME="$HOME_DIR" CODEX_INSTALL_DIR="$CODEX_BIN_DIR" CODEX_NON_INTERACTIVE=true \
    /bin/sh "$codex_installer"
fi
CODEX="$CODEX_BIN_DIR/codex"
[[ -x "$CODEX" ]] || die "Official Codex CLI was not installed at $CODEX."
"$CODEX" --version

mkdir -p "$HOME_DIR/.codex"
for file in "$HOME_DIR/.codex/config.toml" "$HOME_DIR/.codex/models.json"; do
  if [[ -e "$file" ]]; then
    [[ "$REPLACE_EXISTING" == true ]] || die "Codex configuration appeared during installation; rerun with reviewed --replace-existing."
    codey_owned_path "$file" || die "Refusing to replace unowned or linked Codex configuration."
    cp -p -- "$file" "$(mktemp "$file.XXXXXX.bak")"
  fi
done
cp "$MODELS_SOURCE" "$HOME_DIR/.codex/models.json"
"$NODE" - "$MODEL_CONFIG" "$HOME_DIR/.codex/models.json" "$HOME_DIR/.codex/config.toml" <<'NODE'
const fs = require("node:fs");
const [template, models, output] = process.argv.slice(2);
fs.writeFileSync(output, fs.readFileSync(template, "utf8")
  .replace("__CODEY_MODEL_CATALOG__", () => JSON.stringify(models)), {mode: 0o600});
NODE
chmod 600 "$HOME_DIR/.codex/config.toml" "$HOME_DIR/.codex/models.json"
for profile in "$HOME_DIR/.profile" "$HOME_DIR/.bashrc"; do
  touch "$profile"
  sed -i '/# >>> Codey model API >>>/,/# <<< Codey model API <<</d' "$profile"
  cat >>"$profile" <<EOF

# >>> Codey model API >>>
if [ -r "$CONFIG_ROOT/provider.env" ]; then
  . "$CONFIG_ROOT/provider.env"
  export CODEY_MODEL_API_KEY
fi
# <<< Codey model API <<<
EOF
done

CODEX_LOG="$CONFIG_ROOT/codex-test.log"
if ! HOME="$HOME_DIR" CODEX_HOME="$HOME_DIR/.codex" CODEY_MODEL_API_KEY="$MODEL_KEY" \
  timeout --kill-after=5s 300s "$CODEX" exec --skip-git-repo-check \
    "Reply with only CODEY_CODEX_OK" </dev/null >"$CODEX_LOG" 2>&1 ||
  ! grep -q CODEY_CODEX_OK "$CODEX_LOG"; then
  die "Codex model test failed; see $CODEX_LOG"
fi

log 4 "Start the new Codey workspace"
codey_check_ports || exit 1
cat >"$CONFIG_ROOT/cloudcli.env" <<EOF
CODEY_MANAGED=true
CODEY_PORTAL_SSO=true
SERVER_PORT=3001
HOST=127.0.0.1
DATABASE_PATH=$DATA_ROOT/cloudcli/auth.db
CODEY_PORTAL_NODE_ID=$NODE_ID
CODEY_PORTAL_USERNAME=$WORKSPACE_USER
CODEY_PORTAL_PRINCIPAL_ID=$WORKSPACE_SUBJECT
CODEY_PORTAL_SSO_KEY=$SSO_KEY
CODEY_PORTAL_TLS_CERT=$CERT
CODEY_PORTAL_TLS_KEY=$KEY
CODEY_CODEX_EXECUTABLE=$CODEX
CODEX_HOME=$HOME_DIR/.codex
EOF
chmod 600 "$CONFIG_ROOT/cloudcli.env"

write_unit codey-cloudcli.service <<EOF
[Unit]
Description=Codey CloudCLI Workspace
After=network-online.target codey-copilot-api.service
Wants=network-online.target
Requires=codey-copilot-api.service
StartLimitIntervalSec=0

[Service]
Type=simple
Environment=HOME=$HOME_DIR
Environment=NODE_ENV=production
EnvironmentFile=$CONFIG_ROOT/provider.env
EnvironmentFile=$CONFIG_ROOT/cloudcli.env
WorkingDirectory=$APP
ExecStart=$NODE $APP/bin/codey.mjs workspace
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user start codey-cloudcli.service
for _ in $(seq 1 60); do
  status="$(curl -ksS --resolve "$SERVER_NAME:3001:127.0.0.1" \
    -o /dev/null -w '%{http_code}' "https://$SERVER_NAME:3001/api/auth/status" 2>/dev/null || true)"
  [[ "$status" == 401 ]] && break
  sleep 1
done
[[ "$status" == 401 ]] || die "CloudCLI did not start or anonymous access was not rejected."

CLOUDCLI_TEST_LOG="$CONFIG_ROOT/cloudcli-codex-test.log"
if ! (
  cd "$APP"
  HOME="$HOME_DIR" CODEX_HOME="$HOME_DIR/.codex" CODEY_MODEL_API_KEY="$MODEL_KEY" \
    CODEY_CODEX_EXECUTABLE="$CODEX" "$NODE" --input-type=module <<'NODE'
import { Codex } from "#codey/codex-sdk";
const codex = new Codex({codexPathOverride: process.env.CODEY_CODEX_EXECUTABLE});
const thread = codex.startThread({
  workingDirectory: process.env.HOME,
  skipGitRepoCheck: true,
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  model: "gpt-6-astra",
  modelReasoningEffort: "max",
});
const result = await thread.run("Reply with only CODEY_CLOUDCLI_OK");
if (!result.finalResponse.includes("CODEY_CLOUDCLI_OK")) process.exit(2);
console.log(result.finalResponse);
NODE
) >"$CLOUDCLI_TEST_LOG" 2>&1; then
  die "CloudCLI Codex runtime test failed; see $CLOUDCLI_TEST_LOG"
fi

write_codey_cli "$HOME_DIR" "$NODE" "$APP"
"$NODE" - "$ASSETS/manifest.json" "$COPILOT_HOME/portal-build.json" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
fs.writeFileSync(process.argv[3], JSON.stringify({
  schema: 1, sourceCommit: manifest.copilotApi.commit, version: manifest.copilotApi.version
}, null, 2) + "\n", {mode: 0o600});
NODE

log 5 "Create and enable application and tunnel watchdogs"
RENEW_SCRIPT="$RUNTIME_ROOT/renew-devtunnel.sh"
cat >"$RENEW_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail
$(declare -f parse_devtunnel_json)
tmp="\$(mktemp)"
trap 'rm -f "\$tmp"' EXIT
"$DEVTUNNEL" token "$QUALIFIED_TUNNEL" --scope connect --json |
  parse_devtunnel_json "$NODE" >"\$tmp"
"$NODE" - "$IDENTITY" "$CONFIG_ROOT/tunnel.json" "\$tmp" "$PORTAL_ORIGIN" <<'NODE'
const fs = require("node:fs"), crypto = require("node:crypto"), https = require("node:https");
const [identityFile, tunnelFile, tokenFile, origin] = process.argv.slice(2);
const id = JSON.parse(fs.readFileSync(identityFile, "utf8"));
const tunnelRaw = JSON.parse(fs.readFileSync(tunnelFile, "utf8"));
const tunnel = tunnelRaw.tunnel || tunnelRaw;
let tunnelId = tunnel.tunnelId, clusterId = tunnel.clusterId;
if (tunnelId.includes(".")) [tunnelId, clusterId] = tunnelId.split(".");
const issued = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
const connectToken = issued.token || issued.accessToken;
const body = JSON.stringify({tunnelId, clusterId, connectToken});
const pathname = \`/api/machine-tunnels/\${id.nodeId}/token\`;
const now = Date.now();
const nonce = crypto.randomBytes(16).toString("base64url");
const message = \`POST\\n\${pathname}\\n\${now}\\n\${nonce}\\n\${crypto.createHash("sha256").update(body).digest("hex")}\`;
const signature = crypto.createHmac("sha256", Buffer.from(id.tunnelUpdateKey, "base64url"))
  .update(message).digest("base64url");
const request = https.request(origin + pathname, {method: "POST", headers: {
  "content-type": "application/json",
  "content-length": Buffer.byteLength(body),
  authorization: \`CodeyTunnel \${now}:\${nonce}:\${signature}\`,
}}, response => {
  response.resume();
  response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
});
request.on("error", () => process.exit(1));
request.end(body);
NODE
EOF
chmod 700 "$RENEW_SCRIPT"

write_unit codey-devtunnel.service <<EOF
[Unit]
Description=Codey private DevTunnel
After=network-online.target codey-cloudcli.service codey-copilot-api.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
Environment=HOME=$HOME_DIR
ExecStart=$DEVTUNNEL host $QUALIFIED_TUNNEL --host-header unchanged --origin-header unchanged
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
EOF

write_unit codey-devtunnel-renew.service <<EOF
[Unit]
Description=Renew Codey DevTunnel connect token
After=network-online.target

[Service]
Type=oneshot
Environment=HOME=$HOME_DIR
ExecStart=$RENEW_SCRIPT
UMask=0077
EOF

cat >"$SYSTEMD_DIR/codey-devtunnel-renew.timer" <<EOF
[Unit]
Description=Schedule Codey DevTunnel token renewal

[Timer]
OnActiveSec=30m
OnUnitActiveSec=6h
Persistent=true
Unit=codey-devtunnel-renew.service

[Install]
WantedBy=timers.target
EOF
chmod 600 "$SYSTEMD_DIR/codey-devtunnel-renew.timer"

sudo -n loginctl enable-linger "$(id -un)"
systemctl --user daemon-reload
for unit in codey-copilot-api.service codey-cloudcli.service codey-devtunnel.service \
  codey-devtunnel-renew.timer; do
  systemctl --user enable --now "$unit"
done

bash "$ROOT/scripts/install-devtunnel-health.sh" "$NODE" "$DEVTUNNEL" "$QUALIFIED_TUNNEL"

codey_check_ports || exit 1
verify_services
export_registration

echo
echo "Codey Linux installation completed."
echo "Registration file: $OUTPUT"
echo "Node ID: $NODE_ID"
echo 'Codey PATH is configured for new Bash terminals. For the current terminal, run:'
echo '  export PATH="$HOME/.local/bin:$PATH"'
echo "Existing Codex processes were not killed; open Codex from a new terminal."
