#!/usr/bin/env bash
set -euo pipefail
umask 077

node_id="${1:?node id required}"
listen_host="${2:?private IP required}"
tls_name="${3:?TLS hostname required}"
root="${HOME}/.local/share/codey-cloudcli"
deployment="${root}/deployments/password-sso-20260905"
config="${HOME}/.config/codey-cloudcli"
unit="${HOME}/.config/systemd/user/codey-cloudcli.service"
release="$(cat "${root}/staged-release")"
previous="$(readlink -f "${root}/current")"

[[ "$node_id" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]
[[ "$listen_host" =~ ^[0-9.]+$ && "$tls_name" =~ ^[a-z0-9.-]+$ ]]
for target in "$release" "$previous"; do
  [[ "$target" == "${root}/releases/"* && "$(readlink -f "$target")" == "$target" ]] || {
    echo "Unexpected release target; refusing activation" >&2
    exit 1
  }
done
[[ -L "${root}/current" && -x "${release}/.codey-bin/node" ]]
[[ -f "${release}/dist-server/server/modules/auth/portal-sso.service.js" ]]
[[ -f "${deployment}/${node_id}.env" && -f "${deployment}/codey-node-ca.pem" ]]
[[ -r "${HOME}/.config/copilot-api/codey-tls/fullchain.pem" ]]
[[ -r "${HOME}/.config/copilot-api/codey-tls/server.key.pem" ]]

copilot_pid="$(systemctl --user show copilot-api.service -p MainPID --value)"
[[ "$copilot_pid" =~ ^[1-9][0-9]*$ ]]
backup="${root}/backups/password-sso-$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
cp -p "$unit" "${backup}/codey-cloudcli.service"
printf '%s\n' "$previous" >"${backup}/previous-release"
if [[ -f "${config}/portal-sso.env" ]]; then cp -p "${config}/portal-sso.env" "${backup}/portal-sso.env"; fi

# SQLite's online backup API preserves WAL transactions without stopping the VM
# or any of the user's existing Codex/copilot processes.
python3 - "${root}/data/auth.db" "${backup}/auth.db" <<'PY'
import json, sqlite3, sys
from pathlib import Path
source = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=10)
destination = sqlite3.connect(sys.argv[2])
with destination:
    source.backup(destination, pages=256, sleep=0.05)
counts = {}
for name in ("users", "projects", "sessions"):
    if source.execute("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'", (name,)).fetchone():
        counts[name] = source.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
Path(sys.argv[2]).with_suffix(".counts.json").write_text(json.dumps(counts))
destination.close()
source.close()
PY

install -m 600 "${deployment}/${node_id}.env" "${config}/portal-sso.env"
python3 - "$unit" "$root" "$config" <<'PY'
from pathlib import Path
import sys
unit, root, config = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
text = unit.read_text()
assert 'dist-server/server/index.js' in text
lines = [line for line in text.splitlines() if 'portal-sso.env' not in line]
result = []
for line in lines:
    if line.startswith('ExecStart='):
        line = f'ExecStart={root}/current/.codey-bin/node {root}/current/dist-server/server/index.js'
    elif line.startswith('Environment=PATH=') and not line.startswith(f'Environment=PATH={root}/current/.codey-bin:'):
        line = line.replace('Environment=PATH=', f'Environment=PATH={root}/current/.codey-bin:', 1)
    result.append(line)
    if line == 'Environment=CODEY_MANAGED=true':
        result.append(f'EnvironmentFile={config}/portal-sso.env')
assert sum('portal-sso.env' in line for line in result) == 1
unit.write_text('\n'.join(result) + '\n')
PY

ln -sfn "$release" "${root}/current.next"
mv -Tf "${root}/current.next" "${root}/current"
systemctl --user daemon-reload
systemctl --user restart codey-cloudcli.service

healthy=false
for _ in $(seq 1 30); do
  if curl --noproxy '*' --silent --fail --cacert "${deployment}/codey-node-ca.pem" \
      --resolve "${tls_name}:3001:${listen_host}" "https://${tls_name}:3001/health" >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  # Restore only the independent workspace service, never copilot-api or a VM.
  cp -p "${backup}/codey-cloudcli.service" "$unit"
  ln -sfn "$previous" "${root}/current.next"
  mv -Tf "${root}/current.next" "${root}/current"
  if [[ -f "${backup}/portal-sso.env" ]]; then cp -p "${backup}/portal-sso.env" "${config}/portal-sso.env"; fi
  systemctl --user daemon-reload
  systemctl --user restart codey-cloudcli.service
  echo "SSO activation failed; previous CloudCLI service restored" >&2
  exit 1
fi
status="$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' \
  --cacert "${deployment}/codey-node-ca.pem" --resolve "${tls_name}:3001:${listen_host}" \
  "https://${tls_name}:3001/api/auth/status")"
[[ "$status" == 401 ]]
[[ "$(systemctl --user show copilot-api.service -p MainPID --value)" == "$copilot_pid" ]]
echo "${node_id}: TLS healthy, anonymous auth status 401; copilot-api PID ${copilot_pid} unchanged"
echo "Release: ${release}"
echo "Rollback backup: ${backup}"
