"""Read bounded session history from stored portable archives."""

from __future__ import annotations

import json
import tarfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .bundle import BundleError

_ROLLOUT_MEMBER = "codex/rollout.jsonl"
_MAX_ROLLOUT_BYTES = 128 * 1024 * 1024
_MAX_MESSAGE_CHARS = 64 * 1024
_MAX_TRANSCRIPT_CHARS = 2 * 1024 * 1024


def iter_archive_messages(archive_path: Path) -> Iterator[dict[str, Any]]:
    """Yield every user/assistant message from a validated stored rollout."""

    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            try:
                member = archive.getmember(_ROLLOUT_MEMBER)
            except KeyError as exc:
                raise BundleError("archive does not contain codex/rollout.jsonl") from exc
            if not member.isfile() or member.size > _MAX_ROLLOUT_BYTES:
                raise BundleError("stored rollout is invalid or exceeds the history limit")
            source = archive.extractfile(member)
            if source is None:
                raise BundleError("unable to read the stored rollout")
            with source:
                for encoded_line in source:
                    try:
                        value = json.loads(encoded_line)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    if not isinstance(value, dict) or value.get("type") != "event_msg":
                        continue
                    payload = value.get("payload")
                    if not isinstance(payload, dict):
                        continue
                    event_type = payload.get("type")
                    if event_type == "user_message":
                        role = "user"
                    elif event_type == "agent_message":
                        role = "assistant"
                    else:
                        continue
                    message = payload.get("message")
                    if not isinstance(message, str) or not message.strip():
                        continue
                    yield {
                        "role": role,
                        "text": message.strip(),
                        "timestamp": value.get("timestamp"),
                    }
    except tarfile.TarError as exc:
        raise BundleError("stored session archive is not a valid gzip tar archive") from exc


def read_archive_transcript(
    archive_path: Path,
    *,
    max_messages: int = 200,
) -> dict[str, Any]:
    """Return the latest bounded user/assistant messages from a stored archive."""

    max_messages = max(1, min(int(max_messages), 500))
    messages: list[dict[str, Any]] = []
    total_chars = 0
    for message in iter_archive_messages(archive_path):
        text = str(message["text"])[:_MAX_MESSAGE_CHARS]
        total_chars += len(text)
        messages.append({**message, "text": text})
        while len(messages) > max_messages or total_chars > _MAX_TRANSCRIPT_CHARS:
            removed = messages.pop(0)
            total_chars -= len(str(removed["text"]))
    return {
        "messages": messages,
        "message_count": len(messages),
        "truncated": total_chars >= _MAX_TRANSCRIPT_CHARS,
    }
