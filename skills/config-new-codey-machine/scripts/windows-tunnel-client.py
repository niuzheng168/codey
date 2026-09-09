"""Private Windows DevTunnel binding and node-scoped renewal; never Azure ARM."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

CREATE_NO_WINDOW = 0x08000000
NODE_ID = re.compile(r"n-[a-f0-9]{24}")


class TunnelError(RuntimeError):
    pass


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_state(file, value):
    """The caller creates this parent with an owner-only Windows ACL."""
    file = Path(file)
    if file.is_symlink():
        raise TunnelError("linked_state_file")
    temporary = file.with_name(file.name + "." + secrets.token_hex(8) + ".next")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        for attempt in range(6):
            try:
                os.replace(temporary, file)
                break
            except OSError as error:
                if os.name != "nt" or getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 5:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        temporary.unlink(missing_ok=True)


def coordinates(value):
    return (isinstance(value, dict)
            and isinstance(value.get("tunnelId"), str)
            and re.fullmatch(r"[a-z0-9][a-z0-9-]{1,58}[a-z0-9]", value["tunnelId"])
            and isinstance(value.get("clusterId"), str)
            and re.fullmatch(r"[a-z][a-z0-9]{1,15}", value["clusterId"]))


def normalize_tunnel(value):
    """Normalize CLI records, not token claims; never infer a missing region."""
    if not isinstance(value, dict):
        raise TunnelError("invalid_tunnel_response")
    record = value.get("tunnel", value)
    if not isinstance(record, dict) or not isinstance(record.get("tunnelId"), str):
        raise TunnelError("invalid_tunnel_response")
    raw_id = record["tunnelId"]
    cluster = record.get("clusterId")
    if "." in raw_id:
        parts = raw_id.split(".")
        if len(parts) != 2:
            raise TunnelError("invalid_qualified_tunnel_id")
        raw_id, suffix = parts
        if "clusterId" in record and cluster != suffix:
            raise TunnelError("conflicting_tunnel_cluster")
        cluster = suffix
    normalized = {**record, "tunnelId": raw_id, "clusterId": cluster}
    if not coordinates(normalized):
        raise TunnelError("invalid_tunnel_coordinates")
    return normalized


def exact_origin(origin):
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment):
        raise TunnelError("invalid_portal_origin")
    return origin


def validate_bundle(enrollment, manifest, *, ready=False, now=None):
    now = time.time() * 1000 if now is None else now
    if (enrollment.get("schema") != 1 or not NODE_ID.fullmatch(enrollment.get("nodeId", ""))
            or enrollment.get("platform") != "windows-x64"
            or manifest.get("schema") != 1 or manifest.get("platform") != "windows-x64"
            or enrollment.get("releaseId") != manifest.get("releaseId")
            or enrollment.get("network") != {"mode": "devtunnel"}):
        raise TunnelError("personalized_windows_tunnel_package_required")
    if not ready and enrollment.get("expiresAt", 0) <= now:
        raise TunnelError("enrollment_expired")
    if (not re.fullmatch(r"[a-z0-9-]{1,80}", enrollment.get("principalId", ""))
            or not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", enrollment.get("username", ""))):
        raise TunnelError("invalid_node_owner")
    for key in ("clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey"):
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", enrollment.get(key, "")):
            raise TunnelError("node_specific_credentials_required")
    if len({enrollment[key] for key in ("clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey")}) != 3:
        raise TunnelError("credentials_must_be_purpose_separated")
    exact_origin(enrollment.get("portalOrigin", ""))
    version, bun = manifest.get("node", ""), manifest.get("bunBuildTool", "")
    if not all(re.fullmatch(r"\d+\.\d+\.\d+", value) for value in (version, bun)):
        raise TunnelError("pinned_runtime_required")
    distribution = manifest.get("nodeDistribution", {})
    file = f"node-v{version}-win-x64.zip"
    if (distribution.get("file") != file
            or distribution.get("url") != f"https://nodejs.org/dist/v{version}/{file}"
            or not re.fullmatch(r"[a-f0-9]{64}", distribution.get("sha256", ""))):
        raise TunnelError("pinned_native_windows_node_required")
    artifacts = manifest.get("artifacts", [])
    if [item.get("file") for item in artifacts] != [
        "cloudcli-source.tar.gz", "copilot-api-source.tar.gz", "portal-node-source.tar.gz",
    ]:
        raise TunnelError("complete_windows_workspace_and_relay_sources_required")
    if any(not re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", ""))
           or type(item.get("size")) is not int or not 0 < item["size"] <= 256 * 1024 ** 2
           for item in artifacts):
        raise TunnelError("invalid_source_metadata")
    identity = "\n".join([version, bun, distribution["sha256"]] + [item["sha256"] for item in artifacts])
    if (manifest.get("dependencyMode") != "install-on-target"
            or manifest["releaseId"] != "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]):
        raise TunnelError("release_identity_mismatch")
    return artifacts


def cli(executable, arguments, *, runner=subprocess.run, check=True):
    result = runner(
        [str(executable), *arguments], stdin=subprocess.DEVNULL,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=45, creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if check and result.returncode:
        raise TunnelError("devtunnel_command_failed")
    if len(result.stdout or "") > 65536:
        raise TunnelError("devtunnel_response_too_large")
    return result


def ensure_tunnel(executable, enrollment, config_root, *, runner=subprocess.run,
                  reuse_only=False, inspect_only=False, expected_binding=None):
    """Journal first; never retry a creation after an ambiguous acknowledgement."""
    node_id = enrollment["nodeId"]
    if not NODE_ID.fullmatch(node_id):
        raise TunnelError("invalid_node_id")
    requested = "codey-" + node_id
    description = "Codey Windows " + node_id
    journal = Path(config_root) / "tunnel.json"
    if journal.is_symlink():
        raise TunnelError("linked_tunnel_journal")
    pinned = None
    if journal.exists():
        state = json.loads(journal.read_text(encoding="utf-8-sig"))
        if not isinstance(state, dict) or state.get("requested") != requested:
            raise TunnelError("tunnel_journal_identity_mismatch")
        if set(state) == {"requested"}:
            qualified = requested  # Legacy create acknowledgement was not saved.
        else:
            if (not coordinates(state) or state["tunnelId"] != requested
                    or state.get("qualifiedId") != state["tunnelId"] + "." + state["clusterId"]):
                raise TunnelError("invalid_tunnel_journal")
            qualified = state["qualifiedId"]
            pinned = {"tunnelId": state["tunnelId"], "clusterId": state["clusterId"]}
        result = cli(executable, ["show", qualified, "--json"], runner=runner)
    else:
        if reuse_only or inspect_only:
            raise TunnelError("resume_requires_existing_tunnel_journal_no_tunnel_created")
        write_state(journal, {"requested": requested})
        result = cli(executable, ["create", requested, "--description", description, "--json"], runner=runner)
    tunnel = normalize_tunnel(json.loads(result.stdout))
    if tunnel["tunnelId"] != requested or tunnel.get("description") != description:
        raise TunnelError("tunnel_not_bound_to_this_installation")
    binding = {"tunnelId": tunnel["tunnelId"], "clusterId": tunnel["clusterId"]}
    if (pinned is not None and binding != pinned) or (expected_binding is not None and binding != expected_binding):
        raise TunnelError("tunnel_binding_changed_no_replacement_created")
    qualified = tunnel["tunnelId"] + "." + tunnel["clusterId"]
    ports = tunnel.get("ports", [])
    if not isinstance(ports, list) or any(not isinstance(port, dict) or type(port.get("portNumber")) is not int
                                         or port["portNumber"] not in (3001, 8443) for port in ports):
        raise TunnelError("unrelated_ports_in_tunnel")
    missing = []
    for port in (3001, 8443):
        matches = [row for row in ports if row.get("portNumber") == port]
        if len(matches) > 1 or (matches and matches[0].get("protocol") != "https"):
            raise TunnelError("tunnel_port_must_be_https")
        if not matches:
            missing.append(port)
    if inspect_only:
        return binding
    write_state(journal, {"requested": requested, "qualifiedId": qualified, **binding})
    for port in missing:
        cli(executable, ["port", "create", qualified, "--port-number", str(port),
                         "--protocol", "https", "--json"], runner=runner)
    return binding


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
    result = cli(config["devtunnelExe"], [
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


def host_connections(config, *, runner=subprocess.run):
    """Unknown authentication/network state is not proof that a host is dead."""
    try:
        result = cli(config["devtunnelExe"], [
            "show", config["tunnelId"] + "." + config["clusterId"], "--json",
        ], runner=runner)
        value = normalize_tunnel(json.loads(result.stdout))
        count = value["hostConnections"]
        if (value["tunnelId"] != config["tunnelId"] or value["clusterId"] != config["clusterId"]
                or type(count) is not int or not 0 <= count <= 64):
            return None
        return count
    except (TunnelError, OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        return None
