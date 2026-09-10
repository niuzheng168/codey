"""Build the pinned Linux runtime in an isolated release directory."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request

from ...common.errors import SetupError
from ...common.files import digest, protected_write
from ...common.archives import unpack


def run(args, check=True, cwd=None, env=None, log=None):
    command = [str(value) for value in args]
    if log:
        if shutil.which("nice"):
            command = ["nice", "-n", "15", *command]
        with Path(log).open("a") as output:
            result = subprocess.run(command, text=True, stdout=output, stderr=subprocess.STDOUT,
                                    cwd=cwd, env=env, timeout=1800)
    else:
        result = subprocess.run(command, text=True, capture_output=True, cwd=cwd, env=env, timeout=180)
    if check and result.returncode:
        # Never echo environment files, command output containing credentials,
        # complete process environments, or provider login output.
        if not log:
            log = Path.home() / ".config/codey-machine/last-command-error.log"
            protected_write(log, (result.stderr or "") + (result.stdout or ""))
        raise SetupError(f"{Path(str(args[0])).name} failed (exit {result.returncode}); protected diagnostic: {log}")
    return result


def prepare_runtime(manifest, enrollment, root, stage, log, *, skill):
    distribution = manifest["nodeDistribution"]
    downloads = root / "downloads"
    downloads.mkdir(exist_ok=True)
    archive = downloads / distribution["file"]
    if not archive.exists():
        temporary = archive.with_suffix(".part")
        try:
            with urllib.request.urlopen(distribution["url"], timeout=120) as response, temporary.open("wb") as output:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > 128 * 1024 * 1024:
                        raise SetupError("Unexpectedly large Node distribution")
                    output.write(chunk)
            if digest(temporary) != distribution["sha256"]:
                raise SetupError("Official Node checksum mismatch")
            os.replace(temporary, archive)
        finally:
            temporary.unlink(missing_ok=True)
    if archive.is_symlink() or digest(archive) != distribution["sha256"]:
        raise SetupError("Cached Node distribution checksum mismatch")
    prefix = f"node-v{manifest['node']}-linux-x64"
    unpack(archive, stage, (prefix,))
    os.replace(stage / prefix, stage / "node")
    for component in ["cloudcli", "copilot-api"]:
        target = stage / component
        target.mkdir()
        unpack(skill / "assets" / f"{component}-source.tar.gz", target, None)
    env = {
        **os.environ, "PATH": str(stage / "node/bin") + os.pathsep + os.environ.get("PATH", ""),
        "HUSKY": "0", "SKIP_INSTALL_SIMPLE_GIT_HOOKS": "1", "CI": "true",
        "ELECTRON_SKIP_BINARY_DOWNLOAD": "1", "npm_config_jobs": "2",
        "npm_config_audit": "false", "npm_config_fund": "false",
        "npm_config_cache": str(root / "npm-cache"),
    }
    node, npm = stage / "node/bin/node", stage / "node/bin/npm"
    tools = stage / ".build-tools"
    run([npm, "install", "--prefix", tools, "--no-audit", "--no-fund",
         f"bun@{manifest['bunBuildTool']}"], env=env, log=log)
    bun = tools / "node_modules/.bin/bun"
    copilot = stage / "copilot-api"
    run([bun, "install", "--frozen-lockfile", "--ignore-scripts"], cwd=copilot, env=env, log=log)
    run([bun, "run", "build"], cwd=copilot, env=env, log=log)
    run([bun, "install", "--frozen-lockfile", "--production", "--ignore-scripts"], cwd=copilot, env=env, log=log)
    cloudcli = stage / "cloudcli"
    run([npm, "ci", "--no-audit", "--no-fund"], cwd=cloudcli, env=env, log=log)
    build_env = {
        **env, "VITE_BASE_PATH": f"/cloudcli/{enrollment['nodeId']}/",
        "VITE_CODEY_MANAGED": "true", "VITE_CODEY_PORTAL_SSO": "true",
    }
    run([npm, "run", "build"], cwd=cloudcli, env=build_env, log=log)
    run([npm, "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=cloudcli, env=env, log=log)
    run([node, cloudcli / "node_modules/@openai/codex/bin/codex.js", "--version"], env=env, log=log)
    shutil.rmtree(tools)
    protected_write(stage / "release.json", json.dumps(manifest, indent=2) + "\n")
