"""Build and validate portable Codex session archives."""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

BUNDLE_SCHEMA_VERSION = 1
DEFAULT_MAX_ARCHIVE_INPUT_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_MAX_SINGLE_FILE_BYTES = 256 * 1024 * 1024

_ALWAYS_EXCLUDED_PARTS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    ".tox",
    ".azure",
    ".aws",
    ".ssh",
    "secrets",
}
_SENSITIVE_NAMES = {
    ".env",
    "auth.json",
    "credentials.json",
    "service-account.json",
    "id_rsa",
    "id_ed25519",
}
_SENSITIVE_GLOBS = (
    ".env.*",
    "*.pem",
    "*.key",
    "*.pfx",
    "*.p12",
    "*.kdbx",
)


class BundleError(RuntimeError):
    """Raised when a session cannot be packaged or validated."""


@dataclass(frozen=True)
class BundleBuildResult:
    archive_path: Path
    archive_sha256: str
    archive_size_bytes: int
    manifest: dict[str, Any]
    handoff_summary: str


@dataclass(frozen=True)
class RolloutSnapshot:
    source_size_bytes: int
    captured_size_bytes: int
    omitted_trailing_bytes: int
    boundary: str
    completed_turns: int


_TOOL_CALL_OUTPUT_TYPES = {
    "function_call": "function_call_output",
    "custom_tool_call": "custom_tool_call_output",
    "tool_search_call": "tool_search_output",
}
_TOOL_OUTPUT_TYPES = frozenset(_TOOL_CALL_OUTPUT_TYPES.values())


class _ToolCallTracker:
    def __init__(self) -> None:
        self.calls: dict[str, str] = {}
        self.outputs: dict[str, str] = {}

    def replace(self, items: Any) -> None:
        self.calls.clear()
        self.outputs.clear()
        if isinstance(items, list):
            for item in items:
                self.add(item)

    def add(self, item: Any) -> None:
        if not isinstance(item, dict):
            return
        item_type = item.get("type")
        call_id = item.get("call_id")
        if not isinstance(call_id, str) or not call_id:
            return
        if item_type in _TOOL_CALL_OUTPUT_TYPES:
            self.calls[call_id] = _TOOL_CALL_OUTPUT_TYPES[item_type]
        elif item_type in _TOOL_OUTPUT_TYPES:
            self.outputs[call_id] = str(item_type)

    def error(self) -> str | None:
        missing = [
            call_id
            for call_id, output_type in self.calls.items()
            if self.outputs.get(call_id) != output_type
        ]
        orphaned = [call_id for call_id in self.outputs if call_id not in self.calls]
        if not missing and not orphaned:
            return None
        details: list[str] = []
        if missing:
            details.append(f"missing outputs for {', '.join(missing[:3])}")
        if orphaned:
            details.append(f"orphaned outputs for {', '.join(orphaned[:3])}")
        return "; ".join(details)


def _rollout_record(line: bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def select_rollout_snapshot(rollout_path: Path) -> RolloutSnapshot:
    """Select an atomic, tool-call-balanced rollout prefix for portable transfer."""

    tracker = _ToolCallTracker()
    first_task_started_offset: int | None = None
    completed_turns = 0
    valid_completions: list[int] = []
    completion_errors: list[str] = []

    with rollout_path.open("rb") as handle:
        while line := handle.readline():
            line_start = handle.tell() - len(line)
            line_end = handle.tell()
            record = _rollout_record(line)
            if record is None:
                continue
            record_type = record.get("type")
            payload = record.get("payload")
            if record_type == "compacted" and isinstance(payload, dict):
                tracker.replace(payload.get("replacement_history"))
            elif record_type == "response_item":
                tracker.add(payload)

            if record_type != "event_msg" or not isinstance(payload, dict):
                continue
            event_type = payload.get("type")
            if event_type == "task_started" and first_task_started_offset is None:
                first_task_started_offset = line_start
            elif event_type == "task_complete":
                completed_turns += 1
                error = tracker.error()
                if error is None:
                    valid_completions.append(line_end)
                else:
                    completion_errors.append(error)
        source_size = handle.tell()

    if valid_completions:
        captured_size = valid_completions[-1]
        boundary = "last_completed_turn"
    elif completed_turns:
        detail = completion_errors[-1] if completion_errors else "unbalanced tool calls"
        raise BundleError(
            "no completed rollout turn has portable tool-call history: " + detail
        )
    elif first_task_started_offset is not None:
        captured_size = first_task_started_offset
        boundary = "before_first_active_turn"
    else:
        error = tracker.error()
        if error is not None:
            raise BundleError("rollout has incomplete tool-call history: " + error)
        captured_size = source_size
        boundary = "legacy_end_of_file"

    return RolloutSnapshot(
        source_size_bytes=source_size,
        captured_size_bytes=captured_size,
        omitted_trailing_bytes=source_size - captured_size,
        boundary=boundary,
        completed_turns=completed_turns,
    )


def copy_rollout_snapshot(source: Path, destination: Path) -> RolloutSnapshot:
    """Copy only the selected portable rollout prefix."""

    snapshot = select_rollout_snapshot(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    remaining = snapshot.captured_size_bytes
    with source.open("rb") as input_handle, destination.open("wb") as output:
        while remaining:
            chunk = input_handle.read(min(1024 * 1024, remaining))
            if not chunk:
                raise BundleError("rollout changed while its portable snapshot was copied")
            output.write(chunk)
            remaining -= len(chunk)
    shutil.copystat(source, destination)
    return snapshot


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _sqlite_row(db_path: Path, table: str, where_column: str, value: str) -> dict[str, Any] | None:
    if not db_path.is_file():
        return None
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        row = connection.execute(
            f'SELECT * FROM "{table}" WHERE "{where_column}" = ?',
            (value,),
        ).fetchone()
        return dict(row) if row else None
    except sqlite3.DatabaseError:
        return None
    finally:
        connection.close()


def _sqlite_rows(
    db_path: Path,
    table: str,
    where_column: str,
    value: str,
) -> list[dict[str, Any]]:
    if not db_path.is_file():
        return []
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            f'SELECT * FROM "{table}" WHERE "{where_column}" = ?',
            (value,),
        ).fetchall()
        return [dict(row) for row in rows]
    except sqlite3.DatabaseError:
        return []
    finally:
        connection.close()


def _find_rollout(codex_home: Path, session_id: str) -> Path:
    thread = _sqlite_row(codex_home / "state_5.sqlite", "threads", "id", session_id)
    if thread:
        configured = Path(str(thread.get("rollout_path") or ""))
        if configured.is_file():
            return configured
    candidates = [
        *codex_home.glob(f"sessions/*/*/*/*{session_id}.jsonl"),
        *codex_home.glob(f"archived_sessions/*{session_id}.jsonl"),
    ]
    candidates = [candidate for candidate in candidates if candidate.is_file()]
    if not candidates:
        raise BundleError(f"Codex session {session_id!r} was not found under {codex_home}")
    return max(candidates, key=lambda candidate: candidate.stat().st_mtime_ns)


def _read_session_index(codex_home: Path, session_id: str) -> dict[str, Any] | None:
    index = codex_home / "session_index.jsonl"
    if not index.is_file():
        return None
    selected: dict[str, Any] | None = None
    with index.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if value.get("id") == session_id:
                selected = value
    return selected


def _structured_local_files(rollout_path: Path, codex_home: Path) -> set[Path]:
    """Collect actual structured local-image references, not paths printed in messages."""

    result: set[Path] = set()
    attachments_root = (codex_home / "attachments").resolve()

    def consider(value: Any, *, key: str = "") -> None:
        if isinstance(value, dict):
            for child_key, child in value.items():
                consider(child, key=str(child_key))
            return
        if isinstance(value, list):
            for child in value:
                consider(child, key=key)
            return
        if not isinstance(value, str):
            return
        if key not in {"path", "local_image", "local_images", "image_path"}:
            return
        raw = value.removeprefix("file://")
        candidate = Path(raw).expanduser()
        try:
            resolved = candidate.resolve()
            resolved.relative_to(attachments_root)
        except (OSError, ValueError):
            return
        if resolved.is_file():
            result.add(resolved)

    with rollout_path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            consider(value)
    return result


def _extract_messages(rollout_path: Path) -> list[tuple[str, str]]:
    messages: list[tuple[str, str]] = []
    with rollout_path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            record_type = value.get("type")
            payload = value.get("payload")
            if not isinstance(payload, dict):
                continue
            if record_type == "event_msg" and payload.get("type") == "user_message":
                text = payload.get("message")
                if isinstance(text, str) and text.strip():
                    messages.append(("user", text.strip()))
            elif record_type == "event_msg" and payload.get("type") == "agent_message":
                text = payload.get("message")
                if isinstance(text, str) and text.strip():
                    messages.append(("assistant", text.strip()))
    return messages


def _build_handoff(
    session_id: str,
    thread: dict[str, Any] | None,
    goal: dict[str, Any] | None,
    rollout_path: Path,
    *,
    max_chars: int = 24_000,
) -> str:
    lines = [f"Imported Codex session: {session_id}"]
    if thread:
        if thread.get("title"):
            lines.append(f"Title: {thread['title']}")
        if thread.get("cwd"):
            lines.append(f"Source workspace: {thread['cwd']}")
        if thread.get("git_branch") or thread.get("git_sha"):
            lines.append(
                "Git: "
                + " ".join(
                    str(value)
                    for value in (thread.get("git_branch"), thread.get("git_sha"))
                    if value
                )
            )
    if goal:
        lines.append(f"Goal status: {goal.get('status', 'unknown')}")
        if goal.get("objective"):
            lines.extend(["Goal:", str(goal["objective"]).strip()])
    lines.append("")
    lines.append("Recent conversation:")
    remaining = max_chars - sum(len(line) + 1 for line in lines)
    selected: list[str] = []
    for role, message in reversed(_extract_messages(rollout_path)):
        rendered = f"{role.upper()}: {message}"
        if len(rendered) > remaining and selected:
            break
        if len(rendered) > remaining:
            rendered = rendered[-remaining:]
        selected.append(rendered)
        remaining -= len(rendered) + 2
        if remaining <= 0 or len(selected) >= 24:
            break
    lines.extend(reversed(selected))
    return "\n\n".join(lines).strip()


def _is_sensitive(relative_path: Path) -> bool:
    if any(part in _ALWAYS_EXCLUDED_PARTS for part in relative_path.parts):
        return True
    name = relative_path.name
    if name in _SENSITIVE_NAMES:
        return True
    return any(fnmatch.fnmatch(name, pattern) for pattern in _SENSITIVE_GLOBS)


def _git_output(workspace: Path, *arguments: str, check: bool = True) -> str:
    completed = subprocess.run(
        ["git", "-C", str(workspace), *arguments],
        check=check,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def _workspace_files(workspace: Path) -> tuple[Path, list[Path], dict[str, Any]]:
    try:
        root = Path(_git_output(workspace, "rev-parse", "--show-toplevel")).resolve()
    except (subprocess.CalledProcessError, FileNotFoundError):
        root = workspace.resolve()
        files = [
            path
            for path in root.rglob("*")
            if path.is_file() or path.is_symlink()
        ]
        return root, files, {"is_git": False}

    raw_files = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    files = []
    for encoded in raw_files.split(b"\0"):
        if not encoded:
            continue
        candidate = root / os.fsdecode(encoded)
        if candidate.is_file() or candidate.is_symlink():
            files.append(candidate)
    metadata = {
        "is_git": True,
        "root": str(root),
        "commit": _git_output(root, "rev-parse", "HEAD", check=False),
        "branch": _git_output(root, "branch", "--show-current", check=False),
        "origin": _git_output(root, "remote", "get-url", "origin", check=False),
        "status_porcelain_v2": _git_output(
            root, "status", "--porcelain=v2", "--untracked-files=all", check=False
        ),
        "deleted_tracked_files": [
            os.fsdecode(value)
            for value in subprocess.run(
                ["git", "-C", str(root), "ls-files", "-d", "-z"],
                check=False,
                stdout=subprocess.PIPE,
            ).stdout.split(b"\0")
            if value
        ],
    }
    return root, files, metadata


def _copy_preserving_link(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
    else:
        shutil.copy2(source, destination)


def _inventory(root: Path) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            values.append(
                {
                    "path": relative,
                    "type": "symlink",
                    "target": os.readlink(path),
                }
            )
        elif path.is_file():
            values.append(
                {
                    "path": relative,
                    "type": "file",
                    "size": path.stat().st_size,
                    "sha256": _sha256_file(path),
                }
            )
    return values


def _safe_legacy_relative(value: Any, *, field: str) -> Path:
    pure = PurePosixPath(str(value or ""))
    if not pure.parts or pure.is_absolute() or ".." in pure.parts:
        raise BundleError(f"unsafe legacy {field}: {value}")
    return Path(*pure.parts)


def _legacy_json(path: Path) -> Any:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BundleError(f"legacy bundle contains invalid JSON: {path.name}") from exc


def _legacy_source_codex_home(
    archived_rollout: Path,
    source_rollout: str,
) -> str:
    source_rollout = source_rollout.strip()
    if not source_rollout:
        return ""
    archived_parts = archived_rollout.parts
    try:
        codex_home_index = archived_parts.index("codex_home")
    except ValueError:
        return ""
    relative = Path(*archived_parts[codex_home_index + 1 :]).as_posix()
    suffix = f"/{relative}" if relative else ""
    if suffix and source_rollout.endswith(suffix):
        return source_rollout[: -len(suffix)]
    marker = "/.codex/"
    if marker in source_rollout:
        return source_rollout.split(marker, 1)[0] + "/.codex"
    return ""


def _normalize_legacy_bundle(
    destination: Path,
    legacy_manifest: dict[str, Any],
) -> dict[str, Any]:
    """Convert the pre-0.6 portable archive layout into the current layout."""

    if (
        legacy_manifest.get("format_version") != 1
        or legacy_manifest.get("bundle_type") != "codex_session"
    ):
        raise BundleError("unsupported session bundle schema version")

    session_id = str(legacy_manifest.get("session_id") or "").strip()
    if not session_id:
        raise BundleError("legacy bundle does not identify a session")

    archived_rollout = _safe_legacy_relative(
        legacy_manifest.get("rollout_path"),
        field="rollout path",
    )
    source_rollout_file = destination / archived_rollout
    if not source_rollout_file.is_file():
        raise BundleError("legacy bundle rollout is missing")

    thread_state = _legacy_json(destination / "metadata" / "thread_state.json")
    threads = (
        [item for item in thread_state.get("threads", []) if isinstance(item, dict)]
        if isinstance(thread_state, dict)
        else []
    )
    thread = next(
        (item for item in threads if str(item.get("id") or "") == session_id),
        threads[0] if threads else {},
    )
    thread = dict(thread)
    thread.setdefault("id", session_id)

    index_value = _legacy_json(destination / "metadata" / "session_index.json")
    if isinstance(index_value, list):
        index_entries = [item for item in index_value if isinstance(item, dict)]
        session_index = next(
            (item for item in index_entries if str(item.get("id") or "") == session_id),
            index_entries[0] if index_entries else {},
        )
    elif isinstance(index_value, dict):
        session_index = index_value
    else:
        session_index = {}
    session_index = dict(session_index)
    session_index.setdefault("id", session_id)
    if not session_index.get("thread_name") and legacy_manifest.get("thread_name"):
        session_index["thread_name"] = str(legacy_manifest["thread_name"])

    source_rollout = str(thread.get("rollout_path") or "")
    source_codex_home = _legacy_source_codex_home(archived_rollout, source_rollout)
    source_user_home = (
        str(Path(source_codex_home).parent)
        if source_codex_home and Path(source_codex_home).name == ".codex"
        else ""
    )
    source_workspace = str(thread.get("cwd") or "")

    codex_dir = destination / "codex"
    codex_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_rollout_file, codex_dir / "rollout.jsonl")
    _write_json(codex_dir / "thread.json", thread)
    _write_json(codex_dir / "goal.json", {})
    _write_json(codex_dir / "memories.json", [])
    _write_json(codex_dir / "session_index.json", session_index)

    copied_codex_files: list[dict[str, str]] = []
    attachments_value = legacy_manifest.get("attachments_root")
    if attachments_value:
        attachments_root = _safe_legacy_relative(
            attachments_value,
            field="attachments root",
        )
        attachments_source = destination / attachments_root
        if attachments_source.is_dir():
            for source in sorted(attachments_source.rglob("*")):
                if source.is_dir() and not source.is_symlink():
                    continue
                relative = source.relative_to(attachments_source)
                target = codex_dir / "files" / "attachments" / relative
                _copy_preserving_link(source, target)
                original = (
                    str(Path(source_codex_home) / "attachments" / relative)
                    if source_codex_home
                    else ""
                )
                copied_codex_files.append(
                    {
                        "source": original,
                        "archive_path": target.relative_to(destination).as_posix(),
                    }
                )

    workspace_dir = destination / "workspace"
    workspace_files: list[str] = []
    for value in legacy_manifest.get("workspace_files") or []:
        archived_file = _safe_legacy_relative(value, field="workspace file")
        source = destination / archived_file
        if not source.is_file() and not source.is_symlink():
            raise BundleError(f"legacy workspace file is missing: {archived_file}")
        relative_parts = archived_file.parts
        relative = (
            Path(*relative_parts[1:])
            if relative_parts and relative_parts[0] == "workspace_files"
            else Path(archived_file.name)
        )
        target = workspace_dir / "files" / relative
        _copy_preserving_link(source, target)
        workspace_files.append(relative.as_posix())

    workspace_metadata: dict[str, Any] = {
        "included": bool(workspace_files),
        "source_path": source_workspace,
        "files": workspace_files,
        "excluded_sensitive_files": [],
        "is_git": bool(thread.get("git_origin_url") or thread.get("git_sha")),
        "commit": thread.get("git_sha"),
        "branch": thread.get("git_branch"),
        "origin": thread.get("git_origin_url"),
    }
    _write_json(workspace_dir / "metadata.json", workspace_metadata)

    handoff_path = destination / "handoff_summary.md"
    handoff_summary = (
        handoff_path.read_text(encoding="utf-8").strip()
        if handoff_path.is_file()
        else ""
    )
    normalized: dict[str, Any] = {
        "schema_version": BUNDLE_SCHEMA_VERSION,
        "session_id": session_id,
        "created_at": legacy_manifest.get("created_at"),
        "source": {
            "codex_home": source_codex_home,
            "user_home": source_user_home,
            "rollout_path": source_rollout,
            "workspace": source_workspace,
            "cli_version": thread.get("cli_version"),
            "model_provider": thread.get("model_provider"),
            "history_mode": thread.get("history_mode"),
            "legacy_format_version": legacy_manifest.get("format_version"),
        },
        "codex_files": copied_codex_files,
        "workspace": workspace_metadata,
        "security": {
            "credentials_included": False,
            "history_is_unredacted": True,
            "legacy_bundle": True,
        },
        "handoff_summary": handoff_summary,
    }
    _write_json(destination / "manifest.json", normalized)
    normalized["inventory"] = _inventory(destination)
    _write_json(destination / "manifest.json", normalized)
    return normalized


def build_session_bundle(
    session_id: str,
    output_path: Path,
    *,
    codex_home: Path | None = None,
    workspace: Path | None = None,
    include_workspace: bool = True,
    include_git_bundle: bool = True,
    include_sensitive_workspace_files: bool = False,
    max_input_bytes: int = DEFAULT_MAX_ARCHIVE_INPUT_BYTES,
    max_single_file_bytes: int = DEFAULT_MAX_SINGLE_FILE_BYTES,
) -> BundleBuildResult:
    """Create a portable tar.gz containing thread history, memory, and workspace state."""

    codex_home = (codex_home or Path(os.environ.get("CODEX_HOME", "~/.codex"))).expanduser()
    codex_home = codex_home.resolve()
    rollout_path = _find_rollout(codex_home, session_id)
    thread = _sqlite_row(codex_home / "state_5.sqlite", "threads", "id", session_id)
    goal = _sqlite_row(codex_home / "goals_1.sqlite", "thread_goals", "thread_id", session_id)
    memories = _sqlite_rows(
        codex_home / "memories_1.sqlite",
        "stage1_outputs",
        "thread_id",
        session_id,
    )
    index_entry = _read_session_index(codex_home, session_id)
    if workspace is None:
        source_cwd = str((thread or {}).get("cwd") or "")
        workspace = Path(source_cwd) if source_cwd else Path.cwd()
    workspace = workspace.expanduser().resolve()

    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="codex-session-share-build-") as temporary:
        stage = Path(temporary)
        codex_dir = stage / "codex"
        workspace_dir = stage / "workspace"
        codex_dir.mkdir()
        portable_rollout = codex_dir / "rollout.jsonl"
        rollout_snapshot = copy_rollout_snapshot(rollout_path, portable_rollout)
        _write_json(codex_dir / "thread.json", thread or {})
        _write_json(codex_dir / "goal.json", goal or {})
        _write_json(codex_dir / "memories.json", memories)
        _write_json(codex_dir / "session_index.json", index_entry or {})

        copied_codex_files: list[dict[str, str]] = []
        referenced = _structured_local_files(portable_rollout, codex_home)
        referenced.update(
            path
            for path in (codex_home / "shell_snapshots").glob(f"{session_id}.*")
            if path.is_file()
        )
        for source in sorted(referenced):
            try:
                relative = source.relative_to(codex_home)
            except ValueError:
                continue
            destination = codex_dir / "files" / relative
            _copy_preserving_link(source, destination)
            copied_codex_files.append(
                {
                    "source": str(source),
                    "archive_path": destination.relative_to(stage).as_posix(),
                }
            )

        workspace_metadata: dict[str, Any] = {
            "included": include_workspace,
            "source_path": str(workspace),
            "files": [],
            "excluded_sensitive_files": [],
        }
        total_input_bytes = portable_rollout.stat().st_size
        if include_workspace:
            root, files, detected_metadata = _workspace_files(workspace)
            workspace_metadata.update(detected_metadata)
            workspace_metadata["source_path"] = str(root)
            for source in sorted(set(files)):
                try:
                    relative = source.relative_to(root)
                except ValueError:
                    continue
                if _is_sensitive(relative) and not include_sensitive_workspace_files:
                    workspace_metadata["excluded_sensitive_files"].append(relative.as_posix())
                    continue
                stat = source.lstat()
                file_size = stat.st_size if source.is_file() else 0
                if file_size > max_single_file_bytes:
                    raise BundleError(
                        f"workspace file {relative} exceeds the {max_single_file_bytes}-byte limit"
                    )
                total_input_bytes += file_size
                if total_input_bytes > max_input_bytes:
                    raise BundleError(
                        f"bundle inputs exceed the {max_input_bytes}-byte safety limit"
                    )
                destination = workspace_dir / "files" / relative
                _copy_preserving_link(source, destination)
                workspace_metadata["files"].append(relative.as_posix())

            if include_git_bundle and workspace_metadata.get("is_git"):
                bundle_path = workspace_dir / "repository.bundle"
                bundle_path.parent.mkdir(parents=True, exist_ok=True)
                bundle_refs = ["HEAD"]
                if workspace_metadata.get("branch"):
                    bundle_refs.append(str(workspace_metadata["branch"]))
                completed = subprocess.run(
                    [
                        "git",
                        "-C",
                        str(root),
                        "bundle",
                        "create",
                        str(bundle_path),
                        *bundle_refs,
                    ],
                    capture_output=True,
                    text=True,
                )
                if completed.returncode != 0:
                    bundle_path.unlink(missing_ok=True)
                    workspace_metadata["git_bundle_error"] = completed.stderr.strip()
                else:
                    total_input_bytes += bundle_path.stat().st_size
                    if total_input_bytes > max_input_bytes:
                        raise BundleError(
                            f"bundle inputs exceed the {max_input_bytes}-byte safety limit"
                        )
                    workspace_metadata["git_bundle"] = "workspace/repository.bundle"

        _write_json(workspace_dir / "metadata.json", workspace_metadata)
        handoff_summary = _build_handoff(session_id, thread, goal, portable_rollout)
        manifest: dict[str, Any] = {
            "schema_version": BUNDLE_SCHEMA_VERSION,
            "session_id": session_id,
            "created_at": datetime.now(UTC).isoformat(),
            "source": {
                "codex_home": str(codex_home),
                "user_home": str(Path.home().expanduser().resolve()),
                "rollout_path": str(rollout_path),
                "workspace": str(workspace),
                "cli_version": (thread or {}).get("cli_version"),
                "model_provider": (thread or {}).get("model_provider"),
                "history_mode": (thread or {}).get("history_mode"),
                "rollout_snapshot": {
                    "boundary": rollout_snapshot.boundary,
                    "source_size_bytes": rollout_snapshot.source_size_bytes,
                    "captured_size_bytes": rollout_snapshot.captured_size_bytes,
                    "omitted_trailing_bytes": rollout_snapshot.omitted_trailing_bytes,
                    "completed_turns": rollout_snapshot.completed_turns,
                },
            },
            "codex_files": copied_codex_files,
            "workspace": workspace_metadata,
            "security": {
                "credentials_included": False,
                "excluded_sources": [
                    "auth.json",
                    "config.toml",
                    "MCP OAuth credentials",
                    "global logs",
                    "live processes",
                ],
                "history_is_unredacted": True,
            },
            "handoff_summary": handoff_summary,
        }
        _write_json(stage / "manifest.json", manifest)
        manifest["inventory"] = _inventory(stage)
        _write_json(stage / "manifest.json", manifest)

        with tarfile.open(output_path, "w:gz", compresslevel=6) as archive:
            for child in sorted(stage.iterdir()):
                archive.add(child, arcname=child.name, recursive=True)

    archive_size = output_path.stat().st_size
    return BundleBuildResult(
        archive_path=output_path,
        archive_sha256=_sha256_file(output_path),
        archive_size_bytes=archive_size,
        manifest=manifest,
        handoff_summary=handoff_summary,
    )


def _validate_tar_member(member: tarfile.TarInfo) -> None:
    path = PurePosixPath(member.name)
    if path.is_absolute() or ".." in path.parts:
        raise BundleError(f"unsafe archive path: {member.name}")
    if member.isdev() or member.isfifo() or member.islnk():
        raise BundleError(f"unsupported archive entry type: {member.name}")
    if member.issym():
        target = PurePosixPath(member.linkname)
        if target.is_absolute():
            raise BundleError(f"unsafe absolute link target: {member.name}")
        combined = path.parent.joinpath(target)
        depth = 0
        for part in combined.parts:
            if part == "..":
                depth -= 1
            elif part not in {"", "."}:
                depth += 1
            if depth < 0:
                raise BundleError(f"link escapes archive root: {member.name}")


def extract_and_validate_bundle(archive_path: Path, destination: Path) -> dict[str, Any]:
    """Safely extract an archive and verify its recorded file inventory."""

    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            _validate_tar_member(member)
        for member in members:
            if member.issym():
                continue
            target = destination.joinpath(*PurePosixPath(member.name).parts)
            try:
                target.resolve(strict=False).relative_to(destination.resolve())
            except ValueError as exc:
                raise BundleError(f"archive entry escapes target: {member.name}") from exc
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(member.mode & 0o777)
                continue
            if not member.isfile():
                raise BundleError(f"unsupported archive entry type: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise BundleError(f"unable to read archive entry: {member.name}")
            with source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(member.mode & 0o777)
        for member in members:
            if not member.issym():
                continue
            target = destination.joinpath(*PurePosixPath(member.name).parts)
            if target.exists() or target.is_symlink():
                raise BundleError(f"archive symlink conflicts with another entry: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(member.linkname)
    manifest_path = destination / "manifest.json"
    if not manifest_path.is_file():
        raise BundleError("archive does not contain manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != BUNDLE_SCHEMA_VERSION:
        manifest = _normalize_legacy_bundle(destination, manifest)
    for item in manifest.get("inventory") or []:
        relative = PurePosixPath(str(item.get("path") or ""))
        if relative.name == "manifest.json":
            continue
        candidate = destination.joinpath(*relative.parts)
        if item.get("type") == "file":
            if not candidate.is_file():
                raise BundleError(f"bundle file is missing: {relative}")
            if candidate.stat().st_size != item.get("size"):
                raise BundleError(f"bundle file size mismatch: {relative}")
            if _sha256_file(candidate) != item.get("sha256"):
                raise BundleError(f"bundle file checksum mismatch: {relative}")
        elif item.get("type") == "symlink":
            if not candidate.is_symlink() or os.readlink(candidate) != item.get("target"):
                raise BundleError(f"bundle symlink mismatch: {relative}")
    return manifest


def iter_transcript_messages(rollout_path: Path) -> Iterable[tuple[str, str]]:
    """Public helper used by import/handoff workflows."""

    return iter(_extract_messages(rollout_path))
