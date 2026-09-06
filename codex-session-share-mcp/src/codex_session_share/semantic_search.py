"""Azure AI Search hybrid/vector projection for shared session transcripts."""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx
from azure.identity.aio import ManagedIdentityCredential

from .bundle import BundleError, extract_and_validate_bundle, iter_transcript_messages
from .history import iter_archive_messages
from .storage import SessionStore

_SEARCH_SCOPE = "https://search.azure.com/.default"
_COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default"
_SEARCH_API_VERSION = "2024-07-01"
_OPENAI_API_VERSION = "2024-10-21"
_MAX_CHUNK_CHARS = 4_000
_CHUNK_OVERLAP_CHARS = 400
_EMBEDDING_BATCH_SIZE = 8
_INDEX_BATCH_SIZE = 50
_MAX_RETRY_ATTEMPTS = 8


class SearchConfigurationError(RuntimeError):
    """Raised when semantic-search settings are incomplete."""


class SearchOperationError(RuntimeError):
    """Raised when Azure AI Search or embedding calls fail."""


class AsyncTokenProvider(Protocol):
    async def get_token(self, *scopes: str) -> Any: ...

    async def close(self) -> None: ...


@dataclass(frozen=True)
class SemanticSearchSettings:
    search_endpoint: str
    index_name: str
    embedding_endpoint: str
    embedding_deployment: str
    embedding_dimensions: int = 3072
    managed_identity_client_id: str = ""

    @classmethod
    def from_environment(cls) -> SemanticSearchSettings | None:
        values = {
            "search_endpoint": os.environ.get("SESSION_SHARE_SEARCH_ENDPOINT", "").strip(),
            "index_name": os.environ.get("SESSION_SHARE_SEARCH_INDEX_NAME", "").strip(),
            "embedding_endpoint": os.environ.get(
                "SESSION_SHARE_EMBEDDING_ENDPOINT", ""
            ).strip(),
            "embedding_deployment": os.environ.get(
                "SESSION_SHARE_EMBEDDING_DEPLOYMENT", ""
            ).strip(),
        }
        if not any(values.values()):
            return None
        missing = [name for name, value in values.items() if not value]
        if missing:
            raise SearchConfigurationError(
                f"semantic search is missing: {', '.join(missing)}"
            )
        dimensions = int(
            os.environ.get("SESSION_SHARE_EMBEDDING_DIMENSIONS", "3072")
        )
        if dimensions < 1 or dimensions > 4096:
            raise SearchConfigurationError("embedding dimensions are invalid")
        return cls(
            search_endpoint=values["search_endpoint"].rstrip("/"),
            index_name=values["index_name"],
            embedding_endpoint=values["embedding_endpoint"].rstrip("/"),
            embedding_deployment=values["embedding_deployment"],
            embedding_dimensions=dimensions,
            managed_identity_client_id=os.environ.get(
                "SESSION_SHARE_MANAGED_IDENTITY_CLIENT_ID", ""
            ).strip(),
        )


def chunk_text(
    text: str,
    *,
    max_chars: int = _MAX_CHUNK_CHARS,
    overlap_chars: int = _CHUNK_OVERLAP_CHARS,
) -> list[str]:
    """Split text into overlapping paragraph-aware embedding chunks."""

    normalized = text.strip()
    if not normalized:
        return []
    if max_chars < 256 or overlap_chars < 0 or overlap_chars >= max_chars:
        raise ValueError("invalid chunking limits")
    chunks: list[str] = []
    start = 0
    while start < len(normalized):
        hard_end = min(len(normalized), start + max_chars)
        end = hard_end
        if hard_end < len(normalized):
            minimum = start + int(max_chars * 0.65)
            candidates = [
                normalized.rfind("\n\n", minimum, hard_end),
                normalized.rfind("\n", minimum, hard_end),
                normalized.rfind(" ", minimum, hard_end),
            ]
            boundary = max(candidates)
            if boundary > start:
                end = boundary
        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(normalized):
            break
        start = max(start + 1, end - overlap_chars)
    return chunks


def _document_id(
    session_name: str,
    version_id: str,
    kind: str,
    item_index: int,
    chunk_index: int,
) -> str:
    raw = (
        f"{session_name}\0{version_id}\0{kind}\0{item_index}\0{chunk_index}"
    ).encode()
    return hashlib.sha256(raw).hexdigest()


def build_search_documents(
    metadata: dict[str, Any],
    archive_path: Path,
) -> list[dict[str, Any]]:
    """Build nonvector search documents while leaving the archive unchanged."""

    session_name = str(metadata.get("session_name") or metadata["session_id"])
    version_id = str(metadata["version_id"])
    common = {
        "session_name": session_name,
        "source_session_id": str(
            metadata.get("source_session_id") or session_name
        ),
        "version_id": version_id,
        "state": str(metadata.get("state") or "active"),
        "uploaded_at": int(metadata.get("uploaded_at") or 0),
        "uploaded_by_email": str(metadata.get("uploaded_by_email") or ""),
        "archive_size_bytes": int(metadata.get("archive_size_bytes") or 0),
        "handoff_summary": str(metadata.get("handoff_summary") or ""),
    }
    documents: list[dict[str, Any]] = []
    handoff = common["handoff_summary"]
    for chunk_index, content in enumerate(chunk_text(handoff)):
        documents.append(
            {
                "id": _document_id(
                    session_name, version_id, "handoff", 0, chunk_index
                ),
                **common,
                "kind": "handoff",
                "role": "system",
                "message_index": -1,
                "chunk_index": chunk_index,
                "timestamp": "",
                "content": content,
            }
        )
    try:
        messages = list(iter_archive_messages(archive_path))
    except BundleError:
        with tempfile.TemporaryDirectory(
            prefix="codex-session-share-search-legacy-"
        ) as temporary:
            extracted = Path(temporary)
            extract_and_validate_bundle(archive_path, extracted)
            messages = [
                {"role": role, "text": text, "timestamp": None}
                for role, text in iter_transcript_messages(
                    extracted / "codex" / "rollout.jsonl"
                )
            ]
    for message_index, message in enumerate(messages):
        for chunk_index, content in enumerate(chunk_text(str(message["text"]))):
            documents.append(
                {
                    "id": _document_id(
                        session_name,
                        version_id,
                        "message",
                        message_index,
                        chunk_index,
                    ),
                    **common,
                    "kind": "message",
                    "role": str(message["role"]),
                    "message_index": message_index,
                    "chunk_index": chunk_index,
                    "timestamp": str(message.get("timestamp") or ""),
                    "content": content,
                }
            )
    return documents


class SemanticSearchClient:
    """Push and query session chunks using managed-identity authenticated REST."""

    def __init__(
        self,
        settings: SemanticSearchSettings,
        *,
        credential: AsyncTokenProvider | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings
        self.credential = credential or ManagedIdentityCredential(
            client_id=settings.managed_identity_client_id or None
        )
        self.http = http_client or httpx.AsyncClient(
            timeout=httpx.Timeout(connect=30, read=120, write=120, pool=30),
            follow_redirects=False,
        )
        self._owns_http = http_client is None
        self._owns_credential = credential is None

    @classmethod
    def from_environment(cls) -> SemanticSearchClient | None:
        settings = SemanticSearchSettings.from_environment()
        return cls(settings) if settings else None

    async def close(self) -> None:
        if self._owns_http:
            await self.http.aclose()
        if self._owns_credential:
            await self.credential.close()

    async def status(self) -> dict[str, Any]:
        return {
            "enabled": True,
            "search_endpoint": self.settings.search_endpoint,
            "index_name": self.settings.index_name,
            "embedding_deployment": self.settings.embedding_deployment,
            "embedding_dimensions": self.settings.embedding_dimensions,
        }

    async def index_session(
        self,
        metadata: dict[str, Any],
        archive_path: Path,
        *,
        previous_name: str | None = None,
    ) -> dict[str, Any]:
        documents = await asyncio.to_thread(
            build_search_documents, metadata, archive_path
        )
        session_name = str(metadata.get("session_name") or metadata["session_id"])
        if previous_name and previous_name != session_name:
            await self.delete_session(previous_name)
        await self.delete_session(session_name)
        if not documents:
            return {"indexed_documents": 0, "session_name": session_name}
        for start in range(0, len(documents), _EMBEDDING_BATCH_SIZE):
            batch = documents[start : start + _EMBEDDING_BATCH_SIZE]
            embeddings = await self._embed([str(item["content"]) for item in batch])
            for item, vector in zip(batch, embeddings, strict=True):
                item["content_vector"] = vector
                item["@search.action"] = "upload"
        for start in range(0, len(documents), _INDEX_BATCH_SIZE):
            await self._index_documents(documents[start : start + _INDEX_BATCH_SIZE])
        return {
            "indexed_documents": len(documents),
            "session_name": session_name,
        }

    async def delete_session(self, session_name: str) -> int:
        escaped = session_name.replace("'", "''")
        keys: list[str] = []
        skip = 0
        while True:
            response = await self._search_request(
                {
                    "search": "*",
                    "filter": f"session_name eq '{escaped}'",
                    "select": "id",
                    "top": 1000,
                    "skip": skip,
                }
            )
            values = response.get("value") or []
            keys.extend(str(value["id"]) for value in values if value.get("id"))
            if len(values) < 1000:
                break
            skip += len(values)
        for start in range(0, len(keys), _INDEX_BATCH_SIZE):
            await self._index_documents(
                [
                    {"@search.action": "delete", "id": key}
                    for key in keys[start : start + _INDEX_BATCH_SIZE]
                ]
            )
        return len(keys)

    async def delete_indexed_session(
        self,
        metadata: dict[str, Any],
        archive_path: Path,
    ) -> int:
        """Delete deterministic document IDs without relying on query visibility."""

        documents = await asyncio.to_thread(
            build_search_documents,
            metadata,
            archive_path,
        )
        keys = [str(document["id"]) for document in documents]
        for start in range(0, len(keys), _INDEX_BATCH_SIZE):
            await self._index_documents(
                [
                    {"@search.action": "delete", "id": key}
                    for key in keys[start : start + _INDEX_BATCH_SIZE]
                ]
            )
        return len(keys)

    async def search(
        self,
        query: str,
        *,
        state: str = "active",
        limit: int = 50,
        offset: int = 0,
        start_at: int = 0,
    ) -> dict[str, Any]:
        query = query.strip()
        if not query:
            raise ValueError("semantic search query cannot be empty")
        vector = (await self._embed([query]))[0]
        top = min(1000, max(50, (offset + limit) * 10))
        body: dict[str, Any] = {
            "search": query,
            "queryType": "simple",
            "searchMode": "any",
            "vectorQueries": [
                {
                    "kind": "vector",
                    "vector": vector,
                    "fields": "content_vector",
                    "k": top,
                }
            ],
            "vectorFilterMode": "preFilter",
            "select": (
                "id,session_name,source_session_id,version_id,state,"
                "uploaded_at,uploaded_by_email,archive_size_bytes,"
                "handoff_summary,kind,role,message_index,chunk_index,"
                "timestamp,content"
            ),
            "highlight": "content",
            "highlightPreTag": "",
            "highlightPostTag": "",
            "top": top,
        }
        filters: list[str] = []
        if state in {"active", "trash"}:
            filters.append(f"state eq '{state}'")
        if start_at > 0:
            filters.append(f"uploaded_at ge {int(start_at)}")
        if filters:
            body["filter"] = " and ".join(filters)
        response = await self._search_request(body)
        sessions: dict[str, dict[str, Any]] = {}
        for value in response.get("value") or []:
            name = str(value.get("session_name") or "")
            if not name:
                continue
            score = float(value.get("@search.score") or 0)
            current = sessions.get(name)
            if current is None:
                current = {
                    "session_name": name,
                    "source_session_id": value.get("source_session_id"),
                    "state": value.get("state") or "active",
                    "uploaded_at": value.get("uploaded_at") or 0,
                    "uploaded_by_email": value.get("uploaded_by_email") or "",
                    "archive_size_bytes": value.get("archive_size_bytes") or 0,
                    "handoff_summary": value.get("handoff_summary") or "",
                    "search_score": score,
                    "matches": [],
                }
                sessions[name] = current
            current["search_score"] = max(current["search_score"], score)
            if len(current["matches"]) < 4:
                highlights = value.get("@search.highlights") or {}
                highlighted = (highlights.get("content") or [value.get("content") or ""])[
                    0
                ]
                current["matches"].append(
                    {
                        "role": value.get("role"),
                        "kind": value.get("kind"),
                        "timestamp": value.get("timestamp"),
                        "content": highlighted,
                        "score": score,
                    }
                )
        ordered = sorted(
            sessions.values(),
            key=lambda item: (-float(item["search_score"]), -int(item["uploaded_at"])),
        )
        return {
            "items": ordered[offset : offset + limit],
            "total": len(ordered),
            "limit": limit,
            "offset": offset,
            "has_more": offset + limit < len(ordered),
            "search_mode": "azure_ai_search_hybrid_vector",
        }

    async def reindex_all(self, store: SessionStore) -> dict[str, Any]:
        await self.clear_index()
        indexed = 0
        sessions = 0
        errors: list[dict[str, str]] = []
        for state in ("active", "trash"):
            for metadata in await store.list_sessions(state=state):
                name = str(metadata.get("session_name") or metadata.get("session_id"))
                try:
                    archive = await store.resolve_version(
                        name,
                        str(metadata["version_id"]),
                        state=state,
                    )
                    result = await self.index_session(metadata, archive)
                    indexed += int(result["indexed_documents"])
                    sessions += 1
                except Exception as exc:  # noqa: BLE001
                    errors.append({"session_name": name, "error": str(exc)[:500]})
        return {
            "indexed_sessions": sessions,
            "indexed_documents": indexed,
            "errors": errors,
        }

    async def clear_index(self) -> int:
        keys: list[str] = []
        skip = 0
        while True:
            response = await self._search_request(
                {"search": "*", "select": "id", "top": 1000, "skip": skip}
            )
            values = response.get("value") or []
            keys.extend(str(value["id"]) for value in values if value.get("id"))
            if len(values) < 1000:
                break
            skip += len(values)
        for start in range(0, len(keys), _INDEX_BATCH_SIZE):
            await self._index_documents(
                [
                    {"@search.action": "delete", "id": key}
                    for key in keys[start : start + _INDEX_BATCH_SIZE]
                ]
            )
        return len(keys)

    async def _embed(self, values: list[str]) -> list[list[float]]:
        token = await self.credential.get_token(_COGNITIVE_SCOPE)
        url = (
            f"{self.settings.embedding_endpoint}/openai/deployments/"
            f"{self.settings.embedding_deployment}/embeddings"
            f"?api-version={_OPENAI_API_VERSION}"
        )
        response = await self._post_with_retry(
            url,
            headers={"Authorization": f"Bearer {token.token}"},
            payload={
                "input": values,
                "dimensions": self.settings.embedding_dimensions,
            },
            operation="embedding",
        )
        if response.status_code != 200:
            raise SearchOperationError(
                f"embedding request failed with HTTP {response.status_code}: "
                f"{response.text[:500]}"
            )
        data = response.json().get("data") or []
        ordered = sorted(data, key=lambda item: int(item["index"]))
        embeddings = [item.get("embedding") for item in ordered]
        if len(embeddings) != len(values) or any(
            not isinstance(vector, list)
            or len(vector) != self.settings.embedding_dimensions
            for vector in embeddings
        ):
            raise SearchOperationError("embedding response shape is invalid")
        return embeddings

    async def _index_documents(self, documents: list[dict[str, Any]]) -> None:
        token = await self.credential.get_token(_SEARCH_SCOPE)
        url = (
            f"{self.settings.search_endpoint}/indexes/"
            f"{self.settings.index_name}/docs/index"
            f"?api-version={_SEARCH_API_VERSION}"
        )
        response = await self._post_with_retry(
            url,
            headers={"Authorization": f"Bearer {token.token}"},
            payload={"value": documents},
            operation="search indexing",
        )
        if response.status_code not in {200, 201, 207}:
            raise SearchOperationError(
                f"search indexing failed with HTTP {response.status_code}: "
                f"{response.text[:500]}"
            )
        failures = [
            value
            for value in response.json().get("value") or []
            if value.get("status") is False
        ]
        if failures:
            raise SearchOperationError(
                f"search rejected {len(failures)} document operation(s): "
                f"{str(failures[:3])[:500]}"
            )

    async def _search_request(self, body: dict[str, Any]) -> dict[str, Any]:
        token = await self.credential.get_token(_SEARCH_SCOPE)
        url = (
            f"{self.settings.search_endpoint}/indexes/"
            f"{self.settings.index_name}/docs/search"
            f"?api-version={_SEARCH_API_VERSION}"
        )
        response = await self._post_with_retry(
            url,
            headers={"Authorization": f"Bearer {token.token}"},
            payload=body,
            operation="search query",
        )
        if response.status_code != 200:
            raise SearchOperationError(
                f"search query failed with HTTP {response.status_code}: "
                f"{response.text[:500]}"
            )
        return response.json()

    async def _post_with_retry(
        self,
        url: str,
        *,
        headers: dict[str, str],
        payload: dict[str, Any],
        operation: str,
    ) -> httpx.Response:
        response: httpx.Response | None = None
        for attempt in range(_MAX_RETRY_ATTEMPTS):
            response = await self.http.post(url, headers=headers, json=payload)
            if response.status_code not in {429, 500, 502, 503, 504}:
                return response
            retry_after = response.headers.get("retry-after")
            try:
                delay = float(retry_after) if retry_after else min(60, 2**attempt)
            except ValueError:
                delay = min(60, 2**attempt)
            if attempt + 1 < _MAX_RETRY_ATTEMPTS:
                await asyncio.sleep(max(1, min(delay, 90)))
        if response is None:
            raise SearchOperationError(f"{operation} did not produce a response")
        return response
