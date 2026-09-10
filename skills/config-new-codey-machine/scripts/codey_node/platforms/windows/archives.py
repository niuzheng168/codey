"""Windows-safe archive names, extraction and in-archive link materialization."""
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import tarfile
import zipfile

from ...common.errors import SetupError


def within(file, root):
    resolved, parent = Path(file).resolve(), Path(root).resolve()
    if resolved == parent or not resolved.is_relative_to(parent):
        raise SetupError("A computed installation path escaped its named root")
    return resolved


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
