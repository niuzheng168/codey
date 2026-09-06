#!/usr/bin/env bash
set -euo pipefail

PACKAGE_PATH=""
EXPECTED_SHA256="__PORTAL_PACKAGE_SHA256__"
EMBEDDED_PACKAGE_NAME="__PORTAL_PACKAGE_FILE__"
EMBEDDED_PACKAGE_BASE64="$(cat <<'PORTAL_PACKAGE'
__PORTAL_PACKAGE_BASE64__
PORTAL_PACKAGE
)"
PORT=4141
MODEL="gpt-6-astra"
FORCE=0
SKIP_LOGIN=0
SKIP_START=0

usage() {
  cat <<'EOF'
Usage: ./install-codex-workstation.sh [options]

Options:
  --package PATH      Copilot API .tgz/.tgzz package
  --sha256 SHA256     Expected package SHA-256
  --port PORT         Local proxy port (default: 4141)
  --model MODEL       Codex model (default: gpt-6-astra)
  --force             Back up and replace an existing managed configuration
  --skip-login        Skip interactive GitHub Copilot authentication
  --skip-start        Install without loading the LaunchAgent now
  -h, --help          Show this help
EOF
}

while (($#)); do
  case "$1" in
    --package)
      PACKAGE_PATH="${2:?--package requires a path}"
      shift 2
      ;;
    --sha256)
      EXPECTED_SHA256="${2:?--sha256 requires a value}"
      shift 2
      ;;
    --port)
      PORT="${2:?--port requires a value}"
      shift 2
      ;;
    --model)
      MODEL="${2:?--model requires a value}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --skip-login)
      SKIP_LOGIN=1
      shift
      ;;
    --skip-start)
      SKIP_START=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'This installer supports macOS only.\n' >&2
  exit 1
fi
if [[ "$(id -u)" -eq 0 ]]; then
  printf 'Run this installer as the signed-in macOS user, not with sudo.\n' >&2
  exit 1
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1024 || PORT > 65535)); then
  printf 'Port must be between 1024 and 65535.\n' >&2
  exit 1
fi
if [[ "$MODEL" != "gpt-6-astra" ]]; then
  printf 'The embedded catalog supports gpt-6-astra only.\n' >&2
  exit 1
fi
if [[ ! "$EXPECTED_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
  printf 'A valid expected package SHA-256 is required.\n' >&2
  exit 1
fi

ensure_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  fi
  if ((major >= 20)) && command -v npm >/dev/null 2>&1; then
    return
  fi
  if ! command -v brew >/dev/null 2>&1; then
    printf 'Node.js 20+ is required. Install it from https://nodejs.org or Homebrew.\n' >&2
    exit 1
  fi
  printf '==> Installing Node.js 22 with Homebrew\n'
  brew install node@22
  export PATH="$(brew --prefix node@22)/bin:$PATH"
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if ((major < 20)); then
    printf 'Node.js 20 or newer is required; found %s.\n' "$(node --version)" >&2
    exit 1
  fi
}

for command in shasum curl openssl base64 launchctl plutil; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 1
  fi
done
ensure_node

work_root="$(mktemp -d)"
trap 'rm -rf "$work_root"' EXIT
if [[ -z "$PACKAGE_PATH" ]]; then
  if ((${#EMBEDDED_PACKAGE_BASE64} < 100)); then
    printf 'No embedded package is present. Pass --package explicitly.\n' >&2
    exit 1
  fi
  PACKAGE_PATH="$work_root/copilot-api.tgz"
  printf '%s' "$EMBEDDED_PACKAGE_BASE64" | base64 -D > "$PACKAGE_PATH"
fi
if [[ ! -f "$PACKAGE_PATH" ]]; then
  printf 'Package not found: %s\n' "$PACKAGE_PATH" >&2
  exit 1
fi

actual_sha256="$(shasum -a 256 "$PACKAGE_PATH" | awk '{print tolower($1)}')"
expected_sha256="$(printf '%s' "$EXPECTED_SHA256" | tr '[:upper:]' '[:lower:]')"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  printf 'Package checksum mismatch.\nExpected: %s\nActual:   %s\n' \
    "$expected_sha256" "$actual_sha256" >&2
  exit 1
fi
install_package="$work_root/copilot-api.tgz"
if [[ "$PACKAGE_PATH" != "$install_package" ]]; then
  cp "$PACKAGE_PATH" "$install_package"
fi

npm_prefix="$(npm config get prefix)"
if [[ ! -d "$npm_prefix" || ! -w "$npm_prefix" ]]; then
  npm_prefix="$HOME/.local"
  mkdir -p "$npm_prefix"
  npm config set prefix "$npm_prefix"
fi
runtime_bin="$npm_prefix/bin"
node_path="$(command -v node)"
node_dir="$(dirname "$node_path")"
export PATH="$runtime_bin:$node_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

copilot_home="$HOME/.local/share/copilot-api"
codex_home="$HOME/.codex"
launch_agents="$HOME/Library/LaunchAgents"
logs_root="$HOME/Library/Logs/CodexWorkstation"
label="com.codex-workstation.copilot-api"
plist_path="$launch_agents/$label.plist"
key_path="$copilot_home/codex-api-key"
config_path="$copilot_home/config.json"
codex_config_path="$codex_home/config.toml"
models_path="$codex_home/models.json"
package_json="$(npm root --global)/@jeffreycao/copilot-api/package.json"

existing=""
for candidate in "$config_path" "$codex_config_path" "$models_path" "$plist_path"; do
  if [[ -e "$candidate" ]]; then
    existing="$existing
  $candidate"
  fi
done
if [[ -n "$existing" && "$FORCE" -eq 0 ]]; then
  printf 'Existing installation detected. Re-run with --force to back up configuration:%s\n' \
    "$existing" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
for candidate in "$config_path" "$codex_config_path" "$models_path" "$plist_path" "$key_path"; do
  if [[ -f "$candidate" ]]; then
    cp -p "$candidate" "$candidate.backup-$timestamp"
  fi
done
if [[ -f "$plist_path" ]]; then
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
fi

printf '==> Installing Copilot API and Codex CLI\n'
npm install \
  --global \
  "$install_package" \
  --registry=https://registry.npmjs.org/ \
  --no-audit \
  --no-fund

codex_installer="$work_root/install-codex.sh"
curl \
  --proto '=https' \
  --tlsv1.2 \
  --location \
  --fail \
  --silent \
  --show-error \
  https://chatgpt.com/codex/install.sh \
  --output "$codex_installer"
if [[ ! -s "$codex_installer" ]] || [[ "$(wc -c < "$codex_installer")" -lt 1000 ]]; then
  printf 'The official Codex installer download was empty or incomplete.\n' >&2
  exit 1
fi
CODEX_NON_INTERACTIVE=true sh "$codex_installer"
codex_bin="$HOME/.local/bin/codex"
if [[ ! -x "$codex_bin" ]]; then
  printf 'The official Codex installer did not create %s.\n' "$codex_bin" >&2
  exit 1
fi
codex_version="$("$codex_bin" --version | awk '{print $NF}')"
if [[ -z "$codex_version" ]]; then
  printf 'Unable to verify the installed Codex CLI version.\n' >&2
  exit 1
fi

installed_name="$(node -p 'require(process.argv[1]).name' "$package_json")"
installed_version="$(node -p 'require(process.argv[1]).version' "$package_json")"
if [[ "$installed_name" != "@jeffreycao/copilot-api" ]]; then
  printf 'Unexpected installed package: %s\n' "$installed_name" >&2
  exit 1
fi

mkdir -p "$copilot_home" "$codex_home" "$launch_agents" "$logs_root"
chmod 700 "$copilot_home" "$codex_home" "$launch_agents" "$logs_root"

gateway_api_key="$(openssl rand -hex 32)"
admin_api_key="$(openssl rand -hex 32)"
session_history_api_key="$(openssl rand -hex 32)"
printf '%s' "$gateway_api_key" > "$key_path"
chmod 600 "$key_path"

GATEWAY_API_KEY="$gateway_api_key" \
ADMIN_API_KEY="$admin_api_key" \
SESSION_HISTORY_API_KEY="$session_history_api_key" \
MODEL="$MODEL" \
node - "$config_path" <<'NODE'
const fs = require("fs");
const output = process.argv[2];
const config = {
  auth: {
    apiKeys: [process.env.GATEWAY_API_KEY],
    adminApiKey: process.env.ADMIN_API_KEY,
    sessionHistoryApiKey: process.env.SESSION_HISTORY_API_KEY,
  },
  providers: {},
  modelMappings: {},
  contextManagement: { messages: true, responses: false },
  modelReasoningEfforts: { [process.env.MODEL]: "max" },
  useMessagesApi: true,
  useResponsesApiWebSocket: true,
  useResponsesApiWebSearch: true,
};
fs.writeFileSync(output, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
NODE
chmod 600 "$config_path"

cat > "$models_path" <<'JSON'
{
  "models": [
    {
      "slug": "gpt-6-astra",
      "display_name": "GPT-6 Astra",
      "description": "GPT-6 Astra coding model with an 872K prompt context.",
      "default_reasoning_level": "max",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Light reasoning" },
        { "effort": "medium", "description": "Balanced reasoning" },
        { "effort": "high", "description": "Deep reasoning" },
        { "effort": "xhigh", "description": "Extra deep reasoning" },
        { "effort": "max", "description": "Maximum reasoning" }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "minimal_client_version": "0.98.0",
      "supported_in_api": true,
      "priority": 100,
      "additional_speed_tiers": [],
      "service_tiers": [],
      "default_service_tier": null,
      "availability_nux": null,
      "upgrade": null,
      "base_instructions": "You are Codex, a coding agent. Inspect relevant code before changing it, follow repository instructions, make focused edits, validate changes, and do not undo unrelated user changes.",
      "model_messages": null,
      "include_skills_usage_instructions": false,
      "supports_reasoning_summaries": true,
      "supports_reasoning_summary_parameter": true,
      "default_reasoning_summary": "auto",
      "support_verbosity": true,
      "default_verbosity": "low",
      "apply_patch_tool_type": "freeform",
      "web_search_tool_type": "text_and_image",
      "truncation_policy": { "mode": "tokens", "limit": 10000 },
      "supports_parallel_tool_calls": true,
      "supports_image_detail_original": true,
      "context_window": 872000,
      "max_context_window": 1000000,
      "auto_compact_token_limit": 722000,
      "comp_hash": "3000",
      "effective_context_window_percent": 100,
      "experimental_supported_tools": [],
      "input_modalities": ["text", "image"],
      "supports_search_tool": true,
      "use_responses_lite": false,
      "auto_review_model_override": null,
      "tool_mode": null,
      "multi_agent_version": null
    }
  ]
}
JSON
chmod 600 "$models_path"

cat > "$codex_config_path" <<EOF
model = "$MODEL"
model_provider = "copilot_api"
model_catalog_json = "$models_path"
model_reasoning_effort = "max"
model_reasoning_summary = "auto"
model_context_window = 872000
model_auto_compact_token_limit = 722000
personality = "pragmatic"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[model_providers.copilot_api]
name = "OpenAI"
base_url = "http://localhost:$PORT"
requires_openai_auth = false
supports_websockets = false
wire_api = "responses"
request_max_retries = 3
stream_max_retries = 1
stream_idle_timeout_ms = 300000

[model_providers.copilot_api.auth]
command = "cat"
args = ["$key_path"]

[features]
memories = true

[analytics]
enabled = false
EOF
chmod 600 "$codex_config_path"

copilot_bin="$runtime_bin/copilot-api"
if [[ ! -x "$copilot_bin" ]]; then
  printf 'Installed Copilot API executable was not found: %s\n' "$copilot_bin" >&2
  exit 1
fi
if ((SKIP_LOGIN == 0)); then
  printf '==> Starting interactive GitHub Copilot authentication\n'
  "$copilot_bin" auth login --provider copilot
fi

cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$copilot_bin</string>
    <string>start</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>$runtime_bin:$node_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$logs_root/copilot-api.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$logs_root/copilot-api.stderr.log</string>
</dict>
</plist>
EOF
chmod 600 "$plist_path"
plutil -lint "$plist_path" >/dev/null

if ((SKIP_START == 0)); then
  printf '==> Starting Copilot API LaunchAgent\n'
  domain="gui/$(id -u)"
  launchctl bootstrap "$domain" "$plist_path"
  launchctl enable "$domain/$label"
  launchctl kickstart -k "$domain/$label"
  ready=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 \
      -H "x-api-key: $gateway_api_key" \
      "http://127.0.0.1:$PORT/v1/models" >/dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  if ((ready == 0)); then
    tail -40 "$logs_root/copilot-api.stderr.log" >&2 || true
    printf 'Copilot API did not become ready.\n' >&2
    exit 1
  fi
fi

printf 'Installed Copilot API %s with model %s on port %s.\n' \
  "$installed_version" "$MODEL" "$PORT"
printf 'Installed Codex CLI %s using the official architecture-aware installer.\n' \
  "$codex_version"
printf 'LaunchAgent: %s\n' "$plist_path"
