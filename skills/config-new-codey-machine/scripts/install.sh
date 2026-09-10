#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

log() { printf '\n[%s/6] %s\n' "$1" "$2"; }
die() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }
stop_user_unit() { systemctl --user disable --now "$1" >/dev/null 2>&1 || true; }
stop_system_unit() { sudo -n systemctl disable --now "$1" >/dev/null 2>&1 || true; }
kill_matches() {
  local pattern="$1"
  pkill -TERM -u "$(id -u)" -f "$pattern" >/dev/null 2>&1 || true
  sleep 1
  pkill -KILL -u "$(id -u)" -f "$pattern" >/dev/null 2>&1 || true
}
CODEX_PROCESS_PATTERN='(^|/)[c]odex([.]js)?([[:space:]]|$)'
codex_processes_running() {
  pgrep -u "$(id -u)" -x codex >/dev/null 2>&1 ||
    pgrep -u "$(id -u)" -f "$CODEX_PROCESS_PATTERN" >/dev/null 2>&1
}
stop_codex_processes() {
  local owner_uid
  owner_uid="$(id -u)"
  pkill -TERM -u "$owner_uid" -x codex >/dev/null 2>&1 || true
  pkill -TERM -u "$owner_uid" -f "$CODEX_PROCESS_PATTERN" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    codex_processes_running || return 0
    sleep 0.25
  done
  pkill -KILL -u "$owner_uid" -x codex >/dev/null 2>&1 || true
  pkill -KILL -u "$owner_uid" -f "$CODEX_PROCESS_PATTERN" >/dev/null 2>&1 || true
  sleep 1
  if codex_processes_running; then
    die "Old Codex processes are still running."
  fi
  return 0
}
stop_cloudcli_processes() {
  local unit
  for unit in codey-cloudcli.service cloudcli.service; do
    stop_user_unit "$unit"
    stop_system_unit "$unit"
  done
  kill_matches '[d]ist-server/server/index.js'
  kill_matches '[/]bin/codey\.mjs workspace'
}
free_port() {
  local port="$1"
  if command -v fuser >/dev/null 2>&1; then
    sudo -n fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  fi
}
write_unit() {
  local name="$1"
  cat >"$SYSTEMD_DIR/$name"
  chmod 600 "$SYSTEMD_DIR/$name"
}

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] ||
  die "This package supports Linux x86_64 only."
[[ "$(id -u)" != 0 ]] || die "Run as the target user; the script uses sudo only where required."

for command in curl openssl sha256sum tar systemctl loginctl pgrep pkill seq timeout; do need "$command"; done
need sudo
sudo -n true || die "Administrator access is required. Run sudo -v, then rerun this script."

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$ROOT/assets"
MODELS_SOURCE="$ROOT/templates/a100-models.json"
[[ -f "$ASSETS/manifest.json" && -f "$ASSETS/setup.json" && -f "$ASSETS/SHA256SUMS" ]] ||
  die "Package metadata is incomplete."
[[ -f "$MODELS_SOURCE" ]] || die "models.json template is missing."
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
mkdir -p "$TOOLS" "$RUNTIME_ROOT/releases" "$CONFIG_ROOT" "$COPILOT_HOME" \
  "$DATA_ROOT/cloudcli" "$STATE_ROOT" "$SYSTEMD_DIR" "$CACHE_ROOT" "$HOME_DIR/.local/bin"
chmod 700 "$TOOLS" "$RUNTIME_ROOT" "$CONFIG_ROOT" "$COPILOT_HOME" \
  "$DATA_ROOT" "$DATA_ROOT/cloudcli" "$STATE_ROOT" "$SYSTEMD_DIR" "$CACHE_ROOT"

# Runtime prerequisites are downloaded from their official publishers and are
# deliberately not carried in this package.
NODE_VERSION="24.20.0"
NODE_SHA256="2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
NODE_DIR="$TOOLS/node-v${NODE_VERSION}"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  tmp="$CACHE_ROOT/$NODE_ARCHIVE.part"
  archive="$CACHE_ROOT/$NODE_ARCHIVE"
  curl --fail --location --proto '=https' --tlsv1.2 --output "$tmp" "$NODE_URL"
  echo "$NODE_SHA256  $tmp" | sha256sum -c -
  mv -f "$tmp" "$archive"
  stage="$TOOLS/.node-${NODE_VERSION}-$$"
  rm -rf "$stage"
  mkdir "$stage"
  tar -xJf "$archive" -C "$stage"
  rm -rf "$NODE_DIR"
  mv "$stage/node-v${NODE_VERSION}-linux-x64" "$NODE_DIR"
  rmdir "$stage"
fi
NODE="$NODE_DIR/bin/node"
"$NODE" --version | grep -qx "v$NODE_VERSION" || die "Official Node installation failed."

readarray -t PACKAGE < <("$NODE" - "$ASSETS/manifest.json" "$ASSETS/setup.json" "$NODE_VERSION" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const setup = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const artifact = manifest.artifacts?.[0];
const assets = path.dirname(process.argv[2]);
const sums = fs.readFileSync(path.join(assets, "SHA256SUMS"), "utf8").trim().split("\n");
if (manifest.schema !== 2 || manifest.name !== "codey" || setup.schema !== 1 ||
    manifest.platform !== "linux-x64" || setup.platform !== "linux-x64" ||
    manifest.node !== process.argv[4] ||
    !/^machine-[a-f0-9]{16}$/.test(manifest.releaseId ?? "") ||
    manifest.releaseId !== setup.releaseId ||
    manifest.dependencyMode !== "npm-codey-package" ||
    !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1 ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.codey?.version ?? "") ||
    artifact?.file !== `codey-${manifest.codey.version}.tgz` ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") ||
    !Number.isSafeInteger(artifact.size) || artifact.size <= 0 ||
    fs.statSync(path.join(assets, artifact.file)).size !== artifact.size ||
    !sums.includes(`${artifact.sha256}  ${artifact.file}`) ||
    JSON.stringify(manifest.bundledRuntimes) !== JSON.stringify(["cloudcli", "copilot-api", "updater"])) process.exit(2);
const origin = new URL(setup.portalOrigin);
if (origin.protocol !== "https:" || origin.origin !== setup.portalOrigin) process.exit(2);
console.log(manifest.releaseId);
console.log(setup.portalOrigin);
console.log(artifact.file);
NODE
)
[[ "${#PACKAGE[@]}" -eq 3 ]] || die "Invalid package metadata."
RELEASE_ID="${PACKAGE[0]}"
PORTAL_ORIGIN="${PACKAGE[1]}"
NPM_PACKAGE="${PACKAGE[2]}"
RELEASE="$RUNTIME_ROOT/releases/$RELEASE_ID"
STAGE="$RUNTIME_ROOT/releases/.${RELEASE_ID}.stage"
STAGE_PACKAGE="$STAGE/lib/node_modules/codey"
RELEASE_PACKAGE="$RELEASE/lib/node_modules/codey"

IDENTITY="$STATE_ROOT/identity.json"
if [[ ! -f "$IDENTITY" ]]; then
  NODE_ID="n-$(openssl rand -hex 12)"
  SUBJECT="m-$(openssl rand -hex 12)"
  CLIENT_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  SSO_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  TUNNEL_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  UPDATER_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  "$NODE" - "$IDENTITY" "$NODE_ID" "$SUBJECT" "$(id -un)" \
    "$CLIENT_KEY" "$SSO_KEY" "$TUNNEL_KEY" "$UPDATER_KEY" <<'NODE'
const fs = require("node:fs");
const [file, nodeId, subject, username, clientSigningKey, workspaceSsoKey,
  tunnelUpdateKey, updaterCredential] = process.argv.slice(2);
const value = {schema: 1, nodeId, workspaceSubject: subject, workspaceUsername: username,
  clientSigningKey, workspaceSsoKey, tunnelUpdateKey, updaterCredential};
fs.writeFileSync(file + ".next", JSON.stringify(value, null, 2) + "\n", {mode: 0o600, flag: "wx"});
fs.renameSync(file + ".next", file);
NODE
fi
chmod 600 "$IDENTITY"
readarray -t ID < <("$NODE" - "$IDENTITY" <<'NODE'
const d = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
for (const name of ["nodeId", "workspaceSubject", "workspaceUsername", "clientSigningKey",
  "workspaceSsoKey", "tunnelUpdateKey", "updaterCredential"]) console.log(d[name]);
NODE
)
[[ "${#ID[@]}" -eq 7 ]] || die "Invalid local machine identity."
NODE_ID="${ID[0]}"
WORKSPACE_SUBJECT="${ID[1]}"
WORKSPACE_USER="${ID[2]}"
CLIENT_KEY="${ID[3]}"
SSO_KEY="${ID[4]}"
TUNNEL_KEY="${ID[5]}"
UPDATER_KEY="${ID[6]}"

rm -rf "$STAGE"
mkdir -p "$STAGE"

# Install exactly one application through npm, with one shared dependency tree.
# Native dependencies are prepared before stopping any existing service.
PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install --global --prefix "$STAGE" \
  --omit=dev --no-audit --no-fund "$ASSETS/$NPM_PACKAGE"
for file in package.json npm-shrinkwrap.json bin/codey.mjs codey-build.json \
  dist-server/server/index.js gateway/main.js \
  updater/install.py updater/updater.py updater/engine.py updater/probe.mjs; do
  [[ -f "$STAGE_PACKAGE/$file" ]] || die "Codey npm package is incomplete: $file"
done
"$NODE" - "$STAGE_PACKAGE" "$ASSETS/manifest.json" <<'NODE'
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
stop_user_unit codey-devtunnel-renew.timer
stop_user_unit codey-devtunnel-renew.service
stop_user_unit codey-devtunnel.service
stop_system_unit codey-devtunnel.service
kill_matches '[d]evtunnel host'

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

if ! "$DEVTUNNEL" user show --json >"$STATE_ROOT/devtunnel-user.json" 2>/dev/null ||
   ! "$NODE" - "$STATE_ROOT/devtunnel-user.json" <<'NODE'
const d = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
process.exit(String(d.status).toLowerCase() === "logged in" &&
  String(d.provider).toLowerCase() === "github" ? 0 : 1);
NODE
then
  "$DEVTUNNEL" user login --github --use-device-code-auth
  "$DEVTUNNEL" user show --json >"$STATE_ROOT/devtunnel-user.json"
fi

TUNNEL_ID="codey-$NODE_ID"
if ! "$DEVTUNNEL" show "$TUNNEL_ID" --json >"$STATE_ROOT/tunnel-show.json" 2>/dev/null; then
  "$DEVTUNNEL" create "$TUNNEL_ID" --description "Codey Linux $NODE_ID" --json \
    >"$STATE_ROOT/tunnel-show.json"
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
"$DEVTUNNEL" show "$QUALIFIED_TUNNEL" --json >"$CONFIG_ROOT/tunnel.json"
"$NODE" - "$CONFIG_ROOT/tunnel.json" "$TUNNEL_ID" "$TUNNEL_CLUSTER" <<'NODE'
const fs = require("node:fs");
const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const t = d.tunnel || d;
let id = t.tunnelId, cluster = t.clusterId;
if (id && id.includes(".")) [id, cluster] = id.split(".");
const ports = t.ports || [];
const exact = [3001, 8443].every(n => ports.some(p => p.portNumber === n && p.protocol === "https"));
const all = [t, ...ports].every(x => {
  const entries = Array.isArray(x.accessControl)
    ? x.accessControl
    : (Array.isArray(x.accessControl?.entries) ? x.accessControl.entries : []);
  return !entries.some(e =>
    String(e.type).toLowerCase() === "anonymous" && e.isDeny !== true);
});
if (id !== process.argv[3] || cluster !== process.argv[4] || !exact || !all) process.exit(2);
NODE
chmod 600 "$CONFIG_ROOT/tunnel.json"

CERT="$CONFIG_ROOT/node-cert.pem"
KEY="$CONFIG_ROOT/node-key.pem"
SERVER_NAME="$NODE_ID.nodes.codey.internal"
openssl req -x509 -newkey rsa:3072 -noenc -days 365 \
  -keyout "$KEY" -out "$CERT" -subj "/CN=$SERVER_NAME" \
  -addext "subjectAltName=DNS:$SERVER_NAME" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
printf '%s\n' "$CLIENT_KEY" >"$CONFIG_ROOT/client-signing.key"
chmod 600 "$CERT" "$KEY" "$CONFIG_ROOT/client-signing.key"

log 2 "Stop old copilot-api, configure and start the Codey gateway"
# Stop the old workspace before rotating the model key. Otherwise its watchdog
# can immediately respawn a Codex app-server with the stale environment.
stop_cloudcli_processes
stop_codex_processes
for unit in codey-copilot-api.service copilot-api.service copilot-api-update.service copilot-api-update.timer; do
  stop_user_unit "$unit"
  stop_system_unit "$unit"
done
kill_matches '[c]opilot-api'
kill_matches '[/]bin/codey\.mjs gateway'
free_port 4141
free_port 8443

MODEL_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
ADMIN_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
HISTORY_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
"$NODE" - "$COPILOT_HOME/config.json" "$MODEL_KEY" "$ADMIN_KEY" "$HISTORY_KEY" <<'NODE'
const fs = require("node:fs");
const [file, apiKey, adminApiKey, sessionHistoryApiKey] = process.argv.slice(2);
const value = {
  auth: {apiKeys: [apiKey], adminApiKey, sessionHistoryApiKey}
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
WorkingDirectory=$STAGE_PACKAGE
ExecStart=$NODE $STAGE_PACKAGE/bin/codey.mjs gateway start --headless --host 127.0.0.1 --port 4141
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user start codey-copilot-api.service
if [[ ! -s "$COPILOT_HOME/github_token" ]]; then
  HOME="$HOME_DIR" COPILOT_API_HOME="$COPILOT_HOME" \
    "$NODE" "$STAGE_PACKAGE/bin/codey.mjs" auth login --provider copilot
fi
systemctl --user restart codey-copilot-api.service
for _ in $(seq 1 60); do
  if curl -fsS -H "Authorization: Bearer $MODEL_KEY" \
    http://127.0.0.1:4141/models >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS -H "Authorization: Bearer $MODEL_KEY" http://127.0.0.1:4141/models >/dev/null ||
  die "copilot-api model endpoint did not become ready."

log 3 "Stop old Codex, install the latest official Codex CLI, configure and test it"
stop_codex_processes
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
cp "$MODELS_SOURCE" "$HOME_DIR/.codex/models.json"
cat >"$HOME_DIR/.codex/config.toml" <<EOF
model = "gpt-6-astra"
model_provider = "copilot_api"
model_reasoning_effort = "max"
model_reasoning_summary = "auto"
model_context_window = 872000
model_auto_compact_token_limit = 722000
model_catalog_json = "$HOME_DIR/.codex/models.json"
personality = "pragmatic"
approvals_reviewer = "user"
sandbox_mode = "danger-full-access"
approval_policy = "never"

[model_providers.copilot_api]
name = "OpenAI"
base_url = "http://localhost:4141"
env_key = "CODEY_MODEL_API_KEY"
requires_openai_auth = false
supports_websockets = false
wire_api = "responses"
request_max_retries = 3
stream_max_retries = 1
stream_idle_timeout_ms = 300000

[features]
remote_compaction_v2 = true
EOF
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

log 4 "Stop old CloudCLI and start the Codey workspace"
stop_cloudcli_processes
free_port 3001
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
WorkingDirectory=$STAGE_PACKAGE
ExecStart=$NODE $STAGE_PACKAGE/bin/codey.mjs workspace
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
  cd "$STAGE_PACKAGE"
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

rm -rf "$RELEASE.next"
mv "$STAGE" "$RELEASE.next"
rm -rf "$RELEASE"
mv "$RELEASE.next" "$RELEASE"
sed -i "s#WorkingDirectory=$STAGE/#WorkingDirectory=$RELEASE/#; s# $STAGE/# $RELEASE/#g" \
  "$SYSTEMD_DIR/codey-copilot-api.service" "$SYSTEMD_DIR/codey-cloudcli.service"
systemctl --user daemon-reload
systemctl --user restart codey-copilot-api.service codey-cloudcli.service

cat >"$HOME_DIR/.local/bin/codey" <<EOF
#!/bin/sh
exec "$NODE" "$RELEASE_PACKAGE/bin/codey.mjs" "\$@"
EOF
chmod 700 "$HOME_DIR/.local/bin/codey"

"$NODE" - "$ASSETS/manifest.json" "$RELEASE/release.json" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
fs.writeFileSync(process.argv[3], JSON.stringify(manifest, null, 2) + "\n", {mode: 0o600});
NODE
"$NODE" - "$ASSETS/manifest.json" "$COPILOT_HOME/portal-build.json" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
fs.writeFileSync(process.argv[3], JSON.stringify({
  schema: 1, sourceCommit: manifest.copilotApi.commit, version: manifest.copilotApi.version
}, null, 2) + "\n", {mode: 0o600});
NODE

log 5 "Install the Codey updater"
stop_user_unit codey-node-updater.service
stop_system_unit codey-node-updater.service
rm -rf "$HOME_DIR/.local/share/codey-updater" "$HOME_DIR/.config/codey-updater"
PYTHON=""
for candidate in /usr/bin/python3.13 /usr/bin/python3.12 \
  "$HOME_DIR/miniconda3/bin/python" /usr/local/bin/python3 /opt/az/bin/python3 \
  "$(command -v python3 2>/dev/null || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]] &&
     timeout --kill-after=2s 10s "$candidate" \
       -c 'import sys, sqlite3, ssl; raise SystemExit(sys.version_info < (3,12))' \
       >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
[[ -n "$PYTHON" ]] || die "The updater requires Python 3.12+."
UPDATER_SOURCE="$RELEASE_PACKAGE/updater"
UPDATER_CONFIG="$CONFIG_ROOT/updater-bootstrap.json"
"$NODE" - "$ASSETS/setup.json" "$IDENTITY" "$UPDATER_CONFIG" <<'NODE'
const fs = require("node:fs");
const setup = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const id = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const value = {schema: 1, nodeId: id.nodeId, ownerId: id.workspaceSubject,
  username: id.workspaceUsername, portalOrigin: setup.portalOrigin,
  credential: id.updaterCredential, releasePublicKey: setup.updater.releasePublicKey,
  protocol: setup.updater.protocol};
fs.writeFileSync(process.argv[4], JSON.stringify(value, null, 2) + "\n", {mode: 0o600});
NODE
chmod 600 "$UPDATER_CONFIG"
"$PYTHON" -I -S "$UPDATER_SOURCE/install.py" --config "$UPDATER_CONFIG" --apply

log 6 "Create and enable all watchdog services"
RENEW_SCRIPT="$RUNTIME_ROOT/renew-devtunnel.sh"
cat >"$RENEW_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail
tmp="\$(mktemp)"
trap 'rm -f "\$tmp"' EXIT
"$DEVTUNNEL" token "$QUALIFIED_TUNNEL" --scope connect --json >"\$tmp"
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
  codey-devtunnel-renew.timer codey-node-updater.service; do
  systemctl --user enable --now "$unit"
done

TOKEN_FILE="$STATE_ROOT/connect-token.json"
"$DEVTUNNEL" token "$QUALIFIED_TUNNEL" --scope connect --json >"$TOKEN_FILE"
OUTPUT="$HOME_DIR/codey-machine-registration.json"
"$NODE" - "$ASSETS/setup.json" "$IDENTITY" "$CONFIG_ROOT/tunnel.json" \
  "$TOKEN_FILE" "$CERT" "$OUTPUT" "$(hostname)" <<'NODE'
const fs = require("node:fs");
const [setupFile, identityFile, tunnelFile, tokenFile, certFile, output, hostname] = process.argv.slice(2);
const setup = JSON.parse(fs.readFileSync(setupFile, "utf8"));
const id = JSON.parse(fs.readFileSync(identityFile, "utf8"));
const raw = JSON.parse(fs.readFileSync(tunnelFile, "utf8"));
const tunnel = raw.tunnel || raw;
let tunnelId = tunnel.tunnelId, clusterId = tunnel.clusterId;
if (tunnelId.includes(".")) [tunnelId, clusterId] = tunnelId.split(".");
const issued = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
const document = {
  schema: 2,
  package: {portalOrigin: setup.portalOrigin, releaseId: setup.releaseId, platform: setup.platform},
  machine: {
    schema: 1, nodeId: id.nodeId, name: hostname, region: "Linux · DevTunnel",
    platform: "linux-x64", tlsCertificate: fs.readFileSync(certFile, "utf8"),
    networkMode: "devtunnel", devTunnel: {tunnelId, clusterId},
  },
  credentials: {
    clientSigningKey: id.clientSigningKey, workspaceSsoKey: id.workspaceSsoKey,
    tunnelUpdateKey: id.tunnelUpdateKey, updaterCredential: id.updaterCredential,
    workspaceSubject: id.workspaceSubject, workspaceUsername: id.workspaceUsername,
  },
  devTunnelConnectToken: issued.token || issued.accessToken,
};
fs.writeFileSync(output + ".next", JSON.stringify(document, null, 2) + "\n", {mode: 0o600});
fs.renameSync(output + ".next", output);
NODE
chmod 600 "$OUTPUT"

rm -f "$TOKEN_FILE"
find "$RUNTIME_ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -name "$RELEASE_ID" -exec rm -rf -- {} +

for unit in codey-copilot-api.service codey-cloudcli.service codey-devtunnel.service \
  codey-devtunnel-renew.timer codey-node-updater.service; do
  [[ "$(systemctl --user is-enabled "$unit")" == enabled ]] || die "$unit is not enabled."
  [[ "$(systemctl --user is-active "$unit")" == active ]] || die "$unit is not active."
done
[[ "$(loginctl show-user "$(id -un)" -p Linger --value)" == yes ]] || die "User linger is not enabled."

echo
echo "Codey Linux installation completed."
echo "Registration file: $OUTPUT"
echo "Node ID: $NODE_ID"
echo "Previous Codex processes were stopped; reopen Codex from a new terminal."
