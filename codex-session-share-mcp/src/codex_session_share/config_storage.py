"""Private per-user storage for Codex configuration snapshots."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .names import validate_config_profile


class ConfigProfileNotFoundError(FileNotFoundError):
    """Raised when a user has no current snapshot for a profile."""


class ConfigPendingUploadNotFoundError(FileNotFoundError):
    """Raised when a configuration upload reservation is unavailable."""


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, sort_keys=True, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def config_owner_key(principal: str) -> str:
    """Return a non-reversible storage key for an authenticated principal."""

    return hashlib.sha256(principal.encode("utf-8")).hexdigest()


def config_lease_name(principal: str, profile: str) -> str:
    """Return a safe coordination key without exposing the principal."""

    profile = validate_config_profile(profile)
    digest = hashlib.sha256(f"{principal}\0{profile}".encode()).hexdigest()
    return f"config-sync-{digest}"


@dataclass(frozen=True)
class ConfigUploadReservation:
    pending_id: str
    profile: str
    owner_key: str
    principal: str
    uploader_email: str
    archive_sha256: str
    archive_size_bytes: int
    expires_at: int
    lease_id: str
    manifest: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "pending_id": self.pending_id,
            "profile": self.profile,
            "owner_key": self.owner_key,
            "principal": self.principal,
            "uploader_email": self.uploader_email,
            "archive_sha256": self.archive_sha256,
            "archive_size_bytes": self.archive_size_bytes,
            "expires_at": self.expires_at,
            "lease_id": self.lease_id,
            "manifest": self.manifest,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> ConfigUploadReservation:
        return cls(
            pending_id=str(value["pending_id"]),
            profile=validate_config_profile(str(value["profile"])),
            owner_key=str(value["owner_key"]),
            principal=str(value["principal"]),
            uploader_email=str(value.get("uploader_email") or ""),
            archive_sha256=str(value["archive_sha256"]),
            archive_size_bytes=int(value["archive_size_bytes"]),
            expires_at=int(value["expires_at"]),
            lease_id=str(value["lease_id"]),
            manifest=dict(value.get("manifest") or {}),
        )


class ConfigStore:
    """Store one current immutable configuration archive per user and profile."""

    def __init__(self, root: Path) -> None:
        self.root = root / "config-sync"
        self.profiles_root = self.root / "profiles"
        self.pending_root = self.root / "pending"
        self.temp_root = self.root / "tmp"
        self._locks: dict[str, asyncio.Lock] = {}
        for directory in (self.profiles_root, self.pending_root, self.temp_root):
            directory.mkdir(parents=True, exist_ok=True)

    def _profile_dir(self, principal: str, profile: str) -> Path:
        return (
            self.profiles_root
            / config_owner_key(principal)
            / validate_config_profile(profile)
        )

    def _current_path(self, principal: str, profile: str) -> Path:
        return self._profile_dir(principal, profile) / "current.json"

    def _pending_path(self, pending_id: str) -> Path:
        return self.pending_root / f"{pending_id}.json"

    def _claimed_path(self, pending_id: str) -> Path:
        return self.pending_root / f"{pending_id}.claimed.json"

    def _lock_for(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())

    def new_temp_path(self) -> Path:
        return self.temp_root / f"{uuid.uuid4().hex}.upload"

    async def profile_exists(self, principal: str, profile: str) -> bool:
        return await asyncio.to_thread(self._current_path(principal, profile).is_file)

    async def reserve_upload(
        self,
        *,
        principal: str,
        uploader_email: str,
        profile: str,
        archive_sha256: str,
        archive_size_bytes: int,
        manifest: dict[str, Any],
        ttl_seconds: int,
        lease_id: str,
    ) -> ConfigUploadReservation:
        profile = validate_config_profile(profile)
        pending_id = uuid.uuid4().hex
        reservation = ConfigUploadReservation(
            pending_id=pending_id,
            profile=profile,
            owner_key=config_owner_key(principal),
            principal=principal,
            uploader_email=uploader_email,
            archive_sha256=archive_sha256,
            archive_size_bytes=archive_size_bytes,
            expires_at=int(time.time()) + ttl_seconds,
            lease_id=lease_id,
            manifest=dict(manifest),
        )
        await asyncio.to_thread(
            _write_json_atomic,
            self._pending_path(pending_id),
            reservation.as_dict(),
        )
        return reservation

    async def claim_upload(self, pending_id: str) -> ConfigUploadReservation:
        async with self._lock_for(f"pending:{pending_id}"):
            pending = self._pending_path(pending_id)
            claimed = self._claimed_path(pending_id)

            def claim() -> ConfigUploadReservation:
                if not pending.is_file():
                    raise ConfigPendingUploadNotFoundError(pending_id)
                os.replace(pending, claimed)
                try:
                    reservation = ConfigUploadReservation.from_dict(
                        json.loads(claimed.read_text(encoding="utf-8"))
                    )
                except Exception:
                    claimed.unlink(missing_ok=True)
                    raise
                if reservation.expires_at < int(time.time()):
                    claimed.unlink(missing_ok=True)
                    raise ConfigPendingUploadNotFoundError(pending_id)
                return reservation

            return await asyncio.to_thread(claim)

    async def release_claim(
        self,
        reservation: ConfigUploadReservation,
        *,
        retryable: bool,
    ) -> None:
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
        reservation: ConfigUploadReservation,
        temporary_archive: Path,
    ) -> dict[str, Any]:
        key = f"profile:{reservation.owner_key}:{reservation.profile}"
        async with self._lock_for(key):
            profile_dir = self._profile_dir(reservation.principal, reservation.profile)
            versions_dir = profile_dir / "versions"
            current_path = profile_dir / "current.json"
            version_id = uuid.uuid4().hex
            version_path = versions_dir / f"{version_id}.tar.gz"
            uploaded_at = int(time.time())

            def commit() -> dict[str, Any]:
                versions_dir.mkdir(parents=True, exist_ok=True)
                replaced = current_path.is_file()
                os.replace(temporary_archive, version_path)
                storage_path = (
                    f"config-sync/profiles/{reservation.owner_key}/{reservation.profile}"
                )
                metadata = {
                    "schema_version": 1,
                    "bundle_type": "codex_config",
                    "profile": reservation.profile,
                    "owner_key": reservation.owner_key,
                    "storage_path": storage_path,
                    "archive_path": f"{storage_path}/versions/{version_id}.tar.gz",
                    "version_id": version_id,
                    "archive_sha256": reservation.archive_sha256,
                    "archive_size_bytes": reservation.archive_size_bytes,
                    "archive_format": "application/gzip",
                    "uploaded_by": reservation.principal,
                    "uploaded_by_email": reservation.uploader_email,
                    "uploaded_at": uploaded_at,
                    "manifest": reservation.manifest,
                    "replaced": replaced,
                }
                _write_json_atomic(current_path, metadata)
                for candidate in versions_dir.glob("*.tar.gz"):
                    if candidate == version_path:
                        continue
                    with suppress(FileNotFoundError, PermissionError):
                        candidate.unlink()
                return metadata

            return await asyncio.to_thread(commit)

    async def read_profile(self, principal: str, profile: str) -> dict[str, Any]:
        profile = validate_config_profile(profile)
        current = self._current_path(principal, profile)
        key = f"profile:{config_owner_key(principal)}:{profile}"
        async with self._lock_for(key):

            def read() -> dict[str, Any]:
                if not current.is_file():
                    raise ConfigProfileNotFoundError(profile)
                value = json.loads(current.read_text(encoding="utf-8"))
                if (
                    value.get("profile") != profile
                    or value.get("owner_key") != config_owner_key(principal)
                ):
                    raise RuntimeError("config profile metadata mismatch")
                return value

            return await asyncio.to_thread(read)

    async def resolve_version(
        self,
        principal: str,
        profile: str,
        version_id: str,
    ) -> Path:
        profile_dir = self._profile_dir(principal, profile)
        candidate = profile_dir / "versions" / f"{version_id}.tar.gz"
        resolved = candidate.resolve()
        if resolved.parent != (profile_dir / "versions").resolve() or not resolved.is_file():
            raise ConfigProfileNotFoundError(profile)
        return resolved

    async def discard_temp(self, path: Path) -> None:
        await asyncio.to_thread(path.unlink, missing_ok=True)
