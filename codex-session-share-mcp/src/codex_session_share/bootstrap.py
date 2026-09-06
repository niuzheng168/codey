"""Zero-install client for shared sessions and private Codex configuration sync."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from .bundle import BundleError, extract_and_validate_bundle
from .codex_store import derive_local_session_id, restore_bundle
from .config_sync import (
    ConfigSyncError,
    build_config_bundle,
    extract_config_bundle,
    restore_config_bundle,
)
from .names import validate_config_profile, validate_session_name


class BootstrapError(RuntimeError):
    """Raised when the zero-install download cannot complete."""


def _codex_home(value: str | None) -> Path:
    return Path(value or os.environ.get("CODEX_HOME", "~/.codex")).expanduser().resolve()


def _target_workspace(value: str | None, session_name: str) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    if os.environ.get("CODEX_THREAD_ID"):
        return Path.cwd().resolve()
    return (Path.cwd() / f"shared-session-{session_name}").resolve()


def _azure_cli_token(resource: str, tenant_id: str) -> str:
    override = os.environ.get("CODEX_SESSION_SHARE_ACCESS_TOKEN", "").strip()
    if override:
        return override
    try:
        completed = subprocess.run(
            [
                "az.cmd" if os.name == "nt" else "az",
                "account",
                "get-access-token",
                "--resource",
                resource,
                "--tenant",
                tenant_id,
                "--output",
                "json",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except FileNotFoundError as exc:
        raise BootstrapError("Azure CLI is not installed or is not on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise BootstrapError("Azure CLI token acquisition timed out") from exc
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise BootstrapError(
            "unable to obtain an Entra token from Azure CLI; run `az login` first"
            + (f": {detail}" if detail else "")
        )
    try:
        payload = json.loads(completed.stdout)
        token = str(payload["accessToken"]).strip()
        actual_tenant = str(payload["tenant"]).strip().lower()
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise BootstrapError("Azure CLI returned an invalid access-token response") from exc
    if not token:
        raise BootstrapError("Azure CLI returned an empty access token")
    if tenant_id and actual_tenant != tenant_id.strip().lower():
        raise BootstrapError(
            f"Azure CLI is logged into tenant {actual_tenant}, expected {tenant_id}"
        )
    return token


def _required(value: Any, *, field: str) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        raise BootstrapError(f"{field} is required")
    return value


def _current_platform() -> str:
    name = platform.system().lower()
    if name == "darwin":
        return "macos"
    if name == "windows":
        return "windows"
    return "linux"


def _json_request(
    url: str,
    *,
    token: str,
    method: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "codex-session-share-bootstrap",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise BootstrapError(
            f"config sync request failed with HTTP {exc.code}: {detail}"
        ) from exc
    except json.JSONDecodeError as exc:
        raise BootstrapError("config sync server returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise BootstrapError("config sync server returned an invalid response")
    return value


def _upload_archive(url: str, archive_path: Path, *, token: str) -> dict[str, Any]:
    content = archive_path.read_bytes()
    request = urllib.request.Request(
        url,
        data=content,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/gzip",
            "Content-Length": str(len(content)),
            "Accept": "application/json",
            "User-Agent": "codex-session-share-bootstrap",
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(request, timeout=1800) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise BootstrapError(
            f"config archive upload failed with HTTP {exc.code}: {detail}"
        ) from exc
    except json.JSONDecodeError as exc:
        raise BootstrapError("config archive upload returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise BootstrapError("config archive upload returned an invalid response")
    return value


def _download_archive(
    url: str,
    destination: Path,
    *,
    token: str,
    expected_size: int,
    expected_sha256: str,
) -> None:
    temporary = destination.with_name(f".{destination.name}.download.tmp")
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "codex-session-share-bootstrap",
        },
    )
    digest = hashlib.sha256()
    size = 0
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with (
            urllib.request.urlopen(request, timeout=1800) as response,
            temporary.open("wb") as output,
        ):
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > expected_size:
                    raise BootstrapError(
                        "downloaded archive exceeded the advertised size"
                    )
                digest.update(chunk)
                output.write(chunk)
        if size != expected_size:
            raise BootstrapError(
                f"downloaded archive size mismatch: expected {expected_size}, received {size}"
            )
        if digest.hexdigest() != expected_sha256:
            raise BootstrapError("downloaded archive SHA-256 mismatch")
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _restore_download(args: argparse.Namespace) -> dict[str, Any]:
    session_name = validate_session_name(
        str(_required(args.session_name, field="session-name"))
    )
    source_session_id = validate_session_name(
        str(_required(args.source_session_id, field="source-session-id"))
    )
    codex_home = _codex_home(args.codex_home)
    target_workspace = _target_workspace(args.workspace, session_name)
    archive_path = codex_home / "imports" / session_name / "bundle.tar.gz"
    token = _azure_cli_token(
        str(_required(args.entra_resource, field="entra-resource")),
        str(_required(args.entra_tenant_id, field="entra-tenant-id")),
    )
    _download_archive(
        str(_required(args.download_url, field="download-url")),
        archive_path,
        token=token,
        expected_size=int(_required(args.archive_size_bytes, field="archive-size-bytes")),
        expected_sha256=str(_required(args.archive_sha256, field="archive-sha256")),
    )

    with tempfile.TemporaryDirectory(prefix="codex-session-share-extract-") as temporary:
        extracted = Path(temporary)
        manifest = extract_and_validate_bundle(archive_path, extracted)
        source_session_id = str(manifest.get("session_id") or source_session_id)
        if args.preserve_session_id:
            local_session_id = source_session_id
        elif args.new_copy:
            local_session_id = str(uuid.uuid4())
        else:
            local_session_id = derive_local_session_id(
                codex_home,
                source_session_id,
                args.share_origin,
            )
        install_native = not (
            os.environ.get("CODEX_THREAD_ID") == local_session_id
            and codex_home == _codex_home(None)
        )
        restored = restore_bundle(
            extracted,
            manifest,
            target_codex_home=codex_home,
            target_workspace=target_workspace,
            replace_workspace=args.replace_workspace,
            install_native_session=install_native,
            local_session_id=local_session_id,
            import_name=session_name,
        )

    return {
        "operation": "session-download",
        "session_name": session_name,
        "session_id": restored.session_id,
        "source_session_id": restored.source_session_id,
        "archive_path": str(archive_path),
        "workspace_path": str(restored.workspace_path),
        "rollout_path": str(restored.rollout_path) if install_native else None,
        "handoff_path": str(restored.handoff_path),
        "transcript_path": str(restored.transcript_path),
        "native_session_installed": install_native,
        "resume_command": restored.resume_command if install_native else None,
        "backup_path": str(restored.backup_path) if restored.backup_path else None,
    }


def _compact_config_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        key: manifest[key]
        for key in (
            "schema_version",
            "bundle_type",
            "profile",
            "created_at",
            "source",
            "options",
            "security",
            "summary",
            "warnings",
        )
        if key in manifest
    }


def _config_upload(args: argparse.Namespace) -> dict[str, Any]:
    profile = validate_config_profile(str(_required(args.profile, field="profile")))
    codex_home = _codex_home(args.codex_home)
    user_home = Path(args.user_home or Path.home()).expanduser().resolve()
    token = _azure_cli_token(
        str(_required(args.entra_resource, field="entra-resource")),
        str(_required(args.entra_tenant_id, field="entra-tenant-id")),
    )
    with tempfile.TemporaryDirectory(prefix="codex-config-sync-upload-") as temporary:
        archive_path = Path(temporary) / f"{profile}.tar.gz"
        built = build_config_bundle(
            profile,
            archive_path,
            codex_home=codex_home,
            user_home=user_home,
            include_app_state=args.include_app_state,
            include_ssh_config=args.include_ssh_config,
            include_automations=args.include_automations,
            include_memories=args.include_memories,
            include_customizations=args.include_customizations,
        )
        reservation = _json_request(
            str(_required(args.config_upload_url, field="config-upload-url")),
            token=token,
            method="POST",
            payload={
                "profile": profile,
                "archive_sha256": built.archive_sha256,
                "archive_size_bytes": built.archive_size_bytes,
                "manifest": _compact_config_manifest(built.manifest),
            },
        )
        upload = reservation.get("upload")
        if not isinstance(upload, dict) or not upload.get("url"):
            raise BootstrapError("config sync server did not return an upload URL")
        upload_url = urllib.parse.urljoin(
            str(args.config_upload_url),
            str(upload["url"]),
        )
        stored = _upload_archive(upload_url, built.archive_path, token=token)
    return {
        "operation": "config-upload",
        "status": stored.get("status") or "stored",
        "action": stored.get("action"),
        "profile": profile,
        "archive_size_bytes": built.archive_size_bytes,
        "file_count": (built.manifest.get("summary") or {}).get("file_count"),
        "redactions": (built.manifest.get("security") or {}).get("redactions") or [],
        "warnings": built.manifest.get("warnings") or [],
        "uploaded_at": stored.get("uploaded_at"),
    }


def _config_download(args: argparse.Namespace) -> dict[str, Any]:
    profile = validate_config_profile(str(_required(args.profile, field="profile")))
    codex_home = _codex_home(args.codex_home)
    user_home = Path(args.user_home or Path.home()).expanduser().resolve()
    target_platform = args.client_platform or _current_platform()
    token = _azure_cli_token(
        str(_required(args.entra_resource, field="entra-resource")),
        str(_required(args.entra_tenant_id, field="entra-tenant-id")),
    )
    with tempfile.TemporaryDirectory(prefix="codex-config-sync-download-") as temporary:
        temporary_root = Path(temporary)
        archive_path = temporary_root / f"{profile}.tar.gz"
        extracted = temporary_root / "extracted"
        _download_archive(
            str(_required(args.download_url, field="download-url")),
            archive_path,
            token=token,
            expected_size=int(
                _required(args.archive_size_bytes, field="archive-size-bytes")
            ),
            expected_sha256=str(
                _required(args.archive_sha256, field="archive-sha256")
            ),
        )
        manifest = extract_config_bundle(archive_path, extracted)
        restored = restore_config_bundle(
            extracted,
            manifest,
            target_codex_home=codex_home,
            target_user_home=user_home,
            target_platform=target_platform,
            apply_app_state=args.apply_app_state,
            activate_automations=args.activate_automations,
        )
    return {
        "operation": "config-download",
        "status": "restored",
        "profile": restored.profile,
        "restored_files": list(restored.restored_files),
        "backup_path": str(restored.backup_path) if restored.backup_path else None,
        "staged_app_state": (
            str(restored.staged_app_state) if restored.staged_app_state else None
        ),
        "applied_app_state": restored.applied_app_state,
        "warnings": list(restored.warnings),
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codex-session-share-bootstrap",
        description=(
            "Transfer a shared Codex session or private Codex configuration without "
            "installing a package."
        ),
    )
    parser.add_argument(
        "--operation",
        choices=("session-download", "config-upload", "config-download"),
        default="session-download",
    )
    parser.add_argument("--session-name")
    parser.add_argument("--source-session-id")
    parser.add_argument("--share-origin")
    parser.add_argument("--download-url")
    parser.add_argument("--archive-sha256")
    parser.add_argument("--archive-size-bytes", type=int)
    parser.add_argument("--entra-resource")
    parser.add_argument("--entra-tenant-id")
    parser.add_argument("--codex-home")
    parser.add_argument("--workspace")
    parser.add_argument("--replace-workspace", action="store_true")
    identity = parser.add_mutually_exclusive_group()
    identity.add_argument("--preserve-session-id", action="store_true")
    identity.add_argument("--new-copy", action="store_true")
    parser.add_argument("--profile")
    parser.add_argument("--config-upload-url")
    parser.add_argument("--user-home")
    parser.add_argument(
        "--client-platform",
        choices=("windows", "macos", "linux"),
    )
    parser.add_argument(
        "--include-app-state",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--include-ssh-config",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--include-automations",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--include-memories",
        action=argparse.BooleanOptionalAction,
        default=False,
    )
    parser.add_argument(
        "--include-customizations",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--apply-app-state", action="store_true")
    parser.add_argument("--activate-automations", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser


def _print_result(result: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, indent=2, sort_keys=True))
        return
    operation = result.get("operation")
    if operation == "config-upload":
        print(f"Config profile uploaded: {result['profile']}")
        print(f"Archive size: {result['archive_size_bytes']} bytes")
        print(f"Files: {result.get('file_count') or 0}")
        if result.get("redactions"):
            print(f"Credential-like values redacted: {len(result['redactions'])}")
        for warning in result.get("warnings") or []:
            print(f"Warning: {warning}")
        return
    if operation == "config-download":
        print(f"Config profile restored: {result['profile']}")
        print(f"Files restored: {len(result.get('restored_files') or [])}")
        if result.get("backup_path"):
            print(f"Backup: {result['backup_path']}")
        if result.get("staged_app_state"):
            print(f"Pending app state: {result['staged_app_state']}")
        for warning in result.get("warnings") or []:
            print(f"Warning: {warning}")
        return
    print(f"Session: {result['session_id']}")
    if result["source_session_id"] != result["session_id"]:
        print(f"Source session: {result['source_session_id']}")
    print(f"Workspace: {result['workspace_path']}")
    print(f"Handoff: {result['handoff_path']}")
    print(f"Transcript: {result['transcript_path']}")
    if result["native_session_installed"]:
        print(f"Resume: {result['resume_command']}")
    else:
        print("Native session registration skipped for the active task.")
    if result.get("backup_path"):
        print(f"Existing local session backup: {result['backup_path']}")


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    try:
        if args.operation == "config-upload":
            result = _config_upload(args)
        elif args.operation == "config-download":
            result = _config_download(args)
        else:
            result = _restore_download(args)
        _print_result(result, as_json=args.json)
    except (
        BootstrapError,
        BundleError,
        ConfigSyncError,
        OSError,
        ValueError,
        urllib.error.URLError,
    ) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
