from __future__ import annotations

import pytest

from codex_session_share.tickets import TicketError, TicketSigner


def test_ticket_is_bound_to_operation_principal_and_expiry() -> None:
    signer = TicketSigner(b"x" * 32)
    ticket = signer.issue(
        operation="download",
        principal="alice",
        ttl_seconds=60,
        session_id="session-1",
        version_id="version-1",
    )
    payload = signer.verify(
        ticket,
        operation="download",
        principal="alice",
    )
    assert payload["session_id"] == "session-1"

    with pytest.raises(TicketError, match="principal"):
        signer.verify(ticket, operation="download", principal="bob")
    with pytest.raises(TicketError, match="operation"):
        signer.verify(ticket, operation="upload", principal="alice")
    with pytest.raises(TicketError, match="expired"):
        signer.verify(ticket, operation="download", principal="alice", now=payload["exp"] + 1)
    with pytest.raises(TicketError):
        signer.verify(ticket + "tampered", operation="download", principal="alice")
