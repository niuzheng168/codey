"""Read-only inspection of existing owner tools, proxy, ports and Codex config."""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request

from ...common.errors import SetupError as Error
from ...common import verification, codex_cli
from ...devtunnel.renewal import NoRedirect
from . import helpers as windows
from .process import run


def gateway_proof():
    """Inspect, never stop/reconfigure, the exact same-owner 4141 listener."""
    script = r"""
$ErrorActionPreference='Stop'
$listeners=@(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq 4141 })
$ids=@($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
if($ids.Count -ne 1){throw 'Expected one existing model service'}
$c=Get-CimInstance Win32_Process -Filter "ProcessId=$($ids[0])"
$p=Get-Process -Id $ids[0]
$sid=(Invoke-CimMethod -InputObject $c -MethodName GetOwnerSid).Sid
@{pid=$p.Id;executable=$p.Path;startedUtc=$p.StartTime.ToUniversalTime().ToString('o');
  ownerSid=$sid;mentionsCopilotApi=([string]$c.CommandLine -match 'copilot-api')} | ConvertTo-Json -Compress
"""
    result = run([windows.native_powershell(), "-NoProfile", "-NonInteractive", "-Command", script])
    value = json.loads(result.stdout)
    if (type(value.get("pid")) is not int or value["pid"] <= 0 or not value.get("executable")
            or not value.get("startedUtc") or value.get("mentionsCopilotApi") is not True):
        raise Error("existing_4141_service_is_not_a_verified_copilot_api")
    return value


def free_ports():
    occupied = []
    for port in (3001, 8443):
        try:
            with socket.socket() as connection:
                connection.bind(("127.0.0.1", port))
        except OSError:
            occupied.append(port)
    return occupied


def existing_tools(args, home, skill):
    codex = codex_cli.require_cli(skill, args.codex_executable)
    openssl = Path(args.openssl) if args.openssl else None
    if openssl is None:
        candidates = [
            Path(shutil.which("openssl.exe") or "__missing__"),
            Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/usr/bin/openssl.exe",
        ]
        openssl = next((value for value in candidates if value.is_absolute() and value.is_file()), None)
    for value in (codex, openssl):
        if value is None or not value.is_absolute() or not value.is_file() or value.suffix.lower() != ".exe":
            raise Error("existing_absolute_native_codex_and_openssl_required")
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    if not pythonw.is_file():
        raise Error("pythonw_required_for_hidden_logon_tasks")
    return codex.resolve(), openssl.resolve(), pythonw.resolve()


def referenced_provider(codex_home):
    file = codex_home / "config.toml"
    if not file.exists():
        return {}, {}
    if file.stat().st_size > 1024 * 1024:
        raise Error("unexpected_codex_configuration_size")
    config = tomllib.loads(file.read_text(encoding="utf-8-sig"))
    provider = config.get("model_providers", {}).get(config.get("model_provider"), {})
    names = set()
    if isinstance(provider.get("env_key"), str):
        names.add(provider["env_key"])
    for name in provider.get("env_http_headers", {}).values():
        if isinstance(name, str):
            names.add(name)
    blocked = {
        "PATH", "HOME", "USERPROFILE", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED",
        "PYTHONPATH", "PYTHONHOME", "PSMODULEPATH", "CODEX_HOME",
        "CODEX_THREAD_ID", "CODEX_PARENT_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    }
    if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
           or name.upper() in blocked or (name.upper().startswith("CODEY_") and name != "CODEY_MODEL_API_KEY") for name in names):
        raise Error("unsafe_provider_environment_reference")
    return provider, {name: os.environ[name] for name in names if name in os.environ}


def usage_key_file(explicit, provider, codex_home):
    if explicit:
        candidate = Path(explicit)
    else:
        endpoint = urllib.parse.urlsplit(provider.get("base_url", ""))
        if (endpoint.scheme not in ("http", "https") or endpoint.hostname not in ("127.0.0.1", "localhost", "::1")
                or endpoint.port != 4141 or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment):
            return None  # Never forward an unrelated provider's credential to a local service.
        auth = provider.get("auth", {})
        arguments = auth.get("args", [])
        candidate = Path(arguments[0]) if (auth.get("command") in ("cat", "cat.exe")
                                           and len(arguments) == 1 and isinstance(arguments[0], str)) else None
        if candidate is None:
            return None
    if not candidate.is_absolute() or not candidate.is_file() or candidate.stat().st_size > 8192:
        raise Error("existing_usage_key_file_required_no_key_is_regenerated")
    return candidate.resolve()


def verify_usage(key_file):
    headers = {"accept": "application/json"}
    if key_file:
        key = key_file.read_text(encoding="utf-8-sig").strip()
        if not key or "\n" in key or "\r" in key:
            raise Error("invalid_usage_key_file")
        headers["authorization"] = "Bearer " + key
    # Inherited HTTP proxies/redirects must never receive a loopback credential.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)

    def probe(pathname):
        request = urllib.request.Request("http://127.0.0.1:4141" + pathname, headers=headers)
        try:
            with opener.open(request, timeout=10) as response:
                raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise ValueError()
                return response.status, json.loads(raw)
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()  # Never print an upstream body, URL or credential.
            if status in (401, 403):
                raise Error("existing_usage_auth_required_use_UsageKeyFile_not_a_key_value") from None
            return status, None
        except (urllib.error.URLError, OSError, ValueError):
            raise Error("existing_proxy_data_probe_unavailable_no_service_changed") from None

    status, body = probe("/usage")
    usage = verification.quota_available(status, body)
    if not usage:
        token_status, token_body = probe("/token-usage")
        if token_status != 200 or not isinstance(token_body, dict) or "error" in token_body:
            raise Error("existing_proxy_token_usage_unavailable_no_service_changed")
    return {
        "dataAccess": True, "usage": usage, "usageHttpStatus": status,
        **({"tokenUsage": True} if not usage else {}),
        "warnings": [] if usage else ["copilot_quota_unavailable_model_inference_not_tested"],
    }
