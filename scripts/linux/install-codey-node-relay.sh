#!/usr/bin/env bash
set -euo pipefail

: "${CODEY_RELAY_NODE_ID:?CODEY_RELAY_NODE_ID is required}"
: "${CODEY_RELAY_NODE_NAME:?CODEY_RELAY_NODE_NAME is required}"
: "${CODEY_RELAY_NODE_REGION:?CODEY_RELAY_NODE_REGION is required}"
: "${CODEY_RELAY_NODE_ACCENT:?CODEY_RELAY_NODE_ACCENT is required}"
: "${CODEY_RELAY_ALLOWED_ORIGIN:?CODEY_RELAY_ALLOWED_ORIGIN is required}"
: "${CODEY_RELAY_SIGNING_KEY_SOURCE:?CODEY_RELAY_SIGNING_KEY_SOURCE is required}"

source_root="${CODEY_RELAY_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
runtime_root="${HOME}/.local/share/codey-node-relay"
config_root="${HOME}/.config/codey-node-relay"
service_root="${HOME}/.config/systemd/user"
node_bin="$(command -v node)"
if test "$(readlink -f "${node_bin}")" = "/usr/bin/snap" &&
  test -x /snap/node/current/bin/node; then
  node_bin=/snap/node/current/bin/node
fi

test -f "${source_root}/node-relay/server.mjs"
test -f "${source_root}/src/client-ticket.mjs"
test -f "${source_root}/src/config.mjs"
test -f "${source_root}/src/node-session-history.mjs"
test -f "${source_root}/src/metrics.mjs"
test -f "${CODEY_RELAY_SIGNING_KEY_SOURCE}"

mkdir -p "${runtime_root}/node-relay" "${runtime_root}/src" "${config_root}" "${service_root}"
install -m 0644 "${source_root}/node-relay/server.mjs" "${runtime_root}/node-relay/server.mjs"
for file in client-ticket.mjs config.mjs node-session-history.mjs metrics.mjs; do
  install -m 0644 "${source_root}/src/${file}" "${runtime_root}/src/${file}"
done
install -m 0600 "${CODEY_RELAY_SIGNING_KEY_SOURCE}" "${config_root}/signing.key"

cat >"${config_root}/relay.env" <<EOF
CODEY_RELAY_NODE_ID="${CODEY_RELAY_NODE_ID}"
CODEY_RELAY_NODE_NAME="${CODEY_RELAY_NODE_NAME}"
CODEY_RELAY_NODE_REGION="${CODEY_RELAY_NODE_REGION}"
CODEY_RELAY_NODE_ACCENT="${CODEY_RELAY_NODE_ACCENT}"
CODEY_RELAY_ALLOWED_ORIGIN="${CODEY_RELAY_ALLOWED_ORIGIN}"
CODEY_RELAY_SIGNING_KEY_FILE="${config_root}/signing.key"
CODEY_RELAY_SESSION_ROOT="${HOME}/.codex/sessions"
CODEY_RELAY_HOST="127.0.0.1"
CODEY_RELAY_PORT="4242"
EOF
chmod 0600 "${config_root}/relay.env"

cat >"${service_root}/codey-node-relay.service" <<EOF
[Unit]
Description=Codey read-only node relay
After=network-online.target

[Service]
Type=simple
EnvironmentFile=${config_root}/relay.env
ExecStart=${node_bin} ${runtime_root}/node-relay/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now codey-node-relay.service
systemctl --user is-active --quiet codey-node-relay.service
curl -fsS --max-time 5 http://127.0.0.1:4242/healthz >/dev/null
echo "CODEY_RELAY_INSTALLED node=${CODEY_RELAY_NODE_ID} node_bin=${node_bin}"
