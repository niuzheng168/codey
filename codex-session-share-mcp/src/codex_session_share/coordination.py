"""Filesystem-backed read/write leases for cross-user operation coordination."""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .names import validate_session_name

LeaseMode = Literal["read", "write"]


class SessionBusyError(RuntimeError):
    """Raised when another active operation conflicts with a requested lease."""

    def __init__(self, names: tuple[str, ...], holders: list[dict[str, Any]]) -> None:
        self.names = names
        self.holders = holders
        operations = sorted(
            {
                str(holder.get("operation") or holder.get("mode") or "operation")
                for holder in holders
            }
        )
        super().__init__(
            f"session is busy with {', '.join(operations) or 'another operation'}; retry later"
        )


class LeaseNotActiveError(RuntimeError):
    """Raised when a transfer lease expired or was already released."""


@dataclass(frozen=True)
class SessionLease:
    lease_id: str
    names: tuple[str, ...]
    mode: LeaseMode
    principal: str
    operation: str
    expires_at: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "lease_id": self.lease_id,
            "names": list(self.names),
            "mode": self.mode,
            "principal": self.principal,
            "operation": self.operation,
            "expires_at": self.expires_at,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> SessionLease:
        return cls(
            lease_id=str(value["lease_id"]),
            names=tuple(str(name) for name in value["names"]),
            mode=str(value["mode"]),  # type: ignore[arg-type]
            principal=str(value["principal"]),
            operation=str(value["operation"]),
            expires_at=int(value["expires_at"]),
        )


class FileLeaseCoordinator:
    """Coordinate readers and writers through short-lived files on shared storage."""

    def __init__(self, root: Path, *, mutex_timeout_seconds: float = 10.0) -> None:
        self.root = root
        self.active_root = root / "active"
        self.mutex_path = root / ".mutex"
        self.mutex_timeout_seconds = mutex_timeout_seconds
        self.active_root.mkdir(parents=True, exist_ok=True)

    def _lease_path(self, lease_id: str) -> Path:
        return self.active_root / f"{lease_id}.json"

    def _take_mutex(self) -> int:
        deadline = time.monotonic() + self.mutex_timeout_seconds
        while True:
            try:
                descriptor = os.open(
                    self.mutex_path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
                os.write(descriptor, f"{os.getpid()} {time.time()}".encode())
                return descriptor
            except FileExistsError:
                try:
                    if self.mutex_path.stat().st_mtime < time.time() - 60:
                        self.mutex_path.unlink(missing_ok=True)
                        continue
                except FileNotFoundError:
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        "timed out acquiring the session lease mutex"
                    ) from None
                time.sleep(0.02)

    def _release_mutex(self, descriptor: int) -> None:
        os.close(descriptor)
        self.mutex_path.unlink(missing_ok=True)

    def _with_mutex(self, callback: Any) -> Any:
        descriptor = self._take_mutex()
        try:
            return callback()
        finally:
            self._release_mutex(descriptor)

    def _active_leases(self, now: int) -> list[SessionLease]:
        leases: list[SessionLease] = []
        for path in self.active_root.glob("*.json"):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                lease = SessionLease.from_dict(value)
            except Exception:
                path.unlink(missing_ok=True)
                continue
            if lease.expires_at < now:
                path.unlink(missing_ok=True)
                continue
            leases.append(lease)
        return leases

    async def acquire(
        self,
        names: list[str] | tuple[str, ...],
        *,
        mode: LeaseMode,
        principal: str,
        operation: str,
        ttl_seconds: int,
    ) -> SessionLease:
        normalized = tuple(sorted({validate_session_name(name) for name in names}))
        if not normalized:
            raise ValueError("at least one session name is required")

        def acquire_sync() -> SessionLease:
            now = int(time.time())
            active = self._active_leases(now)
            conflicts = [
                lease
                for lease in active
                if set(lease.names).intersection(normalized)
                and (mode == "write" or lease.mode == "write")
            ]
            if conflicts:
                raise SessionBusyError(
                    normalized,
                    [lease.as_dict() for lease in conflicts],
                )
            lease = SessionLease(
                lease_id=uuid.uuid4().hex,
                names=normalized,
                mode=mode,
                principal=principal,
                operation=operation,
                expires_at=now + ttl_seconds,
            )
            path = self._lease_path(lease.lease_id)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(lease.as_dict(), sort_keys=True, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(temporary, path)
            return lease

        return await asyncio.to_thread(self._with_mutex, acquire_sync)

    async def validate(
        self,
        lease_id: str,
        *,
        principal: str,
        mode: LeaseMode,
    ) -> SessionLease:
        def validate_sync() -> SessionLease:
            now = int(time.time())
            active = {lease.lease_id: lease for lease in self._active_leases(now)}
            lease = active.get(lease_id)
            if lease is None or lease.principal != principal or lease.mode != mode:
                raise LeaseNotActiveError("session operation lease is no longer active")
            return lease

        return await asyncio.to_thread(self._with_mutex, validate_sync)

    async def renew(self, lease_id: str, *, ttl_seconds: int) -> SessionLease:
        def renew_sync() -> SessionLease:
            now = int(time.time())
            active = {lease.lease_id: lease for lease in self._active_leases(now)}
            lease = active.get(lease_id)
            if lease is None:
                raise LeaseNotActiveError("session operation lease is no longer active")
            renewed = SessionLease(
                lease_id=lease.lease_id,
                names=lease.names,
                mode=lease.mode,
                principal=lease.principal,
                operation=lease.operation,
                expires_at=now + ttl_seconds,
            )
            path = self._lease_path(lease_id)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(renewed.as_dict(), sort_keys=True, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(temporary, path)
            return renewed

        return await asyncio.to_thread(self._with_mutex, renew_sync)

    async def release(self, lease_id: str) -> None:
        def release_sync() -> None:
            self._active_leases(int(time.time()))
            self._lease_path(lease_id).unlink(missing_ok=True)

        await asyncio.to_thread(self._with_mutex, release_sync)
