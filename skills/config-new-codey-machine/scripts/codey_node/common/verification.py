"""TLS/SAN, node tickets, Workspace SSO and anonymous-denial checks."""
import base64
import hashlib
import hmac
import http.client
import json
import secrets
import socket
import ssl
import time

from .errors import SetupError


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def signed(payload, key):
    encoded = b64(json.dumps(payload, separators=(",", ":")).encode())
    return encoded + "." + b64(hmac.new(key, encoded.encode(), hashlib.sha256).digest())


def local_probe(ip, port, server_name, cert, pathname, headers=None):
    context = ssl.create_default_context(cafile=str(cert))
    # Connect to the private listener, but validate the exact reserved DNS SAN.
    class Connection(http.client.HTTPSConnection):
        def connect(self):
            self.sock = context.wrap_socket(socket.create_connection((ip, port), timeout=5), server_hostname=server_name)
    connection = Connection(server_name, port, timeout=5, context=context)
    try:
        connection.request("GET", pathname, headers=headers or {})
        response = connection.getresponse()
        body = response.read(1024 * 1024)
        return response.status, json.loads(body)
    finally:
        connection.close()


def quota_available(status, body):
    """Quota telemetry is not model health. Authentication/protocol failures stay fatal."""
    if status == 200 and isinstance(body, dict) and "error" not in body:
        return True
    if (status == 200 and body is None) or status in (404, 429) or 500 <= status <= 599:
        return False
    raise SetupError(f"Authenticated quota probe failed: HTTP {status}")


def _workspace(identity):
    """The static protocol uses workspace* names; old callers remain readable until ported."""
    subject = identity.get("workspaceSubject", identity.get("principalId"))
    username = identity.get("workspaceUsername", identity.get("username"))
    if not isinstance(subject, str) or not isinstance(username, str):
        raise SetupError("Workspace identity is incomplete")
    return subject, username


def verify(identity, network, cert):
    node_id = identity["nodeId"]
    subject, username = _workspace(identity)
    server_name = f"{node_id}.nodes.codey.internal"
    ip = network["listenIp"]
    now = int(time.time())
    ticket = signed({"v": 1, "aud": node_id, "sub": subject, "scope": ["history", "usage"],
                     "iat": now, "exp": now + 60}, identity["clientSigningKey"].encode())
    health_status, health = local_probe(ip, 8443, server_name, cert, "/healthz")
    if health_status != 200:
        raise SetupError("HTTPS health probe failed")
    headers = {"authorization": "Bearer " + ticket}
    usage_status, usage_body = local_probe(ip, 8443, server_name, cert, "/usage", headers)
    if identity.get("network") != {"mode": "devtunnel"}:
        raise SetupError("The active installer requires a private DevTunnel package")
    usage = quota_available(usage_status, usage_body)
    if not usage:
        owner_bound = isinstance(health, dict) and (
            health.get("relay") == "codey-node-relay" or (
                identity.get("platform") == "linux-x64"
                and health.get("service") == "copilot-api-codey-https"))
        if (not owner_bound
                or health.get("nodeId") != node_id):
            raise SetupError(f"Authenticated probe failed: /usage returned HTTP {usage_status}")
        status, body = local_probe(ip, 8443, server_name, cert, "/token-usage", headers)
        if status != 200 or not isinstance(body, dict) or "error" in body:
            raise SetupError(f"Authenticated token usage probe failed: HTTP {status}")
        if local_probe(ip, 8443, server_name, cert, "/token-usage")[0] != 401:
            raise SetupError("Anonymous token usage must be denied")
    status = local_probe(ip, 8443, server_name, cert, "/session-history?state=all&limit=1", headers)[0]
    if status != 200:
        raise SetupError(f"Authenticated History probe failed: HTTP {status}")
    if local_probe(ip, 8443, server_name, cert, "/usage")[0] != 401:
        raise SetupError("Anonymous Usage must be denied")
    pathname = "/api/auth/status"
    assertion = signed({
        "iss": "codey-portal", "aud": node_id, "sub": subject, "username": username,
        "sid": secrets.token_hex(32), "method": "GET", "path": pathname,
        "iat": now, "exp": now + 20, "nonce": b64(secrets.token_bytes(16)),
    }, base64.urlsafe_b64decode(identity["workspaceSsoKey"] + "="))
    status, body = local_probe(ip, 3001, server_name, cert, pathname, {"x-codey-workspace-assertion": assertion})
    if status != 200 or body.get("managedAuthentication") is not True or body.get("user", {}).get("username") != username:
        raise SetupError("Workspace SSO binding probe failed")
    if local_probe(ip, 3001, server_name, cert, pathname)[0] != 401:
        raise SetupError("Anonymous Workspace must be denied")
    return {
        "usage": usage, "usageHttpStatus": usage_status, "history": True, "workspaceSso": True,
        "anonymousDenied": True, **({"tokenUsage": True} if not usage else {}),
        "warnings": [] if usage else ["copilot_quota_unavailable_model_inference_not_tested"],
    }
