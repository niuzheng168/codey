#!/usr/bin/env python3
"""Build an offline maintenance ZIP + pinned PS launcher, never another Codey release.

Inputs are the unchanged published tgz, a Windows/x64 npm cache seeded with
--ignore-scripts, and independently checked upstream SQLite prebuilds.
No machine/service changes or publication are performed by this builder.
"""
import argparse
import hashlib
import json
import re
import shutil
import stat
import struct
import tarfile
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = [
    "update.mjs", "update-files.mjs", "update-archive.mjs", "package-info.mjs",
    "update-service.py", "update-windows.ps1", "update-probe.mjs",
]


def sha(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save(file, value):
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def allowed_path(name):
    if not re.fullmatch(r"[A-Za-z0-9_@+./-]+", name):
        raise ValueError("Unsafe offline filename")
    if any(not part or part in {".", ".."} or part.endswith(".") or
           re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", part, re.I)
           for part in name.split("/")):
        raise ValueError("Unsafe offline path")


def validate_runtime_platforms(platforms):
    if platforms not in (
        ["linux-x64", "windows-x64"],
        ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"],
    ):
        raise ValueError("Offline Windows kits require a reviewed Windows-capable shared package")


def render_readme(version, computer):
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch(r"[A-Za-z0-9-]{1,63}", computer):
        raise ValueError("Invalid offline documentation version or computer")
    text = (ROOT / "docs/codey-offline-windows-update.md").read_text()
    return text.replace("{{CODEY_VERSION}}", version).replace("{{EXPECTED_COMPUTER}}", computer)


def build(package, cache, seed, native_proof, output, computer):
    assert re.fullmatch(r"[A-Za-z0-9-]{1,63}", computer)
    assert not output.exists(), "Use a new output directory; never overwrite a delivered kit."
    assert package.is_file() and not package.is_symlink()
    output.mkdir(mode=0o700, parents=True)
    content = output / "content"
    content.mkdir(mode=0o700)
    with tarfile.open(package, "r:gz") as archive:
        pkg = json.load(archive.extractfile("package/package.json"))
        lock = json.load(archive.extractfile("package/npm-shrinkwrap.json"))
        build_info = json.load(archive.extractfile("package/codey-build.json"))
        version = pkg["version"]
        assert pkg["name"] == "codey" and re.fullmatch(r"\d+\.\d+\.\d+", version)
        assert lock["version"] == build_info["version"] == version and lock["lockfileVersion"] == 3
        validate_runtime_platforms(build_info["runtimePlatforms"])
        assert hashlib.sha256(archive.extractfile("package/npm-shrinkwrap.json").read()).hexdigest() == build_info["lockSha256"]
        assert (seed / "npm-shrinkwrap.json").read_bytes() == archive.extractfile("package/npm-shrinkwrap.json").read()
        assert json.loads((seed / "package.json").read_text()) == pkg
        bootstrap = content / "bootstrap"
        bootstrap.mkdir()
        for name in BOOTSTRAP:
            item = archive.getmember("package/lib/" + name)
            assert item.isfile() and not item.issym() and not item.islnk()
            (bootstrap / name).write_bytes(archive.extractfile(item).read())
    package_name = f"codey-{version}.tgz"
    shutil.copyfile(package, content / package_name)
    shutil.copyfile(ROOT / "scripts/windows/offline-update.mjs", content / "offline-update.mjs")
    (content / "README.md").write_text(render_readme(version, computer))
    # No npm logs, userconfig, credentials or dependency trees enter the kit.
    for folder in ["content-v2", "index-v5"]:
        source = cache / "_cacache" / folder
        assert source.is_dir()
        for file in source.rglob("*"):
            assert not file.is_symlink(), "Linked npm cache input is not allowed."
        shutil.copytree(source, content / "cache/_cacache" / folder)
    packages = {}
    for name, metadata in lock["packages"].items():
        if not name:
            continue
        file = seed / name / "package.json"
        if file.is_file():
            assert json.loads(file.read_text())["version"] == metadata["version"]
            packages[name] = metadata["version"]
    for required in ["better-sqlite3", "bcrypt", "node-pty", "@vscode/ripgrep-win32-x64"]:
        assert "node_modules/" + required in packages
    sqlite = {}
    native = json.loads(native_proof.read_text())
    assert sorted(item["nodeAbi"] for item in native) == [127, 137]
    for item in native:
        abi = item["nodeAbi"]
        assert item["version"] == packages["node_modules/better-sqlite3"] and item["upstreamDigestVerified"]
        expected_name = f"better-sqlite3-v{item['version']}-node-v{abi}-win32-x64.tar.gz"
        assert item["source"] == f"https://github.com/WiseLibs/better-sqlite3/releases/download/v{item['version']}/{expected_name}"
        source = native_proof.parent / "native" / expected_name
        assert sha(source) == item["sourceSha256"]
        with tarfile.open(source, "r:gz") as archive:
            entries = [entry for entry in archive if entry.isfile()]
            assert len(entries) == 1 and entries[0].name == "build/Release/better_sqlite3.node"
            body = archive.extractfile(entries[0]).read()
        assert hashlib.sha256(body).hexdigest() == item["sha256"] and len(body) == item["size"]
        assert body[:2] == b"MZ"
        offset = struct.unpack_from("<I", body, 0x3c)[0]
        assert body[offset:offset + 4] == b"PE\0\0" and struct.unpack_from("<H", body, offset + 4)[0] == 0x8664
        assert item["file"] == f"native/{abi}/better_sqlite3.node"
        destination = content / item["file"]
        destination.parent.mkdir(parents=True)
        destination.write_bytes(body)
        sqlite[str(abi)] = item
    files = {}
    folded = set()
    for file in sorted(content.rglob("*")):
        assert not file.is_symlink()
        if not file.is_file():
            continue
        name = file.relative_to(content).as_posix()
        allowed_path(name)
        assert name.lower() not in folded
        folded.add(name.lower())
        files[name] = {"size": file.stat().st_size, "sha256": sha(file)}
    manifest = {
        "schema": 1, "kind": "codey-offline-windows", "version": version, "platform": "windows-x64",
        "sourceCommit": build_info["sourceCommit"], "lockSha256": build_info["lockSha256"],
        "nodeAbis": [127, 137], "expectedComputer": computer,
        "package": {"file": package_name, **files[package_name]}, "sqlite": sqlite,
        "packages": packages, "files": files,
        "activation": "unchanged-published-Codey-updater",
        "dependencyNetwork": False, "installHooks": False, "modelRequests": False,
        "limitations": ["Only existing owner-managed Windows x64 npm installations.",
                        "Existing Node 22/24 and npm required; neither is installed.",
                        "Finish native Codex/Codey work and use an external non-admin terminal.",
                        "Existing model services may need provider network access when restarted."],
    }
    save(content / "manifest.json", manifest)
    zip_name = f"codey-{version}-windows-x64-offline.zip"
    delivered = output / zip_name
    with zipfile.ZipFile(delivered, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(content.rglob("*")):
            if not file.is_file():
                continue
            info = zipfile.ZipInfo(file.relative_to(content).as_posix(), (2026, 9, 12, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, file.read_bytes())
    template = (ROOT / "scripts/windows/update-codey-offline.ps1").read_text()
    for key, value in {"BUNDLE_NAME": zip_name, "BUNDLE_SHA256": sha(delivered),
                       "MANIFEST_SHA256": sha(content / "manifest.json"),
                       "RUNNER_SHA256": sha(content / "offline-update.mjs"),
                       "EXPECTED_COMPUTER": computer, "VERSION": version}.items():
        template = template.replace("@@" + key + "@@", value)
    assert "@@" not in template
    script = output / f"Update-Codey-{version}.ps1"
    script.write_text(template, encoding="utf-8-sig", newline="\r\n")
    report = {"passed": True, "version": version, "expectedComputer": computer,
              "packageUnchanged": sha(package) == sha(content / package_name),
              "files": len(files), "windowsDependencyPackages": len(packages),
              "bundle": {"file": zip_name, "size": delivered.stat().st_size, "sha256": sha(delivered)},
              "script": {"file": script.name, "size": script.stat().st_size, "sha256": sha(script)},
              "nodeAbis": [127, 137], "windowsServicesChanged": False, "portalPublished": False}
    save(output / "build-report.json", report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["package", "cache", "seed", "native-proof", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--expected-computer", required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.package, args.cache, args.seed, args.native_proof,
                           args.output, args.expected_computer), indent=2))
