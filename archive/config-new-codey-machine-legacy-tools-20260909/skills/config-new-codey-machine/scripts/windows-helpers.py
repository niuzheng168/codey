"""Windows owner checks and safe archive helpers; no installer or network lifecycle."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import secrets
import shutil
import stat
import subprocess
import tarfile
import zipfile

SCRIPT = Path(__file__).resolve().parent
SKILL = SCRIPT.parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SCRIPT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

common = load("codey_machine_common", "machine-common.py")
service = load("codey_windows_owner", "windows-owner.py")
SetupError = common.SetupError


def native_powershell():
    folder = "Sysnative" if ctypes.sizeof(ctypes.c_void_p) == 4 else "System32"
    return Path(os.environ["WINDIR"]) / folder / "WindowsPowerShell/v1.0/powershell.exe"


def child_environment():
    return {key: value for key, value in os.environ.items()
            if key.upper() not in ("PSMODULEPATH", "CODEX_THREAD_ID", "CODEX_PARENT_THREAD_ID",
                                   "CODEX_INTERNAL_ORIGINATOR_OVERRIDE")}


def command(arguments, *, cwd=None, env=None, log=None):
    options = {"cwd": cwd, "env": env or child_environment(), "stdin": subprocess.DEVNULL,
               "text": True, "encoding": "utf-8", "errors": "replace", "timeout": 1800,
               "creationflags": service.CREATE_NO_WINDOW}
    if log:
        with Path(log).open("a", encoding="utf-8") as output:
            result = subprocess.run([str(arg) for arg in arguments], stdout=output,
                                    stderr=subprocess.STDOUT, **options)
    else:
        result = subprocess.run([str(arg) for arg in arguments], capture_output=True, **options)
    if result.returncode:
        raise SetupError(f"{Path(str(arguments[0])).name} failed; "
                         + ("inspect the owner-only build log" if log else "no policy or privilege fallback attempted"))
    return result


def within(file, root):
    resolved, parent = Path(file).resolve(), Path(root).resolve()
    if resolved == parent or not resolved.is_relative_to(parent):
        raise SetupError("A computed installation path escaped its named root")
    return resolved


def write_json(file, value):
    file = Path(file)
    if file.is_symlink():
        raise SetupError("Refusing a linked configuration file")
    temporary = file.with_name(file.name + "." + secrets.token_hex(6) + ".next")
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
    os.replace(temporary, file)


def private_directory(directory, sid):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    # This installer creates this exact directory; it does not edit an existing
    # tree's ACL, elevate, or change system/user security settings.
    icacls = Path(os.environ["WINDIR"]) / "System32/icacls.exe"
    command([icacls, directory, "/inheritance:r", "/grant:r",
             f"*{sid}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"])


def archive_name(name):
    value = PurePosixPath(name)
    reserved = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)
    if (value.is_absolute() or PureWindowsPath(name).drive or "\\" in name or ".." in value.parts
            or any(re.search(r'[<>:"|?*\x00-\x1f]', part) or part.rstrip(" .") != part or reserved.match(part)
                   for part in value.parts)):
        raise SetupError("Unsafe Windows archive member")
    return value


def extract_zip(archive, target, expected_root):
    target = Path(target)
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        if len(entries) > 100000 or sum(entry.file_size for entry in entries) > 768 * 1024 ** 2:
            raise SetupError("Unexpectedly large Node archive")
        seen = set()
        for entry in entries:
            name = archive_name(entry.filename)
            folded = str(name).casefold()
            if (not name.parts or name.parts[0] != expected_root or folded in seen
                    or stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1):
                raise SetupError("Unexpected, duplicate, linked, or encrypted Node archive member")
            seen.add(folded)
        package.extractall(target)


def extract_source(archive, target):
    with tarfile.open(archive) as package:
        entries = package.getmembers()
        if len(entries) > 200000 or sum(entry.size for entry in entries) > 8 * 1024 ** 3:
            raise SetupError("Unexpectedly large source archive")
        members = {}
        for entry in entries:
            name = str(archive_name(entry.name)).casefold()
            if name in members or not (entry.isfile() or entry.isdir() or entry.issym() or entry.islnk()):
                raise SetupError("Duplicate source path or special device")
            members[name] = entry
        # Git's CLAUDE.md -> AGENTS.md is a normal source-file link. Materialize
        # safe in-archive file links; do not require Windows Developer Mode,
        # create filesystem links, or resolve a link outside the checked archive.
        def file_target(entry, visited):
            if entry.isfile():
                return entry
            name = str(archive_name(entry.name)).casefold()
            if name in visited or len(visited) >= 8 or not (entry.issym() or entry.islnk()):
                raise SetupError("Source link must resolve to an ordinary in-archive file")
            relative = archive_name(entry.linkname)
            destination = PurePosixPath(entry.name).parent / relative if entry.issym() else relative
            linked = members.get(str(destination).casefold())
            if linked is None:
                raise SetupError("Source link target is missing")
            return file_target(linked, {*visited, name})
        links = [(entry, file_target(entry, set())) for entry in entries if entry.issym() or entry.islnk()]
        if sum(entry.size for entry in entries) + sum(linked.size for _, linked in links) > 8 * 1024 ** 3:
            raise SetupError("Expanded source links exceed the extraction limit")
        package.extractall(target, members=[entry for entry in entries if entry.isfile() or entry.isdir()], filter="data")
        for entry, linked in links:
            destination = within(Path(target) / PurePosixPath(entry.name), target)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with package.extractfile(linked) as source, destination.open("xb") as output:
                shutil.copyfileobj(source, output)
