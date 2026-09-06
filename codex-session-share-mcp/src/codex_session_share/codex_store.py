"""Restore a portable bundle into a local Codex installation."""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from .bundle import BundleError, iter_transcript_messages, select_rollout_snapshot


@dataclass(frozen=True)
class RestoreResult:
    session_id: str
    source_session_id: str
    rollout_path: Path
    workspace_path: Path
    handoff_path: Path
    transcript_path: Path
    resume_command: str
    backup_path: Path | None


_CLONE_NAMESPACE = uuid.UUID("ac84921d-7a3e-5cca-95f8-d2a6b3f7af39")


def _machine_identity(codex_home: Path) -> str:
    override = os.environ.get("CODEX_SESSION_SHARE_MACHINE_ID", "").strip()
    if override:
        return override
    machine_id = Path("/etc/machine-id")
    if machine_id.is_file():
        value = machine_id.read_text(encoding="utf-8").strip()
        if value:
            return value
    installation_id = codex_home / "installation_id"
    if installation_id.is_file():
        value = installation_id.read_text(encoding="utf-8").strip()
        if value:
            return value
    fallback = codex_home / "session-share-machine-id"
    if fallback.is_file():
        value = fallback.read_text(encoding="utf-8").strip()
        if value:
            return value
    value = str(uuid.uuid4())
    fallback.parent.mkdir(parents=True, exist_ok=True)
    fallback.write_text(value + "\n", encoding="utf-8")
    fallback.chmod(0o600)
    return value


def derive_local_session_id(
    codex_home: Path,
    source_session_id: str,
    share_origin: str,
) -> str:
    """Return a stable clone ID unique to this machine and share service."""

    identity = _machine_identity(codex_home.expanduser().resolve())
    return str(
        uuid.uuid5(
            _CLONE_NAMESPACE,
            f"{identity}\0{share_origin}\0{source_session_id}",
        )
    )


def local_session_exists(codex_home: Path, session_id: str) -> bool:
    """Return whether a persisted local Codex thread uses this ID."""

    codex_home = codex_home.expanduser().resolve()
    state_db = codex_home / "state_5.sqlite"
    if state_db.is_file():
        connection = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True, timeout=10)
        try:
            if connection.execute(
                "SELECT 1 FROM threads WHERE id = ? LIMIT 1",
                (session_id,),
            ).fetchone():
                return True
        except sqlite3.DatabaseError:
            pass
        finally:
            connection.close()
    return any(
        path.is_file()
        for path in (
            *codex_home.glob(f"sessions/*/*/*/*{session_id}.jsonl"),
            *codex_home.glob(f"archived_sessions/*{session_id}.jsonl"),
        )
    )


def _safe_archive_relative(value: str) -> Path:
    pure = PurePosixPath(value)
    if pure.is_absolute() or ".." in pure.parts:
        raise BundleError(f"unsafe manifest archive path: {value}")
    return Path(*pure.parts)


def _copy_path(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        if destination.is_dir() and not destination.is_symlink():
            shutil.rmtree(destination)
        else:
            destination.unlink()
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
    else:
        shutil.copy2(source, destination)


def _clear_workspace_except_git(workspace: Path) -> None:
    for child in workspace.iterdir():
        if child.name == ".git":
            continue
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()


def restore_workspace(
    extracted_root: Path,
    target_workspace: Path,
    *,
    replace_workspace: bool = False,
    apply_deletions: bool = True,
) -> Path:
    """Restore the captured working tree, preserving an existing .git directory."""

    metadata_path = extracted_root / "workspace" / "metadata.json"
    if not metadata_path.is_file():
        target_workspace.mkdir(parents=True, exist_ok=True)
        return target_workspace
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    files_root = extracted_root / "workspace" / "files"
    git_bundle = extracted_root / "workspace" / "repository.bundle"
    target_workspace = target_workspace.expanduser().resolve()

    if git_bundle.is_file() and (
        not target_workspace.exists()
        or (target_workspace.is_dir() and not any(target_workspace.iterdir()))
    ):
        target_workspace.parent.mkdir(parents=True, exist_ok=True)
        if target_workspace.exists():
            target_workspace.rmdir()
        completed = subprocess.run(
            ["git", "clone", str(git_bundle), str(target_workspace)],
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            target_workspace.mkdir(parents=True, exist_ok=True)

    target_workspace.mkdir(parents=True, exist_ok=True)
    if replace_workspace:
        _clear_workspace_except_git(target_workspace)

    if files_root.is_dir():
        for source in sorted(files_root.rglob("*")):
            if source.is_dir() and not source.is_symlink():
                continue
            relative = source.relative_to(files_root)
            destination = target_workspace / relative
            try:
                destination.resolve(strict=False).relative_to(target_workspace)
            except ValueError as exc:
                raise BundleError(f"workspace path escapes target: {relative}") from exc
            _copy_path(source, destination)

    if apply_deletions:
        for value in metadata.get("deleted_tracked_files") or []:
            relative = _safe_archive_relative(str(value))
            destination = target_workspace / relative
            try:
                destination.resolve(strict=False).relative_to(target_workspace)
            except ValueError:
                continue
            if destination.is_dir() and not destination.is_symlink():
                shutil.rmtree(destination)
            else:
                destination.unlink(missing_ok=True)
    return target_workspace


def _prepared_replacements(
    replacements: list[tuple[str, str]],
) -> tuple[re.Pattern[str] | None, dict[str, str]]:
    mapping: dict[str, str] = {}
    for source, destination in replacements:
        if source and source != destination and source not in mapping:
            mapping[source] = destination
    if not mapping:
        return None, mapping
    ordered_sources = sorted(mapping, key=lambda source: (-len(source), source))
    return re.compile("|".join(re.escape(source) for source in ordered_sources)), mapping


def _replace_strings_prepared(
    value: Any,
    pattern: re.Pattern[str] | None,
    mapping: dict[str, str],
) -> Any:
    if isinstance(value, dict):
        return {
            (
                pattern.sub(lambda match: mapping[match.group(0)], key)
                if isinstance(key, str) and pattern is not None
                else key
            ): _replace_strings_prepared(child, pattern, mapping)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [_replace_strings_prepared(child, pattern, mapping) for child in value]
    if isinstance(value, str) and pattern is not None:
        return pattern.sub(lambda match: mapping[match.group(0)], value)
    return value


def _replace_strings(value: Any, replacements: list[tuple[str, str]]) -> Any:
    pattern, mapping = _prepared_replacements(replacements)
    return _replace_strings_prepared(value, pattern, mapping)


def _sanitize_rollout_record(value: dict[str, Any]) -> dict[str, Any] | None:
    record_type = value.get("type")
    payload = value.get("payload")
    if record_type == "compaction":
        return None
    if (
        record_type == "response_item"
        and isinstance(payload, dict)
        and payload.get("type") == "compaction"
    ):
        return None
    if isinstance(payload, dict):
        replacement_history = payload.get("replacement_history")
        if isinstance(replacement_history, list):
            payload["replacement_history"] = [
                item
                for item in replacement_history
                if not (isinstance(item, dict) and item.get("type") == "compaction")
            ]
    return value


def _rewrite_rollout(
    source_rollout: Path,
    destination_rollout: Path,
    replacements: list[tuple[str, str]],
) -> None:
    snapshot = select_rollout_snapshot(source_rollout)
    pattern, mapping = _prepared_replacements(replacements)
    destination_rollout.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=destination_rollout.parent,
        prefix=f".{destination_rollout.name}.",
        suffix=".tmp",
        delete=False,
    ) as output:
        temporary = Path(output.name)
        remaining = snapshot.captured_size_bytes
        with source_rollout.open("rb") as input_handle:
            while remaining:
                encoded_line = input_handle.readline(remaining)
                if not encoded_line:
                    raise BundleError(
                        "rollout changed while its portable snapshot was restored"
                    )
                remaining -= len(encoded_line)
                line = encoded_line.decode("utf-8", errors="replace")
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    output.write(line)
                    continue
                if not isinstance(value, dict):
                    output.write(line)
                    continue
                value = _sanitize_rollout_record(value)
                if value is None:
                    continue
                output.write(
                    json.dumps(
                        _replace_strings_prepared(value, pattern, mapping),
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, destination_rollout)


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}


def _read_json_list(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    value = json.loads(path.read_text(encoding="utf-8"))
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _upsert_dynamic(
    db_path: Path,
    table: str,
    key_columns: tuple[str, ...],
    row: dict[str, Any],
) -> bool:
    if not db_path.is_file() or not row:
        return False
    connection = sqlite3.connect(db_path, timeout=30)
    try:
        available = {
            str(column[1])
            for column in connection.execute(f'PRAGMA table_info("{table}")').fetchall()
        }
        if not available or not set(key_columns).issubset(available):
            return False
        values = {key: value for key, value in row.items() if key in available}
        if not set(key_columns).issubset(values):
            return False
        columns = list(values)
        placeholders = ", ".join("?" for _ in columns)
        quoted_columns = ", ".join(f'"{column}"' for column in columns)
        updates = ", ".join(
            f'"{column}" = excluded."{column}"'
            for column in columns
            if column not in key_columns
        )
        conflict = ", ".join(f'"{column}"' for column in key_columns)
        sql = (
            f'INSERT INTO "{table}" ({quoted_columns}) VALUES ({placeholders}) '
            f"ON CONFLICT ({conflict}) DO UPDATE SET {updates}"
        )
        connection.execute(sql, tuple(values[column] for column in columns))
        connection.commit()
        return True
    except sqlite3.DatabaseError:
        connection.rollback()
        return False
    finally:
        connection.close()


def _update_session_index(codex_home: Path, entry: dict[str, Any]) -> None:
    if not entry:
        return
    path = codex_home / "session_index.jsonl"
    existing: list[dict[str, Any]] = []
    if path.is_file():
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if value.get("id") != entry.get("id"):
                    existing.append(value)
    existing.append(entry)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.session-share.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for value in existing:
            handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(temporary, path)


def _backup_existing(
    codex_home: Path,
    session_id: str,
    destination_rollout: Path,
) -> Path | None:
    existing = []
    if destination_rollout.is_file():
        existing.append(destination_rollout)
    existing.extend(
        path
        for path in codex_home.glob(f"sessions/*/*/*/*{session_id}.jsonl")
        if path.is_file() and path not in existing
    )
    if not existing:
        return None
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    backup = codex_home / "recovery-backups" / "session-share" / session_id / timestamp
    backup.mkdir(parents=True, exist_ok=True)
    for path in existing:
        shutil.copy2(path, backup / path.name)
    return backup


def _rollout_date(source_rollout: Path) -> tuple[str, str, str]:
    with source_rollout.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if value.get("type") != "session_meta":
                continue
            timestamp = (value.get("payload") or {}).get("timestamp")
            if isinstance(timestamp, str):
                try:
                    parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                    return parsed.strftime("%Y"), parsed.strftime("%m"), parsed.strftime("%d")
                except ValueError:
                    pass
    now = datetime.now(UTC)
    return now.strftime("%Y"), now.strftime("%m"), now.strftime("%d")


def _write_handoff_files(
    extracted_root: Path,
    codex_home: Path,
    local_session_id: str,
    source_session_id: str,
    import_name: str,
    workspace: Path,
) -> tuple[Path, Path]:
    import_root = codex_home / "imports" / import_name
    import_root.mkdir(parents=True, exist_ok=True)
    source_rollout = extracted_root / "codex" / "rollout.jsonl"
    transcript = import_root / "transcript.md"
    with transcript.open("w", encoding="utf-8") as handle:
        handle.write(
            f"# Shared Codex session {import_name}\n\n"
            f"- Local clone ID: `{local_session_id}`\n"
            f"- Source session ID: `{source_session_id}`\n\n"
        )
        for role, message in iter_transcript_messages(source_rollout):
            handle.write(f"## {role.title()}\n\n{message}\n\n")
    manifest = _read_json(extracted_root / "manifest.json")
    handoff = import_root / "handoff.md"
    handoff.write_text(
        "\n".join(
            [
                f"# Imported Codex session {import_name}",
                "",
                f"Local clone ID: `{local_session_id}`",
                f"Source session ID: `{source_session_id}`",
                "",
                str(manifest.get("handoff_summary") or "No handoff summary was captured."),
                "",
                f"Restored workspace: `{workspace}`",
                f"Full reconstructed transcript: `{transcript}`",
                f"Raw rollout source: `{source_rollout}`",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    shutil.copy2(extracted_root / "manifest.json", import_root / "manifest.json")
    shutil.copy2(source_rollout, import_root / "rollout.jsonl")
    return handoff, transcript


def restore_bundle(
    extracted_root: Path,
    manifest: dict[str, Any],
    *,
    target_codex_home: Path,
    target_workspace: Path,
    replace_workspace: bool = False,
    install_native_session: bool = True,
    local_session_id: str | None = None,
    import_name: str | None = None,
) -> RestoreResult:
    """Restore workspace files and register the archived thread locally."""

    source_session_id = str(manifest["session_id"])
    session_id = local_session_id or source_session_id
    import_name = import_name or source_session_id
    target_codex_home = target_codex_home.expanduser().resolve()
    target_codex_home.mkdir(parents=True, exist_ok=True)
    target_workspace = restore_workspace(
        extracted_root,
        target_workspace,
        replace_workspace=replace_workspace,
    )
    source_rollout = extracted_root / "codex" / "rollout.jsonl"
    if not source_rollout.is_file():
        raise BundleError("bundle does not contain codex/rollout.jsonl")

    source_codex_home = str((manifest.get("source") or {}).get("codex_home") or "")
    source_user_home = str((manifest.get("source") or {}).get("user_home") or "")
    source_workspace = str(
        (manifest.get("workspace") or {}).get("source_path")
        or (manifest.get("source") or {}).get("workspace")
        or ""
    )
    if not source_user_home and source_codex_home:
        source_codex_home_path = Path(source_codex_home)
        if source_codex_home_path.name == ".codex":
            source_user_home = str(source_codex_home_path.parent)
    target_user_home = (
        str(target_codex_home.parent)
        if target_codex_home.name == ".codex"
        else str(Path.home().expanduser().resolve())
    )
    replacements = [
        (source_codex_home, str(target_codex_home)),
        (source_workspace, str(target_workspace)),
        (source_user_home, target_user_home),
        (source_session_id, session_id),
    ]

    for item in manifest.get("codex_files") or []:
        archive_relative = _safe_archive_relative(str(item["archive_path"]))
        source = extracted_root / archive_relative
        original = str(item.get("source") or "")
        try:
            relative = Path(original).relative_to(source_codex_home)
        except (TypeError, ValueError):
            relative = archive_relative.relative_to(Path("codex") / "files")
        if source_session_id != session_id:
            relative = Path(relative.as_posix().replace(source_session_id, session_id))
        destination = target_codex_home / relative
        _copy_path(source, destination)

    year, month, day = _rollout_date(source_rollout)
    original_rollout_name = Path(
        str((manifest.get("source") or {}).get("rollout_path") or source_rollout.name)
    ).name
    original_rollout_name = original_rollout_name.replace(source_session_id, session_id)
    if session_id not in original_rollout_name:
        original_rollout_name = f"rollout-{year}-{month}-{day}T00-00-00-{session_id}.jsonl"
    destination_rollout = (
        target_codex_home / "sessions" / year / month / day / original_rollout_name
    )
    backup = _backup_existing(target_codex_home, session_id, destination_rollout)
    if install_native_session:
        _rewrite_rollout(source_rollout, destination_rollout, replacements)

        thread = _read_json(extracted_root / "codex" / "thread.json")
        source_title = str(thread.get("title") or "").strip()
        thread.update(
            {
                "id": session_id,
                "rollout_path": str(destination_rollout),
                "cwd": str(target_workspace),
                "archived": 0,
                "archived_at": None,
                "updated_at": int(datetime.now(UTC).timestamp()),
                "updated_at_ms": int(datetime.now(UTC).timestamp() * 1000),
                "recency_at": int(datetime.now(UTC).timestamp()),
                "recency_at_ms": int(datetime.now(UTC).timestamp() * 1000),
            }
        )
        if session_id != source_session_id and source_title:
            thread["title"] = f"{source_title} (shared copy)"
        _upsert_dynamic(target_codex_home / "state_5.sqlite", "threads", ("id",), thread)

        goal = _read_json(extracted_root / "codex" / "goal.json")
        if goal:
            goal["thread_id"] = session_id
            _upsert_dynamic(
                target_codex_home / "goals_1.sqlite",
                "thread_goals",
                ("thread_id",),
                goal,
            )
        for memory in _read_json_list(extracted_root / "codex" / "memories.json"):
            memory["thread_id"] = session_id
            _upsert_dynamic(
                target_codex_home / "memories_1.sqlite",
                "stage1_outputs",
                ("thread_id",),
                memory,
            )
        index_entry = _read_json(extracted_root / "codex" / "session_index.json")
        index_entry.update(
            {
                "id": session_id,
                "updated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            }
        )
        if not index_entry.get("thread_name"):
            index_entry["thread_name"] = thread.get("title") or f"Shared session {session_id}"
        elif session_id != source_session_id:
            index_entry["thread_name"] = f"{index_entry['thread_name']} (shared copy)"
        _update_session_index(target_codex_home, index_entry)

    handoff, transcript = _write_handoff_files(
        extracted_root,
        target_codex_home,
        session_id,
        source_session_id,
        import_name,
        target_workspace,
    )
    resume_command = f"codex resume {session_id} -C {target_workspace}"
    return RestoreResult(
        session_id=session_id,
        source_session_id=source_session_id,
        rollout_path=destination_rollout,
        workspace_path=target_workspace,
        handoff_path=handoff,
        transcript_path=transcript,
        resume_command=resume_command,
        backup_path=backup,
    )
