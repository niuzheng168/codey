"""Stdlib-only service bootstrap: verify every Python input BEFORE package import."""
import argparse
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import sys

ENTRYPOINT = "codey_node/service/launcher.py"
SHARED_FILES = (
    "codey_node/__init__.py",
    "codey_node/common/__init__.py", "codey_node/common/errors.py", "codey_node/common/files.py",
    "codey_node/devtunnel/__init__.py", "codey_node/devtunnel/auth.py",
    "codey_node/devtunnel/binding.py", "codey_node/devtunnel/renewal.py",
    "codey_node/service/__init__.py", ENTRYPOINT,
    "codey_node/platforms/__init__.py",
)
COMPONENTS = {
    "linux": ("host", "renew"),
    "macos": ("codex", "workspace", "data", "tunnel", "renew"),
    "windows": ("workspace", "data", "tunnel", "renew"),
}


def runtime_files(platform):
    if platform not in COMPONENTS:
        raise RuntimeError("unsupported_service_platform")
    prefix = f"codey_node/platforms/{platform}/"
    return (*SHARED_FILES, prefix + "__init__.py", prefix + "supervisor.py",
            *((prefix + "owner.py",) if platform == "windows" else ()))


def ordinary_path(value):
    path = Path(value)
    if not path.is_absolute() or path.resolve() != path:
        raise RuntimeError("service_path_must_be_absolute_and_unlinked")
    if any(part.is_symlink() or part.is_junction() for part in (path, *path.parents)):
        raise RuntimeError("linked_service_path")
    return path


def validate_files(bundle, platform):
    """Also used by installers and long-lived supervisors; never imports the payload."""
    if not isinstance(bundle, dict) or bundle.get("schema") != 1 or bundle.get("platform") != platform:
        raise RuntimeError("service_bundle_platform_mismatch")
    root = ordinary_path(bundle["root"])
    expected = set(runtime_files(platform))
    hashes = bundle.get("fileHashes", {})
    if not root.is_dir() or set(hashes) != expected or bundle.get("entrypoint") != str(root / ENTRYPOINT):
        raise RuntimeError("incomplete_service_module_manifest")
    actual = {file.relative_to(root).as_posix() for file in root.rglob("*") if not file.is_dir()}
    if actual != expected:
        raise RuntimeError("unexpected_or_missing_service_module")
    for relative in expected:
        file = ordinary_path(root / relative)
        if (not file.is_file() or not isinstance(hashes[relative], str)
                or not re.fullmatch(r"[a-f0-9]{64}", hashes[relative])
                or file.stat().st_size > 128 * 1024):
            raise RuntimeError("invalid_service_module")
        if os.name != "nt" and (file.stat().st_uid != os.getuid() or file.stat().st_mode & 0o077):
            raise RuntimeError("service_modules_must_be_owner_only")
        with file.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != hashes[relative]:
                raise RuntimeError("service_module_checksum_mismatch")
    return root


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--component", required=True)
    args = parser.parse_args(argv)
    if not sys.flags.isolated or not sys.dont_write_bytecode:
        raise RuntimeError("service_requires_python_I_B")
    config_file = ordinary_path(args.config)
    if not config_file.is_file() or config_file.stat().st_size > 1024 * 1024:
        raise RuntimeError("invalid_service_configuration")
    if os.name != "nt" and (config_file.stat().st_uid != os.getuid() or config_file.stat().st_mode & 0o077):
        raise RuntimeError("service_configuration_must_be_owner_only")
    config = json.loads(config_file.read_text(encoding="utf-8-sig"))
    platform = {"linux": "linux", "darwin": "macos", "win32": "windows"}.get(sys.platform)
    if platform not in COMPONENTS or args.component not in COMPONENTS[platform]:
        raise RuntimeError("unsupported_native_service_component")
    bundle = config["pythonRuntime"]
    root = validate_files(bundle, platform)
    if str(Path(__file__).resolve()) != bundle["entrypoint"]:
        raise RuntimeError("service_launcher_does_not_match_runtime")
    # No flat copies or unverified sibling imports. Only the complete pinned
    # package and the isolated interpreter's stdlib are on the import path.
    sys.path.insert(0, str(root))
    supervisor = importlib.import_module(f"codey_node.platforms.{platform}.supervisor")
    supervisor.serve(config_file, args.component)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Codey service stopped: inspect owner login, configuration and pinned modules.", file=sys.stderr)
        raise SystemExit(1)
