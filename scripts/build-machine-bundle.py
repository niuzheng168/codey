#!/usr/bin/env python3
"""Package reviewed Codey sources; install platform runtimes on the target."""
import argparse
import hashlib
import gzip
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd=None, env=None):
    subprocess.run([str(x) for x in args], cwd=cwd, env=env, check=True)


def metadata(file):
    digest, crc, size = hashlib.sha256(), 0, 0
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            crc = zlib.crc32(chunk, crc)
            size += len(chunk)
    return {"file": file.name, "sha256": digest.hexdigest(), "crc32": crc, "size": size}


def source(repo, destination, allow_dirty):
    commit = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    patch = subprocess.check_output(["git", "-C", str(repo), "diff", "--binary", "HEAD", "--"])
    if patch and not allow_dirty:
        raise RuntimeError(f"{repo.name} has local modifications; review them and pass --allow-reviewed-diff")
    destination.mkdir()
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "-C", str(repo), "archive", "HEAD"], stdout=archive, check=True)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as package:
            package.extractall(destination, filter="data")
    if patch:
        subprocess.run(["git", "apply", "-"], input=patch, cwd=destination,
                       env={**os.environ, "GIT_CEILING_DIRECTORIES": str(destination.parent)}, check=True)
    version = json.loads((destination / "package.json").read_text())["version"]
    return {"commit": commit, "version": version, "patchSha256": hashlib.sha256(patch).hexdigest() if patch else None}


def archive_tree(source_dir, destination):
    # Deterministic on both BSD/macOS and GNU/Linux; never archive the checkout.
    with destination.open("wb") as output, gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for file in sorted(source_dir.rglob("*")):
                info = archive.gettarinfo(str(file), arcname="./" + file.relative_to(source_dir).as_posix())
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ""
                info.pax_headers = {}
                if info.isfile():
                    with file.open("rb") as stream:
                        archive.addfile(info, stream)
                else:
                    archive.addfile(info)


def portal_runtime(destination, allow_dirty):
    files = [
        "node-relay/server.mjs", "src/client-ticket.mjs", "src/config.mjs",
        "src/node-session-history.mjs", "src/metrics.mjs",
    ]
    patch = subprocess.check_output(["git", "-C", str(ROOT), "diff", "--binary", "HEAD", "--", *files])
    if patch and not allow_dirty:
        raise RuntimeError("Portal node runtime has reviewed changes that must be committed before publication")
    destination.mkdir()
    for name in files:
        source_file = ROOT / name
        if source_file.is_symlink() or source_file.resolve() != source_file:
            raise RuntimeError("Unsafe Portal runtime input")
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source_file.read_bytes())
    (destination / "package.json").write_text('{"private":true,"type":"module"}\n')
    return {
        "commit": subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip(),
        "patchSha256": hashlib.sha256(patch).hexdigest() if patch else None,
    }


def build(args):
    dependencies = json.loads((ROOT / "skills/config-new-codey-machine/dependencies.json").read_text())
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / "manifest.json").exists():
        raise RuntimeError("Choose a new output directory; published releases are immutable")
    work = output / ".build"
    work.mkdir()
    version = dependencies["node"]
    suffix = {"linux-x64": "linux-x64.tar.xz", "windows-x64": "win-x64.zip",
              "macos-arm64": "darwin-arm64.tar.gz", "macos-x64": "darwin-x64.tar.gz"}[args.platform]
    name = f"node-v{version}-{suffix}"
    base = f"https://nodejs.org/dist/v{version}/"
    with urllib.request.urlopen(base + "SHASUMS256.txt", timeout=60) as response:
        sums = response.read().decode()
    expected = next(line.split()[0] for line in sums.splitlines() if line.split()[-1] == name)
    copilot = work / "copilot-api"
    cloudcli = work / "cloudcli"
    copilot_info = source(ROOT / "copilot-api", copilot, args.allow_reviewed_diff)
    cloudcli_info = source(ROOT / "cloudcli", cloudcli, args.allow_reviewed_diff)
    copilot_info["repository"] = dependencies["copilotApiRepository"]
    cloudcli_info["repository"] = dependencies["cloudcliRepository"]
    for file, folder in [("copilot-api-source.tar.gz", copilot), ("cloudcli-source.tar.gz", cloudcli)]:
        archive_tree(folder, output / file)
    info = {
        "schema": 1, "platform": args.platform, "node": version,
        "cloudcli": cloudcli_info, "copilotApi": copilot_info,
        "sharedWorkspaceUiRequired": True,
        "bunBuildTool": dependencies["bunBuildTool"],
        "nodeDistribution": {"file": name, "url": base + name, "sha256": expected},
        "dependencyMode": "install-on-target",
    }
    artifacts = ["cloudcli-source.tar.gz", "copilot-api-source.tar.gz"]
    if args.platform.startswith("macos-") or args.platform == "windows-x64":
        runtime = work / "portal-node"
        info["portalRuntime"] = portal_runtime(runtime, args.allow_reviewed_diff)
        archive_tree(runtime, output / "portal-node-source.tar.gz")
        artifacts.append("portal-node-source.tar.gz")
    info["artifacts"] = [metadata(output / name) for name in artifacts]
    identity = "\n".join([version, info["bunBuildTool"], expected] + [file["sha256"] for file in info["artifacts"]])
    info["releaseId"] = "machine-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
    (output / "manifest.json").write_text(json.dumps(info, indent=2) + "\n")
    print(json.dumps({"ok": True, "releaseId": info["releaseId"], "output": str(output),
                      "artifacts": info["artifacts"]}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--platform", choices=["linux-x64", "windows-x64", "macos-arm64", "macos-x64"], default="linux-x64")
    parser.add_argument("--allow-reviewed-diff", action="store_true")
    build(parser.parse_args())
