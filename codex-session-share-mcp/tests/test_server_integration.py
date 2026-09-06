from __future__ import annotations

import asyncio
import hashlib
import json
import os
import socket
import sqlite3
import subprocess
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
import pytest
import pytest_asyncio
import uvicorn
from fastmcp import Client
from fastmcp.exceptions import ToolError
from fastmcp.server.auth.providers.jwt import StaticTokenVerifier
from key_value.aio.stores.memory import MemoryStore

from codex_session_share.auth import create_entra_oauth_provider
from codex_session_share.bundle import build_session_bundle
from codex_session_share.server import ServerSettings, create_app

_TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47"
_REQUIRED_ROLE = "SessionShare.Contributor"
_ADMIN_ROLE = "SessionShare.Admin"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest_asyncio.fixture
async def running_server(tmp_path: Path) -> AsyncIterator[dict[str, Any]]:
    static_verifier = StaticTokenVerifier(
        {
            "alice-token": {
                "client_id": "azure-cli",
                "scopes": ["access_as_user"],
                "tid": _TENANT_ID,
                "oid": "alice-object-id",
                "roles": [_REQUIRED_ROLE, _ADMIN_ROLE],
                "preferred_username": "alice@microsoft.com",
            },
            "bob-token": {
                "client_id": "azure-cli",
                "scopes": ["access_as_user"],
                "tid": _TENANT_ID,
                "oid": "bob-object-id",
                "roles": [_REQUIRED_ROLE],
                "preferred_username": "bob@microsoft.com",
            },
            "missing-role-token": {
                "client_id": "azure-cli",
                "scopes": ["access_as_user"],
                "tid": _TENANT_ID,
                "oid": "unauthorized-object-id",
                "roles": [],
            },
        },
        required_scopes=["access_as_user"],
    )
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"
    settings = ServerSettings(
        data_dir=tmp_path / "data",
        signing_key=b"s" * 32,
        auth_mode="entra",
        auth_provider=static_verifier,
        entra_tenant_id=_TENANT_ID,
        entra_app_id="session-share-app",
        required_role=_REQUIRED_ROLE,
        admin_role=_ADMIN_ROLE,
        max_archive_bytes=1024 * 1024,
        ticket_ttl_seconds=300,
        public_base_url=base_url,
        azure_file_base_url="https://sessionstore.file.core.windows.net/session-data",
        port=port,
    )
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(settings),
            host="127.0.0.1",
            port=port,
            log_level="error",
        )
    )
    task = asyncio.create_task(server.serve())
    async with httpx.AsyncClient() as client:
        for _ in range(100):
            try:
                response = await client.get(f"{base_url}/readyz")
                if response.status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.02)
        else:
            server.should_exit = True
            await task
            raise RuntimeError("test server did not start")
    try:
        yield {
            "base_url": base_url,
            "mcp_url": f"{base_url}/mcp",
            "alice": "alice-token",
            "bob": "bob-token",
            "missing_role": "missing-role-token",
            "data_dir": str(tmp_path / "data"),
        }
    finally:
        server.should_exit = True
        await task


def _tool_data(result: object) -> dict:
    value = getattr(result, "data", None)
    assert isinstance(value, dict)
    return value


def _portable_archive(root: Path, session_id: str) -> Path:
    codex_home = root / "source-codex-home"
    workspace = root / "source-workspace"
    workspace.mkdir()
    (workspace / "portable.txt").write_text("portable\n", encoding="utf-8")
    rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "08"
        / "10"
        / f"rollout-2026-08-10T00-00-00-{session_id}.jsonl"
    )
    rollout.parent.mkdir(parents=True)
    records = [
        {
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "timestamp": "2026-08-10T00:00:00Z",
                "cwd": str(workspace),
            },
        },
        {
            "type": "event_msg",
            "payload": {"type": "task_started", "turn_id": "turn-1"},
        },
        {
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "Portable session"},
        },
        {
            "type": "event_msg",
            "payload": {"type": "agent_message", "message": "Ready to continue"},
        },
        {
            "type": "event_msg",
            "payload": {"type": "task_complete", "turn_id": "turn-1"},
        },
    ]
    rollout.write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )
    archive = root / "portable-session.tar.gz"
    build_session_bundle(
        session_id,
        archive,
        codex_home=codex_home,
        workspace=workspace,
        include_git_bundle=False,
    )
    return archive


def _create_target_state_db(codex_home: Path) -> None:
    codex_home.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(codex_home / "state_5.sqlite")
    try:
        connection.execute(
            """
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                cwd TEXT NOT NULL,
                title TEXT,
                archived INTEGER NOT NULL
            )
            """
        )
        connection.commit()
    finally:
        connection.close()


def test_server_settings_support_passwordless_oauth(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("SESSION_SHARE_AUTH_MODE", "entra")
    monkeypatch.setenv("SESSION_SHARE_SIGNING_KEY", "s" * 32)
    monkeypatch.setenv("SESSION_SHARE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SESSION_SHARE_ENTRA_TENANT_ID", _TENANT_ID)
    monkeypatch.setenv(
        "SESSION_SHARE_ENTRA_APP_ID",
        "11111111-1111-1111-1111-111111111111",
    )
    monkeypatch.setenv(
        "SESSION_SHARE_MANAGED_IDENTITY_CLIENT_ID",
        "managed-identity-client",
    )
    monkeypatch.setenv(
        "SESSION_SHARE_PUBLIC_BASE_URL",
        "https://session-share.example",
    )

    settings = ServerSettings.from_environment()

    assert settings.entra_client_secret == ""
    assert settings.managed_identity_client_id == "managed-identity-client"
    assert settings.public_base_url == "https://session-share.example"


@pytest.mark.asyncio
async def test_parent_app_exposes_direct_entra_oauth_metadata(tmp_path: Path) -> None:
    base_url = "https://session-share.example"
    auth_provider = create_entra_oauth_provider(
        tenant_id=_TENANT_ID,
        app_id="11111111-1111-1111-1111-111111111111",
        managed_identity_client_id="managed-identity-client",
        jwt_signing_key=b"s" * 32,
        base_url=base_url,
        required_role=_REQUIRED_ROLE,
        accept_azure_cli_tokens=False,
        client_storage=MemoryStore(),
    )
    app = create_app(
        ServerSettings(
            data_dir=tmp_path / "data",
            signing_key=b"s" * 32,
            auth_mode="entra",
            auth_provider=auth_provider,
            entra_tenant_id=_TENANT_ID,
            required_role=_REQUIRED_ROLE,
            public_base_url=base_url,
        )
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url=base_url,
    ) as client:
        authorization = await client.get("/.well-known/oauth-authorization-server")
        protected_resource = await client.get(
            "/.well-known/oauth-protected-resource/mcp"
        )

    assert authorization.status_code == 200
    assert authorization.json()["registration_endpoint"] == f"{base_url}/register"
    assert protected_resource.status_code == 200
    assert protected_resource.json()["resource"] == f"{base_url}/mcp"


@pytest.mark.asyncio
async def test_session_history_uses_semantic_search_and_admin_reindex(
    tmp_path: Path,
) -> None:
    class FakeSemanticSearch:
        closed = False
        reindexed = False

        async def status(self) -> dict[str, Any]:
            return {"enabled": True, "index_name": "sessions"}

        async def search(
            self,
            query: str,
            *,
            state: str,
            limit: int,
            offset: int,
            start_at: int,
        ) -> dict[str, Any]:
            assert query == "unstable proxy"
            assert state == "active"
            assert start_at == 123
            return {
                "items": [
                    {
                        "session_name": "semantic-session",
                        "state": "active",
                        "search_score": 0.9,
                        "matches": [{"role": "assistant", "content": "proxy retry"}],
                    }
                ],
                "total": 1,
                "limit": limit,
                "offset": offset,
                "has_more": False,
                "search_mode": "azure_ai_search_hybrid_vector",
            }

        async def reindex_all(self, _store: object) -> dict[str, Any]:
            self.reindexed = True
            return {
                "indexed_sessions": 1,
                "indexed_documents": 2,
                "errors": [],
            }

        async def close(self) -> None:
            self.closed = True

    semantic = FakeSemanticSearch()
    verifier = StaticTokenVerifier(
        {
            "admin-token": {
                "client_id": "azure-cli",
                "scopes": ["access_as_user"],
                "tid": _TENANT_ID,
                "oid": "admin-user",
                "roles": [_REQUIRED_ROLE, _ADMIN_ROLE],
            }
        },
        required_scopes=["access_as_user"],
    )
    app = create_app(
        ServerSettings(
            data_dir=tmp_path / "data",
            signing_key=b"s" * 32,
            auth_mode="entra",
            auth_provider=verifier,
            semantic_search_client=semantic,  # type: ignore[arg-type]
            entra_tenant_id=_TENANT_ID,
            required_role=_REQUIRED_ROLE,
            admin_role=_ADMIN_ROLE,
            public_base_url="https://session-share.test",
        )
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="https://session-share.test",
        headers={"Authorization": "Bearer admin-token"},
    ) as client:
        search = await client.get(
            "/v1/session-history",
            params={
                "state": "active",
                "q": "unstable proxy",
                "start_at": "123",
            },
        )
        reindex = await client.post("/v1/session-history/reindex")

    assert search.status_code == 200
    assert search.json()["search_mode"] == "azure_ai_search_hybrid_vector"
    assert search.json()["items"][0]["session_name"] == "semantic-session"
    assert reindex.status_code == 200
    assert semantic.reindexed is True


@pytest.mark.asyncio
async def test_cross_user_create_replace_and_download(
    running_server: dict[str, Any],
) -> None:
    base_url = running_server["base_url"]
    mcp_url = running_server["mcp_url"]
    alice = running_server["alice"]
    bob = running_server["bob"]

    async with Client(mcp_url, auth=alice) as client:
        assert [tool.name for tool in await client.list_tools()] == [
            "upload_session",
            "download_session",
            "codex_config_sync",
            "rename_session",
        ]

    async def upload(content: bytes) -> dict:
        digest = hashlib.sha256(content).hexdigest()
        async with Client(mcp_url, auth=alice) as client:
            ticket = _tool_data(
                await client.call_tool(
                    "upload_session",
                    {
                        "session_id": "shared-session",
                        "archive_sha256": digest,
                        "archive_size_bytes": len(content),
                        "handoff_summary": "handoff",
                        "manifest": {"schema_version": 1},
                    },
                )
            )
        async with httpx.AsyncClient() as http:
            response = await http.put(
                urljoin(base_url, ticket["upload"]["url"]),
                headers={
                    "Authorization": f"Bearer {alice}",
                    "Content-Length": str(len(content)),
                },
                content=content,
            )
        assert response.status_code in {200, 201}
        return response.json()

    first = await upload(b"first archive")
    assert first["action"] == "created"
    assert first["azure_file_url"].startswith(
        "https://sessionstore.file.core.windows.net/session-data/"
        "sessions/shared-session/versions/"
    )

    async with Client(mcp_url, auth=bob) as client:
        ticket = _tool_data(
            await client.call_tool(
                "download_session",
                {"session_id": "shared-session"},
            )
        )
    assert ticket["uploaded_by"] == f"{_TENANT_ID}:alice-object-id"
    assert ticket["uploaded_by_email"] == "alice@microsoft.com"
    async with httpx.AsyncClient() as http:
        response = await http.get(
            urljoin(base_url, ticket["download"]["url"]),
            headers={"Authorization": f"Bearer {bob}"},
        )
    assert response.status_code == 200
    assert response.content == b"first archive"

    second = await upload(b"second archive replaces the first")
    assert second["action"] == "replaced"
    async with Client(mcp_url, auth=bob) as client:
        replacement_ticket = _tool_data(
            await client.call_tool(
                "download_session",
                {"session_id": "shared-session"},
            )
        )
    async with httpx.AsyncClient() as http:
        replacement = await http.get(
            urljoin(base_url, replacement_ticket["download"]["url"]),
            headers={"Authorization": f"Bearer {bob}"},
        )
    assert replacement.content == b"second archive replaces the first"
    versions = list(
        (Path(running_server["data_dir"]) / "sessions").glob("*/*/*.tar.gz")
    )
    assert len(versions) == 1
    assert (
        Path(running_server["data_dir"])
        / "sessions"
        / "shared-session"
        / "current.json"
    ).is_file()


@pytest.mark.asyncio
async def test_config_sync_is_private_confirmed_and_windows_capable(
    running_server: dict[str, Any],
) -> None:
    base_url = running_server["base_url"]
    mcp_url = running_server["mcp_url"]
    alice = running_server["alice"]
    bob = running_server["bob"]

    async with Client(mcp_url, auth=alice) as client:
        local_upload = _tool_data(
            await client.call_tool(
                "codex_config_sync",
                {
                    "action": "upload",
                    "client_platform": "windows",
                    "profile": "workstation",
                },
            )
        )
    assert local_upload["status"] == "local_execution_required"
    assert local_upload["session_history_included"] is False
    assert local_upload["credentials_included"] is False
    assert local_upload["local_execution"]["shell"] == "powershell"
    assert local_upload["local_execution"]["command"].startswith("& ")
    assert "--operation=config-upload" in local_upload["local_execution"]["arguments"]

    content = b"private configuration archive"
    manifest = {
        "schema_version": 1,
        "bundle_type": "codex_config",
        "profile": "workstation",
        "source": {"platform": "windows"},
        "security": {
            "credentials_included": False,
            "session_history_included": False,
        },
    }
    headers = {"Authorization": f"Bearer {alice}"}
    async with httpx.AsyncClient() as http:
        reservation = await http.post(
            f"{base_url}/v1/config-sync/upload",
            headers=headers,
            json={
                "profile": "workstation",
                "archive_sha256": hashlib.sha256(content).hexdigest(),
                "archive_size_bytes": len(content),
                "manifest": manifest,
            },
        )
        assert reservation.status_code == 200
        reserved = reservation.json()
        assert reserved["action"] == "create"
        stored = await http.put(
            reserved["upload"]["url"],
            headers={
                **headers,
                "Content-Length": str(len(content)),
            },
            content=content,
        )
        assert stored.status_code == 201
        assert stored.json()["profile"] == "workstation"

    async with Client(mcp_url, auth=bob) as client:
        with pytest.raises(ToolError, match="no Codex configuration snapshot"):
            await client.call_tool(
                "codex_config_sync",
                {
                    "action": "download",
                    "client_platform": "windows",
                    "profile": "workstation",
                },
            )

    async with Client(mcp_url, auth=alice) as client:
        confirmation = _tool_data(
            await client.call_tool(
                "codex_config_sync",
                {
                    "action": "download",
                    "client_platform": "windows",
                    "profile": "workstation",
                },
            )
        )
        assert confirmation["status"] == "confirmation_required"
        download = _tool_data(
            await client.call_tool(
                "codex_config_sync",
                {
                    "action": "download",
                    "client_platform": "windows",
                    "profile": "workstation",
                    "confirm_overwrite": True,
                },
            )
        )
    assert download["status"] == "download_ready"
    assert download["local_execution"]["shell"] == "powershell"
    assert "--operation=config-download" in download["local_execution"]["arguments"]
    async with httpx.AsyncClient() as http:
        response = await http.get(
            download["download"]["url"],
            headers=headers,
        )
    assert response.status_code == 200
    assert response.content == content


@pytest.mark.asyncio
async def test_rest_upload_reservation_uses_the_mcp_upload_pipeline(
    running_server: dict[str, Any],
) -> None:
    content = b"REST upload pipeline archive"
    digest = hashlib.sha256(content).hexdigest()
    headers = {"Authorization": f"Bearer {running_server['alice']}"}
    async with httpx.AsyncClient() as http:
        ticket = await http.post(
            f"{running_server['base_url']}/v1/session-history/upload",
            headers=headers,
            json={
                "session_id": "rest-source-session",
                "name": "rest_upload_session",
                "archive_sha256": digest,
                "archive_size_bytes": len(content),
                "handoff_summary": "REST upload pipeline",
                "manifest": {
                    "schema_version": 1,
                    "source_session_id": "rest-source-session",
                },
            },
        )
        assert ticket.status_code == 200
        payload = ticket.json()
        assert payload["status"] == "upload_ready"
        assert payload["session_name"] == "rest_upload_session"
        stored = await http.put(
            payload["upload"]["url"],
            headers={
                **headers,
                "Content-Type": "application/gzip",
                "Content-Length": str(len(content)),
            },
            content=content,
        )
    assert stored.status_code == 201
    assert stored.json()["session_name"] == "rest_upload_session"


@pytest.mark.asyncio
async def test_session_history_api_enforces_admin_mutations_and_trash_lifecycle(
    running_server: dict[str, Any],
    tmp_path: Path,
) -> None:
    base_url = running_server["base_url"]
    archive = _portable_archive(tmp_path, "history-session")
    content = archive.read_bytes()
    async with Client(running_server["mcp_url"], auth=running_server["alice"]) as client:
        ticket = _tool_data(
            await client.call_tool(
                "upload_session",
                {
                    "session_id": "history-session",
                    "archive_sha256": hashlib.sha256(content).hexdigest(),
                    "archive_size_bytes": len(content),
                    "manifest": {"schema_version": 1},
                },
            )
        )
    async with httpx.AsyncClient() as http:
        stored = await http.put(
            ticket["upload"]["url"],
            headers={
                "Authorization": f"Bearer {running_server['alice']}",
                "Content-Length": str(len(content)),
            },
            content=content,
        )
        assert stored.status_code == 201

        contributor_headers = {
            "Authorization": f"Bearer {running_server['bob']}"
        }
        admin_headers = {
            "Authorization": f"Bearer {running_server['alice']}"
        }
        listing = await http.get(
            f"{base_url}/v1/session-history",
            headers=contributor_headers,
        )
        assert listing.status_code == 200
        assert listing.json()["items"][0]["session_name"] == "history-session"
        assert listing.json()["permissions"]["can_manage"] is False
        filtered = await http.get(
            f"{base_url}/v1/session-history",
            headers=contributor_headers,
            params={
                "start_at": str(int(listing.json()["items"][0]["uploaded_at"]) + 1)
            },
        )
        assert filtered.status_code == 200
        assert filtered.json()["total"] == 0
        invalid_time = await http.get(
            f"{base_url}/v1/session-history",
            headers=contributor_headers,
            params={"start_at": "not-an-integer"},
        )
        assert invalid_time.status_code == 400
        admin_listing = await http.get(
            f"{base_url}/v1/session-history",
            headers=admin_headers,
        )
        assert admin_listing.json()["permissions"]["can_manage"] is True

        detail = await http.get(
            f"{base_url}/v1/session-history/active/history-session",
            headers=contributor_headers,
        )
        assert detail.status_code == 200
        transcript = detail.json()["transcript"]["messages"]
        assert [message["text"] for message in transcript] == [
            "Portable session",
            "Ready to continue",
        ]

        archive_download = await http.get(
            f"{base_url}/v1/session-history/active/history-session/archive",
            headers=contributor_headers,
        )
        assert archive_download.status_code == 200
        assert archive_download.content == content

        denied = await http.post(
            f"{base_url}/v1/session-history/active/history-session/rename",
            headers=contributor_headers,
            json={"new_name": "history-renamed"},
        )
        assert denied.status_code == 403

        renamed = await http.post(
            f"{base_url}/v1/session-history/active/history-session/rename",
            headers=admin_headers,
            json={"new_name": "history-renamed"},
        )
        assert renamed.status_code == 200

        trashed = await http.delete(
            f"{base_url}/v1/session-history/active/history-renamed",
            headers=admin_headers,
        )
        assert trashed.status_code == 200
        trash_listing = await http.get(
            f"{base_url}/v1/session-history?state=trash",
            headers=contributor_headers,
        )
        assert trash_listing.json()["items"][0]["state"] == "trash"

        restored = await http.post(
            f"{base_url}/v1/session-history/trash/history-renamed/restore",
            headers=admin_headers,
        )
        assert restored.status_code == 200

        purged = await http.delete(
            f"{base_url}/v1/session-history/active/history-renamed/purge",
            headers=admin_headers,
        )
        assert purged.status_code == 200
        assert purged.json()["status"] == "purged"
        empty_trash = await http.get(
            f"{base_url}/v1/session-history?state=trash",
            headers=contributor_headers,
        )
        assert empty_trash.json()["total"] == 0
        empty_active = await http.get(
            f"{base_url}/v1/session-history?state=active",
            headers=contributor_headers,
        )
        assert empty_active.json()["total"] == 0


@pytest.mark.asyncio
async def test_download_session_runs_zero_install_restore(
    running_server: dict[str, Any],
    tmp_path: Path,
) -> None:
    base_url = running_server["base_url"]
    mcp_url = running_server["mcp_url"]
    archive = _portable_archive(tmp_path, "portable-session")
    content = archive.read_bytes()
    async with Client(mcp_url, auth=running_server["alice"]) as client:
        upload_ticket = _tool_data(
            await client.call_tool(
                "upload_session",
                {
                    "session_id": "portable-session",
                    "archive_sha256": hashlib.sha256(content).hexdigest(),
                    "archive_size_bytes": len(content),
                    "manifest": {"schema_version": 1},
                },
            )
        )
    async with httpx.AsyncClient() as http:
        stored = await http.put(
            upload_ticket["upload"]["url"],
            headers={
                "Authorization": f"Bearer {running_server['alice']}",
                "Content-Length": str(len(content)),
            },
            content=content,
        )
    assert stored.status_code == 201

    recipient_home = tmp_path / "recipient home"
    target_codex_home = recipient_home / ".codex"
    target_workspace = tmp_path / "recipient workspace"
    _create_target_state_db(target_codex_home)
    async with Client(mcp_url, auth=running_server["bob"]) as client:
        download_ticket = _tool_data(
            await client.call_tool(
                "download_session",
                {
                    "session_id": "portable-session",
                    "workspace": str(target_workspace),
                    "codex_home": str(target_codex_home),
                    "new_copy": True,
                },
            )
        )

    local_execution = download_ticket["local_execution"]
    assert local_execution["bootstrap_url"] == (
        f"{base_url}/v1/client/codex-session-share.pyz?version=0.9.0"
    )
    assert "pip install" not in local_execution["command"]
    assert "codex-session-share download" not in local_execution["command"]
    assert download_ticket["next_action"].startswith(
        "Execute local_execution.command"
    )
    async with httpx.AsyncClient() as http:
        bootstrap = await http.get(local_execution["bootstrap_url"])
    assert bootstrap.status_code == 200
    assert bootstrap.headers["x-codex-session-share-version"] == "0.9.0"
    assert bootstrap.content.startswith(b"PK")
    assert hashlib.sha256(bootstrap.content).hexdigest() == (
        local_execution["bootstrap_sha256"]
    )

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    az = bin_dir / "az"
    az.write_text(
        "#!/usr/bin/env python3\n"
        "import json\n"
        "print(json.dumps({"
        f"'accessToken': '{running_server['bob']}', "
        f"'tenant': '{_TENANT_ID}'"
        "}))\n",
        encoding="utf-8",
    )
    az.chmod(0o755)
    environment = os.environ.copy()
    environment.update(
        {
            "HOME": str(recipient_home),
            "CODEX_HOME": str(target_codex_home),
            "PATH": f"{bin_dir}:{environment['PATH']}",
        }
    )
    environment.pop("CODEX_SESSION_SHARE_ACCESS_TOKEN", None)
    completed = await asyncio.to_thread(
        subprocess.run,
        ["bash", "-c", local_execution["command"]],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert completed.returncode == 0, completed.stderr
    assert "Resume: codex resume " in completed.stdout
    assert (target_workspace / "portable.txt").read_text(encoding="utf-8") == (
        "portable\n"
    )
    connection = sqlite3.connect(target_codex_home / "state_5.sqlite")
    try:
        thread = connection.execute(
            "SELECT id, cwd, rollout_path FROM threads"
        ).fetchone()
    finally:
        connection.close()
    assert thread is not None
    assert thread[0] != "portable-session"
    assert thread[1] == str(target_workspace)
    rollout_text = Path(thread[2]).read_text(encoding="utf-8")
    assert str(target_workspace) in rollout_text
    assert str(tmp_path / "source-workspace") not in rollout_text


@pytest.mark.asyncio
async def test_named_upload_is_unique_and_returns_azure_file_url(
    running_server: dict[str, Any],
) -> None:
    base_url = running_server["base_url"]
    mcp_url = running_server["mcp_url"]
    alice = running_server["alice"]
    source_session_id = "019fb689-c996-7c71-ac58-8253c100adb7"
    session_name = "shared_session_123"
    content = b"named archive"

    async with Client(mcp_url, auth=alice) as client:
        local_bridge = _tool_data(
            await client.call_tool(
                "upload_session",
                {
                    "session_id": source_session_id,
                    "name": session_name,
                },
            )
        )
        assert local_bridge["status"] == "local_bundle_required"
        assert f"--name {session_name}" in local_bridge["message"]
        ticket = _tool_data(
            await client.call_tool(
                "upload_session",
                {
                    "session_id": source_session_id,
                    "name": session_name,
                    "archive_sha256": hashlib.sha256(content).hexdigest(),
                    "archive_size_bytes": len(content),
                    "manifest": {"source_session_id": "untrusted-value"},
                },
            )
        )
    assert ticket["session_id"] == source_session_id
    assert ticket["session_name"] == session_name
    assert ticket["source_session_id"] == source_session_id
    assert ticket["action"] == "create"

    async with Client(mcp_url, auth=running_server["bob"]) as client:
        with pytest.raises(ToolError, match="busy"):
            await client.call_tool(
                "upload_session",
                {
                    "session_id": "competing-session",
                    "name": session_name,
                    "archive_sha256": hashlib.sha256(b"competing").hexdigest(),
                    "archive_size_bytes": len(b"competing"),
                },
            )

    async with httpx.AsyncClient() as http:
        response = await http.put(
            urljoin(base_url, ticket["upload"]["url"]),
            headers={
                "Authorization": f"Bearer {alice}",
                "Content-Length": str(len(content)),
            },
            content=content,
        )
    assert response.status_code == 201
    stored = response.json()
    assert stored["session_id"] == source_session_id
    assert stored["session_name"] == session_name
    assert stored["source_session_id"] == source_session_id
    assert stored["action"] == "created"
    assert stored["azure_file_url"] == (
        "https://sessionstore.file.core.windows.net/session-data/"
        + stored["archive_path"]
    )

    metadata_path = (
        Path(running_server["data_dir"])
        / "sessions"
        / session_name
        / "current.json"
    )
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["source_session_id"] == source_session_id
    assert metadata["session_name"] == session_name
    assert metadata["uploaded_by_email"] == "alice@microsoft.com"

    async with Client(mcp_url, auth=alice) as client:
        with pytest.raises(ToolError, match="already used"):
            await client.call_tool(
                "upload_session",
                {
                    "session_id": "another-session",
                    "name": session_name,
                    "archive_sha256": hashlib.sha256(b"duplicate").hexdigest(),
                    "archive_size_bytes": len(b"duplicate"),
                },
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["bad-name", "bad.name", "bad name", "", "a" * 129])
async def test_named_upload_rejects_invalid_name(
    running_server: dict[str, Any],
    name: str,
) -> None:
    async with Client(running_server["mcp_url"], auth=running_server["alice"]) as client:
        with pytest.raises(ToolError, match="letters, numbers, or '_'"):
            await client.call_tool(
                "upload_session",
                {
                    "session_id": "019fb689-c996-7c71-ac58-8253c100adb7",
                    "name": name,
                },
            )


@pytest.mark.asyncio
async def test_transfer_rejects_missing_role_and_wrong_body(
    running_server: dict[str, Any],
) -> None:
    base_url = running_server["base_url"]
    mcp_url = running_server["mcp_url"]
    alice = running_server["alice"]
    content = b"expected"
    async with Client(mcp_url, auth=running_server["missing_role"]) as client:
        with pytest.raises(ToolError, match="application role"):
            await client.call_tool(
                "upload_session",
                {
                    "session_id": "role-denied",
                    "archive_sha256": hashlib.sha256(content).hexdigest(),
                    "archive_size_bytes": len(content),
                },
            )
    async with Client(mcp_url, auth=alice) as client:
        ticket = _tool_data(
            await client.call_tool(
                "upload_session",
                {
                    "session_id": "bad-upload",
                    "archive_sha256": hashlib.sha256(content).hexdigest(),
                    "archive_size_bytes": len(content),
                },
            )
        )
    url = urljoin(base_url, ticket["upload"]["url"])
    async with httpx.AsyncClient() as http:
        unauthorized = await http.put(
            url,
            headers={"Content-Length": str(len(content))},
            content=content,
        )
        assert unauthorized.status_code == 401
        forbidden = await http.put(
            url,
            headers={
                "Authorization": "Bearer missing-role-token",
                "Content-Length": str(len(content)),
            },
            content=content,
        )
        assert forbidden.status_code == 403
        mismatch = await http.put(
            url,
            headers={
                "Authorization": f"Bearer {alice}",
                "Content-Length": str(len(content)),
            },
            content=b"mismatch",
        )
        assert mismatch.status_code == 422


@pytest.mark.asyncio
async def test_rename_rejects_collisions_and_active_races(
    running_server: dict[str, Any],
) -> None:
    base_url = running_server["base_url"]
    mcp_url = running_server["mcp_url"]
    alice = running_server["alice"]
    bob = running_server["bob"]

    async def upload(session_name: str, content: bytes) -> None:
        async with Client(mcp_url, auth=alice) as client:
            ticket = _tool_data(
                await client.call_tool(
                    "upload_session",
                    {
                        "session_id": session_name,
                        "archive_sha256": hashlib.sha256(content).hexdigest(),
                        "archive_size_bytes": len(content),
                        "manifest": {
                            "schema_version": 1,
                            "source_session_id": f"source-{session_name}",
                        },
                    },
                )
            )
        async with httpx.AsyncClient() as http:
            response = await http.put(
                urljoin(base_url, ticket["upload"]["url"]),
                headers={
                    "Authorization": f"Bearer {alice}",
                    "Content-Length": str(len(content)),
                },
                content=content,
            )
        assert response.status_code in {200, 201}

    await upload("original-session", b"original")
    await upload("already-used", b"other")

    async with Client(mcp_url, auth=bob) as client:
        active_download = _tool_data(
            await client.call_tool(
                "download_session",
                {"session_id": "original-session"},
            )
        )

    async with Client(mcp_url, auth=alice) as client:
        with pytest.raises(ToolError, match="busy"):
            await client.call_tool(
                "rename_session",
                {
                    "original_name": "original-session",
                    "new_name": "friendly-name",
                },
            )
        with pytest.raises(ToolError, match="busy"):
            await client.call_tool(
                "upload_session",
                {
                    "session_id": "original-session",
                    "archive_sha256": hashlib.sha256(b"replacement").hexdigest(),
                    "archive_size_bytes": len(b"replacement"),
                },
            )

    async with httpx.AsyncClient() as http:
        response = await http.get(
            urljoin(base_url, active_download["download"]["url"]),
            headers={"Authorization": f"Bearer {bob}"},
        )
    assert response.content == b"original"
    await asyncio.sleep(0.05)

    async with Client(mcp_url, auth=alice) as client:
        renamed = _tool_data(
            await client.call_tool(
                "rename_session",
                {
                    "original_name": "original-session",
                    "new_name": "friendly-name",
                },
            )
        )
        assert renamed["status"] == "renamed"
        assert renamed["storage_path"] == "sessions/friendly-name"
        with pytest.raises(ToolError, match="already used"):
            await client.call_tool(
                "rename_session",
                {
                    "original_name": "friendly-name",
                    "new_name": "already-used",
                },
            )
        with pytest.raises(ToolError, match="not found"):
            await client.call_tool(
                "download_session",
                {"session_id": "original-session"},
            )

    async with Client(mcp_url, auth=bob) as client:
        renamed_download = _tool_data(
            await client.call_tool(
                "download_session",
                {"session_id": "friendly-name"},
            )
        )
    assert renamed_download["source_session_id"] == "source-original-session"
    async with httpx.AsyncClient() as http:
        renamed_response = await http.get(
            urljoin(base_url, renamed_download["download"]["url"]),
            headers={"Authorization": f"Bearer {bob}"},
        )
    assert renamed_response.content == b"original"

    data_root = Path(running_server["data_dir"]) / "sessions"
    assert not (data_root / "original-session").exists()
    assert (data_root / "friendly-name" / "current.json").is_file()
