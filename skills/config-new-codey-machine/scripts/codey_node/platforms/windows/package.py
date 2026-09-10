"""Validate the static Windows source bundle, not tunnel operations."""
import hashlib
import re

from ...common.errors import TunnelError
from ...common import registration


def validate_bundle(setup, manifest, *, now=None):
    try:
        registration.validate_setup(setup, "windows-x64", now=now)
    except registration.SetupError as error:
        raise TunnelError(str(error)) from None
    if (manifest.get("schema") != 1 or manifest.get("platform") != "windows-x64"
            or setup.get("releaseId") != manifest.get("releaseId")):
        raise TunnelError("static_windows_package_release_mismatch")
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
