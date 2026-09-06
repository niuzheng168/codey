"""Short-lived HMAC transfer tickets."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any


class TicketError(ValueError):
    """Raised when a transfer ticket is invalid or expired."""


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding)
    except Exception as exc:  # noqa: BLE001
        raise TicketError("invalid ticket encoding") from exc


@dataclass(frozen=True)
class TicketSigner:
    """Issue and verify compact signed JSON tickets."""

    secret: bytes

    def __post_init__(self) -> None:
        if len(self.secret) < 32:
            raise ValueError("ticket signing secret must contain at least 32 bytes")

    def issue(self, *, operation: str, principal: str, ttl_seconds: int, **claims: Any) -> str:
        now = int(time.time())
        payload = {
            "v": 1,
            "op": operation,
            "sub": principal,
            "iat": now,
            "exp": now + ttl_seconds,
            **claims,
        }
        encoded = _b64url_encode(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        )
        signature = _b64url_encode(
            hmac.new(self.secret, encoded.encode("ascii"), hashlib.sha256).digest()
        )
        return f"{encoded}.{signature}"

    def verify(
        self,
        ticket: str,
        *,
        operation: str,
        principal: str,
        now: int | None = None,
    ) -> dict[str, Any]:
        try:
            encoded, provided_signature = ticket.split(".", 1)
        except ValueError as exc:
            raise TicketError("malformed transfer ticket") from exc
        expected_signature = _b64url_encode(
            hmac.new(self.secret, encoded.encode("ascii"), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(provided_signature, expected_signature):
            raise TicketError("invalid transfer ticket signature")
        try:
            payload = json.loads(_b64url_decode(encoded))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise TicketError("invalid transfer ticket payload") from exc
        current_time = int(time.time()) if now is None else now
        if payload.get("v") != 1:
            raise TicketError("unsupported transfer ticket version")
        if payload.get("op") != operation:
            raise TicketError("transfer ticket operation mismatch")
        if payload.get("sub") != principal:
            raise TicketError("transfer ticket principal mismatch")
        if not isinstance(payload.get("exp"), int) or payload["exp"] < current_time:
            raise TicketError("transfer ticket expired")
        return payload
