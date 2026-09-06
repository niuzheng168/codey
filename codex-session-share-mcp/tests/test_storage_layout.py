from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

import pytest

from codex_session_share.names import validate_session_name, validate_shared_name
from codex_session_share.storage import SessionNotFoundError, SessionStore


def test_migrates_legacy_hash_directory_to_readable_name(tmp_path: Path) -> None:
    session_id = "019fb689-c996-7c71-ac58-8253c100adb7"
    legacy_name = hashlib.sha256(session_id.encode()).hexdigest()
    legacy = tmp_path / "sessions" / legacy_name
    versions = legacy / "versions"
    versions.mkdir(parents=True)
    (versions / "version.tar.gz").write_bytes(b"archive")
    (legacy / "current.json").write_text(
        json.dumps(
            {
                "session_id": session_id,
                "storage_key": legacy_name,
                "version_id": "version",
            }
        ),
        encoding="utf-8",
    )

    store = SessionStore(tmp_path)
    migrated = asyncio.run(store.migrate_legacy_layout())

    assert migrated == [{"from": legacy_name, "to": session_id}]
    assert not legacy.exists()
    current = tmp_path / "sessions" / session_id / "current.json"
    metadata = json.loads(current.read_text(encoding="utf-8"))
    assert metadata["session_name"] == session_id
    assert metadata["storage_path"] == f"sessions/{session_id}"
    assert (
        metadata["archive_path"]
        == f"sessions/{session_id}/versions/version.tar.gz"
    )


def test_session_names_are_safe_readable_path_components() -> None:
    assert validate_session_name("019fb689-c996-7c71-ac58-8253c100adb7")
    assert validate_session_name("dashboard-demo.v2")
    for value in ("../escape", "contains space", "/absolute", "bad:name", ""):
        try:
            validate_session_name(value)
        except ValueError:
            continue
        raise AssertionError(f"unsafe session name was accepted: {value!r}")


def test_user_selected_shared_names_use_restricted_alphabet() -> None:
    assert validate_shared_name("shared_session_123") == "shared_session_123"
    assert validate_shared_name("ABC_123") == "ABC_123"
    for value in (
        "contains-hyphen",
        "contains.dot",
        "contains space",
        "",
        "a" * 129,
    ):
        with pytest.raises(ValueError):
            validate_shared_name(value)


def test_trash_restore_and_purge_session_directory(tmp_path: Path) -> None:
    session_name = "session-history"
    active = tmp_path / "sessions" / session_name
    versions = active / "versions"
    versions.mkdir(parents=True)
    (versions / "version-1.tar.gz").write_bytes(b"archive")
    (active / "current.json").write_text(
        json.dumps(
            {
                "session_id": session_name,
                "session_name": session_name,
                "source_session_id": "source-session",
                "version_id": "version-1",
                "storage_path": f"sessions/{session_name}",
                "archive_path": (
                    f"sessions/{session_name}/versions/version-1.tar.gz"
                ),
            }
        ),
        encoding="utf-8",
    )
    store = SessionStore(tmp_path)

    trashed = asyncio.run(store.trash_session(session_name, principal="tenant:admin"))
    assert trashed["state"] == "trash"
    assert trashed["deleted_by"] == "tenant:admin"
    assert not active.exists()
    assert (tmp_path / "trash" / session_name / "current.json").is_file()
    assert [item["session_name"] for item in asyncio.run(
        store.list_sessions(state="trash")
    )] == [session_name]

    restored = asyncio.run(
        store.restore_session(session_name, principal="tenant:admin")
    )
    assert restored["state"] == "active"
    assert restored["restored_by"] == "tenant:admin"
    assert active.is_dir()

    asyncio.run(store.trash_session(session_name, principal="tenant:admin"))
    purged = asyncio.run(store.purge_session(session_name, state="trash"))
    assert purged["session_name"] == session_name
    with pytest.raises(SessionNotFoundError):
        asyncio.run(store.read_session_state(session_name, state="trash"))
