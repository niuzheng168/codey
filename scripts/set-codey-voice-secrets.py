"""Read the requested .env and set ONLY Codey voice secrets, without secret-bearing OS argv/logs."""
import argparse
import contextlib
import hashlib
import io
import json
import logging
import pathlib
import re
from urllib.parse import urlsplit

workspace = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("env_file", nargs="?", type=pathlib.Path, default=workspace / ".env")
parser.add_argument("bindings_file", nargs="?", type=pathlib.Path)
parser.add_argument("--mai-model", choices=["MAI-Transcribe-1", "MAI-Transcribe-1.5", "MAI-Transcribe-2"])
parser.add_argument("--rewrite-deployment", help="Explicit existing Foundry deployment; no model or resource is created.")
parser.add_argument("--secret-suffix", default="", help="Version the new secrets so an old revision keeps its original key.")
parser.add_argument("--expect-env-sha256", help="Refuse a .env changed since the successful transcription probe.")
parser.add_argument("--dry-run", action="store_true", help="Validate and show only names/SecretRef bindings; do not call Azure.")
args = parser.parse_args()
env_file, bindings_file = args.env_file, args.bindings_file
if args.secret_suffix and not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?", args.secret_suffix):
    raise SystemExit("Invalid secret suffix; no secret changes made")
raw_env = env_file.read_bytes()
env_sha = hashlib.sha256(raw_env).hexdigest()
if args.expect_env_sha256 and env_sha != args.expect_env_sha256:
    raise SystemExit("The .env changed since verification; re-test it before changing secrets")
values = {}
for line in raw_env.decode("utf-8-sig").splitlines():
    match = re.match(r"\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)", line)
    if match:
        values[match[1]] = match[2].strip().strip("\"'")

# Accept the Foundry portal's names, but publish the canonical variables already
# understood by the running image. Never rewrite the user's .env or duplicate keys.
values["FOUNDRY_API_KEY"] = values.get("FOUNDRY_API_KEY") or values.get("FOUNDRY_KEY", "")
values["AZURE_SPEECH_ENDPOINT"] = values.get("AZURE_SPEECH_ENDPOINT") or values.get("SPEECH_ENDPOINT", "")
if args.rewrite_deployment:
    values["VOICE_REWRITE_DEPLOYMENT"] = args.rewrite_deployment
if values.get("VOICE_REWRITE_DEPLOYMENT") and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", values["VOICE_REWRITE_DEPLOYMENT"]):
    raise SystemExit("Invalid rewrite deployment; no secret changes made")
if args.mai_model:
    values["MAI_TRANSCRIBE_MODEL"] = args.mai_model
    values["MAI_TRANSCRIBE_SPEECH_ENDPOINT"] = (
        values.get("MAI_TRANSCRIBE_SPEECH_ENDPOINT") or values["AZURE_SPEECH_ENDPOINT"]
    )
    if not values["MAI_TRANSCRIBE_SPEECH_ENDPOINT"]:
        raise SystemExit("Enabling MAI requires an explicit Speech endpoint; no secret changes made")

allowed = {
    "FOUNDRY_ENDPOINT", "FOUNDRY_API_KEY", "AZURE_SPEECH_ENDPOINT",
    "AZURE_SPEECH_KEY", "AZURE_SPEECH_API_KEY", "MAI_TRANSCRIBE_SPEECH_ENDPOINT",
    "MAI_TRANSCRIBE_KEY", "MAI_TRANSCRIBE_API_KEY", "MAI_TRANSCRIBE_MODEL",
    "VOICE_REWRITE_ENDPOINT", "VOICE_REWRITE_API_KEY", "VOICE_REWRITE_DEPLOYMENT",
    "VOICE_REWRITE_REASONING_EFFORT",
}
selected = {key: value for key, value in values.items() if key in allowed and value}
if not (selected.get("FOUNDRY_API_KEY") or selected.get("AZURE_SPEECH_KEY") or selected.get("AZURE_SPEECH_API_KEY")
        or selected.get("VOICE_REWRITE_API_KEY")):
    raise SystemExit("A server-side Speech or rewrite key is required")
for name, value in selected.items():
    if name.endswith("_ENDPOINT"):
        endpoint = urlsplit(value)
        if endpoint.scheme != "https" or endpoint.username or endpoint.password or endpoint.fragment:
            raise SystemExit(f"Invalid {name}; no secret changes made")
        if any(key not in {"api-version"} for key in re.findall(r"(?:^|&)([^=]+)=", endpoint.query)):
            raise SystemExit(f"Unsupported query in {name}; no secret changes made")
if args.mai_model and not (selected.get("MAI_TRANSCRIBE_KEY") or selected.get("MAI_TRANSCRIBE_API_KEY")):
    azure = urlsplit(selected.get("AZURE_SPEECH_ENDPOINT", ""))
    mai = urlsplit(selected["MAI_TRANSCRIBE_SPEECH_ENDPOINT"])
    if not azure.hostname or (azure.scheme, azure.hostname, azure.port) != (mai.scheme, mai.hostname, mai.port):
        raise SystemExit("A separate MAI resource requires its own key; no secret changes made")
if selected.get("VOICE_REWRITE_REASONING_EFFORT", "low") not in {"none", "low", "medium"}:
    raise SystemExit("Unsupported rewrite reasoning effort; no secret changes made")
if selected.get("VOICE_REWRITE_DEPLOYMENT"):
    foundry = urlsplit(selected.get("FOUNDRY_ENDPOINT", ""))
    rewrite = urlsplit(selected.get("VOICE_REWRITE_ENDPOINT") or selected.get("FOUNDRY_ENDPOINT", ""))
    if not rewrite.hostname or not re.fullmatch(r"[a-z0-9-]+\.(?:services\.ai\.azure\.com|openai\.azure\.com)", rewrite.hostname, re.I):
        raise SystemExit("Rewrite requires a Foundry/OpenAI HTTPS endpoint; no secret changes made")
    valid_path = (
        re.fullmatch(r"/(?:openai/v1(?:/responses)?/?)?", rewrite.path)
        if selected.get("VOICE_REWRITE_ENDPOINT")
        else re.fullmatch(r"/(?:api/projects/[a-zA-Z0-9_.-]+/?)?", rewrite.path)
    )
    if not valid_path or rewrite.query or rewrite.port not in {None, 443}:
        raise SystemExit("Unsupported rewrite endpoint path/query/port; no secret changes made")
    if not selected.get("VOICE_REWRITE_API_KEY") and (
        not foundry.hostname or rewrite.hostname.split(".")[0] != foundry.hostname.split(".")[0]
        or not selected.get("FOUNDRY_API_KEY")
    ):
        raise SystemExit("A separate rewrite resource requires its own key; no secret changes made")

secret_values = [value for name, value in selected.items() if name.endswith("_KEY")]
old_factory = logging.getLogRecordFactory()

def redacted_record(*args, **kwargs):
    record = old_factory(*args, **kwargs)
    message = record.getMessage()
    for secret in secret_values:
        message = message.replace(secret, "[REDACTED]")
    record.msg, record.args = message, ()
    return record

cli_secrets = []
bindings = []
for name, value in selected.items():
    if name.endswith("_KEY"):
        secret_name = "codey-voice-" + name.lower().replace("_", "-")
        if args.secret_suffix:
            secret_name += "-" + args.secret_suffix
        if len(secret_name) > 63:
            raise SystemExit("Versioned secret name is too long; no secret changes made")
        cli_secrets.append(f"{secret_name}={value}")
        bindings.append(f"{name}=secretref:{secret_name}")
    else:
        bindings.append(f"{name}={value}")

plan = {
    "updatedSecretNames": [item.split("=", 1)[0] for item in cli_secrets],
    "environmentNames": list(selected),
    "envSha256": env_sha,
    "otherSecretsPreserved": True,
}
if args.dry_run:
    print(json.dumps({**plan, "dryRun": True, "bindings": bindings}))
    raise SystemExit(0)

# Import only for the authorized write, allowing isolated, dependency-free tests
# of aliases/validation. Suppress CLI logging as well as console output.
from azure.cli.core import get_default_cli

capture = io.StringIO()
previous_disable = logging.root.manager.disable
logging.setLogRecordFactory(redacted_record)
logging.disable(logging.CRITICAL)
try:
    with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
        try:
            result = get_default_cli().invoke([
                "containerapp", "secret", "set", "--name", "codey", "--resource-group", "zhn-devbox",
                "--subscription", "42b416ee-e2a0-44b2-b016-db59f7a1e8f2",
                "--secrets", *cli_secrets, "--only-show-errors", "--output", "none",
            ])
        except (Exception, SystemExit):
            result = 1
finally:
    logging.disable(previous_disable)
    logging.setLogRecordFactory(old_factory)
if result:
    # Never print captured CLI output: its error paths can contain request details.
    raise SystemExit("Voice secret update failed; no credential values were printed")
if bindings_file:
    bindings_file.write_text(json.dumps(bindings, indent=2), encoding="utf-8")
print(json.dumps(plan))
