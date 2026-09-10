"""Build a pinned native Windows backend without changing the model proxy."""
import os
from pathlib import Path
import sys

from ...common.files import write_state
from . import helpers as windows, archives
from .cli import download
from .process import run


def build_runtime(manifest, root, stage, log, *, skill):
    archive = root / manifest["nodeDistribution"]["file"]
    download(manifest["nodeDistribution"]["url"], archive, expected=manifest["nodeDistribution"]["sha256"])
    prefix = manifest["nodeDistribution"]["file"].removesuffix(".zip")
    archives.extract_zip(archive, stage, prefix)
    os.replace(windows.within(stage / prefix, root), windows.within(stage / "node", root))
    for name, file in (("cloudcli", "cloudcli-source.tar.gz"), ("portal-node", "portal-node-source.tar.gz")):
        target = stage / name
        target.mkdir()
        archives.extract_source(skill / "assets" / file, target)
    node = stage / "node/node.exe"
    npm = stage / "node/node_modules/npm/bin/npm-cli.js"
    cloudcli = stage / "cloudcli"
    allow = {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
        "PROGRAMFILES", "PROGRAMFILES(X86)", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE", "VSINSTALLDIR", "VCINSTALLDIR", "INCLUDE", "LIB", "LIBPATH",
        "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    }
    env = {key: value for key, value in windows.child_environment().items() if key.upper() in allow}
    env.update({
        "PATH": str(node.parent) + os.pathsep + str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
        "HUSKY": "0", "ELECTRON_SKIP_BINARY_DOWNLOAD": "1", "CI": "true",
        "npm_config_cache": str(root / "npm-cache"), "npm_config_audit": "false", "npm_config_fund": "false",
        "npm_config_maxsockets": "4",
    })
    run([node, npm, "ci", "--no-audit", "--no-fund"], cwd=cloudcli, env=env, log=log)
    # The shared Portal UI is independently deployed; build the node backend only.
    run([node, npm, "run", "build:server"], cwd=cloudcli, env=env, log=log)
    run([node, "-e", "const D=require('better-sqlite3');const d=new D(':memory:');d.exec('select 1');d.close();require('node-pty')"],
        cwd=cloudcli, env=env, log=log)
    run([node, npm, "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd=cloudcli, env=env, log=log)
    write_state(stage / "release.json", manifest)
