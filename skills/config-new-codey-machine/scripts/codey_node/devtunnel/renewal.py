"""Connect-only token issuance and signed renewal to the exact bound portal."""
import base64
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

from ..common.errors import TunnelError
from ..common.files import write_state
from . import auth
from .binding import NODE_ID, coordinates


def exact_origin(origin):
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment):
        raise TunnelError("invalid_portal_origin")
    return origin


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def renew(config, enrollment, *, force=False, runner=subprocess.run, opener=None, now=None):
    now = int(time.time() * 1000) if now is None else now
    if (not NODE_ID.fullmatch(config.get("nodeId", "")) or enrollment.get("nodeId") != config["nodeId"]
            or not coordinates(config) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", enrollment.get("tunnelUpdateKey", ""))):
        raise TunnelError("invalid_renewal_identity")
    exact_origin(enrollment["portalOrigin"])
    state_file = Path(config["configRoot"]) / "renewal.json"
    if state_file.is_symlink():
        raise TunnelError("linked_renewal_state")
    if not force and state_file.exists():
        previous = json.loads(state_file.read_text(encoding="utf-8-sig"))
        if (previous.get("nodeId") == config["nodeId"]
                and previous.get("expiresAt", 0) > now + 8 * 3600_000):
            return previous
    if config.get("tunnelAuthProvider") == "github":
        auth.require_github_login(config["devtunnelExe"], runner=runner)
    result = auth.cli(config["devtunnelExe"], [
        "token", config["tunnelId"] + "." + config["clusterId"], "--scope", "connect", "--json",
    ], runner=runner)
    try:
        value = json.loads(result.stdout)
        token = value.get("token") or value.get("accessToken")
        if not isinstance(token, str) or len(token) > 8192:
            raise ValueError()
        claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
        if (claims["tunnelId"] != config["tunnelId"] or claims["clusterId"] != config["clusterId"]
                or claims["scp"] != "connect" or type(claims["exp"]) not in (int, float)
                or claims["exp"] * 1000 <= now + 600000):
            raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError, IndexError):
        raise TunnelError("invalid_node_bound_connect_only_token") from None
    body = json.dumps({"tunnelId": config["tunnelId"], "clusterId": config["clusterId"],
                       "connectToken": token}, separators=(",", ":")).encode()
    pathname = f"/api/machine-tunnels/{config['nodeId']}/token"
    nonce = base64.urlsafe_b64encode(secrets.token_bytes(16)).decode().rstrip("=")
    message = f"POST\n{pathname}\n{now}\n{nonce}\n{hashlib.sha256(body).hexdigest()}".encode()
    signature = base64.urlsafe_b64encode(hmac.new(
        base64.urlsafe_b64decode(enrollment["tunnelUpdateKey"] + "="), message, hashlib.sha256,
    ).digest()).decode().rstrip("=")
    request = urllib.request.Request(enrollment["portalOrigin"] + pathname, data=body, method="POST", headers={
        "content-type": "application/json", "authorization": f"CodeyTunnel {now}:{nonce}:{signature}",
    })
    try:
        with (opener or urllib.request.build_opener(NoRedirect).open)(request, timeout=30) as response:
            payload = json.loads(response.read(16384))
            if (response.status != 200 or payload.get("nodeId") != config["nodeId"]
                    or payload.get("ok") is not True or payload.get("expiresAt") != claims["exp"] * 1000):
                raise ValueError()
    except (urllib.error.URLError, ValueError, OSError):
        raise TunnelError("portal_renewal_failed_no_credential_forwarding_or_fallback") from None
    status = {"ok": True, "nodeId": config["nodeId"], "renewedAt": now, "expiresAt": claims["exp"] * 1000}
    write_state(state_file, status)
    return status
