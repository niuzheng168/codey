#!/usr/bin/env python3
"""Build the Linux one-click package payloads from the current reviewed sources."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
CLOUDCLI_SERVER_RUNTIME_DEPENDENCIES = [
    "@iarna/toml", "@octokit/rest", "@openai/codex-sdk", "@vscode/ripgrep",
    "bcrypt", "better-sqlite3", "chokidar", "cors", "cross-spawn", "express",
    "gray-matter", "ignore", "jsonwebtoken", "mime-types", "multer", "node-pty",
    "web-push", "ws",
]


def run(args, *, cwd=None, env=None):
    subprocess.run([str(value) for value in args], cwd=cwd, env=env, check=True)


def metadata(file):
    digest, crc, size = hashlib.sha256(), 0, 0
    with Path(file).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            crc = zlib.crc32(chunk, crc)
            size += len(chunk)
    return {"file": Path(file).name, "sha256": digest.hexdigest(), "crc32": crc, "size": size}


def source(repo, destination, allow_dirty):
    commit = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
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
        subprocess.run(["git", "apply", "-"], input=patch, cwd=destination, check=True)
    package = json.loads((destination / "package.json").read_text())
    return {
        "commit": commit,
        "version": package["version"],
        "patchSha256": hashlib.sha256(patch).hexdigest() if patch else None,
    }


def archive_tree(source_dir, destination):
    with Path(destination).open("wb") as output, gzip.GzipFile(
        fileobj=output, mode="wb", mtime=0, filename=""
    ) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for file in sorted(Path(source_dir).rglob("*")):
                info = archive.gettarinfo(str(file), arcname="./" + file.relative_to(source_dir).as_posix())
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ""
                info.pax_headers = {}
                if info.isfile():
                    with file.open("rb") as stream:
                        archive.addfile(info, stream)
                else:
                    archive.addfile(info)


def copy_required(source_root, destination, names):
    destination.mkdir()
    for name in names:
        source_file = source_root / name
        if not source_file.exists():
            raise RuntimeError(f"Missing build output: {source_file}")
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if source_file.is_dir():
            shutil.copytree(source_file, target)
        else:
            shutil.copy2(source_file, target)


def official_node(work, version):
    filename = f"node-v{version}-linux-x64.tar.xz"
    url = f"https://nodejs.org/dist/v{version}/{filename}"
    with urllib.request.urlopen(f"https://nodejs.org/dist/v{version}/SHASUMS256.txt", timeout=60) as response:
        sums = response.read().decode()
    checksum = next(line.split()[0] for line in sums.splitlines() if line.split()[-1] == filename)
    archive = work / filename
    with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as output:
        shutil.copyfileobj(response, output)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
        raise RuntimeError("Official Node checksum mismatch")
    with tarfile.open(archive) as package:
        package.extractall(work, filter="data")
    return work / f"node-v{version}-linux-x64", {
        "file": filename, "url": url, "sha256": checksum,
    }


def build_copilot(source_root, output, node, bun_version, env):
    tools = output.parent / "bun-tools"
    run([node / "bin/npm", "install", "--prefix", tools, "--no-audit", "--no-fund", f"bun@{bun_version}"], env=env)
    bun = tools / "node_modules/.bin/bun"
    run([bun, "install", "--frozen-lockfile", "--ignore-scripts"], cwd=source_root, env=env)
    run([bun, "run", "build"], cwd=source_root, env=env)
    copy_required(source_root, output, ["dist", "pages", "package.json", "bun.lock"])
    run([bun, "install", "--cwd", output, "--frozen-lockfile", "--production", "--ignore-scripts"], env=env)
    run([node / "bin/node", output / "dist/main.js", "--help"], env=env)
    shutil.rmtree(tools)


def resolve_cloudcli_profile(dependencies, requested):
    config = dependencies.get("cloudcliBuild", {})
    name = requested or config.get("defaultProfile")
    profiles = config.get("profiles", {})
    if name not in profiles:
        raise RuntimeError(f"Unknown CloudCLI profile: {name}")
    profile = profiles[name]
    providers = profile.get("enabledProviders")
    runtime_dependencies = config.get("serverRuntimeDependencies")
    provider_dependencies = profile.get("providerDependencies")
    if not isinstance(providers, list) or not providers or len(set(providers)) != len(providers):
        raise RuntimeError(f"Invalid enabled providers for CloudCLI profile {name}")
    if runtime_dependencies != CLOUDCLI_SERVER_RUNTIME_DEPENDENCIES:
        raise RuntimeError("CloudCLI server runtime dependency allowlist was changed without builder review")
    expected = {
        "codex-only": (["codex"], []),
        "full": (["claude", "codex", "cursor", "opencode"], ["@anthropic-ai/claude-agent-sdk"]),
    }
    if name not in expected or (providers, provider_dependencies) != expected[name]:
        raise RuntimeError(f"Unsupported CloudCLI profile definition: {name}")
    return {
        "name": name,
        "enabledProviders": providers,
        "runtimeDependencies": [*runtime_dependencies, *provider_dependencies],
        "providerDependencies": provider_dependencies,
    }


def configure_cloudcli_dependencies(output, profile, node, env):
    package_file = output / "package.json"
    package = json.loads(package_file.read_text())
    original = package.get("dependencies", {})
    included = profile["runtimeDependencies"]
    missing = [name for name in included if name not in original]
    if missing:
        raise RuntimeError(f"CloudCLI runtime dependencies are missing: {', '.join(missing)}")
    excluded = sorted(set(original) - set(included))
    package["dependencies"] = {name: original[name] for name in included}
    package.pop("devDependencies", None)
    package.pop("optionalDependencies", None)
    package_file.write_text(json.dumps(package, indent=2) + "\n")
    run([
        node / "bin/npm", "install", "--package-lock-only", "--ignore-scripts",
        "--no-audit", "--no-fund",
    ], cwd=output, env=env)
    lock = json.loads((output / "package-lock.json").read_text())
    packages = lock.get("packages", {})
    root = packages.get("", {})
    if set(root.get("dependencies", {})) != set(included) or any(
        root.get(name) for name in ("devDependencies", "optionalDependencies")
    ):
        raise RuntimeError("Pruned CloudCLI lock does not match the runtime dependency allowlist")
    if profile["name"] == "codex-only" and any(
        name.startswith("node_modules/@anthropic-ai/") for name in packages
    ):
        raise RuntimeError("Pruned CloudCLI lock still contains Anthropic packages")
    return excluded


def build_cloudcli(source_root, output, node, env, profile):
    run([node / "bin/npm", "ci", "--no-audit", "--no-fund"], cwd=source_root, env=env)
    build_env = {**env, "VITE_BASE_PATH": "/", "VITE_CODEY_MANAGED": "true", "VITE_CODEY_PORTAL_SSO": "true"}
    run([node / "bin/npm", "run", "build"], cwd=source_root, env=build_env)
    copy_required(source_root, output, [
        "dist", "dist-server", "public", "shared", "package.json", "package-lock.json", "scripts/fix-node-pty.js",
    ])
    package_file = output / "package.json"
    package = json.loads(package_file.read_text())
    for name in ("prepare", "postinstall", "prepublishOnly"):
        package.get("scripts", {}).pop(name, None)
    package_file.write_text(json.dumps(package, indent=2) + "\n")
    excluded_dependencies = configure_cloudcli_dependencies(output, profile, node, env)
    run([node / "bin/npm", "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=output, env=env)
    for relative in [
        "node_modules/@openai/codex", "node_modules/@openai/codex-linux-x64",
        "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl",
        "node_modules/lightningcss-linux-x64-musl", "node_modules/@rollup/rollup-linux-x64-musl",
        "node_modules/@oxc-resolver/binding-linux-x64-musl", "node_modules/@oxc-parser/binding-linux-x64-musl",
        "node_modules/react-doctor/node_modules/@oxlint/binding-linux-x64-musl",
    ]:
        shutil.rmtree(output / relative, ignore_errors=True)
    if (output / "node_modules/@openai/codex-linux-x64").exists():
        raise RuntimeError("CloudCLI payload still contains a Codex runtime")
    anthropic = output / "node_modules/@anthropic-ai"
    if profile["name"] == "codex-only" and anthropic.exists():
        raise RuntimeError("Codex-only CloudCLI payload still contains Anthropic packages")
    if profile["name"] == "full" and not (anthropic / "claude-agent-sdk").exists():
        raise RuntimeError("Full CloudCLI payload is missing the Claude SDK")
    script = (
        "require('better-sqlite3')(':memory:').close();"
        "const p=require('node-pty').spawn('/bin/sh',['-c','exit 0'],{env:process.env});"
        "p.onExit(e=>process.exit(e.exitCode));setTimeout(()=>process.exit(1),5000).unref();"
    )
    run([node / "bin/node", "-e", script], cwd=output, env=env)
    registry_smoke = (
        "const {providerRegistry}=await import('./dist-server/server/modules/providers/provider.registry.js');"
        f"const expected={json.dumps(profile['enabledProviders'])};"
        "if(providerRegistry.profile!==process.env.CLOUDCLI_PROVIDER_PROFILE"
        "||JSON.stringify(providerRegistry.listProviderIds())!==JSON.stringify(expected))process.exit(2);"
    )
    run(
        [node / "bin/node", "--input-type=module", "-e", registry_smoke],
        cwd=output,
        env={**env, "CLOUDCLI_PROVIDER_PROFILE": profile["name"]},
    )
    return {
        "profile": profile["name"],
        "enabledProviders": profile["enabledProviders"],
        "runtimeDependencies": profile["runtimeDependencies"],
        "providerDependencies": profile["providerDependencies"],
        "excludedDependencies": excluded_dependencies,
    }


def build(args):
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("Build Linux payloads on Linux x86_64")
    dependencies = json.loads((ROOT / "skills/config-new-codey-machine/dependencies.json").read_text())
    cloudcli_profile = resolve_cloudcli_profile(dependencies, args.cloudcli_profile)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / "manifest.json").exists():
        raise RuntimeError("Choose a new output directory")
    work = output / ".build"
    work.mkdir()
    node, distribution = official_node(work, dependencies["node"]["version"])
    env = {
        **os.environ,
        "PATH": str(node / "bin") + os.pathsep + os.environ.get("PATH", ""),
        "HUSKY": "0", "SKIP_INSTALL_SIMPLE_GIT_HOOKS": "1", "CI": "true",
        "ELECTRON_SKIP_BINARY_DOWNLOAD": "1", "npm_config_audit": "false", "npm_config_fund": "false",
        "npm_config_cache": str(work / "npm-cache"),
    }
    cloud_source, copilot_source = work / "cloudcli-source", work / "copilot-source"
    cloud_info = source(ROOT / "cloudcli", cloud_source, args.allow_reviewed_diff)
    copilot_info = source(ROOT / "copilot-api", copilot_source, args.allow_reviewed_diff)
    cloud_info["repository"] = "https://github.com/niuzheng168/claudecodeui.git"
    copilot_info["repository"] = "https://github.com/niuzheng168/copilot-api.git"
    stages = {name: work / name for name in ("cloudcli", "copilot-api", "updater")}
    cloud_info.update(build_cloudcli(
        cloud_source, stages["cloudcli"], node, env, cloudcli_profile,
    ))
    build_copilot(copilot_source, stages["copilot-api"], node, "1.4.2", env)
    copy_required(ROOT / "node-updater", stages["updater"], [
        "install.py", "updater.py", "engine.py", "probe.mjs", "UPGRADE.md",
    ])
    for name, stage in stages.items():
        archive_tree(stage, output / f"{name}.tar.gz")
    artifacts = [metadata(output / f"{name}.tar.gz") for name in stages]
    manifest = {
        "schema": 1, "platform": "linux-x64", "node": dependencies["node"]["version"],
        "cloudcli": cloud_info, "copilotApi": copilot_info, "sharedWorkspaceUiRequired": True,
        "bunBuildTool": "1.4.2", "nodeDistribution": distribution,
        "dependencyMode": "prebuilt-private-components", "artifacts": artifacts,
        "bundledRuntimes": ["cloudcli", "copilot-api", "updater"],
        "downloadedOfficialRuntimes": ["node", "codex", "devtunnel"],
    }
    identity = "\n".join([
        manifest["node"], manifest["bunBuildTool"], distribution["sha256"],
        *[item["sha256"] for item in artifacts],
    ])
    manifest["releaseId"] = "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    origin = urllib.parse.urlsplit(args.portal_origin)
    if (origin.scheme != "https" or not origin.hostname or origin.username or origin.password
            or origin.path or origin.query or origin.fragment):
        raise RuntimeError("--portal-origin must be an exact HTTPS origin")
    public_key = Path(args.updater_public_key_file).read_text()
    if not public_key.startswith("-----BEGIN PUBLIC KEY-----\n") or len(public_key) > 8192:
        raise RuntimeError("Invalid updater public key")
    package_root = work / "package" / "config-new-codey-machine"
    for relative in [
        "SKILL.md", "agents/openai.yaml", "dependencies.json",
        "scripts/install.sh", "templates/a100-models.json",
    ]:
        source_file = ROOT / "skills/config-new-codey-machine" / relative
        target = package_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, target)
    assets = package_root / "assets"
    assets.mkdir()
    for item in artifacts:
        shutil.copy2(output / item["file"], assets / item["file"])
    shutil.copy2(output / "manifest.json", assets / "manifest.json")
    setup = {
        "schema": 1, "portalOrigin": args.portal_origin, "releaseId": manifest["releaseId"],
        "platform": "linux-x64", "network": {"mode": "devtunnel"},
        "tunnelAuthProvider": "github",
        "updater": {"protocol": 1, "releasePublicKey": public_key},
    }
    (assets / "setup.json").write_text(json.dumps(setup, indent=2) + "\n")
    checksums = [
        f"{metadata(assets / name)['sha256']}  {name}"
        for name in [*[item["file"] for item in artifacts], "manifest.json", "setup.json"]
    ]
    (assets / "SHA256SUMS").write_text("\n".join(checksums) + "\n")
    package_file = output / "config-new-codey-machine.zip"
    with zipfile.ZipFile(package_file, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for file in sorted(package_root.rglob("*")):
            if not file.is_file():
                continue
            info = zipfile.ZipInfo(file.relative_to(package_root.parent).as_posix())
            info.date_time = (1980, 1, 1, 0, 0, 0)
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = ((0o100700 if file.name == "install.sh" else 0o100600) << 16)
            archive.writestr(info, file.read_bytes())
    package_metadata = metadata(package_file)
    shutil.rmtree(work)
    print(json.dumps({
        "ok": True, "releaseId": manifest["releaseId"], "artifacts": artifacts,
        "cloudcliProfile": cloudcli_profile["name"], "package": package_metadata,
    }, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--platform", choices=["linux-x64"], default="linux-x64")
    parser.add_argument("--portal-origin", required=True)
    parser.add_argument("--updater-public-key-file", required=True)
    parser.add_argument("--cloudcli-profile", choices=["codex-only", "full"])
    parser.add_argument("--allow-reviewed-diff", action="store_true")
    build(parser.parse_args())
