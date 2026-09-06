from __future__ import annotations

import json
import sqlite3
import subprocess
import tarfile
from io import BytesIO
from pathlib import Path, PurePosixPath

import pytest

from codex_session_share.bundle import (
    BundleError,
    build_session_bundle,
    extract_and_validate_bundle,
)
from codex_session_share.codex_store import derive_local_session_id, restore_bundle


def _create_sqlite(path: Path, statements: list[str]) -> None:
    connection = sqlite3.connect(path)
    try:
        for statement in statements:
            connection.execute(statement)
        connection.commit()
    finally:
        connection.close()


def _make_codex_home(root: Path, session_id: str, workspace: Path) -> Path:
    codex_home = root / "codex-home"
    rollout = _rollout_path(codex_home, session_id)
    rollout.parent.mkdir(parents=True)
    records = [
        {
            "type": "session_meta",
            "timestamp": "2026-08-07T00:00:00Z",
            "payload": {
                "id": session_id,
                "timestamp": "2026-08-07T00:00:00Z",
                "cwd": str(workspace),
                "cli_version": "0.144.6",
                "model_provider": "openai",
            },
        },
        {
            "type": "event_msg",
            "timestamp": "2026-08-07T00:00:00Z",
            "payload": {"type": "task_started", "turn_id": "turn-1"},
        },
        {
            "type": "event_msg",
            "timestamp": "2026-08-07T00:00:01Z",
            "payload": {"type": "user_message", "message": "Continue the test session."},
        },
        {
            "type": "response_item",
            "timestamp": "2026-08-07T00:00:01Z",
            "payload": {
                "type": "function_call",
                "name": "synthetic_tool",
                "arguments": "{}",
                "call_id": "call-complete",
            },
        },
        {
            "type": "response_item",
            "timestamp": "2026-08-07T00:00:01Z",
            "payload": {
                "type": "function_call_output",
                "call_id": "call-complete",
                "output": "done",
            },
        },
        {
            "type": "event_msg",
            "timestamp": "2026-08-07T00:00:02Z",
            "payload": {"type": "agent_message", "message": "The test session is ready."},
        },
        {
            "type": "event_msg",
            "timestamp": "2026-08-07T00:00:03Z",
            "payload": {"type": "task_complete", "turn_id": "turn-1"},
        },
    ]
    _write_rollout_records(rollout, records)
    _create_sqlite(
        codex_home / "state_5.sqlite",
        [
            """
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                source TEXT NOT NULL,
                model_provider TEXT NOT NULL,
                cwd TEXT NOT NULL,
                title TEXT NOT NULL,
                sandbox_policy TEXT NOT NULL,
                approval_mode TEXT NOT NULL,
                tokens_used INTEGER NOT NULL,
                has_user_event INTEGER NOT NULL,
                archived INTEGER NOT NULL,
                archived_at INTEGER,
                cli_version TEXT NOT NULL,
                first_user_message TEXT NOT NULL,
                memory_mode TEXT NOT NULL,
                preview TEXT NOT NULL,
                recency_at INTEGER NOT NULL,
                recency_at_ms INTEGER NOT NULL,
                history_mode TEXT NOT NULL
            )
            """,
            f"""
            INSERT INTO threads VALUES (
                '{session_id}', '{rollout}', 1, 2, 'cli', 'openai', '{workspace}',
                'Synthetic session', '{{}}', 'never', 10, 1, 0, NULL, '0.144.6',
                'Continue the test session.', 'enabled', 'Synthetic', 2, 2000, 'legacy'
            )
            """,
        ],
    )
    _create_sqlite(
        codex_home / "goals_1.sqlite",
        [
            """
            CREATE TABLE thread_goals (
                thread_id TEXT PRIMARY KEY,
                goal_id TEXT NOT NULL,
                objective TEXT NOT NULL,
                status TEXT NOT NULL,
                token_budget INTEGER,
                tokens_used INTEGER NOT NULL,
                time_used_seconds INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            )
            """,
            f"""
            INSERT INTO thread_goals VALUES (
                '{session_id}', 'goal-1', 'Finish the synthetic test', 'active',
                NULL, 100, 10, 1, 2
            )
            """,
        ],
    )
    _create_sqlite(
        codex_home / "memories_1.sqlite",
        [
            """
            CREATE TABLE stage1_outputs (
                thread_id TEXT PRIMARY KEY,
                source_updated_at INTEGER NOT NULL,
                raw_memory TEXT NOT NULL,
                rollout_summary TEXT NOT NULL,
                rollout_slug TEXT,
                generated_at INTEGER NOT NULL,
                usage_count INTEGER,
                last_usage INTEGER,
                selected_for_phase2 INTEGER NOT NULL,
                selected_for_phase2_source_updated_at INTEGER
            )
            """,
            f"""
            INSERT INTO stage1_outputs VALUES (
                '{session_id}', 2, 'remember this', 'summary', 'synthetic',
                3, 1, 3, 0, NULL
            )
            """,
        ],
    )
    (codex_home / "session_index.jsonl").write_text(
        json.dumps({"id": session_id, "thread_name": "Synthetic session"}) + "\n",
        encoding="utf-8",
    )
    snapshot = codex_home / "shell_snapshots" / f"{session_id}.1.sh"
    snapshot.parent.mkdir()
    snapshot.write_text("export TEST=1\n", encoding="utf-8")
    return codex_home


def _rollout_path(codex_home: Path, session_id: str) -> Path:
    return (
        codex_home
        / "sessions"
        / "2026"
        / "08"
        / "07"
        / f"rollout-2026-08-07T00-00-00-{session_id}.jsonl"
    )


def _read_rollout_records(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _write_rollout_records(path: Path, records: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )


def _append_rollout_records(path: Path, records: list[dict]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record) + "\n")


def _make_legacy_archive(
    root: Path,
    archive: Path,
    *,
    session_id: str,
    source_user_home: Path,
    source_workspace: Path,
) -> None:
    stage = root / "legacy-stage"
    source_codex_home = source_user_home / ".codex"
    rollout_relative = (
        Path("codex_home")
        / "sessions"
        / "2026"
        / "07"
        / "31"
        / f"rollout-2026-07-31T00-00-00-{session_id}.jsonl"
    )
    rollout = stage / rollout_relative
    rollout.parent.mkdir(parents=True)
    _write_rollout_records(
        rollout,
        [
            {
                "type": "session_meta",
                "payload": {
                    "id": session_id,
                    "timestamp": "2026-07-31T00:00:00Z",
                    "cwd": str(source_workspace),
                },
            },
            {
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-legacy"},
            },
            {
                "type": "turn_context",
                "payload": {
                    "cwd": str(source_workspace),
                    "workspace_roots": [
                        str(source_workspace),
                        str(source_codex_home / "visualizations" / session_id),
                    ],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": json.dumps(
                        {
                            "cmd": f"cat {source_user_home}/.agents/skills/example/SKILL.md",
                            "workdir": str(source_workspace),
                        }
                    ),
                    "call_id": "call-legacy",
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-legacy",
                    "output": f"worktree {source_workspace}",
                },
            },
            {
                "type": "event_msg",
                "payload": {
                    "type": "patch_apply_end",
                    "changes": {
                        str(source_workspace / "README.md"): {"kind": "update"},
                        str(
                            source_user_home
                            / "g"
                            / "vienna-worktree"
                            / "src"
                            / "file.py"
                        ): {"kind": "add"},
                    },
                },
            },
            {
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": str(
                        source_codex_home
                        / "attachments"
                        / "legacy"
                        / "image.png"
                    ),
                },
            },
            {
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "message": "The legacy session is complete.",
                },
            },
            {
                "type": "event_msg",
                "payload": {"type": "task_complete", "turn_id": "turn-legacy"},
            },
        ],
    )

    attachment = stage / "codex_home" / "attachments" / "legacy" / "image.png"
    attachment.parent.mkdir(parents=True)
    attachment.write_bytes(b"legacy-image")
    workspace_file = stage / "workspace_files" / "check.sh"
    workspace_file.parent.mkdir()
    workspace_file.write_text("#!/bin/sh\necho portable\n", encoding="utf-8")
    metadata = stage / "metadata"
    metadata.mkdir()
    (metadata / "thread_state.json").write_text(
        json.dumps(
            {
                "threads": [
                    {
                        "id": session_id,
                        "rollout_path": str(
                            source_codex_home
                            / rollout_relative.relative_to("codex_home")
                        ),
                        "cwd": str(source_workspace),
                        "title": "Legacy session",
                        "model_provider": "copilot_api",
                        "history_mode": "legacy",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (metadata / "session_index.json").write_text(
        json.dumps([{"id": session_id, "thread_name": "Legacy session"}]),
        encoding="utf-8",
    )
    (stage / "handoff_summary.md").write_text(
        "Legacy handoff summary.\n",
        encoding="utf-8",
    )
    (stage / "manifest.json").write_text(
        json.dumps(
            {
                "format_version": 1,
                "bundle_type": "codex_session",
                "session_id": session_id,
                "thread_name": "Legacy session",
                "created_at": "2026-07-31T00:00:00Z",
                "rollout_path": rollout_relative.as_posix(),
                "attachments_root": "codex_home/attachments",
                "workspace_files": ["workspace_files/check.sh"],
                "metadata_files": [
                    "metadata/session_index.json",
                    "metadata/thread_state.json",
                ],
            }
        ),
        encoding="utf-8",
    )
    with tarfile.open(archive, "w:gz") as handle:
        for child in sorted(stage.iterdir()):
            handle.add(child, arcname=child.name)


def test_build_extract_and_restore_bundle(tmp_path: Path) -> None:
    session_id = "019f-test-session"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    subprocess.run(["git", "-C", str(workspace), "init", "-q"], check=True)
    subprocess.run(
        ["git", "-C", str(workspace), "config", "user.email", "test@example.com"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(workspace), "config", "user.name", "Test"],
        check=True,
    )
    (workspace / "tracked.txt").write_text("tracked\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(workspace), "add", "tracked.txt"], check=True)
    subprocess.run(["git", "-C", str(workspace), "commit", "-qm", "initial"], check=True)
    (workspace / "untracked.txt").write_text("untracked\n", encoding="utf-8")
    (workspace / ".env").write_text("SECRET=do-not-copy\n", encoding="utf-8")

    codex_home = _make_codex_home(tmp_path, session_id, workspace)
    archive = tmp_path / "session.tar.gz"
    built = build_session_bundle(
        session_id,
        archive,
        codex_home=codex_home,
        workspace=workspace,
    )
    assert built.archive_size_bytes > 0
    assert built.archive_sha256
    assert "Finish the synthetic test" in built.handoff_summary
    assert built.manifest["source"]["user_home"] == str(Path.home().resolve())

    extracted = tmp_path / "extracted"
    manifest = extract_and_validate_bundle(archive, extracted)
    assert manifest["session_id"] == session_id
    assert ".env" in manifest["workspace"]["excluded_sensitive_files"]

    target_home = tmp_path / "target-home"
    target_workspace = tmp_path / "target-workspace"
    local_session_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    restored = restore_bundle(
        extracted,
        manifest,
        target_codex_home=target_home,
        target_workspace=target_workspace,
        local_session_id=local_session_id,
        import_name="friendly-shared-session",
    )
    assert restored.session_id == local_session_id
    assert restored.source_session_id == session_id
    assert restored.rollout_path.is_file()
    assert local_session_id in restored.rollout_path.name
    assert session_id not in restored.rollout_path.name
    assert (target_workspace / "tracked.txt").read_text() == "tracked\n"
    assert (target_workspace / "untracked.txt").read_text() == "untracked\n"
    assert not (target_workspace / ".env").exists()
    assert restored.handoff_path.is_file()
    assert restored.handoff_path.parent.name == "friendly-shared-session"
    assert restored.transcript_path.is_file()
    rollout_text = restored.rollout_path.read_text(encoding="utf-8")
    rollout_records = _read_rollout_records(restored.rollout_path)
    session_meta = next(
        record for record in rollout_records if record["type"] == "session_meta"
    )
    assert session_meta["payload"]["cwd"] == str(target_workspace)
    assert local_session_id in rollout_text
    assert session_id not in rollout_text
    assert (
        target_home / "shell_snapshots" / f"{local_session_id}.1.sh"
    ).is_file()


def test_restore_legacy_bundle_rewrites_source_home_and_path_keys(
    tmp_path: Path,
) -> None:
    source_session_id = "019fb6be-5cf2-7bf2-8a7a-68ebaa55073b"
    local_session_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    source_user_home = PurePosixPath("/home/source-user")
    source_workspace = source_user_home / "g" / "vienna"
    archive = tmp_path / "legacy-session.tar.gz"
    _make_legacy_archive(
        tmp_path,
        archive,
        session_id=source_session_id,
        source_user_home=source_user_home,
        source_workspace=source_workspace,
    )

    extracted = tmp_path / "extracted"
    manifest = extract_and_validate_bundle(archive, extracted)
    assert manifest["source"]["legacy_format_version"] == 1
    assert manifest["source"]["user_home"] == str(source_user_home)
    assert manifest["source"]["workspace"] == str(source_workspace)
    manifest["source"].pop("user_home")

    target_user_home = tmp_path / "recipient"
    target_codex_home = target_user_home / ".codex"
    target_workspace = tmp_path / "restored-workspace"
    restored = restore_bundle(
        extracted,
        manifest,
        target_codex_home=target_codex_home,
        target_workspace=target_workspace,
        local_session_id=local_session_id,
    )

    assert (target_workspace / "check.sh").read_text(encoding="utf-8").endswith(
        "echo portable\n"
    )
    assert (
        target_codex_home / "attachments" / "legacy" / "image.png"
    ).read_bytes() == b"legacy-image"

    rollout_text = restored.rollout_path.read_text(encoding="utf-8")
    assert str(source_user_home) not in rollout_text
    assert source_session_id not in rollout_text
    records = _read_rollout_records(restored.rollout_path)
    session_meta = next(record for record in records if record["type"] == "session_meta")
    assert session_meta["payload"]["id"] == local_session_id
    assert session_meta["payload"]["cwd"] == str(target_workspace)

    function_call = next(
        record
        for record in records
        if (record.get("payload") or {}).get("type") == "function_call"
    )
    arguments = json.loads(function_call["payload"]["arguments"])
    assert arguments["workdir"] == str(target_workspace)
    assert arguments["cmd"] == (
        f"cat {target_user_home}/.agents/skills/example/SKILL.md"
    )

    patch_event = next(
        record
        for record in records
        if (record.get("payload") or {}).get("type") == "patch_apply_end"
    )
    assert set(patch_event["payload"]["changes"]) == {
        str(target_workspace / "README.md"),
        str(Path(f"{target_workspace}-worktree") / "src" / "file.py"),
    }


def test_build_bundle_stops_at_last_completed_turn(tmp_path: Path) -> None:
    session_id = "019fb689-c996-7c71-ac58-8253c100adb7"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    codex_home = _make_codex_home(tmp_path, session_id, workspace)
    source_rollout = _rollout_path(codex_home, session_id)
    _append_rollout_records(
        source_rollout,
        [
            {
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-upload"},
            },
            {
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "upload this session now",
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{}",
                    "call_id": "call-in-progress",
                },
            },
        ],
    )

    archive = tmp_path / "session.tar.gz"
    built = build_session_bundle(
        session_id,
        archive,
        codex_home=codex_home,
        workspace=workspace,
        include_workspace=False,
        include_git_bundle=False,
    )
    extracted = tmp_path / "extracted"
    manifest = extract_and_validate_bundle(archive, extracted)
    records = _read_rollout_records(extracted / "codex" / "rollout.jsonl")

    assert records[-1]["payload"]["type"] == "task_complete"
    assert all(
        (record.get("payload") or {}).get("call_id") != "call-in-progress"
        for record in records
    )
    assert "upload this session now" not in (extracted / "codex" / "rollout.jsonl").read_text(
        encoding="utf-8"
    )
    snapshot = manifest["source"]["rollout_snapshot"]
    assert snapshot["boundary"] == "last_completed_turn"
    assert snapshot["omitted_trailing_bytes"] > 0
    assert built.manifest["source"]["rollout_snapshot"] == snapshot


@pytest.mark.parametrize("preserve_session_id", [False, True])
def test_restore_clone_removes_nonportable_compaction_items(
    tmp_path: Path,
    preserve_session_id: bool,
) -> None:
    session_id = "019fb689-c996-7c71-ac58-8253c100adb7"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    codex_home = _make_codex_home(tmp_path, session_id, workspace)
    source_rollout = _rollout_path(codex_home, session_id)
    records = _read_rollout_records(source_rollout)
    records.insert(
        -1,
        {
            "type": "compacted",
            "payload": {
                "replacement_history": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "Portable summary"}],
                    },
                    {
                        "type": "compaction",
                        "id": "opaque-compaction-id",
                        "encrypted_content": "opaque-encrypted-content",
                    },
                ]
            },
        },
    )
    _write_rollout_records(source_rollout, records)

    archive = tmp_path / "session.tar.gz"
    build_session_bundle(
        session_id,
        archive,
        codex_home=codex_home,
        workspace=workspace,
        include_workspace=False,
        include_git_bundle=False,
    )
    extracted = tmp_path / "extracted"
    manifest = extract_and_validate_bundle(archive, extracted)
    restored = restore_bundle(
        extracted,
        manifest,
        target_codex_home=tmp_path / "target-home",
        target_workspace=tmp_path / "target-workspace",
        local_session_id=(
            session_id
            if preserve_session_id
            else "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        ),
    )
    restored_records = _read_rollout_records(restored.rollout_path)
    compacted = next(record for record in restored_records if record["type"] == "compacted")
    replacement_history = compacted["payload"]["replacement_history"]

    assert [item["type"] for item in replacement_history] == ["message"]
    assert replacement_history[0]["content"][0]["text"] == "Portable summary"
    assert "opaque-encrypted-content" not in restored.rollout_path.read_text(encoding="utf-8")


def test_restore_repairs_incomplete_active_turn_from_older_bundle(tmp_path: Path) -> None:
    session_id = "019fb689-c996-7c71-ac58-8253c100adb7"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    codex_home = _make_codex_home(tmp_path, session_id, workspace)
    archive = tmp_path / "session.tar.gz"
    build_session_bundle(
        session_id,
        archive,
        codex_home=codex_home,
        workspace=workspace,
        include_workspace=False,
        include_git_bundle=False,
    )
    extracted = tmp_path / "extracted"
    manifest = extract_and_validate_bundle(archive, extracted)
    archived_rollout = extracted / "codex" / "rollout.jsonl"
    _append_rollout_records(
        archived_rollout,
        [
            {
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-upload"},
            },
            {
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "upload this session now",
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{}",
                    "call_id": "call-missing-output",
                },
            },
        ],
    )

    restored = restore_bundle(
        extracted,
        manifest,
        target_codex_home=tmp_path / "target-home",
        target_workspace=tmp_path / "target-workspace",
        local_session_id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    )
    restored_records = _read_rollout_records(restored.rollout_path)

    assert restored_records[-1]["payload"]["type"] == "task_complete"
    assert all(
        (record.get("payload") or {}).get("call_id") != "call-missing-output"
        for record in restored_records
    )
    assert "upload this session now" not in restored.rollout_path.read_text(encoding="utf-8")


def test_clone_target_path_containing_source_id_is_not_rewritten_twice(
    tmp_path: Path,
) -> None:
    source_session_id = "019fb689-c996-7c71-ac58-8253c100adb7"
    local_session_id = "a2b2c16d-772a-56a6-9f76-5649bbc31a2d"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    codex_home = _make_codex_home(tmp_path, source_session_id, workspace)
    archive = tmp_path / "session.tar.gz"
    build_session_bundle(
        source_session_id,
        archive,
        codex_home=codex_home,
        workspace=workspace,
        include_workspace=False,
        include_git_bundle=False,
    )
    extracted = tmp_path / "extracted"
    manifest = extract_and_validate_bundle(archive, extracted)
    target_workspace = tmp_path / f"shared-session-{source_session_id}"
    restored = restore_bundle(
        extracted,
        manifest,
        target_codex_home=tmp_path / "target-home",
        target_workspace=target_workspace,
        local_session_id=local_session_id,
    )
    session_meta = next(
        record
        for record in _read_rollout_records(restored.rollout_path)
        if record["type"] == "session_meta"
    )

    assert session_meta["payload"]["id"] == local_session_id
    assert session_meta["payload"]["cwd"] == str(target_workspace)
    assert source_session_id in session_meta["payload"]["cwd"]
    assert local_session_id not in session_meta["payload"]["cwd"]


def test_machine_local_clone_id_is_stable_and_machine_specific(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_session_id = "019fb689-c996-7c71-ac58-8253c100adb7"
    codex_home = tmp_path / "codex-home"
    monkeypatch.setenv("CODEX_SESSION_SHARE_MACHINE_ID", "machine-x")
    first = derive_local_session_id(codex_home, source_session_id, "https://share.example/mcp")
    second = derive_local_session_id(codex_home, source_session_id, "https://share.example/mcp")
    assert first == second
    assert first != source_session_id

    monkeypatch.setenv("CODEX_SESSION_SHARE_MACHINE_ID", "machine-y")
    other_machine = derive_local_session_id(
        codex_home,
        source_session_id,
        "https://share.example/mcp",
    )
    assert other_machine != first


def test_rejects_path_traversal_archive(tmp_path: Path) -> None:
    archive = tmp_path / "unsafe.tar.gz"
    with tarfile.open(archive, "w:gz") as handle:
        info = tarfile.TarInfo("../escape.txt")
        content = b"escape"
        info.size = len(content)
        handle.addfile(info, BytesIO(content))
    with pytest.raises(BundleError, match="unsafe archive path"):
        extract_and_validate_bundle(archive, tmp_path / "destination")
