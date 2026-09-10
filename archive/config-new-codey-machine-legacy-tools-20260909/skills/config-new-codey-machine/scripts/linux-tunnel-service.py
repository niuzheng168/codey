#!/usr/bin/env python3
"""Linux-only private tunnel host and periodic connect-token renewal."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import sys
import tempfile
import urllib.request


class ServiceError(RuntimeError):
    pass


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def private_json(file):
    file = Path(file)
    info = file.lstat()
    if file.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ServiceError("Node state must be owner-only, not linked")
    return json.loads(file.read_text())


def prepare_cli(explicit, skill, node_id):
    """Reuse a reviewed executable or download only the checksum-pinned CLI."""
    if explicit:
        executable = Path(explicit)
        if not executable.is_absolute() or not executable.is_file() or not os.access(executable, os.X_OK):
            raise ServiceError("--devtunnel-bin must be an existing absolute executable")
        return executable.resolve()
    pin = json.loads((Path(skill) / "dependencies.json").read_text())["devTunnelCli"]["linux-x64"]
    if (pin.get("url") != "https://tunnelsassetsprod.blob.core.windows.net/cli/linux-x64-devtunnel"
            or not re.fullmatch(r"[a-f0-9]{64}", pin.get("sha256", ""))):
        raise ServiceError("A reviewed official Linux DevTunnel checksum is required")
    home = Path.home().resolve()
    root = home / ".local/share/codey-tunnel-cli" / node_id
    if root.resolve() != root or not root.is_relative_to(home):
        raise ServiceError("CLI bootstrap path is linked or outside the owner home")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise ServiceError("CLI bootstrap directory must belong only to this owner")
    executable = root / "devtunnel"
    if not executable.exists():
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=root, prefix="download-", delete=False) as output:
                temporary = Path(output.name)
                os.chmod(temporary, 0o600)
                with urllib.request.urlopen(pin["url"], timeout=120) as response:
                    if response.geturl() != pin["url"]:
                        raise ServiceError("Unexpected CLI download redirect")
                    size = 0
                    while chunk := response.read(1024 * 1024):
                        size += len(chunk)
                        if size > 96 * 1024 ** 2:
                            raise ServiceError("Unexpectedly large CLI download")
                        output.write(chunk)
            if digest(temporary) != pin["sha256"]:
                raise ServiceError("DevTunnel SHA-256 mismatch; no unpinned fallback was executed")
            os.chmod(temporary, 0o700)
            os.replace(temporary, executable)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
    if executable.is_symlink() or digest(executable) != pin["sha256"]:
        raise ServiceError("Cached DevTunnel executable changed")
    return executable


def runtime(file):
    if platform.system() != "Linux" or os.getuid() == 0:
        raise ServiceError("Run as the original non-root Linux owner")
    config = private_json(file)
    if (config.get("schema") != 1 or config.get("uid") != os.getuid()
            or config.get("tunnelAuthProvider") != "github"):
        raise ServiceError("Linux tunnel runtime owner/authentication mismatch")
    expected = Path.home().resolve() / ".config/codey-machine"
    if Path(file).resolve() != expected / "tunnel-runtime.json" or Path(config["configRoot"]) != expected:
        raise ServiceError("Unexpected Linux tunnel state directory")
    for path_key, hash_key in (("devtunnelExe", "devtunnelSha256"),
                               ("worker", "workerSha256"), ("tunnelHelper", "tunnelHelperSha256")):
        path = Path(config[path_key])
        if not path.is_absolute() or not path.is_file() or path.is_symlink() or digest(path) != config[hash_key]:
            raise ServiceError("Reviewed tunnel executable/helper changed")
    enrollment = private_json(config["enrollmentFile"])
    if (enrollment.get("nodeId") != config["nodeId"] or enrollment.get("principalId") != config["ownerId"]
            or enrollment.get("platform") != "linux-x64" or enrollment.get("network") != {"mode": "devtunnel"}):
        raise ServiceError("Tunnel runtime and enrollment differ")
    return config, enrollment


def load_client(file):
    spec = importlib.util.spec_from_file_location("codey_private_tunnel_client", file)
    client = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client)
    return client


def environment():
    # No model credentials or installing Codex task metadata go to DevTunnel.
    names = {"HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL",
             "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS",
             "SSL_CERT_FILE", "SSL_CERT_DIR"}
    return {key: value for key, value in os.environ.items()
            if key in names or key.lower() in {"https_proxy", "http_proxy", "no_proxy", "all_proxy"}}


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("host", "renew"):
        raise ServiceError("Usage: linux-tunnel-service.py host|renew tunnel-runtime.json")
    config, enrollment = runtime(sys.argv[2])
    client = load_client(config["tunnelHelper"])
    import fcntl
    with open(Path(config["configRoot"]) / ("tunnel-" + sys.argv[1] + ".lock"), "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if sys.argv[1] == "renew":
            result = client.renew(config, enrollment)
            print(json.dumps({"ok": True, "expiresAt": result["expiresAt"]}))
            return
        client.require_github_login(config["devtunnelExe"])
        client.ensure_tunnel(config["devtunnelExe"], enrollment, config["configRoot"],
                             reuse_only=True, inspect_only=True,
                             expected_binding={key: config[key] for key in ("tunnelId", "clusterId")})
        os.set_inheritable(lock.fileno(), True)
        arguments = [config["devtunnelExe"], "host", config["tunnelId"] + "." + config["clusterId"],
                     "--host-header", "unchanged", "--origin-header", "unchanged"]
        os.execve(arguments[0], arguments, environment())


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # CLI/HTTP output and credentials are never emitted by this worker.
        print(str(error) if isinstance(error, ServiceError) else
              "Private GitHub tunnel failed; inspect the owner's login and pinned runtime", file=sys.stderr)
        sys.exit(1)
