"""Pin an explicitly selected native Codex bundle outside Desktop's disposable cache."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil

FILES = ("codex.exe", "codex-code-mode-host.exe", "codex-command-runner.exe",
         "codex-windows-sandbox-setup.exe", "rg.exe")
PACKAGE_FILES = (
    "codex-package.json", "bin/codex.exe", "bin/codex-code-mode-host.exe",
    "codex-path/rg.exe", "codex-resources/codex-command-runner.exe",
    "codex-resources/codex-windows-sandbox-setup.exe",
)


class NativeCodexError(RuntimeError):
    pass


def ordinary_path(value):
    """Reject links/junctions in every existing path component, including parents."""
    path = Path(value)
    if not path.is_absolute() or path.resolve() != path.absolute():
        raise NativeCodexError("native_codex_path_must_be_absolute_and_unlinked")
    for part in (path, *path.parents):
        if part.is_symlink() or part.is_junction():
            raise NativeCodexError("native_codex_linked_path_refused")
    return path


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def coordinates(root, node_id, bundle_id):
    root = ordinary_path(root)
    if (not re.fullmatch(r"n-[a-f0-9]{24}", node_id) or root.name != node_id
            or not re.fullmatch(r"[a-f0-9]{64}", bundle_id)):
        raise NativeCodexError("native_codex_installation_identity_mismatch")
    directory = ordinary_path(root / "native-codex" / bundle_id)
    if not directory.is_relative_to(root):
        raise NativeCodexError("native_codex_destination_outside_installation")
    return directory


def bundle_id(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def inventory(source):
    source = ordinary_path(source)
    if source.name.lower() != "codex.exe" or not source.is_file():
        raise NativeCodexError("explicit_existing_native_codex_executable_required_no_PATH_fallback")
    package = source.parent.name == "bin" and (source.parent.parent / "codex-package.json").is_file()
    base = source.parent.parent if package else source.parent
    if package:
        metadata = json.loads(ordinary_path(base / "codex-package.json").read_text(encoding="utf-8"))
        if (metadata.get("layoutVersion") != 1 or metadata.get("target") != "x86_64-pc-windows-msvc"
                or metadata.get("entrypoint") != "bin/codex.exe"
                or metadata.get("resourcesDir") != "codex-resources" or metadata.get("pathDir") != "codex-path"):
            raise NativeCodexError("unreviewed_native_codex_package_layout")
    files = {}
    for name in PACKAGE_FILES if package else FILES:
        file = ordinary_path(base / name)
        if file.exists():
            if not file.is_file():
                raise NativeCodexError("native_codex_companion_must_be_an_ordinary_file")
            files[name] = digest(file)
    if ("bin/codex.exe" if package else "codex.exe") not in files:
        raise NativeCodexError("native_codex_executable_missing")
    if package and set(files) != set(PACKAGE_FILES):
        raise NativeCodexError("native_codex_package_companion_missing")
    return files


def receipt(snapshot):
    return {key: snapshot[key] for key in ("schema", "kind", "nodeId", "bundleId", "files")}


def hashes(snapshot):
    directory = Path(snapshot["executable"]).parent
    if "bin/codex.exe" in snapshot["files"]:
        directory = directory.parent
    return {str(directory / name): expected for name, expected in snapshot["files"].items()}


def verify(snapshot, root, node_id):
    """Verify the node-owned copy without consulting a possibly deleted source cache."""
    if (not isinstance(snapshot, dict) or snapshot.get("schema") != 1
            or snapshot.get("kind") != "windows-native-codex" or snapshot.get("nodeId") != node_id):
        raise NativeCodexError("invalid_native_codex_snapshot")
    files = snapshot.get("files")
    package = isinstance(files, dict) and "bin/codex.exe" in files
    entrypoint = "bin/codex.exe" if package else "codex.exe"
    if (not isinstance(files, dict) or entrypoint not in files or set(files) - set(PACKAGE_FILES if package else FILES)
            or any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value)
                   for value in files.values()) or snapshot.get("bundleId") != bundle_id(files)):
        raise NativeCodexError("invalid_native_codex_snapshot_hashes")
    directory = coordinates(root, node_id, snapshot["bundleId"])
    if snapshot.get("executable") != str(directory / entrypoint):
        raise NativeCodexError("native_codex_snapshot_path_mismatch")
    saved = ordinary_path(directory / "bundle.json")
    if (not saved.is_file() or saved.stat().st_size > 16384
            or json.loads(saved.read_text(encoding="utf-8")) != receipt(snapshot)
            or {file.relative_to(directory).as_posix() for file in directory.rglob("*") if file.is_file()}
                != set(files) | {"bundle.json"}):
        raise NativeCodexError("native_codex_snapshot_receipt_mismatch")
    for name, expected in hashes(snapshot).items():
        file = ordinary_path(name)
        if not file.is_file() or digest(file) != expected:
            raise NativeCodexError("native_codex_snapshot_checksum_mismatch")
    return snapshot


def pin(source, root, node_id, *, apply=False):
    """Never search PATH, change an existing bundle, or copy credentials/configuration."""
    source = ordinary_path(source)
    files = inventory(source)
    identity = bundle_id(files)
    directory = coordinates(root, node_id, identity)
    package = "bin/codex.exe" in files
    snapshot = {
        "schema": 1, "kind": "windows-native-codex", "nodeId": node_id, "bundleId": identity,
        "sourceExecutable": str(source), "executable": str(directory / ("bin/codex.exe" if package else "codex.exe")), "files": files,
    }
    if directory.exists():
        return verify(snapshot, root, node_id)
    if not apply:
        return snapshot
    if not Path(root).is_dir():
        raise NativeCodexError("create_owner_only_installation_root_before_pinning_codex")
    parent = ordinary_path(directory.parent)
    parent.mkdir(exist_ok=True)
    stage = ordinary_path(parent / (identity + ".prepare-" + secrets.token_hex(6)))
    if not stage.is_relative_to(ordinary_path(root)):
        raise NativeCodexError("native_codex_staging_outside_installation")
    stage.mkdir()
    # Failed staging is deliberately retained. Never recursively clean a computed path.
    for name, expected in files.items():
        original = ordinary_path((source.parent.parent if package else source.parent) / name)
        (stage / name).parent.mkdir(parents=True, exist_ok=True)
        with original.open("rb") as input_file, (stage / name).open("xb") as output:
            shutil.copyfileobj(input_file, output, 1024 * 1024)
        if digest(stage / name) != expected:
            raise NativeCodexError("native_codex_source_changed_during_copy_retry_with_current_explicit_path")
    if inventory(source) != files:
        raise NativeCodexError("native_codex_source_changed_during_copy_retry_with_current_explicit_path")
    (stage / "bundle.json").write_text(json.dumps(receipt(snapshot), indent=2) + "\n", encoding="utf-8")
    # Both absolute endpoints are checked immediately before the same-shell/native move.
    ordinary_path(stage)
    ordinary_path(directory)
    if not stage.is_relative_to(Path(root)) or not directory.is_relative_to(Path(root)) or directory.exists():
        raise NativeCodexError("native_codex_destination_changed_no_overwrite")
    os.rename(stage, directory)
    return verify(snapshot, root, node_id)
