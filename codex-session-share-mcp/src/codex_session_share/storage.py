"""Persistent, atomic session archive storage."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
import uuid
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .names import validate_session_name

_LEGACY_HASH_DIRECTORY = re.compile(r"^[0-9a-f]{64}$")


class SessionNotFoundError(FileNotFoundError):
    """Raised when a session name has no current archive."""


class SessionAlreadyExistsError(FileExistsError):
    """Raised when a requested new session name is already in use."""


class PendingUploadNotFoundError(FileNotFoundError):
    """Raised when an upload reservation is missing, expired, or already consumed."""


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, sort_keys=True, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


@dataclass(frozen=True)
class UploadReservation:
    pending_id: str
    session_id: str
    source_session_id: str
    principal: str
    uploader_email: str
    archive_sha256: str
    archive_size_bytes: int
    expires_at: int
    lease_id: str
    require_new: bool
    manifest: dict[str, Any]
    handoff_summary: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "pending_id": self.pending_id,
            "session_id": self.session_id,
            "source_session_id": self.source_session_id,
            "principal": self.principal,
            "uploader_email": self.uploader_email,
            "archive_sha256": self.archive_sha256,
            "archive_size_bytes": self.archive_size_bytes,
            "expires_at": self.expires_at,
            "lease_id": self.lease_id,
            "require_new": self.require_new,
            "manifest": self.manifest,
            "handoff_summary": self.handoff_summary,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> UploadReservation:
        manifest = dict(value.get("manifest") or {})
        session_id = str(value["session_id"])
        return cls(
            pending_id=str(value["pending_id"]),
            session_id=session_id,
            source_session_id=str(
                value.get("source_session_id")
                or manifest.get("source_session_id")
                or session_id
            ),
            principal=str(value["principal"]),
            uploader_email=str(value.get("uploader_email") or ""),
            archive_sha256=str(value["archive_sha256"]),
            archive_size_bytes=int(value["archive_size_bytes"]),
            expires_at=int(value["expires_at"]),
            lease_id=str(value["lease_id"]),
            require_new=bool(value.get("require_new", False)),
            manifest=manifest,
            handoff_summary=str(value.get("handoff_summary") or ""),
        )


class SessionStore:
    """Store immutable archive versions behind an atomically replaced pointer."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.sessions_root = root / "sessions"
        self.trash_root = root / "trash"
        self.pending_root = root / "pending"
        self.temp_root = root / "tmp"
        self._locks: dict[str, asyncio.Lock] = {}
        for directory in (
            self.sessions_root,
            self.trash_root,
            self.pending_root,
            self.temp_root,
        ):
            directory.mkdir(parents=True, exist_ok=True)

    def _session_dir(self, session_name: str) -> Path:
        return self.sessions_root / validate_session_name(session_name)

    def _current_path(self, session_name: str) -> Path:
        return self._session_dir(session_name) / "current.json"

    def _state_root(self, state: str) -> Path:
        if state == "active":
            return self.sessions_root
        if state == "trash":
            return self.trash_root
        raise ValueError("state must be 'active' or 'trash'")

    def _state_session_dir(self, session_name: str, state: str) -> Path:
        return self._state_root(state) / validate_session_name(session_name)

    def _state_current_path(self, session_name: str, state: str) -> Path:
        return self._state_session_dir(session_name, state) / "current.json"

    def _pending_path(self, pending_id: str) -> Path:
        return self.pending_root / f"{pending_id}.json"

    def _claimed_path(self, pending_id: str) -> Path:
        return self.pending_root / f"{pending_id}.claimed.json"

    def new_temp_path(self) -> Path:
        return self.temp_root / f"{uuid.uuid4().hex}.upload"

    def _lock_for(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())

    async def migrate_legacy_layout(self) -> list[dict[str, str]]:
        """Move legacy SHA-256 directories to their readable session names."""

        def migrate() -> list[dict[str, str]]:
            migrated: list[dict[str, str]] = []
            for directory in self.sessions_root.iterdir():
                if not directory.is_dir() or not _LEGACY_HASH_DIRECTORY.fullmatch(directory.name):
                    continue
                current = directory / "current.json"
                if not current.is_file():
                    continue
                try:
                    metadata = json.loads(current.read_text(encoding="utf-8"))
                    session_name = validate_session_name(
                        str(metadata.get("session_name") or metadata.get("session_id") or "")
                    )
                    version_id = str(metadata["version_id"])
                except (KeyError, ValueError, json.JSONDecodeError):
                    continue
                if session_name == directory.name:
                    continue
                destination = self.sessions_root / session_name
                if destination.exists():
                    continue
                source_session_id = str(
                    metadata.get("source_session_id")
                    or metadata.get("session_id")
                    or session_name
                )
                metadata.update(
                    {
                        "session_id": session_name,
                        "session_name": session_name,
                        "source_session_id": source_session_id,
                        "storage_path": f"sessions/{session_name}",
                        "archive_path": (
                            f"sessions/{session_name}/versions/{version_id}.tar.gz"
                        ),
                    }
                )
                metadata.pop("storage_key", None)
                os.replace(directory, destination)
                _write_json_atomic(destination / "current.json", metadata)
                migrated.append({"from": directory.name, "to": session_name})
            return migrated

        async with self._lock_for("legacy-migration"):
            return await asyncio.to_thread(migrate)

    async def session_exists(self, session_name: str) -> bool:
        return await asyncio.to_thread(self._current_path(session_name).is_file)

    async def reserve_upload(
        self,
        *,
        session_id: str,
        source_session_id: str,
        principal: str,
        uploader_email: str,
        archive_sha256: str,
        archive_size_bytes: int,
        manifest: dict[str, Any],
        handoff_summary: str,
        ttl_seconds: int,
        lease_id: str,
        require_new: bool,
    ) -> UploadReservation:
        pending_id = uuid.uuid4().hex
        reservation = UploadReservation(
            pending_id=pending_id,
            session_id=session_id,
            source_session_id=source_session_id,
            principal=principal,
            uploader_email=uploader_email,
            archive_sha256=archive_sha256,
            archive_size_bytes=archive_size_bytes,
            expires_at=int(time.time()) + ttl_seconds,
            lease_id=lease_id,
            require_new=require_new,
            manifest=manifest,
            handoff_summary=handoff_summary,
        )
        await asyncio.to_thread(
            _write_json_atomic,
            self._pending_path(pending_id),
            reservation.as_dict(),
        )
        return reservation

    async def claim_upload(self, pending_id: str) -> UploadReservation:
        async with self._lock_for(f"pending:{pending_id}"):
            pending = self._pending_path(pending_id)
            claimed = self._claimed_path(pending_id)

            def claim() -> UploadReservation:
                if not pending.is_file():
                    raise PendingUploadNotFoundError(pending_id)
                os.replace(pending, claimed)
                try:
                    value = json.loads(claimed.read_text(encoding="utf-8"))
                    reservation = UploadReservation.from_dict(value)
                except Exception:
                    claimed.unlink(missing_ok=True)
                    raise
                if reservation.expires_at < int(time.time()):
                    claimed.unlink(missing_ok=True)
                    raise PendingUploadNotFoundError(pending_id)
                return reservation

            return await asyncio.to_thread(claim)

    async def release_claim(self, reservation: UploadReservation, *, retryable: bool) -> None:
        async with self._lock_for(f"pending:{reservation.pending_id}"):
            pending = self._pending_path(reservation.pending_id)
            claimed = self._claimed_path(reservation.pending_id)

            def release() -> None:
                if retryable and reservation.expires_at >= int(time.time()) and claimed.exists():
                    os.replace(claimed, pending)
                else:
                    claimed.unlink(missing_ok=True)
                    pending.unlink(missing_ok=True)

            await asyncio.to_thread(release)

    async def commit_upload(
        self,
        reservation: UploadReservation,
        temporary_archive: Path,
    ) -> dict[str, Any]:
        async with self._lock_for(f"session:{reservation.session_id}"):
            session_dir = self._session_dir(reservation.session_id)
            versions_dir = session_dir / "versions"
            version_id = uuid.uuid4().hex
            version_path = versions_dir / f"{version_id}.tar.gz"
            uploaded_at = int(time.time())

            def commit() -> dict[str, Any]:
                if reservation.require_new and self._current_path(
                    reservation.session_id
                ).is_file():
                    raise SessionAlreadyExistsError(reservation.session_id)
                versions_dir.mkdir(parents=True, exist_ok=True)
                replaced = self._current_path(reservation.session_id).is_file()
                os.replace(temporary_archive, version_path)
                metadata = {
                    "schema_version": 1,
                    "session_id": reservation.session_id,
                    "session_name": reservation.session_id,
                    "source_session_id": reservation.source_session_id,
                    "storage_path": f"sessions/{reservation.session_id}",
                    "archive_path": (
                        f"sessions/{reservation.session_id}/versions/{version_id}.tar.gz"
                    ),
                    "version_id": version_id,
                    "archive_sha256": reservation.archive_sha256,
                    "archive_size_bytes": reservation.archive_size_bytes,
                    "archive_format": "application/gzip",
                    "uploaded_by": reservation.principal,
                    "uploaded_by_email": reservation.uploader_email,
                    "uploaded_at": uploaded_at,
                    "manifest": reservation.manifest,
                    "handoff_summary": reservation.handoff_summary,
                    "original_handoff_summary": reservation.handoff_summary,
                    "replaced": replaced,
                }
                _write_json_atomic(self._current_path(reservation.session_id), metadata)
                for candidate in versions_dir.glob("*.tar.gz"):
                    if candidate == version_path:
                        continue
                    with suppress(FileNotFoundError, PermissionError):
                        candidate.unlink()
                return metadata

            return await asyncio.to_thread(commit)

    async def read_session(self, session_name: str) -> dict[str, Any]:
        return await self.read_session_state(session_name, state="active")

    async def read_session_state(
        self,
        session_name: str,
        *,
        state: str,
    ) -> dict[str, Any]:
        session_name = validate_session_name(session_name)
        async with self._lock_for(f"session:{state}:{session_name}"):
            current = self._state_current_path(session_name, state)

            def read() -> dict[str, Any]:
                if not current.is_file():
                    raise SessionNotFoundError(session_name)
                value = json.loads(current.read_text(encoding="utf-8"))
                stored_name = value.get("session_name") or value.get("session_id")
                if stored_name != session_name:
                    raise RuntimeError("session metadata name mismatch")
                return value

            return await asyncio.to_thread(read)

    async def list_sessions(self, *, state: str) -> list[dict[str, Any]]:
        root = self._state_root(state)

        def list_values() -> list[dict[str, Any]]:
            values: list[dict[str, Any]] = []
            for directory in root.iterdir():
                if not directory.is_dir():
                    continue
                try:
                    session_name = validate_session_name(directory.name)
                    metadata = json.loads(
                        (directory / "current.json").read_text(encoding="utf-8")
                    )
                    stored_name = metadata.get("session_name") or metadata.get(
                        "session_id"
                    )
                    if stored_name != session_name:
                        continue
                except (
                    FileNotFoundError,
                    OSError,
                    ValueError,
                    json.JSONDecodeError,
                ):
                    continue
                metadata = dict(metadata)
                metadata["state"] = state
                values.append(metadata)
            return values

        return await asyncio.to_thread(list_values)

    async def rename_session(self, original_name: str, new_name: str) -> dict[str, Any]:
        original_name = validate_session_name(original_name)
        new_name = validate_session_name(new_name)
        old_directory = self._session_dir(original_name)
        new_directory = self._session_dir(new_name)

        def rename() -> dict[str, Any]:
            if not (old_directory / "current.json").is_file():
                raise SessionNotFoundError(original_name)
            if new_directory.exists():
                raise SessionAlreadyExistsError(new_name)
            metadata = json.loads(
                (old_directory / "current.json").read_text(encoding="utf-8")
            )
            source_session_id = str(
                metadata.get("source_session_id")
                or metadata.get("session_id")
                or original_name
            )
            original_handoff = str(
                metadata.get("original_handoff_summary")
                or metadata.get("handoff_summary")
                or ""
            )
            metadata.update(
                {
                    "session_id": new_name,
                    "session_name": new_name,
                    "source_session_id": source_session_id,
                    "storage_path": f"sessions/{new_name}",
                    "archive_path": (
                        f"sessions/{new_name}/versions/{metadata['version_id']}.tar.gz"
                    ),
                    "renamed_from": original_name,
                    "renamed_at": int(time.time()),
                    "handoff_summary": (
                        f"Shared session name: {new_name}\n"
                        f"Source Codex session ID: {source_session_id}\n\n"
                        f"{original_handoff}"
                    ).strip(),
                    "original_handoff_summary": original_handoff,
                }
            )
            metadata.pop("storage_key", None)
            os.replace(old_directory, new_directory)
            try:
                _write_json_atomic(new_directory / "current.json", metadata)
            except Exception:
                os.replace(new_directory, old_directory)
                raise
            return metadata

        async with self._lock_for(f"rename:{original_name}:{new_name}"):
            return await asyncio.to_thread(rename)

    async def trash_session(self, session_name: str, *, principal: str) -> dict[str, Any]:
        session_name = validate_session_name(session_name)
        source = self._session_dir(session_name)
        destination = self._state_session_dir(session_name, "trash")

        def move_to_trash() -> dict[str, Any]:
            current = source / "current.json"
            if not current.is_file():
                raise SessionNotFoundError(session_name)
            if destination.exists():
                raise SessionAlreadyExistsError(session_name)
            metadata = json.loads(current.read_text(encoding="utf-8"))
            version_id = str(metadata["version_id"])
            deleted_at = int(time.time())
            metadata.update(
                {
                    "state": "trash",
                    "deleted_at": deleted_at,
                    "deleted_by": principal,
                    "storage_path": f"trash/{session_name}",
                    "archive_path": (
                        f"trash/{session_name}/versions/{version_id}.tar.gz"
                    ),
                }
            )
            os.replace(source, destination)
            try:
                _write_json_atomic(destination / "current.json", metadata)
            except Exception:
                os.replace(destination, source)
                raise
            return metadata

        async with self._lock_for(f"trash:{session_name}"):
            return await asyncio.to_thread(move_to_trash)

    async def restore_session(
        self,
        session_name: str,
        *,
        principal: str,
    ) -> dict[str, Any]:
        session_name = validate_session_name(session_name)
        source = self._state_session_dir(session_name, "trash")
        destination = self._session_dir(session_name)

        def restore() -> dict[str, Any]:
            current = source / "current.json"
            if not current.is_file():
                raise SessionNotFoundError(session_name)
            if destination.exists():
                raise SessionAlreadyExistsError(session_name)
            metadata = json.loads(current.read_text(encoding="utf-8"))
            version_id = str(metadata["version_id"])
            last_deleted_at = metadata.pop("deleted_at", None)
            last_deleted_by = metadata.pop("deleted_by", None)
            metadata.update(
                {
                    "state": "active",
                    "restored_at": int(time.time()),
                    "restored_by": principal,
                    "last_deleted_at": last_deleted_at,
                    "last_deleted_by": last_deleted_by,
                    "storage_path": f"sessions/{session_name}",
                    "archive_path": (
                        f"sessions/{session_name}/versions/{version_id}.tar.gz"
                    ),
                }
            )
            os.replace(source, destination)
            try:
                _write_json_atomic(destination / "current.json", metadata)
            except Exception:
                os.replace(destination, source)
                raise
            return metadata

        async with self._lock_for(f"restore:{session_name}"):
            return await asyncio.to_thread(restore)

    async def purge_session(
        self,
        session_name: str,
        *,
        state: str = "trash",
    ) -> dict[str, Any]:
        session_name = validate_session_name(session_name)
        directory = self._state_session_dir(session_name, state)

        def purge() -> dict[str, Any]:
            current = directory / "current.json"
            if not current.is_file():
                raise SessionNotFoundError(session_name)
            metadata = json.loads(current.read_text(encoding="utf-8"))
            shutil.rmtree(directory)
            return metadata

        async with self._lock_for(f"purge:{state}:{session_name}"):
            return await asyncio.to_thread(purge)

    async def resolve_version(
        self,
        session_name: str,
        version_id: str,
        *,
        state: str = "active",
    ) -> Path:
        session_dir = self._state_session_dir(session_name, state)
        candidate = session_dir / "versions" / f"{version_id}.tar.gz"
        resolved = candidate.resolve()
        if resolved.parent != (session_dir / "versions").resolve() or not resolved.is_file():
            raise SessionNotFoundError(session_name)
        return resolved

    async def discard_temp(self, path: Path) -> None:
        await asyncio.to_thread(path.unlink, missing_ok=True)

    async def clear(self) -> None:
        """Test helper that removes all persisted data below this store."""

        await asyncio.to_thread(shutil.rmtree, self.root, True)
