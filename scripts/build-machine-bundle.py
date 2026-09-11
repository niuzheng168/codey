#!/usr/bin/env python3
"""Build a one-click Skill containing exactly one installable Codey npm package."""
import argparse
import json
from pathlib import Path
import shutil
import shlex
import urllib.parse
import zipfile

from codey_package import ROOT, build_package, metadata, write_runtime_installer


def assemble_bundle(output, built, portal_origin, public_key):
    output = Path(output).resolve()
    work = output / ".build-machine"
    work.mkdir()
    artifacts = [built["artifact"]]
    manifest = {
        "schema": 2, "name": "codey", "platform": "linux-x64", "node": built["node"],
        "codey": built["codey"], "cloudcli": built["cloudcli"], "copilotApi": built["copilotApi"],
        "sharedWorkspaceUiRequired": True, "bunBuildTool": built["bunBuildTool"],
        "nodeDistribution": built["nodeDistribution"], "dependencyMode": "npm-codey-package",
        "artifacts": artifacts, "bundledRuntimes": ["cloudcli", "copilot-api", "updater"],
        "downloadedOfficialRuntimes": ["node", "codex", "devtunnel"],
    }
    manifest["releaseId"] = "machine-" + built["codey"]["entrySha256"][:16]
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    package_root = work / "package" / "config-new-codey-machine"
    for relative in [
        "SKILL.md", "agents/openai.yaml", "dependencies.json",
        "scripts/install.sh", "templates/a100-models.json",
    ]:
        source_file = ROOT / "skills/config-new-codey-machine" / relative
        target = package_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, target)
    installer = (ROOT / "scripts/linux/install-codey.sh").read_text()
    if installer.count('DEFAULT_PACKAGE_FILE=""') != 1:
        raise RuntimeError("Invalid npm installer template")
    installer = installer.replace('DEFAULT_PACKAGE_FILE=""',
                                  "DEFAULT_PACKAGE_FILE=" + shlex.quote(artifacts[0]["file"]))
    (output / "install-codey-linux.sh").write_text(installer)
    (package_root / "scripts/install-npm.sh").write_text(installer)
    runtime_installer = write_runtime_installer(output, artifacts[0])
    shutil.copy2(output / runtime_installer["file"], package_root / "scripts/install-runtime.mjs")
    assets = package_root / "assets"
    assets.mkdir()
    for item in artifacts:
        shutil.copy2(output / item["file"], assets / item["file"])
    shutil.copy2(output / "manifest.json", assets / "manifest.json")
    setup = {
        "schema": 1, "portalOrigin": portal_origin, "releaseId": manifest["releaseId"],
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
            info.external_attr = ((0o100700 if file.name.endswith(".sh") else 0o100600) << 16)
            archive.writestr(info, file.read_bytes())
    package_metadata = metadata(package_file)
    shutil.rmtree(work)
    return {
        "ok": True, "releaseId": manifest["releaseId"], "artifacts": artifacts,
        "package": package_metadata, "npmPackage": artifacts[0],
        "installer": metadata(output / "install-codey-linux.sh"),
        "runtimeInstaller": runtime_installer,
    }


def build(args):
    origin = urllib.parse.urlsplit(args.portal_origin)
    if (origin.scheme != "https" or not origin.hostname or origin.username or origin.password
            or origin.path or origin.query or origin.fragment):
        raise RuntimeError("--portal-origin must be an exact HTTPS origin")
    public_key = Path(args.updater_public_key_file).read_text()
    if not public_key.startswith("-----BEGIN PUBLIC KEY-----\n") or len(public_key) > 8192:
        raise RuntimeError("Invalid updater public key")
    setup = {
        "schema": 1, "portalOrigin": args.portal_origin, "platform": "auto",
        "network": {"mode": "devtunnel"}, "tunnelAuthProvider": "github",
        "updater": {"protocol": 1, "releasePublicKey": public_key},
    }
    built = build_package(args.output, allow_reviewed_diff=args.allow_reviewed_diff,
                          node_dir=args.node_dir, keep_work=args.keep_work, setup_config=setup)
    return assemble_bundle(args.output, built, args.portal_origin, public_key)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--platform", choices=["linux-x64"], default="linux-x64")
    parser.add_argument("--portal-origin", required=True)
    parser.add_argument("--updater-public-key-file", required=True)
    parser.add_argument("--allow-reviewed-diff", action="store_true")
    parser.add_argument("--node-dir", help="Use an existing Node distribution for the build")
    parser.add_argument("--keep-work", action="store_true")
    print(json.dumps(build(parser.parse_args()), indent=2))
