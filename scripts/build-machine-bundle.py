#!/usr/bin/env python3
"""Build a one-click Skill containing exactly one installable Codey npm package."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import urllib.parse
import zipfile

from codey_package import ROOT, build_package, metadata


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
    identity = "\n".join([manifest["node"], artifacts[0]["sha256"]])
    manifest["releaseId"] = "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
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
            info.external_attr = ((0o100700 if file.name == "install.sh" else 0o100600) << 16)
            archive.writestr(info, file.read_bytes())
    package_metadata = metadata(package_file)
    shutil.rmtree(work)
    return {
        "ok": True, "releaseId": manifest["releaseId"], "artifacts": artifacts,
        "package": package_metadata,
    }


def build(args):
    origin = urllib.parse.urlsplit(args.portal_origin)
    if (origin.scheme != "https" or not origin.hostname or origin.username or origin.password
            or origin.path or origin.query or origin.fragment):
        raise RuntimeError("--portal-origin must be an exact HTTPS origin")
    public_key = Path(args.updater_public_key_file).read_text()
    if not public_key.startswith("-----BEGIN PUBLIC KEY-----\n") or len(public_key) > 8192:
        raise RuntimeError("Invalid updater public key")
    built = build_package(args.output, allow_reviewed_diff=args.allow_reviewed_diff)
    return assemble_bundle(args.output, built, args.portal_origin, public_key)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--platform", choices=["linux-x64"], default="linux-x64")
    parser.add_argument("--portal-origin", required=True)
    parser.add_argument("--updater-public-key-file", required=True)
    parser.add_argument("--allow-reviewed-diff", action="store_true")
    print(json.dumps(build(parser.parse_args()), indent=2))
