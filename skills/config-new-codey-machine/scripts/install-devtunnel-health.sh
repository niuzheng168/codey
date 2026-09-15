#!/usr/bin/env bash
# Add only tunnel liveness monitoring to an already configured Linux node.
# Safe to use during a Codex session: no setup, token rotation or app restart.
set -Eeuo pipefail
umask 077
die() { echo "ERROR: $*" >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$(id -u)" != 0 && $# -eq 3 ]] ||
  die "Use the Linux node owner: bash install-devtunnel-health.sh NODE DEVTUNNEL TUNNEL.CLUSTER"

NODE="$1"
DEVTUNNEL="$2"
TUNNEL="$3"
SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/linux-devtunnel-health.mjs"
for value in "$HOME" "$NODE" "$DEVTUNNEL"; do
  [[ "$value" =~ ^/[a-zA-Z0-9_./@+-]+$ ]] || die "Paths must be absolute and free of systemd metacharacters."
done
[[ "$TUNNEL" =~ ^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]\.[a-z][a-z0-9]{1,15}$ ]] ||
  die "A qualified private tunnel ID is required."
[[ -x "$NODE" && -x "$DEVTUNNEL" && -f "$SOURCE" ]] || die "Existing Node, DevTunnel and health helper are required."
[[ "$DEVTUNNEL" == "$HOME/.local/share/codey-tools/devtunnel/devtunnel" ||
   "$DEVTUNNEL" == "$HOME/.local/bin/devtunnel" ]] || die "Use the existing owner-managed DevTunnel entrypoint."
"$NODE" --check "$SOURCE"

RUNTIME="$HOME/.local/share/codey-machine"
STATE="$HOME/.local/state/codey-machine"
SYSTEMD="$HOME/.config/systemd/user"
HOST_UNIT="$SYSTEMD/codey-devtunnel.service"
[[ -f "$HOST_UNIT" && ! -L "$HOST_UNIT" && -O "$HOST_UNIT" ]] || die "An owned Codey tunnel service is required."
[[ "$(systemctl --user show codey-devtunnel.service -p FragmentPath --value)" == "$HOST_UNIT" &&
   -z "$(systemctl --user show codey-devtunnel.service -p DropInPaths --value)" ]] ||
  die "The tunnel service is overridden or not the expected user unit."
[[ "$(grep -c '^ExecStart=' "$HOST_UNIT")" == 1 ]] &&
  grep -Fqx "ExecStart=$DEVTUNNEL host $TUNNEL --host-header unchanged --origin-header unchanged" "$HOST_UNIT" ||
  die "The monitor must match the existing tunnel host; its service will not be changed."

for directory in "$RUNTIME" "$STATE" "$SYSTEMD"; do
  [[ ! -L "$directory" ]] || die "Managed health directories must not be symlinks."
  mkdir -p "$directory"
  [[ -O "$directory" ]] || die "Managed health directories must belong to this user."
  chmod 700 "$directory"
done
stage="$(mktemp -d "$RUNTIME/.devtunnel-health-XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
cp "$SOURCE" "$stage/linux-devtunnel-health.mjs"
cat >"$stage/codey-devtunnel-health.service" <<EOF
[Unit]
Description=Check Codey DevTunnel host connectivity
After=network-online.target

[Service]
Type=oneshot
Environment=HOME=$HOME
ExecStart=$NODE $RUNTIME/linux-devtunnel-health.mjs $DEVTUNNEL $TUNNEL $STATE/devtunnel-health.json
TimeoutStartSec=45s
NoNewPrivileges=true
UMask=0077
EOF
cat >"$stage/codey-devtunnel-health.timer" <<'EOF'
[Unit]
Description=Monitor Codey DevTunnel for disconnected live hosts

[Timer]
OnActiveSec=1min
OnUnitInactiveSec=1min
AccuracySec=5s
Unit=codey-devtunnel-health.service

[Install]
WantedBy=timers.target
EOF
for name in linux-devtunnel-health.mjs codey-devtunnel-health.service codey-devtunnel-health.timer; do
  target="$SYSTEMD/$name"
  [[ "$name" != linux-devtunnel-health.mjs ]] || target="$RUNTIME/$name"
  chmod 600 "$stage/$name"
  [[ ! -e "$target" || -f "$target" || -L "$target" ]] || die "An unexpected file occupies a health monitor path."
  # Atomic replacement never writes through an existing symlink. Leave identical
  # files and the failure/cooldown state alone on repeated maintenance installs.
  if [[ -L "$target" ]] || ! cmp -s "$stage/$name" "$target"; then mv -f "$stage/$name" "$target"; fi
  chmod 600 "$target"
done
systemctl --user daemon-reload
systemctl --user enable --now codey-devtunnel-health.timer
echo "Codey DevTunnel health timer installed; only the tunnel may be restarted after confirmed loss."
