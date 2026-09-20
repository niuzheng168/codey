#!/usr/bin/env python3
"""Build a one-click Skill containing exactly one installable Codey npm package."""
import argparse
import json
import os
from pathlib import Path
import shutil
import shlex
import urllib.parse
import zipfile

from codey_package import (
    ROOT, MACHINE_SKILL_FILES, RUNTIME_PLATFORMS, build_package,
    machine_skill_filename, metadata, write_runtime_installer,
)


def assemble_bundle(output, built, portal_origin, source_root=None):
    source_root = Path(source_root or ROOT)
    output = Path(output).resolve()
    package_file = output / machine_skill_filename(built["codey"]["version"])
    work = output / ".build-machine"
    work.mkdir()
    artifacts = [built["artifact"]]
    manifest = {
        "schema": 2, "name": "codey", "platform": "linux-x64", "node": built["node"],
        "runtimePlatforms": RUNTIME_PLATFORMS,
        "codey": built["codey"], "cloudcli": built["cloudcli"], "copilotApi": built["copilotApi"],
        "releaseSource": built.get("releaseSource"),
        "sharedWorkspaceUiRequired": True, "bunBuildTool": built["bunBuildTool"],
        "nodeDistribution": built["nodeDistribution"], "dependencyMode": "npm-codey-package",
        "artifacts": artifacts, "bundledRuntimes": ["cloudcli", "copilot-api"],
        "downloadedOfficialRuntimes": ["node", "codex", "devtunnel"],
    }
    manifest["releaseId"] = "machine-" + built["codey"]["entrySha256"][:16]
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    package_root = work / "package" / "config-new-codey-machine"
    for relative in MACHINE_SKILL_FILES:
        source_file = source_root / "skills/config-new-codey-machine" / relative
        target = package_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, target)
    installer = (source_root / "scripts/linux/install-codey.sh").read_text()
    if installer.count('DEFAULT_PACKAGE_FILE=""') != 1:
        raise RuntimeError("Invalid npm installer template")
    installer = installer.replace('DEFAULT_PACKAGE_FILE=""',
                                  "DEFAULT_PACKAGE_FILE=" + shlex.quote(artifacts[0]["file"]))
    start = installer.index("# BEGIN_CODEY_PREFLIGHT")
    end = installer.index("# END_CODEY_PREFLIGHT") + len("# END_CODEY_PREFLIGHT")
    preflight = (source_root / "skills/config-new-codey-machine/scripts/linux-preflight.sh").read_text()
    installer = installer[:start] + preflight + installer[end:]
    (output / "install-codey-linux.sh").write_text(installer)
    (package_root / "scripts/install-npm.sh").write_text(installer)
    runtime_installer = write_runtime_installer(output, artifacts[0], source_root)
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
    }
    (assets / "setup.json").write_text(json.dumps(setup, indent=2) + "\n")
    checksums = [
        f"{metadata(assets / name)['sha256']}  {name}"
        for name in [*[item["file"] for item in artifacts], "manifest.json", "setup.json"]
    ]
    (assets / "SHA256SUMS").write_text("\n".join(checksums) + "\n")
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
    setup = {
        "schema": 1, "portalOrigin": args.portal_origin, "platform": "auto",
        "network": {"mode": "devtunnel"}, "tunnelAuthProvider": "github",
    }
    built = build_package(args.output, allow_reviewed_diff=args.allow_reviewed_diff,
                          node_dir=args.node_dir, keep_work=True, setup_config=setup,
                          source_commit=getattr(args, "source_commit", None))
    source_root = Path(args.output).resolve() / ".build-codey/source/portal" if built.get("releaseSource") else ROOT
    result = assemble_bundle(args.output, built, args.portal_origin, source_root)
    if not args.keep_work:
        shutil.rmtree(Path(args.output).resolve() / ".build-codey")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--platform", choices=["linux-x64"], default="linux-x64")
    parser.add_argument("--portal-origin", required=True)
    parser.add_argument("--allow-reviewed-diff", action="store_true", help="Development-only build; cannot be published")
    parser.add_argument("--source-commit", help="Expected origin/main SHA; components use its recorded gitlinks")
    parser.add_argument("--node-dir", help="Use an existing Node distribution for the build")
    parser.add_argument("--keep-work", action="store_true")
    os.umask(0o077)
    print(json.dumps(build(parser.parse_args()), indent=2))
