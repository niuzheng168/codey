"""Original-owner Linux tunnel hosting and periodic renewal."""
import json
import os
from pathlib import Path
import platform

from ...common.errors import ServiceError
from ...common.files import digest, private_json
from ...devtunnel import auth, binding as tunnels, renewal
from ...service.launcher import validate_files


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
    validate_files(config["pythonRuntime"], "linux")
    if config["worker"] != config["pythonRuntime"]["entrypoint"]:
        raise ServiceError("Unexpected Linux service entrypoint")
    path = Path(config["devtunnelExe"])
    if not path.is_absolute() or not path.is_file() or path.is_symlink() or digest(path) != config["devtunnelSha256"]:
        raise ServiceError("Reviewed DevTunnel executable changed")
    enrollment = private_json(config["enrollmentFile"])
    if (enrollment.get("nodeId") != config["nodeId"] or enrollment.get("principalId") != config["ownerId"]
            or enrollment.get("platform") != "linux-x64" or enrollment.get("network") != {"mode": "devtunnel"}):
        raise ServiceError("Tunnel runtime and enrollment differ")
    return config, enrollment


def serve(config_file, component):
    config, enrollment = runtime(config_file)
    import fcntl
    with open(Path(config["configRoot"]) / ("tunnel-" + component + ".lock"), "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if component == "renew":
            result = renewal.renew(config, enrollment)
            print(json.dumps({"ok": True, "expiresAt": result["expiresAt"]}))
            return
        auth.require_github_login(config["devtunnelExe"])
        tunnels.ensure_tunnel(config["devtunnelExe"], enrollment, config["configRoot"],
                             reuse_only=True, inspect_only=True,
                             expected_binding={key: config[key] for key in ("tunnelId", "clusterId")})
        os.set_inheritable(lock.fileno(), True)
        arguments = [config["devtunnelExe"], "host", config["tunnelId"] + "." + config["clusterId"],
                     "--host-header", "unchanged", "--origin-header", "unchanged"]
        os.execve(arguments[0], arguments, auth.cli_environment())
