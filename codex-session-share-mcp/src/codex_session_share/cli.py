"""Local bridge that packages and restores Codex state around the remote MCP tools."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import anyio
import httpx
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.server import create_proxy

from .auth import (
    ApiKeyRegistry,
    AuthConfigurationError,
    AzureCliBearerAuth,
    AzureCliCredentialError,
    AzureCliTokenProvider,
    StaticBearerAuth,
)
from .bundle import (
    BundleError,
    build_session_bundle,
    extract_and_validate_bundle,
)
from .codex_store import derive_local_session_id, local_session_exists, restore_bundle
from .names import validate_shared_name


class BridgeError(RuntimeError):
    """Raised when the local bridge cannot complete a transfer."""


def _codex_home(value: str | None) -> Path:
    return Path(value or os.environ.get("CODEX_HOME", "~/.codex")).expanduser().resolve()


def _client_auth(args: argparse.Namespace) -> httpx.Auth:
    explicit_key = str(args.api_key or "").strip()
    resource = str(
        args.entra_resource
        or os.environ.get("CODEX_SESSION_SHARE_ENTRA_RESOURCE", "")
    ).strip()
    if resource and not explicit_key:
        tenant_id = str(
            args.entra_tenant_id
            or os.environ.get("CODEX_SESSION_SHARE_ENTRA_TENANT_ID", "")
        ).strip()
        return AzureCliBearerAuth(
            AzureCliTokenProvider(resource, tenant_id=tenant_id)
        )
    key = explicit_key or os.environ.get("CODEX_SESSION_SHARE_API_KEY", "").strip()
    if key:
        return StaticBearerAuth(key)
    raise BridgeError(
        "set CODEX_SESSION_SHARE_ENTRA_RESOURCE after `az login`, "
        "or provide the legacy --api-key option"
    )


def _mcp_url(value: str | None) -> str:
    url = (value or os.environ.get("CODEX_SESSION_SHARE_MCP_URL", "")).rstrip("/")
    if not url:
        raise BridgeError(
            "provide --server-url or set CODEX_SESSION_SHARE_MCP_URL"
        )
    if not url.endswith("/mcp"):
        url += "/mcp"
    return url


def _session_id(value: str | None) -> str:
    session_id = value or os.environ.get("CODEX_THREAD_ID", "")
    if not session_id:
        raise BridgeError(
            "provide --session-id; automatic detection requires CODEX_THREAD_ID"
        )
    return session_id


def _resolve_transfer_url(mcp_url: str, value: str) -> str:
    parsed = urlparse(mcp_url)
    origin = f"{parsed.scheme}://{parsed.netloc}/"
    return urljoin(origin, value)


def _tool_data(result: Any) -> dict[str, Any]:
    if isinstance(result.data, dict):
        return result.data
    if isinstance(result.structured_content, dict):
        return result.structured_content
    for block in result.content:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                return value
    raise BridgeError("MCP tool did not return structured transfer data")


async def _call_tool(
    mcp_url: str,
    auth: httpx.Auth,
    name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    async with Client(mcp_url, auth=auth, timeout=120) as client:
        result = await client.call_tool(name, arguments, timeout=120)
    return _tool_data(result)


async def _file_chunks(path: Path) -> AsyncIterator[bytes]:
    async with await anyio.open_file(path, "rb") as handle:
        while chunk := await handle.read(1024 * 1024):
            yield chunk


async def _upload_archive(
    url: str,
    auth: httpx.Auth,
    archive_path: Path,
    expected_size: int,
) -> dict[str, Any]:
    headers = {
        "Content-Type": "application/gzip",
        "Content-Length": str(expected_size),
    }
    timeout = httpx.Timeout(connect=30, read=1800, write=1800, pool=30)
    async with httpx.AsyncClient(
        auth=auth,
        timeout=timeout,
        follow_redirects=False,
    ) as client:
        response = await client.put(
            url,
            headers=headers,
            content=_file_chunks(archive_path),
        )
    if response.status_code not in {200, 201}:
        raise BridgeError(
            f"archive upload failed with HTTP {response.status_code}: {response.text[:500]}"
        )
    value = response.json()
    if not isinstance(value, dict):
        raise BridgeError("archive upload returned an invalid response")
    return value


async def _download_archive(
    url: str,
    auth: httpx.Auth,
    destination: Path,
    expected_size: int,
    expected_sha256: str,
) -> None:
    digest = hashlib.sha256()
    size = 0
    timeout = httpx.Timeout(connect=30, read=1800, write=30, pool=30)
    async with (
        httpx.AsyncClient(
            auth=auth,
            timeout=timeout,
            follow_redirects=False,
        ) as client,
        client.stream("GET", url) as response,
    ):
        if response.status_code != 200:
            body = (await response.aread()).decode("utf-8", errors="replace")
            raise BridgeError(
                f"archive download failed with HTTP {response.status_code}: {body[:500]}"
            )
        async with await anyio.open_file(destination, "wb") as handle:
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > expected_size:
                    raise BridgeError("downloaded archive exceeded the advertised size")
                digest.update(chunk)
                await handle.write(chunk)
    if size != expected_size:
        raise BridgeError(
            f"downloaded archive size mismatch: expected {expected_size}, received {size}"
        )
    if digest.hexdigest() != expected_sha256:
        raise BridgeError("downloaded archive SHA-256 mismatch")


def _compact_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    workspace = manifest.get("workspace") or {}
    return {
        "schema_version": manifest.get("schema_version"),
        "source_session_id": manifest.get("session_id"),
        "created_at": manifest.get("created_at"),
        "source": manifest.get("source") or {},
        "workspace": {
            "included": workspace.get("included"),
            "is_git": workspace.get("is_git"),
            "commit": workspace.get("commit"),
            "branch": workspace.get("branch"),
            "origin": workspace.get("origin"),
            "file_count": len(workspace.get("files") or []),
            "excluded_sensitive_file_count": len(
                workspace.get("excluded_sensitive_files") or []
            ),
            "git_bundle": workspace.get("git_bundle"),
        },
        "security": manifest.get("security") or {},
    }


async def _upload_command(args: argparse.Namespace) -> dict[str, Any]:
    session_id = _session_id(args.session_id)
    session_name = validate_shared_name(args.name) if args.name is not None else session_id
    codex_home = _codex_home(args.codex_home)
    auth = _client_auth(args)
    mcp_url = _mcp_url(args.server_url)
    workspace = Path(args.workspace).expanduser().resolve() if args.workspace else Path.cwd()

    temporary_context: tempfile.TemporaryDirectory[str] | None = None
    if args.output:
        archive_path = Path(args.output).expanduser().resolve()
    else:
        temporary_context = tempfile.TemporaryDirectory(prefix="codex-session-share-upload-")
        archive_path = Path(temporary_context.name) / f"{session_id}.tar.gz"
    try:
        build = await asyncio.to_thread(
            build_session_bundle,
            session_id,
            archive_path,
            codex_home=codex_home,
            workspace=workspace,
            include_workspace=not args.no_workspace,
            include_git_bundle=not args.no_git_bundle,
            include_sensitive_workspace_files=args.include_sensitive,
            max_input_bytes=args.max_input_bytes,
        )
        upload_arguments = {
            "session_id": session_id,
            "archive_sha256": build.archive_sha256,
            "archive_size_bytes": build.archive_size_bytes,
            "handoff_summary": build.handoff_summary,
            "manifest": _compact_manifest(build.manifest),
        }
        if args.name is not None:
            upload_arguments["name"] = session_name
        transfer = await _call_tool(
            mcp_url,
            auth,
            "upload_session",
            upload_arguments,
        )
        if transfer.get("status") != "upload_ready":
            raise BridgeError(f"upload_session did not return an upload ticket: {transfer}")
        upload_url = _resolve_transfer_url(mcp_url, str(transfer["upload"]["url"]))
        stored = await _upload_archive(
            upload_url,
            auth,
            build.archive_path,
            build.archive_size_bytes,
        )
        return {
            "session_id": session_id,
            "session_name": session_name,
            "archive_sha256": build.archive_sha256,
            "archive_size_bytes": build.archive_size_bytes,
            "azure_file_url": stored.get("azure_file_url"),
            "stored": stored,
            "archive_path": str(build.archive_path) if args.output else None,
        }
    finally:
        if temporary_context is not None:
            temporary_context.cleanup()


async def _download_command(args: argparse.Namespace) -> dict[str, Any]:
    session_name = _session_id(args.session_id)
    codex_home = _codex_home(args.codex_home)
    auth = _client_auth(args)
    mcp_url = _mcp_url(args.server_url)
    transfer = await _call_tool(
        mcp_url,
        auth,
        "download_session",
        {"session_id": session_name},
    )
    if transfer.get("status") != "download_ready":
        raise BridgeError(f"download_session did not return a download ticket: {transfer}")

    expected_size = int(transfer["archive_size_bytes"])
    expected_sha256 = str(transfer["archive_sha256"])
    current_thread_id = os.environ.get("CODEX_THREAD_ID")
    if args.workspace:
        target_workspace = Path(args.workspace).expanduser().resolve()
    elif current_thread_id:
        target_workspace = Path.cwd().resolve()
    else:
        target_workspace = (Path.cwd() / f"shared-session-{session_name}").resolve()

    imports_root = codex_home / "imports" / session_name
    imports_root.mkdir(parents=True, exist_ok=True)
    archive_path = imports_root / "bundle.tar.gz"
    temporary_archive = archive_path.with_name(".bundle.download.tmp")
    download_url = _resolve_transfer_url(mcp_url, str(transfer["download"]["url"]))
    await _download_archive(
        download_url,
        auth,
        temporary_archive,
        expected_size,
        expected_sha256,
    )
    os.replace(temporary_archive, archive_path)

    with tempfile.TemporaryDirectory(prefix="codex-session-share-extract-") as temporary:
        extracted = Path(temporary)
        manifest = await asyncio.to_thread(
            extract_and_validate_bundle,
            archive_path,
            extracted,
        )
        install_native = not args.no_native
        source_session_id = str(
            transfer.get("source_session_id")
            or manifest.get("session_id")
            or session_name
        )
        if args.preserve_session_id:
            local_session_id = source_session_id
        elif args.new_copy:
            local_session_id = str(uuid.uuid4())
        else:
            local_session_id = derive_local_session_id(
                codex_home,
                source_session_id,
                mcp_url,
            )
        active_codex_home = _codex_home(None)
        if (
            current_thread_id == local_session_id
            and codex_home == active_codex_home
            and install_native
        ):
            install_native = False
        restored = await asyncio.to_thread(
            restore_bundle,
            extracted,
            manifest,
            target_codex_home=codex_home,
            target_workspace=target_workspace,
            replace_workspace=args.replace_workspace,
            install_native_session=install_native,
            local_session_id=local_session_id,
            import_name=session_name,
        )

    legacy_source_present = (
        restored.source_session_id != restored.session_id
        and local_session_exists(codex_home, restored.source_session_id)
    )
    legacy_source_deleted = False
    if args.delete_legacy_source_id and legacy_source_present:
        if current_thread_id == restored.source_session_id:
            raise BridgeError(
                "cannot delete the legacy source-ID thread while it is the current active "
                "session; run the printed cleanup command from another task"
            )
        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(codex_home)
        completed = await asyncio.to_thread(
            subprocess.run,
            ["codex", "delete", "--force", restored.source_session_id],
            env=environment,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            raise BridgeError(
                "local clone was installed, but deleting the legacy source-ID thread failed: "
                + (completed.stderr.strip() or completed.stdout.strip())
            )
        legacy_source_deleted = True
        legacy_source_present = False

    result = {
        "session_name": session_name,
        "session_id": restored.session_id,
        "local_session_id": restored.session_id,
        "source_session_id": restored.source_session_id,
        "archive_path": str(archive_path),
        "workspace_path": str(restored.workspace_path),
        "rollout_path": str(restored.rollout_path) if install_native else None,
        "handoff_path": str(restored.handoff_path),
        "transcript_path": str(restored.transcript_path),
        "native_session_installed": install_native,
        "resume_command": restored.resume_command if install_native else None,
        "backup_path": str(restored.backup_path) if restored.backup_path else None,
        "handoff_summary": transfer.get("handoff_summary") or "",
        "legacy_source_present": legacy_source_present,
        "legacy_source_deleted": legacy_source_deleted,
        "legacy_cleanup_command": (
            f"CODEX_HOME={codex_home} codex delete --force {restored.source_session_id}"
            if legacy_source_present
            else None
        ),
    }
    return result


async def _rename_command(args: argparse.Namespace) -> dict[str, Any]:
    auth = _client_auth(args)
    mcp_url = _mcp_url(args.server_url)
    return await _call_tool(
        mcp_url,
        auth,
        "rename_session",
        {
            "original_name": args.original_name,
            "new_name": args.new_name,
        },
    )


def _proxy_command(args: argparse.Namespace) -> None:
    """Expose the remote Entra-protected MCP server as a local stdio server."""

    transport = StreamableHttpTransport(
        _mcp_url(args.server_url),
        auth=_client_auth(args),
    )
    client = Client(transport, timeout=120)
    proxy = create_proxy(client, name="Codex Session Share")
    proxy.run(transport="stdio", show_banner=False)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codex-session-share",
        description="Package and restore Codex sessions through the session-share MCP server.",
    )
    parser.add_argument(
        "--server-url",
        help="MCP URL or server base URL; defaults to CODEX_SESSION_SHARE_MCP_URL.",
    )
    parser.add_argument(
        "--api-key",
        help="Legacy API key fallback; defaults to CODEX_SESSION_SHARE_API_KEY.",
    )
    parser.add_argument(
        "--entra-resource",
        help=(
            "Entra API resource, such as api://APP_ID; defaults to "
            "CODEX_SESSION_SHARE_ENTRA_RESOURCE."
        ),
    )
    parser.add_argument(
        "--entra-tenant-id",
        help=(
            "Expected Entra tenant; defaults to CODEX_SESSION_SHARE_ENTRA_TENANT_ID."
        ),
    )
    parser.add_argument(
        "--codex-home",
        help="Target/source Codex home; defaults to CODEX_HOME or ~/.codex.",
    )
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    hash_key = subparsers.add_parser(
        "hash-key",
        help="Hash an API key for SESSION_SHARE_API_KEY_SHA256.",
    )
    hash_key.add_argument("key", nargs="?", help="Raw key; read stdin when omitted.")

    upload = subparsers.add_parser("upload", help="Upload the current or named Codex session.")
    upload.add_argument("--session-id")
    upload.add_argument(
        "--name",
        help=(
            "Create the remote share with this unique name. "
            "Allowed characters: A-Z, a-z, 0-9, and underscore."
        ),
    )
    upload.add_argument("--workspace")
    upload.add_argument("--output", help="Keep a copy of the generated archive at this path.")
    upload.add_argument("--no-workspace", action="store_true")
    upload.add_argument("--no-git-bundle", action="store_true")
    upload.add_argument(
        "--include-sensitive",
        action="store_true",
        help="Include normally excluded .env/key/credential-like workspace files.",
    )
    upload.add_argument(
        "--max-input-bytes",
        type=int,
        default=2 * 1024 * 1024 * 1024,
    )

    download = subparsers.add_parser("download", help="Download and restore a session ID.")
    download.add_argument("session_id")
    download.add_argument("--workspace")
    download.add_argument(
        "--replace-workspace",
        action="store_true",
        help="Remove target workspace files except .git before restoring.",
    )
    download.add_argument(
        "--no-native",
        action="store_true",
        help="Restore handoff/workspace files without registering a resumable Codex thread.",
    )
    identity = download.add_mutually_exclusive_group()
    identity.add_argument(
        "--preserve-session-id",
        action="store_true",
        help=(
            "Register the source session ID locally. This can collide across connected machines; "
            "the default creates a stable machine-local clone ID."
        ),
    )
    identity.add_argument(
        "--new-copy",
        action="store_true",
        help="Generate a fresh local clone ID instead of reusing this machine's stable clone.",
    )
    download.add_argument(
        "--delete-legacy-source-id",
        action="store_true",
        help=(
            "After installing the machine-local clone, delete an older local import that used "
            "the source UUID. Run this only on the receiving machine."
        ),
    )
    rename = subparsers.add_parser("rename", help="Rename a remotely stored session.")
    rename.add_argument("original_name")
    rename.add_argument("new_name")
    subparsers.add_parser(
        "proxy",
        help=(
            "Run a local stdio MCP proxy that authenticates the remote server "
            "with the current Azure CLI login."
        ),
    )
    return parser


def _print_result(result: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
        return
    if result.get("status") == "renamed":
        print(f"Renamed: {result['original_name']} -> {result['new_name']}")
        print(f"Storage path: {result['storage_path']}")
        if result.get("azure_file_url"):
            print(f"Azure file: {result['azure_file_url']}")
        return
    print(f"Session: {result['session_id']}")
    if result.get("source_session_id") and result["source_session_id"] != result["session_id"]:
        print(f"Source session: {result['source_session_id']}")
    if result.get("session_name") and result["session_name"] != result["session_id"]:
        print(f"Shared name: {result['session_name']}")
    if "stored" in result:
        stored = result["stored"]
        print(f"Upload: {stored.get('action', 'stored')}")
        print(f"Archive: {result['archive_size_bytes']} bytes, {result['archive_sha256']}")
        azure_file_url = result.get("azure_file_url") or stored.get("azure_file_url")
        if azure_file_url:
            print(f"Azure file: {azure_file_url}")
        if result.get("archive_path"):
            print(f"Local archive: {result['archive_path']}")
        return
    print(f"Workspace: {result['workspace_path']}")
    print(f"Handoff: {result['handoff_path']}")
    print(f"Transcript: {result['transcript_path']}")
    if result.get("native_session_installed"):
        print(f"Resume: {result['resume_command']}")
    else:
        print("Native session registration skipped; handoff is loaded through this command output.")
    if result.get("backup_path"):
        print(f"Existing local session backup: {result['backup_path']}")
    if result.get("legacy_source_present"):
        print(
            "Warning: an older local import still uses the source session ID. "
            "After verifying the clone, remove it from this receiving machine:"
        )
        print(result["legacy_cleanup_command"])
    handoff = str(result.get("handoff_summary") or "").strip()
    if handoff:
        print("\n--- Shared session handoff ---\n")
        print(handoff)


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    try:
        if args.command == "hash-key":
            raw_key = args.key if args.key is not None else sys.stdin.readline().rstrip("\n")
            if not raw_key:
                raise BridgeError("API key cannot be empty")
            print(ApiKeyRegistry.hash_key(raw_key))
            return
        if args.command == "proxy":
            _proxy_command(args)
            return
        if args.command == "upload":
            result = asyncio.run(_upload_command(args))
        elif args.command == "download":
            result = asyncio.run(_download_command(args))
        elif args.command == "rename":
            result = asyncio.run(_rename_command(args))
        else:
            parser.error(f"unsupported command: {args.command}")
            return
        _print_result(result, as_json=args.json)
    except (
        AuthConfigurationError,
        AzureCliCredentialError,
        BridgeError,
        BundleError,
        OSError,
        ValueError,
        httpx.HTTPError,
    ) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
