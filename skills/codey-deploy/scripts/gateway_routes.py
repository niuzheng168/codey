"""Fail closed if a release drops a reviewed, authenticated Dev Tunnel route.

The policy and proofs contain routing metadata and environment-variable NAMES,
never credentials. This module makes no Azure calls and grants no node access.
"""
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

POLICY_FILE = "cloudcli-tunnels.required.json"
CONFIG_FILE = "cloudcli-nodes.aca.json"
PROOF_FILE = "gateway-routes.json"
FIELDS = ("id", "upstream", "tlsServerName", "fingerprint", "devTunnel")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def route(node):
    """Return only security-critical metadata for an existing Workspace route."""
    require(isinstance(node, dict) and all(key in node for key in FIELDS), "Incomplete Dev Tunnel route")
    require(isinstance(node["id"], str) and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", node["id"]),
            "Invalid Workspace node ID")
    try:
        upstream = urlsplit(node["upstream"])
        port = upstream.port
    except (TypeError, ValueError):
        raise RuntimeError("Invalid Workspace endpoint") from None
    tunnel = node["devTunnel"]
    require(upstream.scheme == "https" and upstream.hostname in {"localhost", "127.0.0.1", "::1"}
            and port == 3001 and upstream.path in {"", "/"}
            and not (upstream.username or upstream.password or upstream.query or upstream.fragment),
            "Dev Tunnel Workspace must keep its authenticated loopback HTTPS endpoint")
    require(node["tlsServerName"] == "localhost" and
            re.fullmatch(r"(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}", node["fingerprint"]),
            "Dev Tunnel Workspace requires a pinned node certificate")
    require(isinstance(tunnel, dict) and set(tunnel) == {"tunnelId", "clusterId", "port", "connectTokenEnv"}
            and re.fullmatch(r"[a-z0-9][a-z0-9-]{1,58}", tunnel["tunnelId"])
            and re.fullmatch(r"[a-z0-9]{2,12}", tunnel["clusterId"])
            and type(tunnel["port"]) is int and tunnel["port"] == 3001
            and re.fullmatch(r"[A-Z][A-Z0-9_]{2,127}", tunnel["connectTokenEnv"]),
            "Unexpected Dev Tunnel identity, port, or credential reference")
    return {key: node[key] for key in FIELDS}


def portal_environment(app):
    """Read names only; never return secret values or the complete environment."""
    portal = next(row for row in app["properties"]["template"]["containers"] if row["name"] == "portal")
    return {row["name"] for row in portal.get("env", []) if row.get("secretRef") or row.get("value")}


def validate(config, policy, environment):
    require(isinstance(config, dict) and isinstance(config.get("nodes"), list), "Invalid gateway configuration")
    nodes = config["nodes"]
    ids = [node["id"] for node in nodes]
    require(len(ids) == len(set(ids)), "Duplicate Workspace node IDs")
    tunnels = {node["id"]: route(node) for node in nodes if node.get("devTunnel")}
    reserved = {name for name in environment if name.startswith("CODEY_") and name.endswith("_TUNNEL_TOKEN")}
    if policy is None:
        require(not tunnels and not reserved, "Missing reviewed Dev Tunnel routing policy")
        policy = {"schema": 1, "routes": [], "probeNodeIds": []}
    require(isinstance(policy, dict) and set(policy) == {"schema", "routes", "probeNodeIds"}
            and policy["schema"] == 1 and isinstance(policy["routes"], list)
            and isinstance(policy["probeNodeIds"], list), "Invalid reviewed routing policy")
    expected = {row["id"]: route(row) for row in policy["routes"]}
    require(len(expected) == len(policy["routes"]), "Duplicate required Workspace routes")
    require(set(tunnels) == set(expected), "Dev Tunnel route set changed; review the private policy explicitly")
    for node_id, value in expected.items():
        require(tunnels[node_id] == value, "Required Workspace route changed: " + node_id)
    references = {value["devTunnel"]["connectTokenEnv"] for value in expected.values()}
    require(references <= set(environment), "A required Workspace credential reference is missing")
    require(reserved <= references, "A configured Workspace token has no protected route")
    probes = policy["probeNodeIds"]
    require(all(isinstance(node, str) for node in probes)
            and len(probes) == len(set(probes)) and set(probes) <= set(expected),
            "Invalid owner-scoped Workspace acceptance targets")
    return {"schema": 1, "configSha256": digest(config), "policySha256": digest(policy),
            "nodeIds": ids, "requiredTunnelIds": sorted(expected),
            "routeSha256": {key: digest(value) for key, value in expected.items()},
            "probeNodeIds": probes}


def inspect_files(config_path, policy_path, app):
    policy_path = Path(policy_path)
    return validate(read(config_path), read(policy_path) if policy_path.is_file() else None,
                    portal_environment(app))


def freeze(root, job, app):
    """Validate the actual frozen Docker build input against the private policy."""
    job = Path(job)
    proof = inspect_files(job / "source/portal/config" / CONFIG_FILE, Path(root) / "config" / POLICY_FILE, app)
    target = job / PROOF_FILE
    require(not target.exists(), "Gateway proof already exists; do not replace its baseline")
    with target.open("x", encoding="utf-8") as stream:
        json.dump(proof, stream, indent=2)
    target.chmod(0o600)
    return proof


def verify_frozen(root, job, app):
    job = Path(job)
    proof = read(job / PROOF_FILE)
    current = inspect_files(job / "source/portal/config" / CONFIG_FILE, Path(root) / "config" / POLICY_FILE, app)
    require(current == proof, "Frozen gateway configuration or reviewed policy changed during the release")
    return proof


def verify_published(http, proof):
    """Use the deployment owner's ordinary API access, never an admin bypass.

    probeNodeIds must explicitly name existing nodes of that owner. Other users'
    routes remain protected by the build check without probing their sessions.
    Usage :8443 and model inference are deliberately outside this check.
    """
    nodes = http("/api/cloudcli/nodes").json()["nodes"]
    ids = [node["id"] for node in nodes]
    require(len(ids) == len(set(ids)), "Duplicate published Workspace node IDs")
    require(set(proof["probeNodeIds"]) <= set(ids), "A required remote Workspace is absent from the published owner API")
    results = []
    for node in proof["probeNodeIds"]:
        prefix = "/cloudcli/" + node
        require(http(prefix + "/api/auth/status").json().get("managedAuthentication") is True,
                "Remote Workspace SSO did not validate")
        http(prefix + "/api/projects")
        http(prefix + "/api/auth/status", authenticated=False, expected=401)
        results.append({"node": node, "workspaceSso": 200, "projects": 200, "anonymous": 401})
    return {"publishedOwnerNodeIds": ids, "tunnelWorkspaces": results,
            "adminAccessExpanded": False, "modelCalls": 0}


if __name__ == "__main__":
    import argparse
    import subprocess
    parser = argparse.ArgumentParser(description="Read-only live gateway policy preflight; no keys are exported")
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    try:
        settings = read(args.root / "config/workspace-ui-publish.json")
        result = subprocess.run([
            "az", "containerapp", "show", "--name", "codey", "--resource-group", settings["resourceGroup"],
            "--subscription", settings["subscription"], "--only-show-errors", "-o", "json",
        ], capture_output=True, text=True, encoding="utf-8", timeout=60)
        require(result.returncode == 0, "Unable to read ACA metadata; check the existing Azure login")
        print(json.dumps(inspect_files(args.root / "config" / CONFIG_FILE,
                                       args.root / "config" / POLICY_FILE, json.loads(result.stdout))))
    except Exception as error:
        # Tracebacks/HTTP responses can contain private configuration. Only expose
        # our fixed validation failures or the exception type.
        message = str(error) if type(error) is RuntimeError else type(error).__name__
        print(json.dumps({"ok": False, "error": message}))
        raise SystemExit(1)
