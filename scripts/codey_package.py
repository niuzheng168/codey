"""Build the single Codey npm application; component repositories are build inputs only."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from urllib.parse import urlsplit
import zlib

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "packages/codey"
RUNTIME_PLATFORMS = ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]
TEXT_SUFFIXES = {".js", ".mjs", ".cjs", ".json", ".map", ".md", ".html", ".css", ".svg", ".txt", ".sh", ".ps1"}


def validate_runtime_lock(package, lock):
    if (lock.get("name") != "codey" or lock.get("version") != package["version"]
            or lock.get("lockfileVersion") != 3 or "os" in package or "cpu" in package):
        raise RuntimeError("Use the one platform-neutral Codey manifest and lock")
    root = lock.get("packages", {}).get("", {})
    if root.get("name") != "codey" or root.get("version") != package["version"]:
        raise RuntimeError("Codey lock root does not match the package")
    for group in ("dependencies", "optionalDependencies"):
        if package.get(group, {}) != root.get(group, {}):
            raise RuntimeError("Codey manifest and dependency lock differ")
    for name, item in lock.get("packages", {}).items():
        if not name:
            continue
        url = urlsplit(item.get("resolved", ""))
        if (item.get("link") or url.scheme != "https" or url.hostname != "registry.npmjs.org"
                or url.port not in (None, 443) or url.username or url.password or url.query or url.fragment
                or not re.match(r"sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}(?:\s|$)", item.get("integrity", ""))):
            raise RuntimeError("Use the shared public npm lock; private feed or local dependency found")


def normalize_runtime_text(runtime):
    """The release's bytes must not depend on checkout CRLF conventions."""
    for file in runtime.rglob("*"):
        if not file.is_file() or "node_modules" in file.relative_to(runtime).parts:
            continue
        if file.suffix in TEXT_SUFFIXES or "LICENSE" in file.name:
            body = file.read_bytes()
            if b"\r\n" in body:
                file.write_bytes(body.replace(b"\r\n", b"\n"))


def write_runtime_installer(output, artifact):
    source = (ROOT / "scripts/install-codey-runtime.mjs").read_text()
    for marker, value in [
        ('const DEFAULT_PACKAGE_FILE = "";', artifact["file"]),
        ('const DEFAULT_PACKAGE_SHA256 = "";', artifact["sha256"]),
    ]:
        if source.count(marker) != 1:
            raise RuntimeError("Invalid shared runtime installer template")
        source = source.replace(marker, marker.split(" = ")[0] + " = " + json.dumps(value) + ";")
    installer = output / "install-codey.mjs"
    installer.write_text(source, newline="\n")
    (output / (artifact["file"] + ".sha256")).write_text(
        f"{artifact['sha256']}  {artifact['file']}\n", newline="\n")
    return metadata(installer)


def run(args, *, cwd=None, env=None, capture=False):
    return subprocess.run(
        [str(value) for value in args], cwd=cwd, env=env, check=True,
        text=True, stdout=subprocess.PIPE if capture else None,
    )


def metadata(file):
    digest, crc, size = hashlib.sha256(), 0, 0
    with Path(file).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            crc = zlib.crc32(chunk, crc)
            size += len(chunk)
    return {"file": Path(file).name, "sha256": digest.hexdigest(), "crc32": crc, "size": size}


def source(repo, destination, allow_dirty):
    commit = run(["git", "-C", repo, "rev-parse", "HEAD"], capture=True).stdout.strip()
    patch = subprocess.check_output(["git", "-C", str(repo), "diff", "--binary", "HEAD", "--"])
    if patch and not allow_dirty:
        raise RuntimeError(f"{repo.name} has local modifications; review and commit them first")
    destination.mkdir()
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "-C", str(repo), "archive", "HEAD"], stdout=archive, check=True)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as package:
            package.extractall(destination, filter="data")
    if patch:
        # This archive may sit inside the outer Codey checkout. Without a discovery
        # ceiling git apply silently skips paths outside that repository's cwd prefix.
        patch_env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(destination.parent.resolve())}
        subprocess.run(["git", "apply", "-"], input=patch, cwd=destination, env=patch_env, check=True)
    package = json.loads((destination / "package.json").read_text())
    return {
        "commit": commit, "version": package["version"],
        "patchSha256": hashlib.sha256(patch).hexdigest() if patch else None,
    }


def copy_required(source_root, destination, names):
    destination.mkdir(parents=True, exist_ok=True)
    for name in names:
        file = source_root / name
        if not file.exists():
            raise RuntimeError(f"Missing build output: {file}")
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if file.is_dir():
            shutil.copytree(file, target)
        else:
            shutil.copy2(file, target)


def official_node(work, version):
    filename = f"node-v{version}-linux-x64.tar.xz"
    url = f"https://nodejs.org/dist/v{version}/{filename}"
    with urllib.request.urlopen(f"https://nodejs.org/dist/v{version}/SHASUMS256.txt", timeout=60) as response:
        sums = response.read().decode()
    checksum = next(line.split()[0] for line in sums.splitlines() if line.split()[-1] == filename)
    archive = work / filename
    with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as output:
        shutil.copyfileobj(response, output)
    if metadata(archive)["sha256"] != checksum:
        raise RuntimeError("Official Node checksum mismatch")
    with tarfile.open(archive) as package:
        package.extractall(work, filter="data")
    return work / f"node-v{version}-linux-x64", {"file": filename, "url": url, "sha256": checksum}


def validate_dependencies(package, cloud, copilot):
    """A source dependency change must be reviewed in the one production lockfile."""
    for group in ("dependencies", "optionalDependencies"):
        expected = {}
        for component in (cloud, copilot):
            for name, spec in component.get(group, {}).items():
                if name in {"@openai/codex", "@openai/codex-sdk"}:
                    # Bundle the locked SDK's JS, not its transitive native Codex runtime.
                    continue
                if name in expected and expected[name] != spec:
                    raise RuntimeError(f"Resolve the shared dependency conflict before building: {name}")
                expected[name] = spec
        if package.get(group, {}) != expected:
            raise RuntimeError(f"Update packages/codey/{group} and its lockfile for the reviewed sources")
    forbidden = {"@cloudcli-ai/cloudcli", "@jeffreycao/copilot-api", "@openai/codex", "@openai/codex-sdk"}
    if forbidden.intersection(package.get("dependencies", {})):
        raise RuntimeError("Codey must compile the apps, not depend on their npm packages")


def compile_sources(cloud, copilot, runtime, node, work, version, env):
    run([node / "bin/npm", "ci", "--no-audit", "--no-fund"], cwd=cloud, env=env)
    # Vite embeds this version; keep the workspace UI and running npm application in sync.
    cloud_package = cloud / "package.json"
    document = json.loads(cloud_package.read_text())
    document["version"] = version
    cloud_package.write_text(json.dumps(document, indent=2) + "\n")
    run([node / "bin/npm", "run", "build"], cwd=cloud, env={
        **env, "VITE_BASE_PATH": "/", "VITE_CODEY_MANAGED": "true", "VITE_CODEY_PORTAL_SSO": "false",
    })
    copy_required(cloud, runtime, ["dist", "dist-server", "public", "shared"])
    sdk = cloud / "node_modules/@openai/codex-sdk"
    shutil.copytree(sdk / "dist", runtime / "lib/codex-sdk")
    # Rewrite only generated module specifiers. The upstream worktree stays untouched;
    # the SDK is an internal JS module, not a second installed Codex executable.
    for file in (runtime / "dist-server").rglob("*.js"):
        text = file.read_text()
        rewritten = re.sub(r"""(['"])@openai/codex-sdk\1""", r"\1#codey/codex-sdk\1", text)
        if rewritten != text:
            file.write_text(rewritten)
    tools = work / "bun-tools"
    run([node / "bin/npm", "install", "--prefix", tools, "--no-audit", "--no-fund", "bun@1.4.2"], env=env)
    bun = tools / "node_modules/.bin/bun"
    run([bun, "install", "--frozen-lockfile", "--ignore-scripts"], cwd=copilot, env=env)
    run([bun, "run", "build"], cwd=copilot, env=env)
    # Both entrypoints now resolve the SAME root package.json and node_modules.
    shutil.copytree(copilot / "dist", runtime / "gateway")
    copy_required(copilot, runtime, ["pages"])
    return {"version": json.loads((sdk / "package.json").read_text())["version"]}


def content_digest(runtime):
    digest = hashlib.sha256()
    for file in sorted(runtime.rglob("*")):
        relative = file.relative_to(runtime)
        if "node_modules" in relative.parts or relative.as_posix() == "codey-build.json" or not file.is_file():
            continue
        digest.update(relative.as_posix().encode() + b"\0")
        digest.update(bytes.fromhex(metadata(file)["sha256"]))
    return digest.hexdigest()


def inspect_npm_package(file):
    """Check the npm layout without extracting files or executing package code."""
    required = {
        "package/package.json", "package/npm-shrinkwrap.json", "package/bin/codey.mjs",
        "package/lib/cli.mjs", "package/codey-build.json", "package/dist-server/server/index.js",
        "package/lib/doctor.mjs", "package/lib/package-info.mjs",
        "package/lib/codex-sdk/index.js",
        "package/dist/index.html", "package/gateway/main.js", "package/pages/index.html",
        "package/updater/install.py", "package/updater/engine.py", "package/updater/updater.py",
    }
    options = {"fileobj": file} if hasattr(file, "read") else {"name": file}
    with tarfile.open(mode="r:gz", **options) as archive:
        files, expanded = set(), 0
        for item in archive:
            name = PurePosixPath(item.name)
            expanded += item.size
            if (not name.parts or name.parts[0] != "package" or name.is_absolute()
                    or ".." in name.parts or "\\" in item.name or ":" in item.name
                    or not (item.isfile() or item.isdir()) or name.as_posix() in files
                    or expanded > 512 * 1024 * 1024 or len(files) >= 100000):
                raise RuntimeError("Unsafe Codey npm package")
            files.add(name.as_posix())
            if item.isfile():
                prefix = archive.extractfile(item).read(4)
                if (name.suffix.lower() in {".node", ".exe", ".dll", ".so", ".dylib"}
                        or prefix == b"\x7fELF" or prefix[:2] == b"MZ"):
                    raise RuntimeError("Shared Codey packages must not bundle platform-native binaries")
        if not required.issubset(files) or any(
            "/node_modules/" in name or name.endswith((".tgz", ".tar.gz"))
            or (name.endswith("/package.json") and name != "package/package.json") for name in files
        ):
            raise RuntimeError("Codey npm package has missing files or embeds another application package")

        def body(name, limit):
            member = archive.getmember("package/" + name)
            if not member.isfile() or member.size > limit:
                raise RuntimeError("Invalid Codey npm metadata")
            return archive.extractfile(member).read()

        package = json.loads(body("package.json", 65536))
        lock_raw = body("npm-shrinkwrap.json", 4 * 1024 * 1024)
        build_raw = body("codey-build.json", 16384)
        lock, build = json.loads(lock_raw), json.loads(build_raw)
        if (not all(isinstance(value, dict) for value in [package, lock, build])
                or package.get("name") != "codey" or not re.fullmatch(
                r"\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?", package.get("version", ""))
                or package.get("bin") != {"codey": "bin/codey.mjs"}
                or package.get("type") != "module"
                or package.get("imports") != {"#codey/codex-sdk": "./lib/codex-sdk/index.js"}
                or lock.get("name") != "codey" or lock.get("version") != package["version"]
                or build.get("schema") != 1 or build.get("name") != "codey" or build.get("version") != package["version"]
                or build.get("lockSha256") != hashlib.sha256(lock_raw).hexdigest()):
            raise RuntimeError("Invalid Codey npm metadata")
        validate_runtime_lock(package, lock)
        if build.get("runtimePlatforms") != RUNTIME_PLATFORMS or "platform" in build:
            raise RuntimeError("Codey must declare one shared Linux/Windows/macOS runtime, not a build-host platform")
        for group in ("dependencies", "optionalDependencies"):
            deps = package.get(group, {})
            if (deps != lock.get("packages", {}).get("", {}).get(group, {})
                    or {"@cloudcli-ai/cloudcli", "@jeffreycao/copilot-api", "@openai/codex", "@openai/codex-sdk"}.intersection(deps)):
                raise RuntimeError("Codey must have one unified runtime dependency lock")
        return {
            "version": package["version"], "commit": build["sourceCommit"],
            "entrySha256": hashlib.sha256(build_raw).hexdigest(),
            "lockSha256": hashlib.sha256(lock_raw).hexdigest(),
        }


def pack_runtime(runtime, output, node, env):
    # npm, not a hand-made tar, defines the installable package format and file list.
    rows = json.loads(run([
        node / "bin/npm", "pack", "--json", "--ignore-scripts", "--pack-destination", output,
    ], cwd=runtime, env=env, capture=True).stdout)
    if len(rows) != 1 or rows[0]["name"] != "codey" or rows[0].get("bundled"):
        raise RuntimeError("Expected exactly one unbundled Codey npm package")
    package = output / rows[0]["filename"]
    inspect_npm_package(package)
    return metadata(package)


def build_package(output, *, allow_reviewed_diff=False, node_dir=None, keep_work=False, setup_config=None):
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("Build and validate Codey on Linux x86_64")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / "codey-package.json").exists() or (output / "manifest.json").exists():
        raise RuntimeError("Choose a new output directory")
    work = output / ".build-codey"
    work.mkdir()
    dependencies = json.loads((ROOT / "skills/config-new-codey-machine/dependencies.json").read_text())
    if node_dir:
        node, distribution = Path(node_dir).resolve(), None
    else:
        node, distribution = official_node(work, dependencies["node"]["version"])
    env = {
        **os.environ, "PATH": str(node / "bin") + os.pathsep + os.environ.get("PATH", ""),
        "HUSKY": "0", "SKIP_INSTALL_SIMPLE_GIT_HOOKS": "1", "CI": "true",
        "ELECTRON_SKIP_BINARY_DOWNLOAD": "1", "npm_config_audit": "false", "npm_config_fund": "false",
    }
    node_version = run([node / "bin/node", "-p", "process.versions.node"], env=env, capture=True).stdout.strip()
    cloud, copilot = work / "cloudcli-source", work / "copilot-source"
    cloud_info = source(ROOT / "cloudcli", cloud, allow_reviewed_diff)
    copilot_info = source(ROOT / "copilot-api", copilot, allow_reviewed_diff)
    cloud_info["repository"] = "https://github.com/niuzheng168/claudecodeui.git"
    copilot_info["repository"] = "https://github.com/niuzheng168/copilot-api.git"
    package = json.loads((PACKAGE / "package.json").read_text())
    locked_bytes = (PACKAGE / "package-lock.json").read_bytes().replace(b"\r\n", b"\n")
    validate_runtime_lock(package, json.loads(locked_bytes))
    validate_dependencies(package, json.loads((cloud / "package.json").read_text()),
                          json.loads((copilot / "package.json").read_text()))
    runtime = work / "codey"
    copy_required(PACKAGE, runtime, [
        "package.json", "bin", "lib", "README.md", "scripts",
    ])
    (runtime / "npm-shrinkwrap.json").write_bytes(locked_bytes)
    sdk_info = compile_sources(cloud, copilot, runtime, node, work, package["version"], env)
    copy_required(ROOT / "node-updater", runtime / "updater", [
        "install.py", "updater.py", "engine.py", "probe.mjs", "UPGRADE.md",
    ])
    copy_required(ROOT / "skills/config-new-codey-machine", runtime / "onboarding", [
        "scripts/install.sh", "templates/a100-models.json", "dependencies.json",
    ])
    if setup_config is not None:
        (runtime / "onboarding/setup.json").write_text(json.dumps(setup_config, indent=2) + "\n")
    shutil.copy2(cloud / "LICENSE", runtime / "LICENSE")
    (runtime / "licenses").mkdir()
    shutil.copy2(cloud / "LICENSE", runtime / "licenses/cloudcli-LICENSE")
    shutil.copy2(copilot / "LICENSE", runtime / "licenses/copilot-api-LICENSE")
    shutil.copy2(cloud / "node_modules/@openai/codex-sdk/LICENSE", runtime / "licenses/codex-sdk-LICENSE")
    normalize_runtime_text(runtime)
    run([node / "bin/npm", "ci", "--omit=dev", "--no-audit", "--no-fund",
         "--registry=https://registry.npmjs.org"], cwd=runtime, env=env)
    if (runtime / "npm-shrinkwrap.json").read_bytes() != locked_bytes:
        raise RuntimeError("npm changed the canonical shared dependency lock")
    source_commit = run(["git", "-C", ROOT, "rev-parse", "HEAD"], capture=True).stdout.strip()
    source_dirty = bool(run([
        "git", "-C", ROOT, "status", "--porcelain", "--",
        "packages/codey", "scripts/codey_package.py", "scripts/build-machine-bundle.py",
        "scripts/install-codey-runtime.mjs", "node-updater", "skills/config-new-codey-machine",
    ], capture=True).stdout.strip())
    provenance = {
        "schema": 1, "name": "codey", "version": package["version"], "sourceCommit": source_commit,
        "sourceDirty": source_dirty,
        "runtimePlatforms": RUNTIME_PLATFORMS,
        "cloudcli": cloud_info, "copilotApi": copilot_info, "codexSdk": sdk_info,
        "lockSha256": metadata(runtime / "npm-shrinkwrap.json")["sha256"],
        "workspaceEntrySha256": metadata(runtime / "dist-server/server/index.js")["sha256"],
        "gatewayEntrySha256": metadata(runtime / "gateway/main.js")["sha256"],
        "contentSha256": content_digest(runtime),
    }
    (runtime / "codey-build.json").write_text(json.dumps(provenance, indent=2) + "\n")
    home = work / "smoke-home"
    home.mkdir()
    smoke_env = {**env, "HOME": str(home), "COPILOT_API_HOME": str(home / "copilot-api")}
    for args in (["--version"], ["--help"], ["gateway", "--help"], ["workspace", "--help"],
                 ["setup", "--help"], ["doctor", "--json"]):
        run([node / "bin/node", runtime / "bin/codey.mjs", *args], cwd=runtime, env=smoke_env)
    if setup_config is not None:
        # A build tree is deliberately not an installed HOME prefix. Validate
        # embedded configuration here; the real npm-install test checks the CLI.
        run([node / "bin/node", "--input-type=module", "-e",
             "import {installedSetup} from './lib/setup.mjs'; await installedSetup(process.cwd());"],
            cwd=runtime, env=smoke_env)
    run([node / "bin/node", runtime / "bin/codey.mjs", "gateway", "debug", "--json"],
        cwd=runtime, env=smoke_env)
    gateway_defaults = json.loads((home / "copilot-api/config.json").read_text())
    if gateway_defaults.get("useResponsesApiWebSocket") is not False:
        raise RuntimeError("Codey gateway must default useResponsesApiWebSocket to false")
    run([node / "bin/node", "-e",
         "require('better-sqlite3')(':memory:').close();"
         "const p=require('node-pty').spawn('/bin/sh',['-c','exit 0'],{env:process.env});"
         "p.onExit(e=>process.exit(e.exitCode));setTimeout(()=>process.exit(1),5000).unref();"],
        cwd=runtime, env=smoke_env)
    artifact = pack_runtime(runtime, output, node, env)
    result = {
        "schema": 1, "name": "codey", "node": node_version, "nodeDistribution": distribution,
        "runtimePlatforms": RUNTIME_PLATFORMS,
        "bunBuildTool": "1.4.2", "cloudcli": cloud_info, "copilotApi": copilot_info,
        "codey": {
            "version": package["version"], "commit": source_commit,
            "entrySha256": metadata(runtime / "codey-build.json")["sha256"],
            "lockSha256": provenance["lockSha256"],
        },
        "artifact": artifact,
        "runtimeInstaller": write_runtime_installer(output, artifact),
    }
    (output / "codey-package.json").write_text(json.dumps(result, indent=2) + "\n")
    if not keep_work:
        shutil.rmtree(work)
    return result
