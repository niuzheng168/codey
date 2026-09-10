"""Reuse an owner Codex CLI, or install a pinned native CLI when none exists."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request

from .errors import SetupError
from .files import digest, write_state
from ..devtunnel.auth import cli_environment
from ..service.launcher import ordinary_path

TARGETS = {
    "linux-x64": ("linux-x64", "x86_64-unknown-linux-musl", "codex"),
    "windows-x64": ("win32-x64", "x86_64-pc-windows-msvc", "codex.exe"),
    "macos-arm64": ("darwin-arm64", "aarch64-apple-darwin", "codex"),
    "macos-x64": ("darwin-x64", "x86_64-apple-darwin", "codex"),
}
SKILL = Path(__file__).resolve().parents[3]


def native_platform():
    arch = platform.machine().lower()
    if sys.platform == "darwin":
        return "macos-arm64" if arch == "arm64" else "macos-x64" if arch == "x86_64" else ""
    return {"linux": "linux-x64", "win32": "windows-x64"}.get(sys.platform, "") if arch in ("x86_64", "amd64") else ""


def pin(skill, target):
    if target not in TARGETS:
        raise SetupError("Codex CLI requires one of this Skill's native platforms")
    config = json.loads((Path(skill) / "dependencies.json").read_text(encoding="utf-8"))["codexCli"]
    version, integrity = config["version"], config["integrities"][target]
    if (not re.fullmatch(r"\d+\.\d+\.\d+", version)
            or not re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", integrity)):
        raise SetupError("A fixed Codex version and official package integrity are required")
    suffix, triple, binary = TARGETS[target]
    return {
        "version": version, "integrity": integrity, "platform": target,
        "url": f"https://registry.npmjs.org/@openai/codex/-/codex-{version}-{suffix}.tgz",
        "vendor": f"package/vendor/{triple}", "entry": f"package/vendor/{triple}/bin/{binary}",
        "triple": triple,
    }


def tool_root(spec):
    return ordinary_path(Path.home().resolve() / ".local/share/codey-tools/codex" /
                         (spec["version"] + "-" + spec["platform"]))


def native_executable(candidate, spec):
    candidate = Path(candidate).resolve()
    # Resolve only the official npm wrapper layout, never arbitrary shell code.
    if candidate.name == "codex.js" and candidate.parent.name == "bin" and candidate.parent.parent.name == "codex":
        suffix = TARGETS[spec["platform"]][0]
        package = candidate.parent.parent
        choices = (
            package / "node_modules/@openai" / ("codex-" + suffix),
            package.parent / ("codex-" + suffix),
        )
        target = Path("vendor") / spec["triple"] / "bin" / TARGETS[spec["platform"]][2]
        candidate = next((root / target for root in choices if (root / target).is_file()), choices[0] / target)
    if not candidate.is_file():
        raise SetupError("The selected native Codex executable is missing")
    with candidate.open("rb") as stream:
        magic = stream.read(4)
    native = (magic[:2] == b"MZ" if spec["platform"] == "windows-x64" else
              magic == b"\x7fELF" if spec["platform"] == "linux-x64" else
              magic in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"))
    if not native:
        raise SetupError("Select a native Codex binary, not an unrelated PATH shim or another platform")
    return ordinary_path(candidate)


def version(executable, *, expected=None):
    result = subprocess.run([str(executable), "--version"], stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, encoding="utf-8", errors="replace", timeout=30,
                            creationflags=0x08000000 if os.name == "nt" else 0, env=cli_environment())
    text = (result.stdout or "").strip()
    match = re.fullmatch(r"codex(?:-cli)? (\d+\.\d+\.\d+)(?:[^\r\n]*)", text)
    if result.returncode or not match or (expected and match[1] != expected):
        raise SetupError("Native Codex --version did not match the reviewed CLI; no login was attempted")
    return text


def verify_installation(root, spec):
    receipt = ordinary_path(root / "receipt.json")
    if receipt.stat().st_size > 1024 * 1024:
        raise SetupError("Oversized Codex installation receipt")
    saved = json.loads(receipt.read_text(encoding="utf-8"))
    if any(saved.get(key) != spec[key] for key in ("version", "platform", "integrity")):
        raise SetupError("The existing Codex tool directory belongs to a different reviewed package")
    vendor = root / spec["vendor"]
    actual = {file.relative_to(root).as_posix() for file in vendor.rglob("*") if file.is_file()}
    expected = saved.get("fileHashes", {})
    if not expected or actual != set(expected) or spec["entry"] not in expected:
        raise SetupError("The managed Codex runtime has missing or unrecognized files")
    for name, sha in expected.items():
        if name not in actual or digest(ordinary_path(root / name)) != sha:
            raise SetupError("A managed Codex executable or companion file changed")
    return native_executable(root / spec["entry"], spec)


def find_cli(skill, explicit=None):
    spec = pin(skill, native_platform())
    if explicit:
        if not Path(explicit).is_absolute():
            raise SetupError("--codex-bin must be an absolute native executable path")
        return native_executable(explicit, spec)
    name = "codex.exe" if os.name == "nt" else "codex"
    candidates = [shutil.which(name)]
    owner_entries = set()
    if spec["platform"] != "windows-x64":
        home = Path.home().resolve()
        owner_entries = {home / ".local/bin/codex", home / ".npm-global/bin/codex"}
        candidates.extend(owner_entries)
    seen = set()
    for candidate in candidates:
        if not candidate or str(candidate) in seen or not Path(candidate).exists():
            continue
        seen.add(str(candidate))
        native = native_executable(candidate, spec)
        entry = Path(candidate).absolute()
        if entry in owner_entries:
            info = entry.lstat()
            if info.st_uid != getattr(os, "getuid", lambda: info.st_uid)():
                raise SetupError("The selected owner Codex entrypoint belongs to another user")
            return entry
        return native
    root = tool_root(spec)
    if root.exists():
        return verify_installation(root, spec)
    return None


def require_cli(skill, explicit=None):
    executable = find_cli(skill, explicit)
    if not executable:
        raise SetupError("Codex CLI is missing. First run: python scripts/codey.py codex --apply (using Python 3.12+)")
    version(executable)
    return executable


def install(skill, *, apply=False, explicit=None):
    spec = pin(skill, native_platform())
    if existing := find_cli(skill, explicit):
        return {"ok": True, "action": "reuse", "executable": str(existing), "version": version(existing),
                "globalEnvironmentChanged": False, "modelLoginTested": False}
    root = tool_root(spec)
    plan = {"action": "install", "version": spec["version"], "platform": spec["platform"],
            "executable": str(root / spec["entry"]), "globalEnvironmentChanged": False, "modelLoginTested": False}
    if not apply:
        return {**plan, "applied": False}
    if os.name == "nt":
        from ..platforms.windows import owner, helpers
        context = owner.owner_context()
        if context["elevated"] or context["sessionId"] <= 0:
            raise SetupError("Install Codex as the original non-admin logged-on owner")
        helpers.private_directory(root, context["sid"])
    else:
        if os.getuid() == 0:
            raise SetupError("Install Codex as the target owner, not root")
        root.mkdir(parents=True, mode=0o700)
    archive = root / "package.tgz"
    with urllib.request.urlopen(spec["url"], timeout=120) as response, archive.open("xb") as output:
        if response.geturl() != spec["url"]:
            raise SetupError("Unexpected Codex package redirect")
        size = 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > 256 * 1024 ** 2:
                raise SetupError("Unexpectedly large Codex package")
            output.write(chunk)
    with archive.open("rb") as stream:
        actual = "sha512-" + base64.b64encode(hashlib.file_digest(stream, "sha512").digest()).decode()
    if actual != spec["integrity"]:
        raise SetupError("Codex package integrity mismatch; no downloaded executable was run")
    with tarfile.open(archive) as package:
        members = package.getmembers()
        if len(members) > 512 or sum(item.size for item in members) > 768 * 1024 ** 2:
            raise SetupError("Unexpected Codex archive size")
        seen = set()
        for item in members:
            name = PurePosixPath(item.name)
            if (not name.parts or name.parts[0] != "package" or ".." in name.parts or name.is_absolute()
                    or re.search(r'[\\:<>"|?*\x00-\x1f]', item.name)
                    or not (item.isfile() or item.isdir()) or item.name.casefold() in seen):
                raise SetupError("Unsafe Codex package member")
            seen.add(item.name.casefold())
        package.extractall(root, members=members, filter="data")
    metadata = json.loads((root / spec["vendor"] / "codex-package.json").read_text(encoding="utf-8"))
    if (metadata.get("layoutVersion") != 1 or metadata.get("version") != spec["version"]
            or metadata.get("target") != spec["triple"] or metadata.get("entrypoint") != "bin/" + TARGETS[spec["platform"]][2]):
        raise SetupError("Unexpected native Codex package layout")
    executable = native_executable(root / spec["entry"], spec)
    result = version(executable, expected=spec["version"])
    hashes = {file.relative_to(root).as_posix(): digest(ordinary_path(file))
              for file in (root / spec["vendor"]).rglob("*") if file.is_file()}
    write_state(root / "receipt.json", {**spec, "fileHashes": hashes})
    verify_installation(root, spec)
    return {**plan, "ok": True, "applied": True, "version": result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--codex-bin", help="Reuse an explicitly reviewed existing native CLI")
    args = parser.parse_args()
    try:
        print(json.dumps(install(SKILL, apply=args.apply, explicit=args.codex_bin), indent=2))
    except (SetupError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, SetupError) else
                          "Codex preparation failed; keep the partial tool directory for review. No model login attempted."}))
        raise SystemExit(1)
