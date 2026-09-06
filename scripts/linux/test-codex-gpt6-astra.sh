#!/usr/bin/env bash
set -euo pipefail

expected_reply="${1:-GPT6_CONFIG_OK}"
codex_home="${CODEX_HOME:-${HOME}/.codex}"

codex_bin=""
for candidate in \
  "$(command -v codex 2>/dev/null || true)" \
  "${HOME}/.local/bin/codex" \
  "${HOME}/.npm-global/bin/codex" \
  "${HOME}"/.nvm/versions/node/*/bin/codex \
  /usr/local/bin/codex \
  /usr/bin/codex \
  /snap/bin/codex
do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    codex_bin="$candidate"
    break
  fi
done

[[ -n "$codex_bin" ]] || {
  echo "Codex CLI was not found" >&2
  exit 1
}
[[ -f "${codex_home}/config.toml" ]] || {
  echo "Missing ${codex_home}/config.toml" >&2
  exit 1
}
[[ -f "${codex_home}/models.json" ]] || {
  echo "Missing ${codex_home}/models.json" >&2
  exit 1
}

temporary_home="$(mktemp -d)"
trap 'rm -rf -- "$temporary_home"' EXIT

cp "${codex_home}/models.json" "${temporary_home}/models.json"

# A Codex binary installed under nvm needs the adjacent Node executable even
# when this script is launched by a minimal SSH environment.
export PATH="$(dirname "$codex_bin"):${PATH}"

provider_config_args=(
  --config 'model_provider="copilot_api"'
  --config 'model_providers.copilot_api.name="GitHub Copilot API"'
  --config 'model_providers.copilot_api.base_url="http://127.0.0.1:4141"'
  --config 'model_providers.copilot_api.wire_api="responses"'
  --config 'model_providers.copilot_api.requires_openai_auth=false'
)
provider_env_key="$(
  sed -nE \
    's/^[[:space:]]*env_key[[:space:]]*=[[:space:]]*"([A-Za-z_][A-Za-z0-9_]*)".*/\1/p' \
    "${codex_home}/config.toml" |
    head -n 1
)"
if [[ -n "$provider_env_key" ]]; then
  [[ -n "${!provider_env_key:-}" ]] || {
    echo "Missing environment variable: ${provider_env_key}" >&2
    exit 1
  }
  export "$provider_env_key"
  provider_config_args+=(
    --config "model_providers.copilot_api.env_key=\"${provider_env_key}\""
  )
fi

output_file="${temporary_home}/events.jsonl"
error_file="${temporary_home}/stderr.log"
prompt="Reply with exactly ${expected_reply} and nothing else."

set +e
CODEX_HOME="$temporary_home" "$codex_bin" exec \
  --ignore-user-config \
  --skip-git-repo-check \
  --sandbox read-only \
  --model gpt-6-astra \
  "${provider_config_args[@]}" \
  --config 'model_reasoning_effort="max"' \
  --config 'model_context_window=872000' \
  --config "model_catalog_json=\"${temporary_home}/models.json\"" \
  --json \
  "$prompt" \
  </dev/null >"$output_file" 2>"$error_file"
exit_code=$?
set -e

if (( exit_code != 0 )); then
  tail -n 30 "$output_file" >&2 || true
  tail -n 30 "$error_file" >&2 || true
  exit "$exit_code"
fi

python3 - "$output_file" "$temporary_home" "$expected_reply" <<'PY'
import json
import sys
import time
from pathlib import Path
from urllib.request import urlopen

output_path = Path(sys.argv[1])
codex_home = Path(sys.argv[2])
expected_reply = sys.argv[3]

events = [
    json.loads(line)
    for line in output_path.read_text(encoding="utf-8").splitlines()
    if line.strip()
]
thread_id = next(
    event["thread_id"]
    for event in events
    if event.get("type") == "thread.started"
)
messages = [
    event.get("item", {}).get("text")
    for event in events
    if event.get("type") == "item.completed"
    and event.get("item", {}).get("type") == "agent_message"
]
message = next((value for value in reversed(messages) if value), "")
if message.strip() != expected_reply:
    raise RuntimeError(f"Unexpected model reply: {message!r}")

context_window = None
for session_path in codex_home.glob("sessions/**/*.jsonl"):
    for line in session_path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = event.get("payload", {})
        if event.get("type") == "event_msg" and payload.get("type") == "task_started":
            context_window = payload.get("model_context_window")

usage = None
for _ in range(20):
    with urlopen(
        "http://127.0.0.1:4141/token-usage/events?limit=20",
        timeout=5,
    ) as response:
        payload = json.load(response)
    usage = next(
        (
            item
            for item in payload.get("items", [])
            if item.get("session_id") == thread_id
        ),
        None,
    )
    if usage is not None:
        break
    time.sleep(0.25)

if usage is None:
    raise RuntimeError(f"No token-usage event found for {thread_id}")

print(f"reply={message.strip()}")
print(f"model={usage.get('model')}")
print(f"reasoning_effort={usage.get('reasoning_effort')}")
print(f"model_context_window={context_window}")
print(f"thread_id={thread_id}")
PY
