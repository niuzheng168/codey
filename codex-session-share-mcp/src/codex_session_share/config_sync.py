"""Build and restore small, credential-free Codex configuration snapshots."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import platform
import re
import shutil
import tarfile
import tempfile
import tomllib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from .bundle import BundleError, extract_and_validate_bundle
from .names import validate_config_profile

CONFIG_BUNDLE_SCHEMA_VERSION = 1
CONFIG_BUNDLE_TYPE = "codex_config"
DEFAULT_MAX_CONFIG_INPUT_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_CONFIG_FILE_BYTES = 32 * 1024 * 1024

_CORE_CODEX_FILES = (
    "config.toml",
    "keybindings.json",
    "AGENTS.md",
    "models.json",
)
_OPTIONAL_CODEX_DIRECTORIES = {
    "automations": set(),
    "memories": set(),
    "pets": set(),
    "plugins": {".plugin-appserver", "cache"},
    "skills": {".system"},
}
_SSH_FILE_NAMES = {"config", "known_hosts", "known_hosts.old"}
_SECRET_PATTERN = re.compile(
    r"(?i)(?:access[_-]?token|api[_-]?key|authorization|bearer|credential|password|secret)"
)
_TOML_ASSIGNMENT = re.compile(r"^(\s*)([A-Za-z0-9_.\"'-]+)(\s*=\s*)(.*)$")

_GLOBAL_STATE_KEYS = {
    "local-projects",
    "remote-project-connection-backfill-completed",
    "electron-remote-control-config-migration-completed",
    "electron-internal-update-cdn-enabled",
    "electron-openai-mcp-form-elicitations-enabled",
    "globalDictationHotkey",
    "global-dictation-keep-visible",
    "codex-managed-remote-connections",
    "remote-connection-auto-connect-by-host-id",
    "host-id-remote-control-allowed",
    "remote-projects",
    "project-order",
    "selected-project",
    "project-appearances",
    "computer-use-bundled-plugin-auto-install-disabled",
    "electron-chrome-extension-sync-managed-plugin-ids",
}
_GLOBAL_ATOM_KEYS = {
    "agent-mode-by-host-id",
    "app-shell-bottom-panel-launcher-visible",
    "app-shell-file-tree-open",
    "app-shell:right-panel-width:v3",
    "browser-sidebar-comment-mode-coachmark-dismissed",
    "codexCloudAccess",
    "composer-auto-context-enabled",
    "composer-model-picker-menu-view-v1",
    "composer-permission-mode-visibility",
    "desktop-link-default-destination",
    "editorDiffViewMode",
    "flat-project-sidebar-preferences-v1",
    "full-access-warning-dismissed-at-v2",
    "home-composer-mode-v1",
    "image-side-panel-auto-expanded-v1",
    "last-explicit-review-diff-filter",
    "preferred-non-full-access-agent-mode-by-host-id",
    "sidebar-project-list-expanded-v1",
    "unified-sidebar-project-order-v1",
}
_GLOBAL_ATOM_PREFIXES = (
    "permission-selection-by-host-id:",
    "sidebar-project-expanded-v1-codex:",
)


class ConfigSyncError(RuntimeError):
    """Raised when a configuration snapshot cannot be built or restored safely."""


@dataclass(frozen=True)
class ConfigBundleResult:
    archive_path: Path
    archive_sha256: str
    archive_size_bytes: int
    manifest: dict[str, Any]


@dataclass(frozen=True)
class ConfigRestoreResult:
    profile: str
    backup_path: Path | None
    restored_files: tuple[str, ...]
    staged_app_state: Path | None
    applied_app_state: bool
    warnings: tuple[str, ...]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.config-sync.tmp")
    with temporary.open("wb") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _inventory(root: Path) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.is_symlink():
            values.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "type": "file",
                    "size": path.stat().st_size,
                    "sha256": _sha256_file(path),
                }
            )
    return values


def _sanitize_config_toml(content: str) -> tuple[str, list[str]]:
    redactions: list[str] = []
    current_section = ""
    output: list[str] = []
    for raw_line in content.splitlines(keepends=True):
        stripped = raw_line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current_section = stripped.strip("[]").strip()
            output.append(raw_line)
            continue
        match = _TOML_ASSIGNMENT.match(raw_line.rstrip("\r\n"))
        if match is None or stripped.startswith("#"):
            output.append(raw_line)
            continue
        key = match.group(2).strip("\"'")
        candidate = f"{current_section}.{key}" if current_section else key
        value = match.group(4)
        if not (_SECRET_PATTERN.search(candidate) or _SECRET_PATTERN.search(value)):
            output.append(raw_line)
            continue
        replacement = "{}" if key.lower() in {"env", "http_headers", "headers"} else (
            '"<redacted-by-codex-config-sync>"'
        )
        newline = "\r\n" if raw_line.endswith("\r\n") else "\n" if raw_line.endswith("\n") else ""
        output.append(f"{match.group(1)}{match.group(2)}{match.group(3)}{replacement}{newline}")
        redactions.append(candidate)
    sanitized = "".join(output)
    try:
        tomllib.loads(sanitized)
    except tomllib.TOMLDecodeError as exc:
        raise ConfigSyncError(f"sanitized config.toml is not valid TOML: {exc}") from exc
    return sanitized, sorted(set(redactions))


def _scrub_secret_keys(value: Any, *, path: str = "") -> tuple[Any, list[str]]:
    redactions: list[str] = []
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            if _SECRET_PATTERN.search(str(key)):
                redactions.append(child_path)
                continue
            sanitized, nested = _scrub_secret_keys(child, path=child_path)
            result[str(key)] = sanitized
            redactions.extend(nested)
        return result, redactions
    if isinstance(value, list):
        result = []
        for index, child in enumerate(value):
            sanitized, nested = _scrub_secret_keys(child, path=f"{path}[{index}]")
            result.append(sanitized)
            redactions.extend(nested)
        return result, redactions
    return copy.deepcopy(value), redactions


def sanitize_global_state(value: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Retain preferences/projects/remotes while dropping all thread and prompt history."""

    result = {
        key: copy.deepcopy(value[key])
        for key in _GLOBAL_STATE_KEYS
        if key in value
    }
    atom_source = value.get("electron-persisted-atom-state")
    if isinstance(atom_source, dict):
        atom = {
            key: copy.deepcopy(child)
            for key, child in atom_source.items()
            if key in _GLOBAL_ATOM_KEYS
            or any(key.startswith(prefix) for prefix in _GLOBAL_ATOM_PREFIXES)
        }
        if atom:
            result["electron-persisted-atom-state"] = atom
    sanitized, redactions = _scrub_secret_keys(result)
    return sanitized, sorted(set(redactions))


def _copy_snapshot_file(
    *,
    source: Path,
    destination: Path,
    target_root: str,
    target_path: str,
    files: list[dict[str, Any]],
    max_single_file_bytes: int,
) -> int:
    if source.is_symlink():
        raise ConfigSyncError(f"configuration symlinks are not copied: {source}")
    size = source.stat().st_size
    if size > max_single_file_bytes:
        raise ConfigSyncError(
            f"configuration file exceeds {max_single_file_bytes} bytes: {source}"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    files.append(
        {
            "archive_path": destination.as_posix(),
            "target_root": target_root,
            "target_path": target_path,
            "size": size,
            "sha256": _sha256_file(destination),
        }
    )
    return size


def _source_platform() -> str:
    name = platform.system().lower()
    if name == "darwin":
        return "macos"
    if name == "windows":
        return "windows"
    return "linux"


def build_config_bundle(
    profile: str,
    output_path: Path,
    *,
    codex_home: Path | None = None,
    user_home: Path | None = None,
    include_app_state: bool = True,
    include_ssh_config: bool = True,
    include_automations: bool = True,
    include_memories: bool = False,
    include_customizations: bool = True,
    max_input_bytes: int = DEFAULT_MAX_CONFIG_INPUT_BYTES,
    max_single_file_bytes: int = DEFAULT_MAX_CONFIG_FILE_BYTES,
) -> ConfigBundleResult:
    """Create a compact private settings archive without sessions or credentials."""

    profile = validate_config_profile(profile)
    codex_home = (
        codex_home or Path(os.environ.get("CODEX_HOME", "~/.codex"))
    ).expanduser().resolve()
    user_home = (user_home or Path.home()).expanduser().resolve()
    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []
    redactions: list[str] = []
    archived_files: list[dict[str, Any]] = []
    total_input_bytes = 0

    with tempfile.TemporaryDirectory(prefix="codex-config-sync-build-") as temporary:
        stage = Path(temporary)
        payload = stage / "payload"

        for name in _CORE_CODEX_FILES:
            source = codex_home / name
            if not source.is_file():
                continue
            destination = payload / "codex" / name
            if name == "config.toml":
                sanitized, config_redactions = _sanitize_config_toml(
                    source.read_text(encoding="utf-8")
                )
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(sanitized, encoding="utf-8")
                redactions.extend(f"config.toml:{item}" for item in config_redactions)
                size = destination.stat().st_size
                archived_files.append(
                    {
                        "archive_path": destination.relative_to(stage).as_posix(),
                        "target_root": "codex",
                        "target_path": name,
                        "size": size,
                        "sha256": _sha256_file(destination),
                    }
                )
                total_input_bytes += size
                continue
            size = _copy_snapshot_file(
                source=source,
                destination=destination,
                target_root="codex",
                target_path=name,
                files=archived_files,
                max_single_file_bytes=max_single_file_bytes,
            )
            archived_files[-1]["archive_path"] = destination.relative_to(stage).as_posix()
            total_input_bytes += size

        selected_directories: list[str] = []
        if include_automations:
            selected_directories.append("automations")
        if include_memories:
            selected_directories.append("memories")
        if include_customizations:
            selected_directories.extend(("pets", "plugins", "skills"))
        for name in selected_directories:
            source_root = codex_home / name
            if not source_root.is_dir():
                continue
            excluded_first_parts = _OPTIONAL_CODEX_DIRECTORIES[name]
            for source in sorted(source_root.rglob("*")):
                if not source.is_file() or source.is_symlink():
                    continue
                relative = source.relative_to(source_root)
                if relative.parts and (
                    relative.parts[0] in excluded_first_parts
                    or relative.parts[0].startswith(".")
                ):
                    continue
                destination = payload / "codex" / name / relative
                size = _copy_snapshot_file(
                    source=source,
                    destination=destination,
                    target_root="codex",
                    target_path=(Path(name) / relative).as_posix(),
                    files=archived_files,
                    max_single_file_bytes=max_single_file_bytes,
                )
                archived_files[-1]["archive_path"] = destination.relative_to(stage).as_posix()
                total_input_bytes += size

        app_state_manifest: dict[str, Any] | None = None
        app_state_path = codex_home / ".codex-global-state.json"
        if include_app_state and app_state_path.is_file():
            try:
                source_state = json.loads(app_state_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise ConfigSyncError("Codex global app state is not valid JSON") from exc
            if not isinstance(source_state, dict):
                raise ConfigSyncError("Codex global app state must be a JSON object")
            sanitized_state, state_redactions = sanitize_global_state(source_state)
            redactions.extend(f"app-state:{item}" for item in state_redactions)
            destination = payload / "app-state.json"
            _write_json(destination, sanitized_state)
            app_state_manifest = {
                "archive_path": destination.relative_to(stage).as_posix(),
                "target_path": ".codex-global-state.json",
                "top_level_keys": sorted(sanitized_state),
            }
            total_input_bytes += destination.stat().st_size

        if include_ssh_config:
            ssh_root = user_home / ".ssh"
            if ssh_root.is_dir():
                for source in sorted(ssh_root.rglob("*")):
                    if not source.is_file() or source.is_symlink():
                        continue
                    relative = source.relative_to(ssh_root)
                    allowed = (
                        (len(relative.parts) == 1 and (
                            source.name in _SSH_FILE_NAMES or source.suffix == ".pub"
                        ))
                        or (relative.parts and relative.parts[0] == "config.d")
                    )
                    if not allowed:
                        continue
                    destination = payload / "ssh" / relative
                    size = _copy_snapshot_file(
                        source=source,
                        destination=destination,
                        target_root="ssh",
                        target_path=relative.as_posix(),
                        files=archived_files,
                        max_single_file_bytes=max_single_file_bytes,
                    )
                    archived_files[-1]["archive_path"] = destination.relative_to(stage).as_posix()
                    total_input_bytes += size

        if total_input_bytes > max_input_bytes:
            raise ConfigSyncError(
                f"configuration snapshot input exceeds {max_input_bytes} bytes"
            )

        if redactions:
            warnings.append(
                "Credential-like values were removed and must be configured again on restore."
            )
        manifest: dict[str, Any] = {
            "schema_version": CONFIG_BUNDLE_SCHEMA_VERSION,
            "bundle_type": CONFIG_BUNDLE_TYPE,
            "profile": profile,
            "created_at": datetime.now(UTC).isoformat(),
            "source": {
                "platform": _source_platform(),
                "user_home": str(user_home),
                "codex_home": str(codex_home),
            },
            "options": {
                "app_state": bool(app_state_manifest),
                "ssh_config": include_ssh_config,
                "automations": include_automations,
                "memories": include_memories,
                "customizations": include_customizations,
            },
            "files": archived_files,
            "app_state": app_state_manifest,
            "security": {
                "credentials_included": False,
                "session_history_included": False,
                "ssh_private_keys_included": False,
                "redactions": sorted(set(redactions)),
                "excluded_sources": [
                    "auth.json and MCP OAuth state",
                    "sessions and archived_sessions",
                    "thread, goal, queue, memory, and log SQLite databases",
                    "SSH private keys",
                    "browser profiles, caches, runtimes, sandboxes, and temporary files",
                ],
            },
            "summary": {
                "file_count": len(archived_files) + (1 if app_state_manifest else 0),
                "input_bytes": total_input_bytes,
            },
            "warnings": warnings,
        }
        _write_json(stage / "manifest.json", manifest)
        manifest["inventory"] = _inventory(stage)
        _write_json(stage / "manifest.json", manifest)
        with tarfile.open(output_path, "w:gz", compresslevel=6) as archive:
            for child in sorted(stage.iterdir()):
                archive.add(child, arcname=child.name, recursive=True)

    return ConfigBundleResult(
        archive_path=output_path,
        archive_sha256=_sha256_file(output_path),
        archive_size_bytes=output_path.stat().st_size,
        manifest=manifest,
    )


def _safe_archive_relative(value: str) -> Path:
    relative = PurePosixPath(value)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise ConfigSyncError(f"unsafe config archive path: {value}")
    return Path(*relative.parts)


def _path_replacements(manifest: dict[str, Any], target_user_home: Path, target_codex_home: Path):
    source = manifest.get("source") or {}
    source_user_home = str(source.get("user_home") or "")
    source_codex_home = str(source.get("codex_home") or "")
    return [
        (source_codex_home, str(target_codex_home)),
        (source_user_home, str(target_user_home)),
    ]


def _rewrite_text_paths(
    content: str,
    replacements: list[tuple[str, str]],
    *,
    target_platform: str,
) -> tuple[str, list[str]]:
    result = content
    warnings: list[str] = []
    for source, target in replacements:
        if not source:
            continue
        variants = {
            source,
            source.replace("\\", "/"),
            source.replace("\\", "\\\\"),
        }
        for variant in sorted(variants, key=len, reverse=True):
            if not variant:
                continue
            replacement = target
            if target_platform == "windows" and "\\\\" in variant:
                replacement = target.replace("\\", "\\\\")
            flags = re.IGNORECASE if re.match(r"^[A-Za-z]:", source) else 0
            result = re.sub(re.escape(variant), lambda _match, value=replacement: value, result, flags=flags)
        if source in result:
            warnings.append(f"Some references to source path remain: {source}")
    if target_platform != "windows":
        target_prefixes = [target for _source, target in replacements if target]
        for prefix in target_prefixes:
            result = result.replace(prefix + "\\", prefix.rstrip("/") + "/")
    return result, warnings


def _rewrite_json_paths(
    value: Any,
    replacements: list[tuple[str, str]],
    *,
    target_platform: str,
) -> Any:
    if isinstance(value, dict):
        return {
            str(_rewrite_json_paths(key, replacements, target_platform=target_platform)):
            _rewrite_json_paths(child, replacements, target_platform=target_platform)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [
            _rewrite_json_paths(child, replacements, target_platform=target_platform)
            for child in value
        ]
    if not isinstance(value, str):
        return copy.deepcopy(value)
    result, _warnings = _rewrite_text_paths(
        value,
        replacements,
        target_platform=target_platform,
    )
    if target_platform != "windows" and (
        result.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", value)
    ):
        result = result.replace("\\", "/")
    elif target_platform == "windows" and result.startswith("/"):
        result = result.replace("/", "\\")
    return result


def _pause_automation(content: str) -> str:
    pattern = re.compile(r'(?m)^status\s*=\s*"(?:ACTIVE|PAUSED)"\s*$')
    if pattern.search(content):
        return pattern.sub('status = "PAUSED"', content)
    suffix = "" if not content or content.endswith("\n") else "\n"
    return content + suffix + 'status = "PAUSED"\n'


def _merge_global_state(existing: dict[str, Any], imported: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(existing)
    imported = copy.deepcopy(imported)
    imported_atoms = imported.pop("electron-persisted-atom-state", None)
    merged.update(imported)
    if isinstance(imported_atoms, dict):
        current_atoms = merged.get("electron-persisted-atom-state")
        if not isinstance(current_atoms, dict):
            current_atoms = {}
        current_atoms = copy.deepcopy(current_atoms)
        current_atoms.update(imported_atoms)
        merged["electron-persisted-atom-state"] = current_atoms
    return merged


def restore_config_bundle(
    extracted_root: Path,
    manifest: dict[str, Any],
    *,
    target_codex_home: Path | None = None,
    target_user_home: Path | None = None,
    target_platform: str | None = None,
    apply_app_state: bool = False,
    activate_automations: bool = False,
) -> ConfigRestoreResult:
    """Merge a private configuration snapshot into the current machine with backups."""

    if manifest.get("schema_version") != CONFIG_BUNDLE_SCHEMA_VERSION:
        raise ConfigSyncError("unsupported config bundle schema version")
    if manifest.get("bundle_type") != CONFIG_BUNDLE_TYPE:
        raise ConfigSyncError("archive is not a Codex configuration snapshot")
    profile = validate_config_profile(str(manifest.get("profile") or ""))
    target_codex_home = (
        target_codex_home or Path(os.environ.get("CODEX_HOME", "~/.codex"))
    ).expanduser().resolve()
    target_user_home = (target_user_home or Path.home()).expanduser().resolve()
    target_platform = target_platform or _source_platform()
    if target_platform not in {"windows", "macos", "linux"}:
        raise ConfigSyncError("target platform must be windows, macos, or linux")
    target_codex_home.mkdir(parents=True, exist_ok=True)
    ssh_root = target_user_home / ".ssh"
    replacements = _path_replacements(manifest, target_user_home, target_codex_home)
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    backup_root = target_codex_home / "config-sync-backups" / profile / timestamp
    backup_created = False
    restored: list[str] = []
    warnings = list(manifest.get("warnings") or [])

    def backup(target: Path, category: str, relative: Path) -> None:
        nonlocal backup_created
        if not target.is_file():
            return
        destination = backup_root / category / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, destination)
        backup_created = True

    for item in manifest.get("files") or []:
        archive_relative = _safe_archive_relative(str(item.get("archive_path") or ""))
        source = extracted_root / archive_relative
        if not source.is_file():
            raise ConfigSyncError(f"config archive file is missing: {archive_relative}")
        target_relative = _safe_archive_relative(str(item.get("target_path") or ""))
        target_root = str(item.get("target_root") or "")
        if target_root == "codex":
            target = target_codex_home / target_relative
            category = "codex"
        elif target_root == "ssh":
            target = ssh_root / target_relative
            category = "ssh"
        else:
            raise ConfigSyncError(f"unsupported config target root: {target_root}")
        content = source.read_bytes()
        if target_relative.as_posix() == "config.toml":
            rewritten, path_warnings = _rewrite_text_paths(
                content.decode("utf-8"),
                replacements,
                target_platform=target_platform,
            )
            try:
                tomllib.loads(rewritten)
            except tomllib.TOMLDecodeError:
                warnings.append(
                    "Automatic path translation would invalidate config.toml; source paths were retained."
                )
            else:
                content = rewritten.encode("utf-8")
                warnings.extend(path_warnings)
        if (
            target_root == "codex"
            and target_relative.name == "automation.toml"
            and not activate_automations
        ):
            content = _pause_automation(content.decode("utf-8")).encode("utf-8")
        backup(target, category, target_relative)
        _atomic_write(target, content)
        if target_root == "ssh":
            try:
                target.chmod(0o644 if target.suffix == ".pub" else 0o600)
            except OSError:
                pass
        restored.append(f"{target_root}:{target_relative.as_posix()}")

    staged_app_state: Path | None = None
    applied_app_state = False
    app_state = manifest.get("app_state")
    if isinstance(app_state, dict) and app_state.get("archive_path"):
        source = extracted_root / _safe_archive_relative(str(app_state["archive_path"]))
        if not source.is_file():
            raise ConfigSyncError("config archive app state is missing")
        imported = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(imported, dict):
            raise ConfigSyncError("config archive app state must be a JSON object")
        imported = _rewrite_json_paths(
            imported,
            replacements,
            target_platform=target_platform,
        )
        target = target_codex_home / ".codex-global-state.json"
        existing: dict[str, Any] = {}
        if target.is_file():
            try:
                loaded = json.loads(target.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    existing = loaded
            except json.JSONDecodeError:
                warnings.append(
                    "Existing Codex app state is invalid JSON; the imported state was not merged with it."
                )
            backup(target, "codex", Path(".codex-global-state.json"))
        merged = _merge_global_state(existing, imported)
        encoded = json.dumps(
            merged,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        if apply_app_state:
            _atomic_write(target, encoded)
            restored.append("codex:.codex-global-state.json")
            applied_app_state = True
            warnings.append("Restart Codex so imported app settings and remote connections reload.")
        else:
            staged_app_state = (
                target_codex_home
                / "config-sync-pending"
                / profile
                / ".codex-global-state.json"
            )
            _atomic_write(staged_app_state, encoded)
            warnings.append(
                "App settings were staged, not applied. Quit Codex, replace "
                f"{target} with {staged_app_state}, then reopen Codex."
            )

    return ConfigRestoreResult(
        profile=profile,
        backup_path=backup_root if backup_created else None,
        restored_files=tuple(restored),
        staged_app_state=staged_app_state,
        applied_app_state=applied_app_state,
        warnings=tuple(dict.fromkeys(str(item) for item in warnings if item)),
    )


def extract_config_bundle(archive_path: Path, destination: Path) -> dict[str, Any]:
    """Safely extract and validate a Codex configuration archive."""

    try:
        manifest = extract_and_validate_bundle(archive_path, destination)
    except BundleError as exc:
        raise ConfigSyncError(str(exc)) from exc
    if manifest.get("bundle_type") != CONFIG_BUNDLE_TYPE:
        raise ConfigSyncError("archive is not a Codex configuration snapshot")
    return manifest
