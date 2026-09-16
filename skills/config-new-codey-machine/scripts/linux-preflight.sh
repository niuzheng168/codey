#!/usr/bin/env bash
# Read-only checks, also embedded in the standalone Linux npm installer.
# Never source configuration files or signal a process to identify a listener.
codey_owned_path() {
  local target="$1" cursor="$1" mode
  [[ "$target" == "$HOME/"* && "$target" != *'/../'* ]] || return 1
  while [[ "$cursor" == "$HOME/"* || "$cursor" == "$HOME" ]]; do
    [[ ! -L "$cursor" ]] || return 1
    if [[ -e "$cursor" ]]; then
      [[ -O "$cursor" ]] || return 1
      mode="$(stat -c '%a' -- "$cursor")" || return 1
      (( (8#$mode & 022) == 0 )) || return 1
    fi
    cursor="${cursor%/*}"
  done
}

codey_unit_runtime() {
  local unit="$1" role="$2" file="$HOME/.config/systemd/user/$1" line node entry rest package
  [[ -f "$file" ]] && codey_owned_path "$file" || return 1
  [[ "$(systemctl --user show "$unit" -p FragmentPath --value)" == "$file" &&
     -z "$(systemctl --user show "$unit" -p DropInPaths --value)" ]] || return 1
  [[ "$(grep -c '^ExecStart=' "$file")" == 1 ]] || return 1
  line="$(grep '^ExecStart=' "$file")"
  read -r node entry rest <<<"${line#ExecStart=}"
  [[ "$node" == /* && "$entry" == "$HOME/"*/bin/codey.mjs && -x "$node" ]] || return 1
  package="${entry%/bin/codey.mjs}"
  codey_owned_path "$entry" && [[ -f "$entry" && -f "$package/codey-build.json" ]] || return 1
  grep -Fqx "WorkingDirectory=$package" "$file" || return 1
  case "$role" in
    workspace) [[ "$rest" == workspace ]] || return 1 ;;
    gateway) [[ "$rest" == 'gateway start --headless --host 127.0.0.1 --port 4141' ]] || return 1 ;;
    *) return 1 ;;
  esac
  printf '%s\n%s\n' "$node" "$package"
}

codey_listener_owned() {
  local port="$1" pid="$2" unit role node package before after i
  local -a saved argv expected
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  if [[ "$port" == 3001 ]]; then unit=codey-cloudcli.service; role=workspace
  else unit=codey-copilot-api.service; role=gateway; fi
  before="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
  [[ "$(stat -c '%u' "/proc/$pid")" == "$(id -u)" &&
     "$(systemctl --user show "$unit" -p MainPID --value)" == "$pid" ]] || return 1
  mapfile -t saved < <(codey_unit_runtime "$unit" "$role")
  [[ "${#saved[@]}" == 2 ]] || return 1
  node="${saved[0]}" package="${saved[1]}"
  [[ "$(readlink -f "/proc/$pid/exe")" == "$(readlink -f "$node")" ]] || return 1
  mapfile -d '' -t argv <"/proc/$pid/cmdline" || return 1
  expected=("$node" "$package/bin/codey.mjs" "$role")
  [[ "$role" != gateway ]] || expected+=(start --headless --host 127.0.0.1 --port 4141)
  [[ "${#argv[@]}" == "${#expected[@]}" ]] || return 1
  for i in "${!expected[@]}"; do [[ "${argv[i]}" == "${expected[i]}" ]] || return 1; done
  after="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
  # Field 22 is the start time; do not mistake a reused PID for the snapshot.
  [[ "$(awk '{print $20}' <<<"${before##*) }")" == "$(awk '{print $20}' <<<"${after##*) }")" ]]
}

codey_check_ports() {
  local listeners line endpoint address port owners pid found
  listeners="$(ss -H -ltnp '( sport = :3001 or sport = :4141 or sport = :8443 )')" ||
    { echo 'Cannot inspect service ports; installation stopped.' >&2; return 1; }
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    read -r _ _ _ endpoint _ owners <<<"$line"
    port="${endpoint##*:}" address="${endpoint%:*}"
    [[ "$port" == 3001 || "$port" == 4141 || "$port" == 8443 ]] || return 1
    found=false
    if [[ "$address" == 127.0.0.1 || "$address" == '[::1]' || "$address" == ::1 ]]; then
      while [[ "$owners" =~ pid=([0-9]+) ]]; do
        pid="${BASH_REMATCH[1]}"
        codey_listener_owned "$port" "$pid" || break
        found=true
        owners="${owners#*pid=$pid}"
      done
    fi
    if [[ "$found" != true || "$owners" =~ pid=([0-9]+) ]]; then
      echo "Port $port is occupied by a foreign or unverified listener; installation stopped. No process was killed." >&2
      return 1
    fi
    printf '[preflight] Port %s: verified owner-managed Codey; continue.\n' "$port"
  done <<<"$listeners"
}

codey_linux_preflight() {
  local command role unit profile kernel
  local -a saved
  [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 && "$(id -u)" != 0 &&
     -z "${SUDO_USER:-}" && "$HOME" == "$(getent passwd "$(id -u)" | cut -d: -f6)" ]] ||
    { echo 'Use the original owner in a native Linux x64 terminal, not sudo.' >&2; return 1; }
  [[ "$HOME" =~ ^/[a-zA-Z0-9_./@+-]+$ ]] ||
    { echo 'Linux managed HOME must be absolute and free of systemd metacharacters.' >&2; return 1; }
  kernel="$(uname -r)"
  [[ -z "${WSL_INTEROP:-}${WSL_DISTRO_NAME:-}" && "${kernel,,}" != *microsoft* ]] ||
    { echo 'Use the native Windows installer, not Linux setup in WSL.' >&2; return 1; }
  for command in ss systemctl stat readlink getent; do
    command -v "$command" >/dev/null || { echo "Missing preflight command: $command" >&2; return 1; }
  done
  [[ ! -e "$HOME/.config/systemd/user/codey-node-updater.service" &&
     ! -e "$HOME/.config/codey-updater" && ! -e "$HOME/.local/share/codey-local-update" ]] ||
    { echo 'This node still has a retired updater. Explicit migration is required.' >&2; return 1; }
  printf '[preflight] Owner: %s (uid %s); native Linux x64; computer: %s\n' "$(id -un)" "$(id -u)" "$(hostname)"
  CODEY_EXISTING_PACKAGE="" CODEY_EXISTING_NODE=""
  for role in gateway workspace; do
    unit=codey-copilot-api.service
    [[ "$role" != workspace ]] || unit=codey-cloudcli.service
    [[ ! -e "$HOME/.config/systemd/user/$unit" && ! -L "$HOME/.config/systemd/user/$unit" ]] && continue
    mapfile -t saved < <(codey_unit_runtime "$unit" "$role")
    [[ "${#saved[@]}" == 2 ]] ||
      { echo "Unrecognized or overridden $unit; installation stopped." >&2; return 1; }
    [[ -z "$CODEY_EXISTING_PACKAGE" || ( "$CODEY_EXISTING_NODE" == "${saved[0]}" &&
       "$CODEY_EXISTING_PACKAGE" == "${saved[1]}" ) ]] || return 1
    CODEY_EXISTING_NODE="${saved[0]}" CODEY_EXISTING_PACKAGE="${saved[1]}"
  done
  codey_check_ports || return 1
  if [[ -n "$CODEY_EXISTING_PACKAGE" || -e "$HOME/.local/state/codey-machine/identity.json" ]]; then
    [[ -n "$CODEY_EXISTING_PACKAGE" && -f "$HOME/.local/state/codey-machine/identity.json" &&
       -f "$HOME/.config/systemd/user/codey-cloudcli.service" &&
       -f "$HOME/.config/systemd/user/codey-copilot-api.service" ]] ||
      { echo 'Incomplete Codey installation; review its state before retrying.' >&2; return 1; }
  fi
  for profile in "$HOME/.codex/config.toml" "$HOME/.codex/models.json" "$HOME/.local/share/copilot-api/config.json"; do
    [[ ! -e "$profile" ]] || printf '[preflight] Existing configuration: %s (confirmation required before replacement)\n' "$profile"
  done
}
