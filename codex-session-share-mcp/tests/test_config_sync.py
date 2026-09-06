from __future__ import annotations

import asyncio
import json
import tomllib
from pathlib import Path

import pytest

from codex_session_share.config_storage import (
    ConfigProfileNotFoundError,
    ConfigStore,
)
from codex_session_share.config_sync import (
    build_config_bundle,
    extract_config_bundle,
    restore_config_bundle,
)


def test_config_bundle_excludes_history_credentials_and_private_keys(
    tmp_path: Path,
) -> None:
    source_user = tmp_path / "source-user"
    source_codex = source_user / ".codex"
    source_codex.mkdir(parents=True)
    (source_codex / "config.toml").write_text(
        "\n".join(
            (
                "model = \"gpt-test\"",
                f"workspace = '{source_user / 'work'}'",
                "[mcp_servers.example]",
                'url = "https://example.invalid/mcp"',
                'http_headers = { Authorization = "Bearer do-not-copy" }',
                "[mcp_servers.example.env]",
                'SAFE_VALUE = "keep"',
                'API_TOKEN = "do-not-copy"',
                "",
            )
        ),
        encoding="utf-8",
    )
    (source_codex / "keybindings.json").write_text('{"save":"ctrl+s"}', encoding="utf-8")
    (source_codex / "auth.json").write_text('{"token":"secret"}', encoding="utf-8")
    (source_codex / "sessions").mkdir()
    (source_codex / "sessions" / "history.jsonl").write_text(
        "session history",
        encoding="utf-8",
    )
    automation = source_codex / "automations" / "daily" / "automation.toml"
    automation.parent.mkdir(parents=True)
    automation.write_text(
        'name = "Daily"\nstatus = "ACTIVE"\n',
        encoding="utf-8",
    )
    (source_codex / "skills" / ".system").mkdir(parents=True)
    (source_codex / "skills" / ".system" / "builtin.md").write_text(
        "builtin",
        encoding="utf-8",
    )
    custom_skill = source_codex / "skills" / "personal" / "SKILL.md"
    custom_skill.parent.mkdir(parents=True)
    custom_skill.write_text("personal", encoding="utf-8")
    (source_codex / "memories").mkdir()
    (source_codex / "memories" / "history.md").write_text(
        "not included by default",
        encoding="utf-8",
    )
    global_state = {
        "local-projects": {
            "project-1": {
                "id": "project-1",
                "rootPaths": [str(source_user / "work")],
            }
        },
        "codex-managed-remote-connections": [
            {
                "hostId": "remote-ssh-discovered:test",
                "alias": "test",
                "hostname": "host.example",
                "identity": str(source_user / ".ssh" / "id_private"),
            }
        ],
        "thread-project-assignments": {"thread-secret": {"projectId": "project-1"}},
        "electron-persisted-atom-state": {
            "editorDiffViewMode": "split",
            "prompt-history": ["do not copy"],
            "thread-browser-tabs-v1:thread-secret": [{"url": "https://example.com"}],
        },
        "accessToken": "do-not-copy",
    }
    (source_codex / ".codex-global-state.json").write_text(
        json.dumps(global_state),
        encoding="utf-8",
    )
    ssh = source_user / ".ssh"
    ssh.mkdir()
    (ssh / "config").write_text(
        f"Host test\n  HostName host.example\n  IdentityFile {ssh / 'id_private'}\n",
        encoding="utf-8",
    )
    (ssh / "id_private").write_text("PRIVATE", encoding="utf-8")
    (ssh / "id_private.pub").write_text("PUBLIC", encoding="utf-8")

    archive = tmp_path / "settings.tar.gz"
    built = build_config_bundle(
        "default",
        archive,
        codex_home=source_codex,
        user_home=source_user,
    )
    extracted = tmp_path / "extracted"
    manifest = extract_config_bundle(archive, extracted)
    archived_targets = {
        f"{item['target_root']}:{item['target_path']}"
        for item in manifest["files"]
    }

    assert manifest["security"]["credentials_included"] is False
    assert manifest["security"]["session_history_included"] is False
    assert manifest["security"]["ssh_private_keys_included"] is False
    assert "codex:auth.json" not in archived_targets
    assert not any("sessions/" in value for value in archived_targets)
    assert "ssh:id_private" not in archived_targets
    assert "ssh:id_private.pub" in archived_targets
    assert not any("memories/" in value for value in archived_targets)
    assert not any("skills/.system/" in value for value in archived_targets)
    assert "codex:skills/personal/SKILL.md" in archived_targets
    assert set(manifest["security"]["redactions"]) == {
        "config.toml:mcp_servers.example.http_headers",
        "config.toml:mcp_servers.example.env.API_TOKEN",
    }

    sanitized_config = (extracted / "payload" / "codex" / "config.toml").read_text(
        encoding="utf-8"
    )
    assert "do-not-copy" not in sanitized_config
    assert "SAFE_VALUE" in sanitized_config
    sanitized_state = json.loads(
        (extracted / "payload" / "app-state.json").read_text(encoding="utf-8")
    )
    assert "thread-project-assignments" not in sanitized_state
    assert "accessToken" not in sanitized_state
    assert "prompt-history" not in sanitized_state["electron-persisted-atom-state"]

    target_user = tmp_path / "target-user"
    target_codex = target_user / ".codex"
    target_codex.mkdir(parents=True)
    (target_codex / "config.toml").write_text('model = "old"\n', encoding="utf-8")
    (target_codex / ".codex-global-state.json").write_text(
        json.dumps(
            {
                "thread-project-assignments": {
                    "local-thread": {"projectId": "local-project"}
                },
                "electron-persisted-atom-state": {
                    "prompt-history": ["keep local history"]
                },
            }
        ),
        encoding="utf-8",
    )
    restored = restore_config_bundle(
        extracted,
        manifest,
        target_codex_home=target_codex,
        target_user_home=target_user,
        target_platform="windows",
        apply_app_state=True,
    )

    assert restored.backup_path is not None
    assert (restored.backup_path / "codex" / "config.toml").is_file()
    restored_automation = tomllib.loads(
        (target_codex / "automations" / "daily" / "automation.toml").read_text(
            encoding="utf-8"
        )
    )
    assert restored_automation["status"] == "PAUSED"
    restored_config = (target_codex / "config.toml").read_text(encoding="utf-8")
    assert str(target_user) in restored_config
    restored_state = json.loads(
        (target_codex / ".codex-global-state.json").read_text(encoding="utf-8")
    )
    assert "local-thread" in restored_state["thread-project-assignments"]
    assert restored_state["codex-managed-remote-connections"][0]["alias"] == "test"
    assert "keep local history" in (
        restored_state["electron-persisted-atom-state"]["prompt-history"]
    )
    assert restored.applied_app_state is True


@pytest.mark.parametrize("key", ["API_TOKEN", "api-token", "apiToken", "GITHUB_API_TOKEN"])
def test_config_bundle_redacts_api_tokens_without_dropping_token_limits(
    tmp_path: Path,
    key: str,
) -> None:
    source_user = tmp_path / "source-user"
    source_codex = source_user / ".codex"
    source_codex.mkdir(parents=True)
    (source_codex / "config.toml").write_text(
        'model_context_window = 872000\n'
        'model_max_output_tokens = 32000\n'
        '[mcp_servers.example.env]\n'
        f'{key} = "do-not-copy"\n'
        'SAFE_VALUE = "keep"\n',
        encoding="utf-8",
    )
    (source_codex / ".codex-global-state.json").write_text(
        json.dumps(
            {
                "codex-managed-remote-connections": [
                    {"alias": "test", key: "do-not-copy"}
                ]
            }
        ),
        encoding="utf-8",
    )

    archive = tmp_path / "settings.tar.gz"
    build_config_bundle(
        "default",
        archive,
        codex_home=source_codex,
        user_home=source_user,
    )
    extracted = tmp_path / "extracted"
    manifest = extract_config_bundle(archive, extracted)

    config = (extracted / "payload" / "codex" / "config.toml").read_text(
        encoding="utf-8"
    )
    state = json.loads(
        (extracted / "payload" / "app-state.json").read_text(encoding="utf-8")
    )
    assert "do-not-copy" not in config
    assert "model_context_window = 872000" in config
    assert "model_max_output_tokens = 32000" in config
    assert 'SAFE_VALUE = "keep"' in config
    assert state["codex-managed-remote-connections"] == [{"alias": "test"}]
    assert set(manifest["security"]["redactions"]) == {
        f"config.toml:mcp_servers.example.env.{key}",
        f"app-state:codex-managed-remote-connections[0].{key}",
    }


def test_config_store_is_private_per_principal(tmp_path: Path) -> None:
    store = ConfigStore(tmp_path)
    temporary = store.new_temp_path()
    temporary.write_bytes(b"private config archive")
    reservation = asyncio.run(
        store.reserve_upload(
            principal="tenant:alice",
            uploader_email="alice@example.com",
            profile="default",
            archive_sha256="a" * 64,
            archive_size_bytes=temporary.stat().st_size,
            manifest={"bundle_type": "codex_config", "profile": "default"},
            ttl_seconds=300,
            lease_id="lease-1",
        )
    )
    claimed = asyncio.run(store.claim_upload(reservation.pending_id))
    metadata = asyncio.run(store.commit_upload(claimed, temporary))
    asyncio.run(store.release_claim(claimed, retryable=False))

    assert metadata["profile"] == "default"
    assert asyncio.run(store.read_profile("tenant:alice", "default"))["version_id"] == (
        metadata["version_id"]
    )
    with pytest.raises(ConfigProfileNotFoundError):
        asyncio.run(store.read_profile("tenant:bob", "default"))
