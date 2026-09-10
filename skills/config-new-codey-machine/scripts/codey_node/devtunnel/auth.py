"""GitHub-only CLI authentication with a credential-free child environment."""
import json
import os
import subprocess

from ..common.errors import TunnelError

CREATE_NO_WINDOW = 0x08000000


def cli_environment(source=None):
    """OS login/proxy plumbing only; never model keys or the calling Codex task."""
    names = {"HOME", "USER", "LOGNAME", "USERNAME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
             "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR",
             "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
             "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS",
             "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CURRENT_DESKTOP",
             "SSL_CERT_FILE", "SSL_CERT_DIR"}
    return {key: value for key, value in (os.environ if source is None else source).items()
            if key.upper() in names or key.lower() in {"https_proxy", "http_proxy", "no_proxy", "all_proxy"}}


def cli(executable, arguments, *, runner=subprocess.run, check=True):
    result = runner(
        [str(executable), *arguments], stdin=subprocess.DEVNULL,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=45, creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0, env=cli_environment(),
    )
    if check and result.returncode:
        raise TunnelError("devtunnel_command_failed")
    if len(result.stdout or "") > 65536:
        raise TunnelError("devtunnel_response_too_large")
    return result


def github_logged_in(result):
    """Use the CLI's structured provider field; a generic login is not enough."""
    try:
        value = json.loads(result.stdout)
        diagnostics = (getattr(result, "stderr", "") or "").lower()
        return (result.returncode == 0 and isinstance(value, dict)
                and value.get("status", "").strip().lower() == "logged in"
                and value.get("provider", "").strip().lower() == "github"
                and not any(marker in diagnostics for marker in
                            ("not logged in", "login required", "a window handle must be configured"))
                and isinstance(value.get("username"), str) and bool(value["username"].strip()))
    except (ValueError, TypeError, AttributeError):
        return False


def require_github_login(executable, *, runner=subprocess.run):
    result = cli(executable, ["user", "show", "--json"], runner=runner, check=False)
    if not github_logged_in(result):
        raise TunnelError("github_login_required_no_account_switch_or_entra_fallback")
