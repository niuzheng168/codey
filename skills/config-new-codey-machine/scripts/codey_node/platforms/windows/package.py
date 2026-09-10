"""Validate the personalized Windows source bundle, not tunnel operations."""
import hashlib
import re
import time

from ...common.errors import TunnelError
from ...devtunnel.binding import NODE_ID
from ...devtunnel.renewal import exact_origin


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
    if enrollment.get("tunnelAuthProvider", "github") != "github":
        raise TunnelError("github_tunnel_authentication_required")
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
