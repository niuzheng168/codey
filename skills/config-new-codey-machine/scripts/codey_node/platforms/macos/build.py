"""macOS pinned Node/backend build and integrity-preserving registry mapping."""
import json
import os
from pathlib import Path
import re
import urllib.parse

from ...common.errors import ServiceError as Error
from ...common.files import digest, write_private
from ...common.archives import unpack
from .process import run


def normalize_registry(lock, registry):
    """Rebase registry tarball locations only; preserve every version/integrity."""
    target = urllib.parse.urlsplit(registry)
    if target.scheme != "https" or not target.hostname or target.username or target.password or target.query or target.fragment:
        raise Error("npm registry must be a credential-free HTTPS registry URL")
    value = json.loads(lock.read_text())
    allowed = {"registry.npmjs.org", "registry.npmmirror.com", "ms-feed-25.pkgs.visualstudio.com", target.hostname}
    for key, package in value.get("packages", {}).items():
        if not package.get("resolved"):
            continue
        source = urllib.parse.urlsplit(package["resolved"])
        if source.hostname not in allowed or source.scheme != "https" or not package.get("integrity"):
            raise Error("Unreviewed dependency source; refusing to weaken npm integrity or URL policy")
        name = key.rsplit("node_modules/", 1)[-1]
        version = package.get("version", "")
        if not re.fullmatch(r"(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+", name) or not re.fullmatch(r"\d[\w.+-]*", version):
            raise Error("Invalid locked registry package")
        package["resolved"] = registry.rstrip("/") + "/" + name + "/-/" + name.rsplit("/", 1)[-1] + "-" + version + ".tgz"
    write_private(lock, value)


def build_runtime(manifest, root, release, registry, log, *, skill):
    distribution = manifest["nodeDistribution"]
    archive = root / distribution["file"]
    if not archive.exists():
        part = archive.with_suffix(".part")
        run(["curl", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
             "--max-time", "180", "--output", str(part), distribution["url"]], log=log)
        if digest(part) != distribution["sha256"]:
            raise Error("Node distribution SHA-256 mismatch")
        os.replace(part, archive)
    if archive.is_symlink() or digest(archive) != distribution["sha256"]:
        raise Error("Cached Node distribution is invalid")
    release.mkdir(mode=0o700)
    prefix = distribution["file"].removesuffix(".tar.gz")
    unpack(archive, release, (prefix,))
    os.replace(release / prefix, release / "node")
    for component, name in (("cloudcli", "cloudcli-source.tar.gz"), ("portal-node", "portal-node-source.tar.gz")):
        destination = release / component
        destination.mkdir()
        unpack(skill / "assets" / name, destination, None)
    node = release / "node/bin/node"
    npm = release / "node/lib/node_modules/npm/bin/npm-cli.js"
    cloudcli = release / "cloudcli"
    normalize_registry(cloudcli / "package-lock.json", registry)
    env = {key: value for key, value in os.environ.items()
           if key in {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "DEVELOPER_DIR"}
           or key.lower() in {"http_proxy", "https_proxy", "no_proxy", "all_proxy"}}
    env.update({
        "PATH": str(node.parent) + ":" + os.environ.get("PATH", "/usr/bin:/bin"),
        "HUSKY": "0", "ELECTRON_SKIP_BINARY_DOWNLOAD": "1", "CI": "true",
        "npm_config_cache": str(root / "npm-cache"), "npm_config_registry": registry,
        "npm_config_audit": "false", "npm_config_fund": "false",
        "npm_config_maxsockets": "4", "npm_config_replace_registry_host": "never",
    })
    run([node, npm, "ci", "--no-audit", "--no-fund"], cwd=cloudcli, env=env, log=log)
    validation_home = root / "validation-home"
    validation_home.mkdir(exist_ok=True, mode=0o700)
    test_env = {**env, "HOME": str(validation_home), "TMPDIR": "/tmp",
                "CODEY_CODEX_DAEMON_SOCKET": ""}
    run([node, cloudcli / "node_modules/tsx/dist/cli.mjs", "--tsconfig", "server/tsconfig.json",
         "--test", "--test-concurrency=2",
         "server/modules/providers/tests/codex-windows-history.test.ts",
         "server/modules/providers/tests/codex-macos-transport.test.ts",
         "server/modules/providers/tests/codex-daemon-interop.test.ts",
         "server/modules/providers/tests/codex-steering.test.ts",
         "server/modules/auth/tests/portal-sso.service.test.ts",
         "server/modules/websocket/tests/portal-sso-websocket.test.ts",
         "server/modules/websocket/tests/shell-websocket.service.test.ts"],
        cwd=cloudcli, env=test_env, log=log)
    run([node, npm, "run", "typecheck"], cwd=cloudcli, env=test_env, log=log)
    run([node, npm, "run", "lint"], cwd=cloudcli, env=test_env, log=log)
    # Portal serves the already reviewed shared UI. Do not rebuild/replace it on this Mac.
    run([node, npm, "run", "build:server"], cwd=cloudcli, env=env, log=log)
    run([node, npm, "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=cloudcli, env=env, log=log)
    write_private(release / "release.json", manifest)
