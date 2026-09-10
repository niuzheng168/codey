"""Small, credential-safe building blocks shared by the release processes."""
import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import time

NODES = ("zhn-a100", "jpe2", "jpe3", "westus2")
PORTAL_NODE_NAMES = {
    "zhn-a100": {"zhna100", "zhna100devtunnel"},
    "jpe2": {"japaneast2", "zhnjpe2"},
    "jpe3": {"japaneast3", "zhnjpe3"},
    "westus2": {"westus2", "zhnusw2"},
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def portal_node_ids(rows, targets):
    require(isinstance(rows, list), "Invalid owner Workspace inventory")
    ids = [row.get("id") for row in rows if isinstance(row, dict)]
    require(all(isinstance(node, str) and node for node in ids) and len(ids) == len(set(ids)),
            "Invalid or duplicate owner Workspace node ID")
    result = []
    for target in targets:
        if target in ids:
            result.append(target)
            continue
        names = PORTAL_NODE_NAMES.get(target, set())
        matches = [row["id"] for row in rows
                   if re.sub(r"[^a-z0-9]", "", str(row.get("name", "")).lower()) in names]
        require(len(matches) == 1, "Cannot resolve the current Portal node ID for " + target)
        result.append(matches[0])
    require(len(result) == len(set(result)), "Portal node aliases resolved to the same node")
    return result


def release_name(value):
    require(isinstance(value, str) and re.fullmatch(r"fast-\d{8}-\d{6}-[a-f0-9]{6}", value),
            "Invalid release identifier")
    return value


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".next")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def command(args, *, cwd=None, env=None, timeout=120, log=None, input=None):
    started = time.monotonic()
    result = subprocess.run(
        [str(arg) for arg in args], cwd=cwd, env=env, input=input,
        stdin=subprocess.DEVNULL if input is None else None,
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )
    if log:
        path = Path(log)
        path.write_text(result.stdout + result.stderr, encoding="utf-8")
        path.chmod(0o600)
    require(result.returncode == 0,
            f"{Path(str(args[0])).name} failed ({result.returncode}); inspect the private phase log")
    return result.stdout.strip(), round(time.monotonic() - started, 3)


def safe_extract(archive_path, destination, *, allow_source_symlinks=False):
    """Accept only regular files/directories; never follow archive links."""
    destination = Path(destination)
    require(not destination.exists(), "Extraction destination already exists")
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        names = set()
        for member in members:
            name = PurePosixPath(member.name)
            require(not name.is_absolute() and ".." not in name.parts
                    and "\\" not in member.name and name.parts,
                    "Unsafe archive path")
            require(member.isfile() or member.isdir() or (allow_source_symlinks and member.issym()),
                    "Archive links/devices are forbidden")
            canonical = name.as_posix()
            require(canonical not in names, "Duplicate archive member")
            names.add(canonical)
        destination.mkdir(mode=0o700, parents=True)
        root = destination.resolve()
        for member in members:
            if member.issym():
                continue
            path = destination / member.name
            require(path.resolve().is_relative_to(root), "Archive escaped its destination")
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, path.open("xb") as target:
                import shutil
                shutil.copyfileobj(source, target)
            path.chmod(member.mode & 0o777 & ~0o6000)
        for member in members:
            if not member.issym():
                continue
            link = destination / member.name
            require(not PurePosixPath(member.linkname).is_absolute(), "Absolute source symlink")
            target = (link.parent / member.linkname).resolve()
            require(target.is_relative_to(root) and target.is_file(), "Unsafe or dangling source symlink")
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(member.linkname)


def archive_tree(source, target, names=None):
    source = Path(source).resolve()
    # Materialize only contained files. No host symlinks or hardlinks enter the archive.
    with tarfile.open(target, "w:gz", compresslevel=1, dereference=True) as archive:
        for name in names or sorted(item.name for item in source.iterdir()):
            entry = source / name
            paths = [entry] if entry.is_file() else [
                Path(base) / filename
                for base, _, files in os.walk(entry, followlinks=True)
                for filename in files
            ]
            for path in sorted(paths):
                require(path.resolve().is_relative_to(source), "Package contains an external symlink")
                relative = path.relative_to(source).as_posix()
                info = archive.gettarinfo(str(path), arcname=relative)
                require(info.isfile(), "Unexpected package object")
                with path.open("rb") as stream:
                    archive.addfile(info, stream)


def canonical(value):
    if isinstance(value, dict):
        result = {key: canonical(item) for key, item in value.items() if item is not None}
        if result.get("secretRef"):
            result.pop("value", None)
        return result
    if isinstance(value, list):
        result = [canonical(item) for item in value]
        if result and all(isinstance(item, dict) and "name" in item for item in result):
            result.sort(key=lambda item: item["name"])
        return result
    return value


@contextlib.contextmanager
def phase(report, name, output):
    started = time.monotonic()
    row = {"phase": name, "startedAt": time.time()}
    report.setdefault("phases", []).append(row)
    print(json.dumps({"phase": name, "status": "started"}), flush=True)
    try:
        yield row
        row["status"] = "passed"
    except Exception as error:
        row["status"] = "failed"
        row["error"] = str(error)
        raise
    finally:
        row["seconds"] = round(time.monotonic() - started, 3)
        save(output, report)
        print(json.dumps(row), flush=True)
