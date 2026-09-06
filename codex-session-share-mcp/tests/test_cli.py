from __future__ import annotations

from codex_session_share.cli import _build_parser, _print_result


def test_upload_parser_accepts_unique_shared_name() -> None:
    args = _build_parser().parse_args(
        [
            "upload",
            "--session-id",
            "019fb689-c996-7c71-ac58-8253c100adb7",
            "--name",
            "shared_session_123",
        ]
    )

    assert args.session_id == "019fb689-c996-7c71-ac58-8253c100adb7"
    assert args.name == "shared_session_123"


def test_upload_result_prints_shared_name_and_azure_file_url(capsys) -> None:
    azure_file_url = (
        "https://sessionstore.file.core.windows.net/session-data/"
        "sessions/shared_session_123/versions/version.tar.gz"
    )
    _print_result(
        {
            "session_id": "019fb689-c996-7c71-ac58-8253c100adb7",
            "session_name": "shared_session_123",
            "archive_sha256": "a" * 64,
            "archive_size_bytes": 123,
            "archive_path": None,
            "azure_file_url": azure_file_url,
            "stored": {
                "action": "created",
                "azure_file_url": azure_file_url,
            },
        },
        as_json=False,
    )

    output = capsys.readouterr().out
    assert "Shared name: shared_session_123" in output
    assert f"Azure file: {azure_file_url}" in output
