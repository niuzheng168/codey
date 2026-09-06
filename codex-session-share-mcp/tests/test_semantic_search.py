from __future__ import annotations

import json
import tarfile
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from codex_session_share.semantic_search import (
    SemanticSearchClient,
    SemanticSearchSettings,
    build_search_documents,
    chunk_text,
)


class FakeCredential:
    async def get_token(self, *_scopes: str) -> SimpleNamespace:
        return SimpleNamespace(token="managed-identity-token")

    async def close(self) -> None:
        return None


def _archive(tmp_path: Path) -> Path:
    root = tmp_path / "archive"
    codex = root / "codex"
    codex.mkdir(parents=True)
    records = [
        {
            "timestamp": "2026-08-15T00:00:00Z",
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "Fix proxy retries"},
        },
        {
            "timestamp": "2026-08-15T00:00:01Z",
            "type": "event_msg",
            "payload": {
                "type": "agent_message",
                "message": "Implemented resilient encrypted-history recovery",
            },
        },
    ]
    (codex / "rollout.jsonl").write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )
    archive = tmp_path / "session.tar.gz"
    with tarfile.open(archive, "w:gz") as output:
        output.add(codex, arcname="codex")
    return archive


def test_chunk_and_build_search_documents_preserve_archive(tmp_path: Path) -> None:
    archive = _archive(tmp_path)
    original = archive.read_bytes()
    chunks = chunk_text("alpha " * 2_000, max_chars=1_000, overlap_chars=100)
    assert len(chunks) > 1
    assert all(len(chunk) <= 1_000 for chunk in chunks)

    documents = build_search_documents(
        {
            "session_name": "shared-session",
            "source_session_id": "source-session",
            "version_id": "version-1",
            "state": "active",
            "uploaded_at": 123,
            "uploaded_by_email": "user@example.com",
            "archive_size_bytes": archive.stat().st_size,
            "handoff_summary": "Proxy resilience work",
        },
        archive,
    )

    assert [document["kind"] for document in documents] == [
        "handoff",
        "message",
        "message",
    ]
    assert documents[1]["content"] == "Fix proxy retries"
    assert archive.read_bytes() == original


@pytest.mark.asyncio
async def test_semantic_client_indexes_and_runs_hybrid_vector_search(
    tmp_path: Path,
) -> None:
    archive = _archive(tmp_path)
    indexed: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content or b"{}")
        if "/embeddings" in request.url.path:
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"index": index, "embedding": [0.1, 0.2, 0.3]}
                        for index, _value in enumerate(payload["input"])
                    ]
                },
            )
        if request.url.path.endswith("/docs/index"):
            indexed.extend(payload["value"])
            return httpx.Response(
                200,
                json={
                    "value": [
                        {"key": item["id"], "status": True}
                        for item in payload["value"]
                    ]
                },
            )
        if request.url.path.endswith("/docs/search"):
            if payload.get("select") == "id":
                return httpx.Response(200, json={"value": []})
            assert payload["search"] == "proxy instability"
            assert payload["vectorQueries"][0]["vector"] == [0.1, 0.2, 0.3]
            assert payload["filter"] == "state eq 'active' and uploaded_at ge 100"
            return httpx.Response(
                200,
                json={
                    "value": [
                        {
                            "@search.score": 0.91,
                            "id": "document",
                            "session_name": "shared-session",
                            "source_session_id": "source-session",
                            "version_id": "version-1",
                            "state": "active",
                            "uploaded_at": 123,
                            "uploaded_by_email": "user@example.com",
                            "archive_size_bytes": 456,
                            "handoff_summary": "Proxy resilience work",
                            "kind": "message",
                            "role": "assistant",
                            "message_index": 1,
                            "chunk_index": 0,
                            "timestamp": "2026-08-15T00:00:01Z",
                            "content": "Implemented resilient recovery",
                        }
                    ]
                },
            )
        raise AssertionError(f"unexpected request: {request.url}")

    client = SemanticSearchClient(
        SemanticSearchSettings(
            search_endpoint="https://search.test",
            index_name="sessions",
            embedding_endpoint="https://embedding.test",
            embedding_deployment="text-embedding-3-large",
            embedding_dimensions=3,
        ),
        credential=FakeCredential(),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    metadata = {
        "session_name": "shared-session",
        "source_session_id": "source-session",
        "version_id": "version-1",
        "state": "active",
        "uploaded_at": 123,
        "archive_size_bytes": archive.stat().st_size,
        "handoff_summary": "Proxy resilience work",
    }
    result = await client.index_session(
        metadata,
        archive,
    )
    assert result["indexed_documents"] == 3
    assert all(len(item["content_vector"]) == 3 for item in indexed)

    search = await client.search("proxy instability", state="active", start_at=100)
    assert search["search_mode"] == "azure_ai_search_hybrid_vector"
    assert search["items"][0]["session_name"] == "shared-session"
    assert search["items"][0]["matches"][0]["role"] == "assistant"
    deleted = await client.delete_indexed_session(metadata, archive)
    assert deleted == 3
    assert [item["@search.action"] for item in indexed[-3:]] == [
        "delete",
        "delete",
        "delete",
    ]
    await client.close()
