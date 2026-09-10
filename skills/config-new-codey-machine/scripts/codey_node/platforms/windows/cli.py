"""Microsoft-signed Windows CLI preparation and explicit GitHub login handoff."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request

from ...common.errors import SetupError as Error
from ...common.files import digest, write_state
from ...devtunnel import auth
from . import helpers as windows
from .process import run


def download(url, destination, *, expected=None, limit=128 * 1024 ** 2):
    destination = Path(destination)
    if destination.is_symlink():
        raise Error("linked_download_path")
    if destination.exists():
        if expected and digest(destination) != expected:
            raise Error("cached_download_checksum_mismatch")
        return
    part = destination.with_name(destination.name + ".part")
    if part.exists():
        raise Error("partial_download_needs_review")
    with urllib.request.urlopen(url, timeout=120) as response, part.open("xb") as output:
        if urllib.parse.urlsplit(response.geturl()).scheme != "https":
            raise Error("download_redirect_must_remain_https")
        size = 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                raise Error("download_too_large")
            output.write(chunk)
    if expected and digest(part) != expected:
        raise Error("download_checksum_mismatch")
    os.replace(part, destination)


def logged_in(result):
    return auth.github_logged_in(result)


class DevTunnelBrowserLoginRequired(Error):
    def __init__(self, executable, code="devtunnel_owner_browser_login_required"):
        super().__init__(code)
        command = "& '" + str(executable).replace("'", "''") + "'"
        self.user_action = {
            "required": "interactive_browser_login",
            "where": "A regular, visible, non-admin PowerShell window under the original Windows owner",
            "command": command + " user login --github --use-browser-auth",
            "verifyCommand": command + " user show --json",
            "then": "Rerun the same first-install command. The cached GitHub DevTunnel login will be reused.",
            "deviceCodeFallback": False,
            "note": "GitHub is required. Do not log out, change a cached Microsoft account, or fall back to Entra. az login does not sign in DevTunnel.",
        }


def interactive_auth_console():
    try:
        return all(stream is not None and stream.isatty() for stream in (sys.stdin, sys.stdout, sys.stderr))
    except (AttributeError, OSError, ValueError):
        return False


def prepare_devtunnel(args, home, sid, *, read_only=False):
    if args.devtunnel_executable:
        candidate = Path(args.devtunnel_executable)
    elif shutil.which("devtunnel.exe"):
        candidate = Path(shutil.which("devtunnel.exe"))
    else:
        root = home / ".local/share/codey-windows-bootstrap"
        if not root.exists():
            if read_only:
                raise Error("resume_requires_existing_devtunnel_executable")
            windows.private_directory(root, sid)
            write_state(root / "bootstrap.json", {"schema": 1, "ownerSid": sid})
        if root.is_symlink() or not root.resolve().is_relative_to(home):
            raise Error("unsafe_bootstrap_directory")
        marker = root / "bootstrap.json"
        if marker.is_symlink() or not marker.is_file() or json.loads(marker.read_text()).get("ownerSid") != sid:
            raise Error("unrecognized_bootstrap_directory")
        candidate = root / "devtunnel.exe"
        if read_only:
            if not candidate.is_file():
                raise Error("resume_requires_existing_devtunnel_executable")
        else:
            download("https://aka.ms/TunnelsCliDownload/win-x64", candidate, limit=96 * 1024 ** 2)
        # The official redirect is not version-pinned; require a valid Microsoft
        # signature before executing, then pin the actual bytes in this node.
        escaped = str(candidate).replace("'", "''")
        script = ("$ErrorActionPreference='Stop';$s=Get-AuthenticodeSignature -LiteralPath '" + escaped
                  + "';@{valid=($s.Status -eq 'Valid');subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress")
        value = json.loads(run([windows.native_powershell(), "-NoProfile", "-NonInteractive", "-Command", script]).stdout)
        if value.get("valid") is not True or not re.search(r"(?:^|,\s*)O=Microsoft Corporation(?:,|$)", value.get("subject", "")):
            raise Error("downloaded_devtunnel_must_have_a_valid_microsoft_signature")
    if not candidate.is_absolute() or not candidate.is_file() or candidate.suffix.lower() != ".exe":
        raise Error("native_devtunnel_required")
    candidate = candidate.resolve()
    result = auth.cli(candidate, ["user", "show", "--json"], check=False)
    if not logged_in(result):
        try:
            existing = json.loads(result.stdout)
        except (ValueError, TypeError):
            existing = {}
        if not isinstance(existing, dict):
            existing = {}
        if existing.get("status", "").lower() == "logged in":
            raise DevTunnelBrowserLoginRequired(candidate, "devtunnel_github_login_required_existing_account_unchanged")
        # Agent pipes, hidden windows, pythonw and read-only resume must not start
        # WAM/device-code prompts. The user performs the same browser command in
        # their normal owner console; subsequent runs reuse that exact login cache.
        if read_only or existing.get("status", "").lower() != "not logged in" or not interactive_auth_console():
            raise DevTunnelBrowserLoginRequired(candidate)
        print("Complete DevTunnel browser sign-in as the original Windows owner. No device-code fallback will be attempted.", flush=True)
        try:
            # Inherit the interactive console, never CREATE_NO_WINDOW/DEVNULL or
            # capture_output. Explicit browser auth avoids the broker/HWND path.
            result = subprocess.run(
                [str(candidate), "user", "login", "--github", "--use-browser-auth"],
                timeout=300, creationflags=0, env=auth.cli_environment(),
            )
        except (OSError, subprocess.TimeoutExpired):
            raise DevTunnelBrowserLoginRequired(candidate, "devtunnel_browser_login_failed") from None
        if result.returncode:
            raise DevTunnelBrowserLoginRequired(candidate, "devtunnel_browser_login_failed")
        if not logged_in(auth.cli(candidate, ["user", "show", "--json"], check=False)):
            raise DevTunnelBrowserLoginRequired(candidate, "devtunnel_browser_login_not_cached_for_this_owner")
    return candidate
