"""Plan/apply the approved A100 Codex defaults; never discover or restart a gateway."""
import argparse
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tomllib

from .errors import SetupError
from .config_files import Change, Owner, absolute, commit
from . import toml_edit

SKILL = Path(__file__).resolve().parents[3]
CATALOG_FILE = "templates/a100-models.json"
CATALOG_SHA256 = "b239fe781d86a0d8bad2f39595e12fb3ecb275600d215d77502be4a11be5fd6d"
MODELS = ("gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-sol-fast")
MODEL_KEY = "CODEY_MODEL_API_KEY"
CODEX_DEFAULTS = {
    "model": "gpt-6-astra", "model_provider": "copilot_api",
    "model_reasoning_effort": "max", "model_reasoning_summary": "auto",
    "model_context_window": 872000, "model_auto_compact_token_limit": 722000,
    "personality": "pragmatic", "approvals_reviewer": "user",
    "sandbox_mode": "danger-full-access", "approval_policy": "never",
}
PROVIDER_DEFAULTS = {
    "name": "OpenAI", "base_url": "http://localhost:4141", "env_key": MODEL_KEY,
    "requires_openai_auth": False, "supports_websockets": False, "wire_api": "responses",
    "request_max_retries": 3, "stream_max_retries": 1, "stream_idle_timeout_ms": 300000,
}
BLOCKED_ENV = {
    "PATH", "HOME", "USER", "USERPROFILE", "HOST", "NODE_ENV", "DATABASE_PATH",
    "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "PYTHONPATH", "PYTHONHOME", "PSMODULEPATH",
    "CODEX_HOME", "CODEX_THREAD_ID", "CODEX_PARENT_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
}


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise SetupError("Duplicate JSON keys make this configuration ambiguous")
        result[key] = value
    return result


def _constant(_value):
    raise SetupError("Non-finite JSON numbers are not supported")


def parse_json(text):
    try:
        result = json.loads(text, object_pairs_hook=_object, parse_constant=_constant)
    except (ValueError, UnicodeError):
        raise SetupError("Invalid configuration JSON; values were not logged or changed") from None
    if not isinstance(result, dict):
        raise SetupError("Expected a JSON configuration object")
    return result


def catalog(skill):
    path = absolute(Path(skill) / CATALOG_FILE)
    for part in (path, *path.parents):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise SetupError("The bundled public catalog must not be linked")
    if not path.is_file() or path.stat().st_nlink != 1 or path.stat().st_size > 1024 * 1024:
        raise SetupError("Invalid public model catalog")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != CATALOG_SHA256:
        raise SetupError("The public A100 model catalog SHA-256 does not match the reviewed resource")
    value = parse_json(data)
    if set(value) != {"models"} or tuple(item.get("slug") for item in value["models"]) != MODELS:
        raise SetupError("The public A100 model catalog contains unexpected models")
    return data


def patch_gateway(text):
    """Change one top-level value without reserializing credentials or other config."""
    before = parse_json(text)
    if before.get("useResponsesApiWebSocket") is False:
        return text
    decoder = json.JSONDecoder()
    index = text.index("{") + 1
    last_end = index
    while True:
        while text[index].isspace() or text[index] == ",":
            index += 1
        if text[index] == "}":
            break
        name, index = decoder.raw_decode(text, index)
        while text[index].isspace() or text[index] == ":":
            index += 1
        start = index
        value, index = decoder.raw_decode(text, index)
        if name == "useResponsesApiWebSocket":
            if isinstance(value, (dict, list)):
                raise SetupError("The gateway WebSocket setting has an incompatible type")
            result = text[:start] + "false" + text[index:]
            break
        last_end = index
    else:
        raise SetupError("Invalid gateway configuration")
    if "useResponsesApiWebSocket" not in before:
        newline = "\r\n" if "\r\n" in text else "\n"
        insertion = ("," if before else "") + newline + '  "useResponsesApiWebSocket": false'
        result = text[:last_end] + insertion + text[last_end:]
    if not toml_edit.same(parse_json(result), {**before, "useResponsesApiWebSocket": False}):
        raise SetupError("Gateway configuration preservation check failed")
    return result


def _text(data):
    try:
        return (data or b"").decode("utf-8-sig")
    except UnicodeError:
        raise SetupError("Configuration must be UTF-8; original bytes were not changed") from None


def _encoded(text, original):
    return (b"\xef\xbb\xbf" if original and original.startswith(b"\xef\xbb\xbf") else b"") + text.encode("utf-8")


def _env_statements(text):
    start, index, quote = 0, 0, ""
    while index < len(text):
        if index == start and text[index:].lstrip(" \t").startswith(("#", ";")):
            end = text.find("\n", index)
            index = len(text) if end < 0 else end + 1
            start = index
            continue
        char = text[index]
        if char == "\\" and quote != "'":
            index += 2 if text[index + 1:index + 3] != "\r\n" else 3
            continue
        if char in "\"'":
            quote = "" if quote == char else char if not quote else quote
        if char == "\n" and not quote:
            yield start, index + 1
            start = index + 1
        index += 1
    if quote:
        raise SetupError("Ambiguous multiline provider.env; review it before applying defaults")
    if start < len(text):
        yield start, len(text)


def patch_provider_env(text, key):
    newline = "\r\n" if "\r\n" in text else "\n"
    line = MODEL_KEY + "=" + json.dumps(key, ensure_ascii=False) + newline
    matches = [(start, end) for start, end in _env_statements(text)
               if re.match(r"[ \t]*(?:export[ \t]+)?" + MODEL_KEY + r"[ \t]*=", text[start:end])]
    if len(matches) > 1:
        raise SetupError("Duplicate model key assignments in provider.env; review the effective value first")
    if matches:
        start, end = matches[0]
        value = re.sub(r"^[ \t]*(?:export[ \t]+)?" + MODEL_KEY + r"[ \t]*=", "", text[start:end]).strip()
        if value in (key, json.dumps(key, ensure_ascii=False), "'" + key + "'"):
            return text
        return text[:start] + line + text[end:]
    return text + (newline if text and not text.endswith("\n") else "") + line


def _key_from_gateway(value, selected=None):
    auth = value.get("auth", {})
    keys = auth.get("apiKeys", []) if isinstance(auth, dict) else []
    if not isinstance(keys, list) or any(not isinstance(key, str) or not key or key != key.strip() or len(key) > 8192
                                         or any(ord(char) < 32 or ord(char) == 127 for char in key) for key in keys):
        raise SetupError("Invalid gateway API-key configuration; no credentials were changed")
    if selected is not None:
        if selected not in keys:
            raise SetupError("The selected model-key file is not an active key in the explicit gateway config")
        return selected
    if len(keys) != 1:
        raise SetupError("A single gateway model key is required; select an existing active key with --model-key-file")
    return keys[0]


def provider_environment(config, key):
    provider = config["model_providers"]["copilot_api"]
    headers = provider.get("env_http_headers", {})
    if not isinstance(headers, dict):
        raise SetupError("Invalid provider environment header references")
    names = [MODEL_KEY, *headers.values()]
    if any(not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
           or name.upper() in BLOCKED_ENV or (name.upper().startswith("CODEY_") and name != MODEL_KEY)
           for name in names):
        raise SetupError("Unsafe provider environment reference; original credentials were preserved")
    result = {name: os.environ[name] for name in set(names) if name != MODEL_KEY and name in os.environ}
    if any(any(ord(char) < 32 for char in value) for value in result.values()):
        raise SetupError("Provider environment values must be single-line")
    return {**result, MODEL_KEY: key}


def _check_active_profile(config, settings):
    """Keep profiles intact, but do not claim root defaults win over a selected profile."""
    name = config.get("profile")
    if name is None:
        return
    profiles = config.get("profiles", {})
    if not isinstance(name, str) or not isinstance(profiles, dict) or not isinstance(profiles.get(name), dict):
        raise SetupError("The default Codex profile is ambiguous; review it without replacing its configuration")
    for path, expected in settings.items():
        value = profiles[name]
        for part in path:
            if not isinstance(value, dict) or part not in value:
                break
            value = value[part]
        else:
            if not toml_edit.same(value, expected):
                raise SetupError("The active Codex profile overrides requested defaults; review the profile selection first. "
                                 "Profiles and credentials were not changed")


@dataclass(repr=False)
class DefaultsPlan:
    owner: Owner
    codex_home: Path
    gateway: Path | None
    changes: list = field(repr=False)
    watches: list = field(repr=False)
    provider_env: dict = field(repr=False)
    blockers: list
    new_gateway: bool

    def report(self):
        return {
            "applied": False, "ownerHome": str(self.owner.home), "codexHome": str(self.codex_home),
            "catalogSha256": CATALOG_SHA256, "models": list(MODELS),
            "codexSettings": {**CODEX_DEFAULTS, "model_catalog_json": str(self.codex_home / "models.json"),
                              "model_providers.copilot_api": dict(PROVIDER_DEFAULTS),
                              "features.remote_compaction_v2": True},
            "permissionNotice": "These explicitly requested installation defaults set danger-full-access / never "
                                "only in the target Codex config; they do not change this installer process's permissions.",
            "gatewayConfig": str(self.gateway) if self.gateway else None,
            "gatewayConfigSource": "new Linux installation COPILOT_API_HOME" if self.new_gateway else "explicit target; never guessed",
            "useResponsesApiWebSocket": False,
            "files": [{"path": str(item.before.path),
                       "action": ("replace-with-backup" if item.before.data is not None else "create") if item.changed else "unchanged"}
                      for item in self.changes],
            "providerEnvironmentNames": sorted(self.provider_env),
            "credentials": "Preserved; no key values or login tokens in this report or public assets",
            "servicesRestarted": False, "modelLoginTested": False,
            "gatewayRuntimeReloaded": False,
            "gatewayNotice": "The new Linux service reads this config on first start. An existing gateway may need "
                             "a separately owner-approved reload; this command only changes its explicit config file.",
            "clientNotice": "New clients need CODEY_MODEL_API_KEY from the selected gateway. Existing processes are not restarted.",
            "requiredActions": list(self.blockers),
        }

    def require_ready(self):
        if self.blockers:
            raise SetupError("Defaults not applied: " + "; ".join(self.blockers))

    def apply(self):
        self.require_ready()
        backups = commit(self.owner, self.changes, watches=self.watches)
        return {**self.report(), "applied": True, "backups": backups,
                "changedFiles": [str(item.before.path) for item in self.changes if item.changed]}


def prepare(skill=SKILL, *, owner=None, codex_home=None, copilot_api_config=None,
            provider_env_file=None, model_key_file=None, new_gateway=False, require_provider_key=False):
    owner = owner or Owner.target()
    inherited = os.environ.get("CODEX_HOME")
    if not codex_home and inherited and not absolute(inherited).is_relative_to(owner.home):
        raise SetupError("Inherited CODEX_HOME is outside the target owner home; specify --codex-home explicitly")
    codex_home = owner.check(codex_home or inherited or owner.home / ".codex")
    config = owner.read(codex_home / "config.toml")
    models = owner.read(codex_home / "models.json")
    settings = {(name,): value for name, value in CODEX_DEFAULTS.items()}
    settings[("model_catalog_json",)] = str(codex_home / "models.json")
    settings.update({("model_providers", "copilot_api", name): value for name, value in PROVIDER_DEFAULTS.items()})
    settings[("features", "remote_compaction_v2")] = True
    config_text = toml_edit.merge(_text(config.data), settings)
    _check_active_profile(tomllib.loads(config_text), settings)
    changes = [Change(models, catalog(skill)), Change(config, _encoded(config_text, config.data))]
    blockers, watches, environment = [], [], {}
    gateway_path = owner.check(copilot_api_config) if copilot_api_config else None
    if gateway_path is None:
        blockers.append("Supply --copilot-api-config with the config.json actually used by the target gateway's COPILOT_API_HOME; "
                        "the legacy default directory and controller environment are not used")
    else:
        gateway = owner.read(gateway_path)
        if gateway.data is None:
            if not new_gateway:
                raise SetupError("The explicit existing gateway config is missing; no guessed or replacement gateway is allowed")
            gateway_text = json.dumps({"auth": {
                "apiKeys": [secrets.token_urlsafe(32)], "adminApiKey": secrets.token_urlsafe(32),
                "sessionHistoryApiKey": secrets.token_urlsafe(32),
            }}, indent=2) + "\n"
        else:
            gateway_text = _text(gateway.data)
        gateway_value = parse_json(gateway_text)
        changes.append(Change(gateway, _encoded(patch_gateway(gateway_text), gateway.data)))
        if require_provider_key or provider_env_file or model_key_file:
            selected = None
            if model_key_file:
                selected_file = owner.read(model_key_file)
                watches.append(selected_file)
                if selected_file.data is None or len(selected_file.data) > 8192:
                    raise SetupError("Select an existing bounded model-key file, not a key value")
                selected = _text(selected_file.data).strip()
            key = _key_from_gateway(gateway_value, selected)
            environment = provider_environment(tomllib.loads(config_text), key)
            if provider_env_file:
                env_file = owner.read(provider_env_file)
                changes.append(Change(env_file, _encoded(patch_provider_env(_text(env_file.data), key), env_file.data)))
    targets = [item.before.path for item in changes]
    inputs = {absolute(Path(skill) / CATALOG_FILE), *(snapshot.path for snapshot in watches)}
    if (len(targets) != len(set(targets)) or set(targets) & inputs
            or any(path in other.parents for path in targets for other in targets if path != other)):
        raise SetupError("Configuration targets overlap; no files were changed")
    return DefaultsPlan(owner, codex_home, gateway_path, changes, watches, environment, blockers, new_gateway)


def add_existing_gateway_arguments(parser):
    parser.add_argument("--copilot-api-config", help="Explicit config.json actually used by the existing target gateway; never guessed")
    parser.add_argument("--model-key-file", help="Select one existing active gateway API key by absolute file path, never a key value")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-home", required=True, help="Explicit existing target owner home; run as that owner")
    parser.add_argument("--codex-home", help="Absolute target Codex home; otherwise this owner's CODEX_HOME or .codex")
    parser.add_argument("--provider-env-file", help="Explicit CloudCLI provider.env to bind to the selected gateway key")
    add_existing_gateway_arguments(parser)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--plan", action="store_true", help="Read-only plan (the default)")
    mode.add_argument("--apply", action="store_true", help="Apply the displayed target defaults with private backups")
    args = parser.parse_args()
    try:
        plan = prepare(owner=Owner.target(args.owner_home), codex_home=args.codex_home,
                       copilot_api_config=args.copilot_api_config, model_key_file=args.model_key_file,
                       provider_env_file=args.provider_env_file)
        print(json.dumps(plan.apply() if args.apply else plan.report(), indent=2))
    except (SetupError, OSError, ValueError, TypeError) as error:
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, SetupError) else
                          "Defaults failed; review the explicit target and any private .codey-defaults-*.bak files. "
                          "No services were restarted and no credentials were logged."}))
        raise SystemExit(1)
