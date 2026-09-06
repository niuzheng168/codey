from __future__ import annotations

from pathlib import Path

import pytest

from codex_session_share.coordination import FileLeaseCoordinator, SessionBusyError


@pytest.mark.asyncio
async def test_filesystem_leases_coordinate_independent_instances(tmp_path: Path) -> None:
    first = FileLeaseCoordinator(tmp_path / "coordination")
    second = FileLeaseCoordinator(tmp_path / "coordination")

    writer = await first.acquire(
        ["shared-session"],
        mode="write",
        principal="alice",
        operation="upload",
        ttl_seconds=60,
    )
    with pytest.raises(SessionBusyError):
        await second.acquire(
            ["shared-session"],
            mode="read",
            principal="bob",
            operation="download",
            ttl_seconds=60,
        )
    await first.release(writer.lease_id)

    reader_one = await first.acquire(
        ["shared-session"],
        mode="read",
        principal="alice",
        operation="download",
        ttl_seconds=60,
    )
    reader_two = await second.acquire(
        ["shared-session"],
        mode="read",
        principal="bob",
        operation="download",
        ttl_seconds=60,
    )
    with pytest.raises(SessionBusyError):
        await first.acquire(
            ["shared-session"],
            mode="write",
            principal="alice",
            operation="rename",
            ttl_seconds=60,
        )
    await first.release(reader_one.lease_id)
    await second.release(reader_two.lease_id)
