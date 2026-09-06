#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage:
  install-codey-cloudcli.sh \
    --archive /path/to/cloudcli-source.tar.gz \
    --node-id zhn-a100 \
    --host 10.0.0.7 \
    [--port 3001] \
    [--runtime-bin /path/to/isolated-node/bin] \
    [--codex-bin /path/to/codex] \
    [--portal-sso] \
    [--stage-only] \
    [--base-path /cloudcli/zhn-a100/]

Installs the Codey CloudCLI fork as a separate systemd user service. The script
does not modify or restart copilot-api, Codex, or any VM system service.
Run from the user's initialized shell when Node/Codex or provider credentials
are configured by nvm or .bashrc. Only referenced provider keys are persisted.
EOF
}

archive=""
node_id=""
listen_host=""
port="3001"
base_path=""
runtime_bin=""
codex_override=""
portal_sso=false
stage_only=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      archive="${2:-}"
      shift 2
      ;;
    --node-id)
      node_id="${2:-}"
      shift 2
      ;;
    --host)
      listen_host="${2:-}"
      shift 2
      ;;
    --port)
      port="${2:-}"
      shift 2
      ;;
    --base-path)
      base_path="${2:-}"
      shift 2
      ;;
    --runtime-bin)
      runtime_bin="${2:-}"
      shift 2
      ;;
    --codex-bin)
      codex_override="${2:-}"
      shift 2
      ;;
    --portal-sso)
      portal_sso=true
      shift
      ;;
    --stage-only)
      stage_only=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -f "$archive" ]] || { echo "Archive does not exist: $archive" >&2; exit 2; }
[[ "$node_id" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]] || {
  echo "Invalid node id: $node_id" >&2
  exit 2
}
[[ -n "$listen_host" ]] || { echo "--host is required" >&2; exit 2; }
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || {
  echo "Invalid port: $port" >&2
  exit 2
}

if [[ -z "$base_path" ]]; then
  base_path="/cloudcli/${node_id}/"
fi
base_path="/${base_path#/}"
base_path="${base_path%/}/"

if [[ -n "$runtime_bin" ]]; then
  [[ "$runtime_bin" == /* && -x "${runtime_bin}/node" && -x "${runtime_bin}/npm" ]] || {
    echo "--runtime-bin must contain Node.js and npm at an absolute path" >&2
    exit 2
  }
  export PATH="${runtime_bin}:${PATH}"
fi

node_bin="$(command -v node || true)"
npm_bin="$(command -v npm || true)"
codex_bin="${codex_override:-$(command -v codex || true)}"
[[ -x "$node_bin" ]] || { echo "Node.js is required" >&2; exit 1; }
[[ -x "$npm_bin" ]] || { echo "npm is required" >&2; exit 1; }
[[ "$codex_bin" == /* && -x "$codex_bin" ]] || {
  echo "Codex CLI must resolve to an absolute executable path" >&2
  exit 1
}

node_major="$("$node_bin" -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 22 && node_major <= 25 )) || {
  echo "This CloudCLI lockfile supports Node.js 22-25; found $("$node_bin" --version). Use --runtime-bin for an isolated supported runtime." >&2
  exit 1
}

# Snap's /snap/bin/node launcher needs privileges blocked by NoNewPrivileges.
# Run the service with the snap's real executable while retaining the launcher
# for npm/build commands executed by this installer.
service_node_bin="$node_bin"
if [[ "$node_bin" == /snap/bin/* && -x /snap/node/current/bin/node ]]; then
  service_node_bin="/snap/node/current/bin/node"
fi

# Preserve the selected runtime and Codex installation without relying on a
# systemd login shell, changing global PATH, or assuming every host uses Snap.
service_path="$(dirname "$service_node_bin"):$(dirname "$codex_bin"):${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

install_root="${HOME}/.local/share/codey-cloudcli"
service_path="${install_root}/current/.codey-bin:${service_path}"
release_id="$(date -u +%Y%m%d-%H%M%S)"
release_dir="${install_root}/releases/${release_id}"
data_dir="${install_root}/data"
config_dir="${HOME}/.config/codey-cloudcli"
service_dir="${HOME}/.config/systemd/user"
service_file="${service_dir}/codey-cloudcli.service"
provider_env_file="${config_dir}/provider.env"

mkdir -p "$release_dir" "$data_dir" "$config_dir" "$service_dir"
tar -xzf "$archive" -C "$release_dir"
[[ -f "${release_dir}/package.json" ]] || {
  echo "Archive must contain CloudCLI package.json at its root" >&2
  exit 1
}

(
  cd "$release_dir"
  export HUSKY=0
  # This is a server deployment, not an Electron desktop package. Bound native
  # build concurrency so installation competes less with active VM workloads.
  export ELECTRON_SKIP_BINARY_DOWNLOAD=1
  export npm_config_jobs=2
  export VITE_BASE_PATH="$base_path"
  export VITE_CODEY_MANAGED=true
  export VITE_CODEY_PORTAL_SSO="$portal_sso"
  "$npm_bin" ci --no-audit --no-fund
  "$npm_bin" run test:client -- \
    src/shared/tests/deploymentPath.test.ts \
    src/modules/provider-auth/tests/ProviderLoginModal.test.ts
  "$node_bin" node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json --test \
    server/modules/providers/tests/codex-auth.test.ts \
    server/modules/providers/tests/codex-models.test.ts \
    server/modules/providers/tests/provider-models.service.test.ts \
    server/modules/system/tests/system.service.test.ts \
    server/modules/websocket/tests/shell-websocket.service.test.ts
  "$node_bin" node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json --test \
    server/modules/auth/tests/portal-sso.service.test.ts \
    server/modules/auth/tests/auth.service.test.ts \
    server/modules/websocket/tests/portal-sso-websocket.test.ts
  "$npm_bin" run test:client -- src/shared/tests/codeySso.test.ts src/modules/shell/tests/codey-sso.test.ts
  "$npm_bin" run typecheck
  "$npm_bin" run build
  "$npm_bin" prune --omit=dev --no-audit --no-fund
)

# A host may have an older /usr/bin/codex and a newer user-installed Codex.
# Explicit per-release shims avoid selecting that older CLI merely because the
# chosen Node directory must precede an nvm directory containing another Node.
mkdir -p "${release_dir}/.codey-bin"
ln -s "$service_node_bin" "${release_dir}/.codey-bin/node"
ln -s "$codex_bin" "${release_dir}/.codey-bin/codex"

if [[ "$stage_only" == true ]]; then
  printf '%s\n' "$release_dir" >"${install_root}/staged-release"
  echo "CloudCLI staged (running service unchanged): ${release_dir}"
  exit 0
fi

provider_keys=()
if [[ -f "${HOME}/.codex/config.toml" ]]; then
  mapfile -t provider_keys < <(
    sed -nE \
      's/^[[:space:]]*env_key[[:space:]]*=[[:space:]]*"([A-Za-z_][A-Za-z0-9_]*)".*/\1/p' \
      "${HOME}/.codex/config.toml" |
      sort -u
  )
fi

# Prepare credentials before activating the release. Keep existing values if
# the invoking shell lacks them; never truncate a working service's env file.
provider_env_next="${provider_env_file}.next"
if [[ -f "$provider_env_file" ]]; then
  cp -p "$provider_env_file" "$provider_env_next"
else
  : >"$provider_env_next"
fi
chmod 600 "$provider_env_next"
for provider_key in "${provider_keys[@]}"; do
  provider_value="$(printenv "$provider_key" 2>/dev/null || true)"
  if [[ -z "$provider_value" ]]; then
    provider_value="$(
      PROVIDER_KEY="$provider_key" bash -lc 'printenv "$PROVIDER_KEY" 2>/dev/null || true'
    )"
  fi
  if [[ -z "$provider_value" ]]; then
    if grep -qE "^${provider_key}=.+" "$provider_env_next"; then
      continue
    fi
    echo "Missing provider environment variable: ${provider_key}; run from the initialized user shell" >&2
    exit 1
  fi
  if [[ ! "$provider_value" =~ ^[A-Za-z0-9._:/+=@-]+$ ]]; then
    echo "Provider environment value for ${provider_key} contains unsupported characters" >&2
    exit 1
  fi
  sed -i "/^${provider_key}=/d" "$provider_env_next"
  printf '%s=%s\n' "$provider_key" "$provider_value" >>"$provider_env_next"
done

cat >"${service_file}.next" <<EOF
[Unit]
Description=Codey CloudCLI node workspace
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
Environment=HOME=${HOME}
Environment=PATH=${service_path}
Environment=NODE_ENV=production
Environment=CODEY_MANAGED=true
EnvironmentFile=-${provider_env_file}
EnvironmentFile=-${config_dir}/portal-sso.env
Environment=HOST=${listen_host}
Environment=SERVER_PORT=${port}
Environment=DATABASE_PATH=${data_dir}/auth.db
WorkingDirectory=${install_root}/current
ExecStart=${service_node_bin} ${install_root}/current/dist-server/server/index.js
Restart=on-failure
RestartSec=5s
TimeoutStopSec=20s
NoNewPrivileges=true
PrivateTmp=true
Nice=5
CPUWeight=50
MemoryHigh=4G
MemoryMax=8G
TasksMax=1024
UMask=0077

[Install]
WantedBy=default.target
EOF

# Retain a small rollback record; node databases and Codex files stay in place.
if [[ -f "$service_file" ]]; then
  cp -p "$service_file" "${service_file}.previous-${release_id}"
fi
if [[ -f "$provider_env_file" ]]; then
  cp -p "$provider_env_file" "${provider_env_file}.previous-${release_id}"
fi
readlink "${install_root}/current" >"${release_dir}/previous-release.txt" || true
mv -f "$provider_env_next" "$provider_env_file"
mv -f "${service_file}.next" "$service_file"
ln -sfn "$release_dir" "${install_root}/current.next"
mv -Tf "${install_root}/current.next" "${install_root}/current"

systemctl --user daemon-reload
systemctl --user enable codey-cloudcli.service
systemctl --user restart codey-cloudcli.service

for _ in $(seq 1 30); do
  if curl --fail --silent --show-error \
    "http://${listen_host}:${port}/health" >/dev/null; then
    echo "Codey CloudCLI is ready on ${listen_host}:${port}"
    echo "Public base path: ${base_path}"
    echo "Release: ${release_id}"
    exit 0
  fi
  sleep 2
done

systemctl --user --no-pager --full status codey-cloudcli.service || true
journalctl --user -u codey-cloudcli.service --no-pager -n 80 || true
echo "CloudCLI did not become healthy" >&2
exit 1
