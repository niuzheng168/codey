"""Node-bound tunnel journals, HTTPS ports and non-anonymous access checks."""
import json
from pathlib import Path
import re
import subprocess

from ..common.errors import TunnelError
from ..common.files import write_state
from . import auth

NODE_ID = re.compile(r"n-[a-f0-9]{24}")


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


def ensure_tunnel(executable, enrollment, config_root, *, runner=subprocess.run,
                  reuse_only=False, inspect_only=False, expected_binding=None):
    """Journal first; never retry a creation after an ambiguous acknowledgement."""
    node_id = enrollment["nodeId"]
    if not NODE_ID.fullmatch(node_id):
        raise TunnelError("invalid_node_id")
    requested = "codey-" + node_id
    platforms = {"windows-x64": "Windows", "linux-x64": "Linux",
                 "macos-arm64": "macOS", "macos-x64": "macOS"}
    label = platforms.get(enrollment.get("platform", "windows-x64"))
    if not label:
        raise TunnelError("unsupported_tunnel_platform")
    description = "Codey " + label + " " + node_id
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
        result = auth.cli(executable, ["show", qualified, "--json"], runner=runner)
    else:
        if reuse_only or inspect_only:
            raise TunnelError("resume_requires_existing_tunnel_journal_no_tunnel_created")
        write_state(journal, {"requested": requested})
        result = auth.cli(executable, ["create", requested, "--description", description, "--json"], runner=runner)
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
    for record in [tunnel, *ports]:
        access = record.get("accessControl") or {}
        if not isinstance(access, dict):
            raise TunnelError("invalid_tunnel_access_control")
        entries = access.get("entries", [])
        if not isinstance(entries, list) or any(
                not isinstance(entry, dict) or
                (str(entry.get("type", "")).lower() == "anonymous" and entry.get("isDeny") is not True)
                for entry in entries):
            raise TunnelError("anonymous_tunnel_access_is_not_allowed")
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
        auth.cli(executable, ["port", "create", qualified, "--port-number", str(port),
                         "--protocol", "https", "--json"], runner=runner)
    return binding


def host_connections(config, *, runner=subprocess.run):
    """Unknown authentication/network state is not proof that a host is dead."""
    try:
        result = auth.cli(config["devtunnelExe"], [
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
