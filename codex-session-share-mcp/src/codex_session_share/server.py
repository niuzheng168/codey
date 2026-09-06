"""FastMCP server and authenticated binary transfer endpoints."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import os
import re
import secrets
import shlex
import time
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

import anyio
import uvicorn
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.auth import AccessToken, AuthProvider
from fastmcp.server.dependencies import get_access_token
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route

from . import __version__
from .auth import (
    ApiKeyRegistry,
    AuthenticationError,
    AuthorizationError,
    HashedApiKeyVerifier,
    authorize_entra_access_token,
    create_entra_oauth_provider,
    entra_user_email,
    require_entra_role,
)
from .bootstrap_archive import build_bootstrap_zipapp
from .bundle import BundleError
from .config_storage import (
    ConfigPendingUploadNotFoundError,
    ConfigProfileNotFoundError,
    ConfigStore,
    config_lease_name,
)
from .config_sync import DEFAULT_MAX_CONFIG_INPUT_BYTES
from .coordination import (
    FileLeaseCoordinator,
    LeaseNotActiveError,
    SessionBusyError,
)
from .history import read_archive_transcript
from .names import (
    validate_config_profile,
    validate_session_name,
    validate_shared_name,
)
from .semantic_search import SearchOperationError, SemanticSearchClient
from .storage import (
    PendingUploadNotFoundError,
    SessionAlreadyExistsError,
    SessionNotFoundError,
    SessionStore,
)
from .tickets import TicketError, TicketSigner

_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_MAX_METADATA_BYTES = 64 * 1024
_MAX_HANDOFF_CHARS = 64 * 1024
_AUTH_MODE_API_KEY = "api-key"
_AUTH_MODE_ENTRA = "entra"
_BOOTSTRAP_PATH = "/v1/client/codex-session-share.pyz"
_BOOTSTRAP_LOADER = (
    "import atexit,hashlib,os,shutil,subprocess,sys,tempfile,urllib.request;"
    "d=tempfile.mkdtemp(prefix='codex-session-share-');"
    "atexit.register(shutil.rmtree,d,True);"
    "p=os.path.join(d,'download.pyz');"
    "urllib.request.urlretrieve(sys.argv[1],p);"
    "h=hashlib.sha256(open(p,'rb').read()).hexdigest();"
    "sys.exit('bootstrap checksum mismatch') if h!=sys.argv[2] else None;"
    "raise SystemExit(subprocess.call([sys.executable,p,*sys.argv[3:]]))"
)
_LOGGER = logging.getLogger(__name__)


def _environment_flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be true or false")


@dataclass(frozen=True)
class ServerSettings:
    """Runtime settings for the MCP service."""

    data_dir: Path
    signing_key: bytes
    auth_mode: str = _AUTH_MODE_ENTRA
    api_keys: ApiKeyRegistry | None = None
    auth_provider: AuthProvider | None = None
    semantic_search_client: SemanticSearchClient | None = None
    entra_tenant_id: str = ""
    entra_app_id: str = ""
    entra_client_secret: str = ""
    entra_private_key: str = ""
    entra_cert_thumbprint_sha256: str = ""
    entra_cert_thumbprint_sha1: str = ""
    managed_identity_client_id: str = ""
    required_role: str = "SessionShare.Contributor"
    admin_role: str = "SessionShare.Admin"
    required_scope: str = "access_as_user"
    accept_azure_cli_tokens: bool = True
    trusted_app_client_ids: tuple[str, ...] = ()
    max_archive_bytes: int = 2 * 1024 * 1024 * 1024
    ticket_ttl_seconds: int = 300
    public_base_url: str = ""
    azure_file_base_url: str = ""
    port: int = 8000

    @classmethod
    def from_environment(cls) -> ServerSettings:
        signing_value = os.environ.get("SESSION_SHARE_SIGNING_KEY", "")
        if len(signing_value.encode("utf-8")) < 32:
            raise RuntimeError("SESSION_SHARE_SIGNING_KEY must contain at least 32 bytes")
        auth_mode = os.environ.get("SESSION_SHARE_AUTH_MODE", "").strip().lower()
        if not auth_mode:
            auth_mode = (
                _AUTH_MODE_ENTRA
                if os.environ.get("SESSION_SHARE_ENTRA_TENANT_ID", "").strip()
                else _AUTH_MODE_API_KEY
            )
        if auth_mode == "entra-easyauth":
            auth_mode = _AUTH_MODE_ENTRA
        if auth_mode not in {_AUTH_MODE_API_KEY, _AUTH_MODE_ENTRA}:
            raise RuntimeError(
                "SESSION_SHARE_AUTH_MODE must be 'entra' or 'api-key'"
            )
        api_keys = ApiKeyRegistry.from_environment() if auth_mode == _AUTH_MODE_API_KEY else None
        entra_tenant_id = os.environ.get("SESSION_SHARE_ENTRA_TENANT_ID", "").strip()
        entra_app_id = os.environ.get("SESSION_SHARE_ENTRA_APP_ID", "").strip()
        entra_client_secret = os.environ.get(
            "SESSION_SHARE_ENTRA_CLIENT_SECRET", ""
        ).strip()
        encoded_private_key = os.environ.get(
            "SESSION_SHARE_ENTRA_PRIVATE_KEY_B64", ""
        ).strip()
        try:
            entra_private_key = (
                base64.b64decode(encoded_private_key, validate=True).decode("utf-8")
                if encoded_private_key
                else ""
            )
        except (binascii.Error, UnicodeDecodeError) as exc:
            raise RuntimeError(
                "SESSION_SHARE_ENTRA_PRIVATE_KEY_B64 must be base64-encoded PEM"
            ) from exc
        entra_cert_thumbprint_sha256 = os.environ.get(
            "SESSION_SHARE_ENTRA_CERT_THUMBPRINT_SHA256", ""
        ).strip()
        entra_cert_thumbprint_sha1 = os.environ.get(
            "SESSION_SHARE_ENTRA_CERT_THUMBPRINT_SHA1", ""
        ).strip()
        managed_identity_client_id = os.environ.get(
            "SESSION_SHARE_MANAGED_IDENTITY_CLIENT_ID", ""
        ).strip()
        required_role = (
            os.environ.get("SESSION_SHARE_REQUIRED_ROLE", "").strip()
            or "SessionShare.Contributor"
        )
        admin_role = (
            os.environ.get("SESSION_SHARE_ADMIN_ROLE", "").strip()
            or "SessionShare.Admin"
        )
        required_scope = (
            os.environ.get("SESSION_SHARE_REQUIRED_SCOPE", "").strip()
            or "access_as_user"
        )
        public_base_url = os.environ.get("SESSION_SHARE_PUBLIC_BASE_URL", "").rstrip("/")
        if auth_mode == _AUTH_MODE_ENTRA:
            missing = [
                name
                for name, value in (
                    ("SESSION_SHARE_ENTRA_TENANT_ID", entra_tenant_id),
                    ("SESSION_SHARE_ENTRA_APP_ID", entra_app_id),
                    ("SESSION_SHARE_PUBLIC_BASE_URL", public_base_url),
                )
                if not value
            ]
            if missing:
                raise RuntimeError(f"{', '.join(missing)} must be configured")
            if (
                not entra_client_secret
                and not (entra_private_key and entra_cert_thumbprint_sha256)
                and not managed_identity_client_id
            ):
                raise RuntimeError(
                    "configure an Entra client secret, certificate, or managed identity"
                )
        return cls(
            data_dir=Path(os.environ.get("SESSION_SHARE_DATA_DIR", "/data")),
            signing_key=signing_value.encode("utf-8"),
            auth_mode=auth_mode,
            api_keys=api_keys,
            entra_tenant_id=entra_tenant_id,
            entra_app_id=entra_app_id,
            entra_client_secret=entra_client_secret,
            entra_private_key=entra_private_key,
            entra_cert_thumbprint_sha256=entra_cert_thumbprint_sha256,
            entra_cert_thumbprint_sha1=entra_cert_thumbprint_sha1,
            managed_identity_client_id=managed_identity_client_id,
            required_role=required_role,
            admin_role=admin_role,
            required_scope=required_scope,
            accept_azure_cli_tokens=_environment_flag(
                "SESSION_SHARE_ACCEPT_AZURE_CLI_TOKENS", True
            ),
            trusted_app_client_ids=tuple(
                value.strip().lower()
                for value in os.environ.get(
                    "SESSION_SHARE_TRUSTED_APP_CLIENT_IDS", ""
                ).split(",")
                if value.strip()
            ),
            max_archive_bytes=int(
                os.environ.get("SESSION_SHARE_MAX_ARCHIVE_BYTES", str(2 * 1024**3))
            ),
            ticket_ttl_seconds=int(os.environ.get("SESSION_SHARE_TICKET_TTL_SECONDS", "300")),
            public_base_url=public_base_url,
            azure_file_base_url=os.environ.get(
                "SESSION_SHARE_AZURE_FILE_BASE_URL", ""
            ).rstrip("/"),
            port=int(os.environ.get("PORT", "8000")),
        )


def _validate_session_id(session_id: str) -> str:
    try:
        return validate_session_name(session_id)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc


def _validate_shared_name(name: str) -> str:
    try:
        return validate_shared_name(name)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc


def _transfer_location(settings: ServerSettings, path: str) -> str:
    if settings.public_base_url:
        return f"{settings.public_base_url}{path}"
    return path


def _azure_file_url(
    settings: ServerSettings,
    metadata: dict[str, Any],
) -> str | None:
    archive_path = str(metadata.get("archive_path") or "")
    if not archive_path and metadata.get("storage_path") and metadata.get("version_id"):
        archive_path = (
            f"{metadata['storage_path']}/versions/{metadata['version_id']}.tar.gz"
        )
    if not settings.azure_file_base_url or not archive_path:
        return None
    encoded_path = "/".join(quote(part, safe="") for part in archive_path.split("/"))
    return f"{settings.azure_file_base_url}/{encoded_path}"


def _optional_local_path(value: str | None, *, field: str) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        raise ToolError(f"{field} cannot be empty")
    if "\x00" in value or len(value) > 4096:
        raise ToolError(f"{field} is invalid")
    return value


def _validate_client_platform(value: str) -> Literal["windows", "macos", "linux"]:
    if value not in {"windows", "macos", "linux"}:
        raise ToolError("client_platform must be windows, macos, or linux")
    return value  # type: ignore[return-value]


def _powershell_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _zero_install_execution(
    settings: ServerSettings,
    *,
    arguments: list[str],
    client_platform: Literal["windows", "macos", "linux"],
    message: str,
) -> dict[str, Any] | None:
    if (
        settings.auth_mode != _AUTH_MODE_ENTRA
        or not settings.public_base_url
        or not settings.entra_app_id
        or not settings.entra_tenant_id
    ):
        return None
    bootstrap_url = (
        f"{settings.public_base_url}{_BOOTSTRAP_PATH}?version={__version__}"
    )
    bootstrap_sha256 = hashlib.sha256(build_bootstrap_zipapp()).hexdigest()
    python_executable = "python" if client_platform == "windows" else "python3"
    argv = [
        python_executable,
        "-c",
        _BOOTSTRAP_LOADER,
        bootstrap_url,
        bootstrap_sha256,
        *arguments,
    ]
    if client_platform == "windows":
        command = "& " + " ".join(_powershell_quote(item) for item in argv)
        shell = "powershell"
    else:
        command = shlex.join(argv)
        shell = "bash"
    return {
        "command": command,
        "argv": argv,
        "shell": shell,
        "client_platform": client_platform,
        "bootstrap_url": bootstrap_url,
        "bootstrap_sha256": bootstrap_sha256,
        "arguments": arguments,
        "requires": [
            f"{python_executable} (Python 3.11 or newer)",
            "Azure CLI authenticated with `az login`",
        ],
        "message": message,
    }


def _zero_install_download(
    settings: ServerSettings,
    *,
    session_name: str,
    source_session_id: str,
    download_url: str,
    archive_sha256: str,
    archive_size_bytes: int,
    workspace: str | None,
    codex_home: str | None,
    new_copy: bool,
    client_platform: Literal["windows", "macos", "linux"],
) -> dict[str, Any] | None:
    arguments = [
        f"--session-name={session_name}",
        f"--source-session-id={source_session_id}",
        f"--share-origin={settings.public_base_url}/mcp",
        f"--download-url={download_url}",
        f"--archive-sha256={archive_sha256}",
        f"--archive-size-bytes={archive_size_bytes}",
        f"--entra-resource=api://{settings.entra_app_id}",
        f"--entra-tenant-id={settings.entra_tenant_id}",
    ]
    if workspace is not None:
        arguments.append(f"--workspace={workspace}")
    if codex_home is not None:
        arguments.append(f"--codex-home={codex_home}")
    if new_copy:
        arguments.append("--new-copy")
    return _zero_install_execution(
        settings,
        arguments=arguments,
        client_platform=client_platform,
        message=(
            "Execute this command locally now. It downloads a temporary standard-library "
            "client, restores the task, and removes the client afterward. No pip install or "
            "persistent bridge package is required."
        ),
    )


def create_app(settings: ServerSettings | None = None) -> Starlette:
    """Create the parent ASGI app with upload, download, and rename tools."""

    settings = settings or ServerSettings.from_environment()
    store = SessionStore(settings.data_dir)
    config_store = ConfigStore(settings.data_dir)
    coordinator = FileLeaseCoordinator(settings.data_dir / "coordination")
    signer = TicketSigner(settings.signing_key)
    semantic_search = (
        settings.semantic_search_client or SemanticSearchClient.from_environment()
    )
    auth_provider = settings.auth_provider
    if auth_provider is None and settings.auth_mode == _AUTH_MODE_ENTRA:
        auth_provider = create_entra_oauth_provider(
            tenant_id=settings.entra_tenant_id,
            app_id=settings.entra_app_id,
            client_secret=settings.entra_client_secret,
            certificate_private_key=settings.entra_private_key,
            certificate_thumbprint_sha256=settings.entra_cert_thumbprint_sha256,
            certificate_thumbprint_sha1=settings.entra_cert_thumbprint_sha1,
            managed_identity_client_id=settings.managed_identity_client_id,
            jwt_signing_key=settings.signing_key,
            base_url=settings.public_base_url,
            required_role=settings.required_role,
            required_scope=settings.required_scope,
            accept_azure_cli_tokens=settings.accept_azure_cli_tokens,
            trusted_app_client_ids=settings.trusted_app_client_ids,
        )
    elif auth_provider is None and (
        settings.auth_mode == _AUTH_MODE_API_KEY and settings.api_keys is not None
    ):
        auth_provider = HashedApiKeyVerifier(settings.api_keys)
    if auth_provider is None:
        raise RuntimeError("session-share authentication is not configured")

    def authorize_access_token(access_token: AccessToken) -> AccessToken:
        if settings.auth_mode != _AUTH_MODE_ENTRA:
            return access_token
        return authorize_entra_access_token(
            access_token,
            tenant_id=settings.entra_tenant_id,
            required_role=settings.required_role,
        )

    async def authenticate_access_token(headers: Any) -> AccessToken:
        authorization = str(headers.get("authorization") or "")
        if not authorization.lower().startswith("bearer "):
            raise AuthenticationError("missing bearer access token")
        token = authorization.split(" ", 1)[1].strip()
        if not token:
            raise AuthenticationError("missing bearer access token")
        access_token = await auth_provider.verify_token(token)
        if access_token is None:
            raise AuthenticationError("invalid bearer access token")
        access_token = authorize_access_token(access_token)
        if not access_token.client_id:
            raise AuthenticationError("authenticated principal is unavailable")
        return access_token

    async def authenticate_headers(headers: Any) -> str:
        return (await authenticate_access_token(headers)).client_id

    def current_identity() -> tuple[str, str]:
        token = get_access_token()
        if token is None:
            raise ToolError("authenticated principal is unavailable")
        try:
            access_token = authorize_access_token(token)
        except (AuthenticationError, AuthorizationError) as exc:
            raise ToolError(str(exc)) from exc
        if not access_token.client_id:
            raise ToolError("authenticated principal is unavailable")
        email = (
            entra_user_email(access_token)
            if settings.auth_mode == _AUTH_MODE_ENTRA
            else ""
        )
        return access_token.client_id, email

    def require_admin(access_token: AccessToken) -> None:
        if settings.auth_mode != _AUTH_MODE_ENTRA:
            return
        require_entra_role(
            access_token,
            tenant_id=settings.entra_tenant_id,
            required_role=settings.admin_role,
        )

    def can_admin(access_token: AccessToken) -> bool:
        try:
            require_admin(access_token)
            return True
        except AuthorizationError:
            return False

    def current_admin_principal() -> str:
        token = get_access_token()
        if token is None:
            raise ToolError("authenticated principal is unavailable")
        try:
            access_token = authorize_access_token(token)
            require_admin(access_token)
        except (AuthenticationError, AuthorizationError) as exc:
            raise ToolError(str(exc)) from exc
        return access_token.client_id

    def current_principal() -> str:
        principal, _email = current_identity()
        return principal

    async def create_upload_ticket(
        *,
        session_id: str,
        name: str | None,
        archive_sha256: str | None,
        archive_size_bytes: int | None,
        handoff_summary: str,
        manifest: dict[str, Any] | None,
        principal: str,
        uploader_email: str,
    ) -> dict[str, Any]:
        requested_session_id = _validate_session_id(session_id)
        source_session_id = requested_session_id
        require_new = name is not None
        session_name = (
            _validate_shared_name(name) if name is not None else requested_session_id
        )
        if archive_sha256 is None or archive_size_bytes is None:
            if require_new and await store.session_exists(session_name):
                raise ToolError(f"session name {session_name!r} is already used")
            name_argument = f" --name {session_name}" if require_new else ""
            return {
                "status": "local_bundle_required",
                "session_id": requested_session_id,
                "session_name": session_name,
                "message": (
                    "Run `codex-session-share upload --session-id "
                    f"{requested_session_id}{name_argument}` on the Codex host. A remote MCP "
                    "server cannot read local $CODEX_HOME or workspace files by itself."
                ),
            }
        archive_sha256 = archive_sha256.lower()
        if not _SHA256_PATTERN.fullmatch(archive_sha256):
            raise ToolError("archive_sha256 must be a lowercase SHA-256 hex digest")
        if archive_size_bytes < 1 or archive_size_bytes > settings.max_archive_bytes:
            raise ToolError(
                f"archive_size_bytes must be between 1 and {settings.max_archive_bytes}"
            )
        if len(handoff_summary) > _MAX_HANDOFF_CHARS:
            raise ToolError(f"handoff_summary exceeds {_MAX_HANDOFF_CHARS} characters")
        manifest = dict(manifest or {})
        if not require_new:
            source_session_id = str(
                manifest.get("source_session_id") or source_session_id
            )
        manifest["source_session_id"] = source_session_id
        encoded_manifest = json.dumps(manifest, separators=(",", ":")).encode("utf-8")
        if len(encoded_manifest) > _MAX_METADATA_BYTES:
            raise ToolError(f"manifest metadata exceeds {_MAX_METADATA_BYTES} bytes")

        ttl_seconds = max(60, min(settings.ticket_ttl_seconds, 3600))
        try:
            lease = await coordinator.acquire(
                [session_name],
                mode="write",
                principal=principal,
                operation="upload",
                ttl_seconds=ttl_seconds,
            )
        except SessionBusyError as exc:
            raise ToolError(str(exc)) from exc
        try:
            exists = await store.session_exists(session_name)
            if require_new and exists:
                raise SessionAlreadyExistsError(session_name)
            action = "replace" if exists else "create"
            reservation = await store.reserve_upload(
                session_id=session_name,
                source_session_id=source_session_id,
                principal=principal,
                uploader_email=uploader_email,
                archive_sha256=archive_sha256,
                archive_size_bytes=archive_size_bytes,
                manifest=manifest,
                handoff_summary=handoff_summary,
                ttl_seconds=ttl_seconds,
                lease_id=lease.lease_id,
                require_new=require_new,
            )
        except SessionAlreadyExistsError as exc:
            await coordinator.release(lease.lease_id)
            raise ToolError(f"session name {session_name!r} is already used") from exc
        except Exception:
            await coordinator.release(lease.lease_id)
            raise
        ticket = signer.issue(
            operation="upload",
            principal=principal,
            ttl_seconds=ttl_seconds,
            pending_id=reservation.pending_id,
        )
        path = f"/v1/transfers/upload/{ticket}"
        return {
            "status": "upload_ready",
            "session_id": requested_session_id,
            "session_name": session_name,
            "source_session_id": source_session_id,
            "action": action,
            "expires_at": reservation.expires_at,
            "upload": {
                "method": "PUT",
                "url": _transfer_location(settings, path),
                "headers": {
                    "Authorization": "<Bearer OAuth access token>",
                    "Content-Type": "application/gzip",
                },
            },
        }

    async def update_search_projection(
        metadata: dict[str, Any],
        *,
        state: str,
        previous_name: str | None = None,
    ) -> dict[str, Any]:
        if semantic_search is None:
            return {"enabled": False, "indexed": False}
        session_name = str(metadata.get("session_name") or metadata.get("session_id"))
        try:
            archive_path = await store.resolve_version(
                session_name,
                str(metadata["version_id"]),
                state=state,
            )
            result = await semantic_search.index_session(
                metadata,
                archive_path,
                previous_name=previous_name,
            )
            return {"enabled": True, "indexed": True, **result}
        except Exception as exc:  # noqa: BLE001
            _LOGGER.exception(
                "Failed to update semantic-search projection for %s",
                session_name,
            )
            return {
                "enabled": True,
                "indexed": False,
                "error": str(exc)[:500],
            }

    mcp = FastMCP(
        "Codex Session Share",
        instructions=(
            "Share portable Codex session bundles across users and machines. "
            "Uploads require local packaging because the remote service cannot read a caller's "
            "Codex files. For downloads, call download_session and then immediately execute the "
            "returned local_execution.command with the local shell. The command performs a "
            "zero-install restore; do not tell the user to install a Python package. "
            "The private codex_config_sync tool uploads or restores credential-free Codex "
            "settings for the authenticated user. Execute its returned local command only after "
            "the user requested that upload or confirmed the download overwrite."
        ),
        auth=auth_provider,
        strict_input_validation=True,
        mask_error_details=True,
    )

    @mcp.tool(
        name="upload_session",
        description=(
            "Create an authenticated upload ticket for the current Codex session bundle. "
            "Pass name to create the share under a unique user-selected name containing only "
            "letters, numbers, and underscores. "
            "A Codex-side bridge packages the current session ID, history, thread memory, "
            "attachments, and workspace files, calls this tool, then streams the archive to the "
            "returned URL. Uploads without name atomically create or replace the source session "
            "ID; uploads with name fail when that name is already used."
        ),
    )
    async def upload_session(
        session_id: str,
        name: str | None = None,
        archive_sha256: str | None = None,
        archive_size_bytes: int | None = None,
        handoff_summary: str = "",
        manifest: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        requested_session_id = _validate_session_id(session_id)
        source_session_id = requested_session_id
        require_new = name is not None
        session_name = _validate_shared_name(name) if name is not None else requested_session_id
        if archive_sha256 is None or archive_size_bytes is None:
            if require_new and await store.session_exists(session_name):
                raise ToolError(f"session name {session_name!r} is already used")
            name_argument = f" --name {session_name}" if require_new else ""
            return {
                "status": "local_bundle_required",
                "session_id": requested_session_id,
                "session_name": session_name,
                "message": (
                    "Run `codex-session-share upload --session-id "
                    f"{requested_session_id}{name_argument}` on the Codex host. A remote MCP "
                    "server cannot read local $CODEX_HOME or workspace files by itself."
                ),
            }
        archive_sha256 = archive_sha256.lower()
        if not _SHA256_PATTERN.fullmatch(archive_sha256):
            raise ToolError("archive_sha256 must be a lowercase SHA-256 hex digest")
        if archive_size_bytes < 1 or archive_size_bytes > settings.max_archive_bytes:
            raise ToolError(
                f"archive_size_bytes must be between 1 and {settings.max_archive_bytes}"
            )
        if len(handoff_summary) > _MAX_HANDOFF_CHARS:
            raise ToolError(f"handoff_summary exceeds {_MAX_HANDOFF_CHARS} characters")
        manifest = dict(manifest or {})
        if not require_new:
            source_session_id = str(
                manifest.get("source_session_id") or source_session_id
            )
        manifest["source_session_id"] = source_session_id
        encoded_manifest = json.dumps(manifest, separators=(",", ":")).encode("utf-8")
        if len(encoded_manifest) > _MAX_METADATA_BYTES:
            raise ToolError(f"manifest metadata exceeds {_MAX_METADATA_BYTES} bytes")

        principal, uploader_email = current_identity()
        ttl_seconds = max(60, min(settings.ticket_ttl_seconds, 3600))
        try:
            lease = await coordinator.acquire(
                [session_name],
                mode="write",
                principal=principal,
                operation="upload",
                ttl_seconds=ttl_seconds,
            )
        except SessionBusyError as exc:
            raise ToolError(str(exc)) from exc
        try:
            exists = await store.session_exists(session_name)
            if require_new and exists:
                raise SessionAlreadyExistsError(session_name)
            action = "replace" if exists else "create"
            reservation = await store.reserve_upload(
                session_id=session_name,
                source_session_id=source_session_id,
                principal=principal,
                uploader_email=uploader_email,
                archive_sha256=archive_sha256,
                archive_size_bytes=archive_size_bytes,
                manifest=manifest,
                handoff_summary=handoff_summary,
                ttl_seconds=ttl_seconds,
                lease_id=lease.lease_id,
                require_new=require_new,
            )
        except SessionAlreadyExistsError as exc:
            await coordinator.release(lease.lease_id)
            raise ToolError(f"session name {session_name!r} is already used") from exc
        except Exception:
            await coordinator.release(lease.lease_id)
            raise
        ticket = signer.issue(
            operation="upload",
            principal=principal,
            ttl_seconds=ttl_seconds,
            pending_id=reservation.pending_id,
        )
        path = f"/v1/transfers/upload/{ticket}"
        return {
            "status": "upload_ready",
            "session_id": requested_session_id,
            "session_name": session_name,
            "source_session_id": source_session_id,
            "action": action,
            "expires_at": reservation.expires_at,
            "upload": {
                "method": "PUT",
                "url": _transfer_location(settings, path),
                "headers": {
                    "Authorization": "Bearer <same OAuth access token>",
                    "Content-Type": "application/gzip",
                },
            },
        }

    @mcp.tool(
        name="download_session",
        description=(
            "Create an authenticated download ticket for a stored Codex session ID. "
            "When local_execution is present, Codex must execute local_execution.command using "
            "its local shell, then report the restored session and resume command. The temporary "
            "standard-library client restores history, memory, attachments, and workspace files "
            "without pip or a preinstalled bridge package. Pass workspace when the restored files "
            "should target a specific local directory."
        ),
    )
    async def download_session(
        session_id: str,
        workspace: str | None = None,
        codex_home: str | None = None,
        new_copy: bool = False,
        client_platform: Literal["windows", "macos", "linux"] = "linux",
    ) -> dict[str, Any]:
        session_id = _validate_session_id(session_id)
        workspace = _optional_local_path(workspace, field="workspace")
        codex_home = _optional_local_path(codex_home, field="codex_home")
        client_platform = _validate_client_platform(client_platform)
        principal = current_principal()
        try:
            lease = await coordinator.acquire(
                [session_id],
                mode="read",
                principal=principal,
                operation="download",
                ttl_seconds=max(60, min(settings.ticket_ttl_seconds, 3600)),
            )
        except SessionBusyError as exc:
            raise ToolError(str(exc)) from exc
        try:
            metadata = await store.read_session(session_id)
        except SessionNotFoundError as exc:
            await coordinator.release(lease.lease_id)
            raise ToolError(f"session {session_id!r} was not found") from exc
        ttl_seconds = max(60, min(settings.ticket_ttl_seconds, 3600))
        ticket = signer.issue(
            operation="download",
            principal=principal,
            ttl_seconds=ttl_seconds,
            session_id=session_id,
            version_id=metadata["version_id"],
            lease_id=lease.lease_id,
        )
        path = f"/v1/transfers/download/{ticket}"
        download_url = _transfer_location(settings, path)
        source_session_id = str(metadata.get("source_session_id") or session_id)
        local_execution = _zero_install_download(
            settings,
            session_name=session_id,
            source_session_id=source_session_id,
            download_url=download_url,
            archive_sha256=str(metadata["archive_sha256"]),
            archive_size_bytes=int(metadata["archive_size_bytes"]),
            workspace=workspace,
            codex_home=codex_home,
            new_copy=new_copy,
            client_platform=client_platform,
        )
        return {
            "status": "download_ready",
            "session_id": session_id,
            "session_name": session_id,
            "source_session_id": source_session_id,
            "expires_at": int(time.time()) + ttl_seconds,
            "archive_sha256": metadata["archive_sha256"],
            "archive_size_bytes": metadata["archive_size_bytes"],
            "uploaded_at": metadata["uploaded_at"],
            "uploaded_by": metadata["uploaded_by"],
            "uploaded_by_email": metadata.get("uploaded_by_email") or "",
            "manifest": metadata.get("manifest") or {},
            "handoff_summary": metadata.get("handoff_summary") or "",
            "azure_file_url": _azure_file_url(settings, metadata),
            "download": {
                "method": "GET",
                "url": download_url,
                "headers": {"Authorization": "Bearer <same OAuth access token>"},
            },
            "local_execution": local_execution,
            "next_action": (
                "Execute local_execution.command with the local shell now, then report its "
                "Session and Resume output to the user."
                if local_execution is not None
                else "Use the optional codex-session-share bridge to apply this ticket locally."
            ),
        }

    @mcp.tool(
        name="codex_config_sync",
        description=(
            "Privately synchronize portable Codex settings for the authenticated user. "
            "Use action='upload' to package and upload this machine's credential-free settings, "
            "or action='download' to restore the user's latest profile. The snapshot includes "
            "config.toml, keybindings, model overrides, optional app preferences and remote "
            "connection definitions, SSH config/public keys, automations, and customizations. "
            "It always excludes session history, auth.json, OAuth state, SSH private keys, "
            "binaries, caches, logs, and temporary files. Download requires "
            "confirm_overwrite=true and creates backups. App state is staged by default; set "
            "apply_app_state=true only when Codex can be restarted immediately."
        ),
    )
    async def codex_config_sync(
        action: Literal["upload", "download"],
        client_platform: Literal["windows", "macos", "linux"],
        profile: str = "default",
        codex_home: str | None = None,
        user_home: str | None = None,
        include_app_state: bool = True,
        include_ssh_config: bool = True,
        include_automations: bool = True,
        include_memories: bool = False,
        include_customizations: bool = True,
        confirm_overwrite: bool = False,
        apply_app_state: bool = False,
        activate_automations: bool = False,
    ) -> dict[str, Any]:
        if action not in {"upload", "download"}:
            raise ToolError("action must be upload or download")
        try:
            profile = validate_config_profile(profile)
        except ValueError as exc:
            raise ToolError(str(exc)) from exc
        client_platform = _validate_client_platform(client_platform)
        codex_home = _optional_local_path(codex_home, field="codex_home")
        user_home = _optional_local_path(user_home, field="user_home")
        principal, uploader_email = current_identity()
        resource = f"api://{settings.entra_app_id}"

        if action == "upload":
            arguments = [
                "--operation=config-upload",
                f"--profile={profile}",
                f"--config-upload-url={_transfer_location(settings, '/v1/config-sync/upload')}",
                f"--entra-resource={resource}",
                f"--entra-tenant-id={settings.entra_tenant_id}",
                f"--client-platform={client_platform}",
            ]
            if codex_home is not None:
                arguments.append(f"--codex-home={codex_home}")
            if user_home is not None:
                arguments.append(f"--user-home={user_home}")
            for enabled, positive, negative in (
                (include_app_state, "--include-app-state", "--no-include-app-state"),
                (include_ssh_config, "--include-ssh-config", "--no-include-ssh-config"),
                (include_automations, "--include-automations", "--no-include-automations"),
                (include_memories, "--include-memories", "--no-include-memories"),
                (
                    include_customizations,
                    "--include-customizations",
                    "--no-include-customizations",
                ),
            ):
                arguments.append(positive if enabled else negative)
            local_execution = _zero_install_execution(
                settings,
                arguments=arguments,
                client_platform=client_platform,
                message=(
                    "Execute this command locally now. It builds a small credential-free Codex "
                    "configuration archive, uploads it to the caller's private profile, and "
                    "deletes the temporary archive."
                ),
            )
            if local_execution is None:
                return {
                    "status": "local_bridge_required",
                    "action": action,
                    "profile": profile,
                    "message": (
                        "Zero-install config upload requires the production Entra endpoint. "
                        "Use the installed codex-session-share bridge in local API-key mode."
                    ),
                }
            return {
                "status": "local_execution_required",
                "action": action,
                "profile": profile,
                "private_to": principal,
                "uploader_email": uploader_email,
                "session_history_included": False,
                "credentials_included": False,
                "local_execution": local_execution,
                "next_action": (
                    "Execute local_execution.command with the requested machine's local shell, "
                    "then report the uploaded profile and archive size."
                ),
            }

        try:
            metadata = await config_store.read_profile(principal, profile)
        except ConfigProfileNotFoundError as exc:
            raise ToolError(
                f"no Codex configuration snapshot exists for profile {profile!r}"
            ) from exc
        snapshot = {
            "profile": profile,
            "uploaded_at": metadata["uploaded_at"],
            "archive_size_bytes": metadata["archive_size_bytes"],
            "manifest": metadata.get("manifest") or {},
        }
        if not confirm_overwrite:
            return {
                "status": "confirmation_required",
                "action": action,
                **snapshot,
                "message": (
                    "Downloading will replace or merge local Codex and SSH settings after making "
                    "a backup. Call again with confirm_overwrite=true. App state is staged unless "
                    "apply_app_state=true."
                ),
            }

        lease_name = config_lease_name(principal, profile)
        ttl_seconds = max(60, min(settings.ticket_ttl_seconds, 3600))
        try:
            lease = await coordinator.acquire(
                [lease_name],
                mode="read",
                principal=principal,
                operation="config-download",
                ttl_seconds=ttl_seconds,
            )
        except SessionBusyError as exc:
            raise ToolError(str(exc)) from exc
        ticket = signer.issue(
            operation="config-download",
            principal=principal,
            ttl_seconds=ttl_seconds,
            profile=profile,
            version_id=metadata["version_id"],
            lease_id=lease.lease_id,
        )
        download_url = _transfer_location(
            settings,
            f"/v1/config-sync/transfers/download/{ticket}",
        )
        arguments = [
            "--operation=config-download",
            f"--profile={profile}",
            f"--download-url={download_url}",
            f"--archive-sha256={metadata['archive_sha256']}",
            f"--archive-size-bytes={metadata['archive_size_bytes']}",
            f"--entra-resource={resource}",
            f"--entra-tenant-id={settings.entra_tenant_id}",
            f"--client-platform={client_platform}",
        ]
        if codex_home is not None:
            arguments.append(f"--codex-home={codex_home}")
        if user_home is not None:
            arguments.append(f"--user-home={user_home}")
        if apply_app_state:
            arguments.append("--apply-app-state")
        if activate_automations:
            arguments.append("--activate-automations")
        local_execution = _zero_install_execution(
            settings,
            arguments=arguments,
            client_platform=client_platform,
            message=(
                "Execute this command locally now. It verifies the private configuration "
                "archive, backs up files that will change, restores settings, and pauses "
                "imported automations unless explicitly requested otherwise."
            ),
        )
        if local_execution is None:
            await coordinator.release(lease.lease_id)
            raise ToolError(
                "zero-install config download requires the production Entra endpoint"
            )
        return {
            "status": "download_ready",
            "action": action,
            **snapshot,
            "expires_at": int(time.time()) + ttl_seconds,
            "download": {
                "method": "GET",
                "url": download_url,
                "headers": {"Authorization": "Bearer <same OAuth access token>"},
            },
            "local_execution": local_execution,
            "next_action": (
                "Execute local_execution.command with the requested machine's local shell, "
                "then report restored files, backup path, and any staged app-state path."
            ),
        }

    @mcp.tool(
        name="rename_session",
        description=(
            "Rename a stored session and its Azure Files directory. The operation checks that "
            "the new name is unused and fails with a busy error when an upload, download, or "
            "other rename is active for either name."
        ),
    )
    async def rename_session(original_name: str, new_name: str) -> dict[str, Any]:
        original_name = _validate_session_id(original_name)
        new_name = _validate_session_id(new_name)
        if original_name == new_name:
            raise ToolError("new_name must be different from original_name")
        principal = current_admin_principal()
        try:
            lease = await coordinator.acquire(
                [original_name, new_name],
                mode="write",
                principal=principal,
                operation="rename",
                ttl_seconds=300,
            )
        except SessionBusyError as exc:
            raise ToolError(str(exc)) from exc
        try:
            metadata = await store.rename_session(original_name, new_name)
        except SessionNotFoundError as exc:
            raise ToolError(f"session {original_name!r} was not found") from exc
        except SessionAlreadyExistsError as exc:
            raise ToolError(f"session name {new_name!r} is already used") from exc
        finally:
            await coordinator.release(lease.lease_id)
        search_projection = await update_search_projection(
            metadata,
            state="active",
            previous_name=original_name,
        )
        return {
            "status": "renamed",
            "original_name": original_name,
            "new_name": new_name,
            "source_session_id": metadata.get("source_session_id"),
            "storage_path": metadata["storage_path"],
            "azure_file_url": _azure_file_url(settings, metadata),
            "renamed_at": metadata["renamed_at"],
            "search_projection": search_projection,
        }

    async def authenticate_history_request(
        request: Request,
        *,
        admin: bool = False,
    ) -> AccessToken:
        access_token = await authenticate_access_token(request.headers)
        if admin:
            require_admin(access_token)
        return access_token

    def history_auth_error(exc: Exception) -> JSONResponse:
        if isinstance(exc, AuthenticationError):
            return JSONResponse(
                {"error": str(exc)},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        return JSONResponse({"error": str(exc)}, status_code=403)

    def history_state(value: str) -> str:
        if value not in {"active", "trash"}:
            raise ValueError("state must be 'active' or 'trash'")
        return value

    def history_summary(metadata: dict[str, Any], state: str) -> dict[str, Any]:
        handoff = str(metadata.get("handoff_summary") or "")
        return {
            "session_name": metadata.get("session_name") or metadata.get("session_id"),
            "source_session_id": metadata.get("source_session_id"),
            "state": state,
            "uploaded_at": metadata.get("uploaded_at"),
            "uploaded_by": metadata.get("uploaded_by"),
            "uploaded_by_email": metadata.get("uploaded_by_email") or "",
            "archive_size_bytes": metadata.get("archive_size_bytes"),
            "archive_sha256": metadata.get("archive_sha256"),
            "version_id": metadata.get("version_id"),
            "deleted_at": metadata.get("deleted_at"),
            "deleted_by": metadata.get("deleted_by"),
            "handoff_summary": handoff[:2000],
        }

    async def history_json_body(request: Request) -> dict[str, Any]:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                declared_length = int(content_length)
            except ValueError as exc:
                raise ValueError("invalid request Content-Length") from exc
            if declared_length > 16 * 1024:
                raise ValueError("request body is too large")
        encoded = await request.body()
        if len(encoded) > 16 * 1024:
            raise ValueError("request body is too large")
        try:
            value = json.loads(encoded or b"{}")
        except json.JSONDecodeError as exc:
            raise ValueError("request body must be valid JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("request body must be a JSON object")
        return value

    async def config_sync_upload_reservation(request: Request) -> Response:
        lease_id: str | None = None
        try:
            access_token = await authenticate_history_request(request)
            body = await history_json_body(request)
            profile = validate_config_profile(str(body.get("profile") or "default"))
            archive_sha256 = str(body.get("archive_sha256") or "").lower()
            archive_size_bytes = int(body.get("archive_size_bytes") or 0)
            manifest = dict(body.get("manifest") or {})
            if not _SHA256_PATTERN.fullmatch(archive_sha256):
                raise ValueError(
                    "archive_sha256 must be a lowercase SHA-256 hex digest"
                )
            max_config_archive_bytes = min(
                settings.max_archive_bytes,
                DEFAULT_MAX_CONFIG_INPUT_BYTES,
            )
            if archive_size_bytes < 1 or archive_size_bytes > max_config_archive_bytes:
                raise ValueError(
                    "archive_size_bytes must be between 1 and "
                    f"{max_config_archive_bytes}"
                )
            if manifest.get("bundle_type") != "codex_config":
                raise ValueError("manifest must describe a codex_config bundle")
            if manifest.get("profile") != profile:
                raise ValueError("manifest profile does not match the request profile")
            encoded_manifest = json.dumps(
                manifest,
                separators=(",", ":"),
            ).encode("utf-8")
            if len(encoded_manifest) > _MAX_METADATA_BYTES:
                raise ValueError(
                    f"manifest metadata exceeds {_MAX_METADATA_BYTES} bytes"
                )
            principal = access_token.client_id
            uploader_email = (
                entra_user_email(access_token)
                if settings.auth_mode == _AUTH_MODE_ENTRA
                else ""
            )
            ttl_seconds = max(60, min(settings.ticket_ttl_seconds, 3600))
            lease = await coordinator.acquire(
                [config_lease_name(principal, profile)],
                mode="write",
                principal=principal,
                operation="config-upload",
                ttl_seconds=ttl_seconds,
            )
            lease_id = lease.lease_id
            action = (
                "replace"
                if await config_store.profile_exists(principal, profile)
                else "create"
            )
            reservation = await config_store.reserve_upload(
                principal=principal,
                uploader_email=uploader_email,
                profile=profile,
                archive_sha256=archive_sha256,
                archive_size_bytes=archive_size_bytes,
                manifest=manifest,
                ttl_seconds=ttl_seconds,
                lease_id=lease.lease_id,
            )
            ticket = signer.issue(
                operation="config-upload",
                principal=principal,
                ttl_seconds=ttl_seconds,
                pending_id=reservation.pending_id,
            )
            return JSONResponse(
                {
                    "status": "upload_ready",
                    "profile": profile,
                    "action": action,
                    "expires_at": reservation.expires_at,
                    "upload": {
                        "method": "PUT",
                        "url": _transfer_location(
                            settings,
                            f"/v1/config-sync/transfers/upload/{ticket}",
                        ),
                        "headers": {
                            "Authorization": "<Bearer OAuth access token>",
                            "Content-Type": "application/gzip",
                        },
                    },
                }
            )
        except (AuthenticationError, AuthorizationError) as exc:
            return history_auth_error(exc)
        except SessionBusyError as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)
        except (TypeError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        except Exception:
            if lease_id:
                await coordinator.release(lease_id)
            raise

    async def session_history_list(request: Request) -> Response:
        try:
            access_token = await authenticate_history_request(request)
        except (AuthenticationError, AuthorizationError) as exc:
            return history_auth_error(exc)
        requested_state = request.query_params.get("state", "active")
        if requested_state not in {"active", "trash", "all"}:
            return JSONResponse(
                {"error": "state must be active, trash, or all"},
                status_code=400,
            )

        query_text = request.query_params.get("q", "").strip()
        if len(query_text) > 256:
            return JSONResponse({"error": "q is too long"}, status_code=400)
        try:
            limit = max(1, min(int(request.query_params.get("limit", "50")), 200))
            offset = max(0, int(request.query_params.get("offset", "0")))
            start_at = max(0, int(request.query_params.get("start_at", "0")))
        except ValueError:
            return JSONResponse(
                {"error": "limit, offset, and start_at must be integers"},
                status_code=400,
            )
        if query_text and semantic_search is not None:
            try:
                result = await semantic_search.search(
                    query_text,
                    state=requested_state,
                    limit=limit,
                    offset=offset,
                    start_at=start_at,
                )
            except SearchOperationError as exc:
                return JSONResponse(
                    {"error": f"semantic search is unavailable: {exc}"},
                    status_code=503,
                )
            result["permissions"] = {"can_manage": can_admin(access_token)}
            result["semantic_search"] = await semantic_search.status()
            return JSONResponse(result)

        query = query_text.casefold()
        states = ("active", "trash") if requested_state == "all" else (requested_state,)
        values: list[dict[str, Any]] = []
        for state in states:
            for metadata in await store.list_sessions(state=state):
                summary = history_summary(metadata, state)
                timestamp = int(
                    summary.get("deleted_at")
                    or summary.get("uploaded_at")
                    or 0
                )
                if start_at and timestamp < start_at:
                    continue
                searchable = "\n".join(
                    str(summary.get(field) or "")
                    for field in (
                        "session_name",
                        "source_session_id",
                        "uploaded_by_email",
                        "handoff_summary",
                    )
                ).casefold()
                if query and query not in searchable:
                    continue
                values.append(summary)
        values.sort(
            key=lambda item: int(
                item.get("deleted_at") or item.get("uploaded_at") or 0
            ),
            reverse=True,
        )
        total = len(values)
        return JSONResponse(
            {
                "items": values[offset : offset + limit],
                "total": total,
                "limit": limit,
                "offset": offset,
                "has_more": offset + limit < total,
                "permissions": {"can_manage": can_admin(access_token)},
                "search_mode": "substring" if query else "browse",
                "semantic_search": (
                    await semantic_search.status()
                    if semantic_search is not None
                    else {"enabled": False}
                ),
            }
        )

    async def session_history_upload_ticket(request: Request) -> Response:
        try:
            access_token = await authenticate_history_request(request)
            body = await history_json_body(request)
            result = await create_upload_ticket(
                session_id=str(body.get("session_id") or ""),
                name=(
                    str(body["name"])
                    if body.get("name") is not None
                    else None
                ),
                archive_sha256=(
                    str(body["archive_sha256"])
                    if body.get("archive_sha256") is not None
                    else None
                ),
                archive_size_bytes=(
                    int(body["archive_size_bytes"])
                    if body.get("archive_size_bytes") is not None
                    else None
                ),
                handoff_summary=str(body.get("handoff_summary") or ""),
                manifest=(
                    dict(body["manifest"])
                    if isinstance(body.get("manifest"), dict)
                    else None
                ),
                principal=access_token.client_id,
                uploader_email=(
                    entra_user_email(access_token)
                    if settings.auth_mode == _AUTH_MODE_ENTRA
                    else ""
                ),
            )
        except (AuthenticationError, AuthorizationError) as exc:
            return history_auth_error(exc)
        except (ToolError, TypeError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse(result)

    async def session_history_detail(request: Request) -> Response:
        try:
            await authenticate_history_request(request)
            state = history_state(request.path_params["state"])
            session_name = _validate_session_id(request.path_params["session_name"])
            metadata = await store.read_session_state(session_name, state=state)
            archive_path = await store.resolve_version(
                session_name,
                str(metadata["version_id"]),
                state=state,
            )
        except (AuthenticationError, AuthorizationError) as exc:
            return history_auth_error(exc)
        except (SessionNotFoundError, KeyError):
            return JSONResponse({"error": "session was not found"}, status_code=404)
        except (ToolError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        transcript: dict[str, Any] | None = None
        transcript_error: str | None = None
        try:
            transcript = await anyio.to_thread.run_sync(
                lambda: read_archive_transcript(archive_path, max_messages=300)
            )
        except (BundleError, OSError, ValueError) as exc:
            transcript_error = str(exc)
        return JSONResponse(
            {
                "session": {
                    **metadata,
                    "state": state,
                    "azure_file_url": _azure_file_url(settings, metadata),
                },
                "transcript": transcript,
                "transcript_error": transcript_error,
            }
        )

    async def session_history_archive(request: Request) -> Response:
        lease_id: str | None = None
        try:
            access_token = await authenticate_history_request(request)
            state = history_state(request.path_params["state"])
            session_name = _validate_session_id(request.path_params["session_name"])
            lease = await coordinator.acquire(
                [session_name],
                mode="read",
                principal=access_token.client_id,
                operation="history-download",
                ttl_seconds=7200,
            )
            lease_id = lease.lease_id
            metadata = await store.read_session_state(session_name, state=state)
            archive_path = await store.resolve_version(
                session_name,
                str(metadata["version_id"]),
                state=state,
            )
        except (AuthenticationError, AuthorizationError) as exc:
            return history_auth_error(exc)
        except SessionBusyError as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)
        except (SessionNotFoundError, KeyError):
            if lease_id:
                await coordinator.release(lease_id)
            return JSONResponse({"error": "session was not found"}, status_code=404)
        except (ToolError, ValueError) as exc:
            if lease_id:
                await coordinator.release(lease_id)
            return JSONResponse({"error": str(exc)}, status_code=400)
        return FileResponse(
            archive_path,
            media_type="application/gzip",
            filename=f"codex-session-{session_name}.tar.gz",
            headers={"Cache-Control": "private, no-store"},
            background=BackgroundTask(coordinator.release, lease_id),
        )

    async def session_history_rename(request: Request) -> Response:
        lease_id: str | None = None
        try:
            access_token = await authenticate_history_request(request, admin=True)
            original_name = _validate_session_id(request.path_params["session_name"])
            body = await history_json_body(request)
            new_name = _validate_session_id(str(body.get("new_name") or ""))
            if original_name == new_name:
                raise ValueError("new_name must be different from the current name")
            lease = await coordinator.acquire(
                [original_name, new_name],
                mode="write",
                principal=access_token.client_id,
                operation="history-rename",
                ttl_seconds=300,
            )
            lease_id = lease.lease_id
            metadata = await store.rename_session(original_name, new_name)
        except (AuthenticationError, AuthorizationError) as exc:
            return history_auth_error(exc)
        except SessionBusyError as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)
        except SessionNotFoundError:
            return JSONResponse({"error": "session was not found"}, status_code=404)
        except SessionAlreadyExistsError:
            return JSONResponse({"error": "the new session name is already used"}, status_code=409)
        except (ToolError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        finally:
            if lease_id:
                await coordinator.release(lease_id)
        search_projection = await update_search_projection(
            metadata,
            state="active",
            previous_name=original_name,
        )
        return JSONResponse(
            {
                "status": "renamed",
                "session": metadata,
                "search_projection": search_projection,
            }
        )

    async def session_history_trash(request: Request) -> Response:
        lease_id: str | None = None
        try:
            access_token = await authenticate_history_request(request, admin=True)
            session_name = _validate_session_id(request.path_params["session_name"])
            lease = await coordinator.acquire(
                [session_name],
                mode="write",
                principal=access_token.client_id,
                operation="history-trash",
                ttl_seconds=300,
            )
            lease_id = lease.lease_id
            metadata = await store.trash_session(
                session_name,
                principal=access_token.client_id,
            )
        except (AuthenticationError, AuthorizationError) as exc:
            return history_auth_error(exc)
        except SessionBusyError as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)
        except SessionNotFoundError:
            return JSONResponse({"error": "session was not found"}, status_code=404)
        except SessionAlreadyExistsError:
            return JSONResponse(
                {"error": "a trash entry with this name already exists"},
                status_code=409,
            )
        except (ToolError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        finally:
            if lease_id:
                await coordinator.release(lease_id)
        search_projection = await update_search_projection(metadata, state="trash")
        return JSONResponse(
            {
                "status": "trashed",
                "session": metadata,
                "search_projection": search_projection,
            }
        )

    async def session_history_restore(request: Request) -> Response:
        lease_id: str | None = None
        try:
            access_token = await authenticate_history_request(request, admin=True)
            session_name = _validate_session_id(request.path_params["session_name"])
            lease = await coordinator.acquire(
                [session_name],
                mode="write",
                principal=access_token.client_id,
                operation="history-restore",
                ttl_seconds=300,
            )
            lease_id = lease.lease_id
            metadata = await store.restore_session(
                session_name,
                principal=access_token.client_id,
            )
        except (AuthenticationError, AuthorizationError) as exc:
            return history_auth_error(exc)
        except SessionBusyError as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)
        except SessionNotFoundError:
            return JSONResponse({"error": "session was not found"}, status_code=404)
        except SessionAlreadyExistsError:
            return JSONResponse(
                {"error": "an active session with this name already exists"},
                status_code=409,
            )
        except (ToolError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        finally:
            if lease_id:
                await coordinator.release(lease_id)
        search_projection = await update_search_projection(metadata, state="active")
        return JSONResponse(
            {
                "status": "restored",
                "session": metadata,
                "search_projection": search_projection,
            }
        )

    async def session_history_purge(request: Request) -> Response:
        lease_id: str | None = None
        try:
            access_token = await authenticate_history_request(request, admin=True)
            session_name = _validate_session_id(request.path_params["session_name"])
            state = str(request.path_params.get("state") or "trash")
            if state not in {"active", "trash"}:
                raise ValueError("state must be active or trash")
            lease = await coordinator.acquire(
                [session_name],
                mode="write",
                principal=access_token.client_id,
                operation=f"history-purge-{state}",
                ttl_seconds=300,
            )
            lease_id = lease.lease_id
            metadata = await store.read_session_state(session_name, state=state)
            if semantic_search is not None:
                archive_path = await store.resolve_version(
                    session_name,
                    str(metadata["version_id"]),
                    state=state,
                )
                deleted_documents = await semantic_search.delete_indexed_session(
                    metadata,
                    archive_path,
                )
                search_projection = {
                    "enabled": True,
                    "deleted": True,
                    "deleted_documents": deleted_documents,
                }
            else:
                search_projection = {"enabled": False, "deleted": False}
            metadata = await store.purge_session(session_name, state=state)
        except (AuthenticationError, AuthorizationError) as exc:
            return history_auth_error(exc)
        except SessionBusyError as exc:
            return JSONResponse({"error": str(exc)}, status_code=409)
        except SessionNotFoundError:
            return JSONResponse({"error": "session was not found"}, status_code=404)
        except SearchOperationError as exc:
            return JSONResponse(
                {"error": f"semantic search cleanup failed: {exc}"},
                status_code=503,
            )
        except (ToolError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        finally:
            if lease_id:
                await coordinator.release(lease_id)
        return JSONResponse(
            {
                "status": "purged",
                "session_name": metadata.get("session_name") or metadata.get("session_id"),
                "search_projection": search_projection,
            }
        )

    async def session_history_reindex(request: Request) -> Response:
        try:
            await authenticate_history_request(request, admin=True)
        except (AuthenticationError, AuthorizationError) as exc:
            return history_auth_error(exc)
        if semantic_search is None:
            return JSONResponse(
                {"error": "semantic search is not configured"},
                status_code=409,
            )
        result = await semantic_search.reindex_all(store)
        return JSONResponse(
            {
                "status": "reindexed",
                **result,
                "semantic_search": await semantic_search.status(),
            }
        )

    async def health(_request: Request) -> Response:
        return JSONResponse({"status": "ok", "service": "codex-session-share"})

    async def ready(_request: Request) -> Response:
        try:
            settings.data_dir.mkdir(parents=True, exist_ok=True)
            probe = settings.data_dir / f".ready-{secrets.token_hex(4)}"
            probe.write_text("ready", encoding="utf-8")
            probe.unlink()
        except OSError:
            return JSONResponse({"status": "not_ready"}, status_code=503)
        return JSONResponse({"status": "ready"})

    async def bootstrap_client(_request: Request) -> Response:
        return Response(
            build_bootstrap_zipapp(),
            media_type="application/zip",
            headers={
                "Cache-Control": "public, max-age=300",
                "Content-Disposition": (
                    'attachment; filename="codex-session-share.pyz"'
                ),
                "X-Codex-Session-Share-Version": __version__,
            },
        )

    async def config_upload_transfer(request: Request) -> Response:
        try:
            principal = await authenticate_headers(request.headers)
        except AuthenticationError as exc:
            return JSONResponse(
                {"error": str(exc)},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        except AuthorizationError as exc:
            return JSONResponse({"error": str(exc)}, status_code=403)
        try:
            claims = signer.verify(
                request.path_params["ticket"],
                operation="config-upload",
                principal=principal,
            )
        except TicketError as exc:
            return JSONResponse({"error": str(exc)}, status_code=403)
        pending_id = claims.get("pending_id")
        if not isinstance(pending_id, str):
            return JSONResponse({"error": "invalid config upload ticket"}, status_code=403)
        try:
            reservation = await config_store.claim_upload(pending_id)
        except ConfigPendingUploadNotFoundError:
            return JSONResponse(
                {"error": "config upload ticket is expired or already used"},
                status_code=409,
            )
        if reservation.principal != principal:
            await config_store.release_claim(reservation, retryable=False)
            await coordinator.release(reservation.lease_id)
            return JSONResponse({"error": "config upload principal mismatch"}, status_code=403)
        try:
            await coordinator.validate(
                reservation.lease_id,
                principal=principal,
                mode="write",
            )
            await coordinator.renew(reservation.lease_id, ttl_seconds=7200)
        except LeaseNotActiveError:
            await config_store.release_claim(reservation, retryable=False)
            return JSONResponse(
                {"error": "config upload operation is no longer active"},
                status_code=409,
            )

        content_length = request.headers.get("content-length")
        if content_length:
            try:
                declared_length = int(content_length)
            except ValueError:
                declared_length = -1
            if declared_length != reservation.archive_size_bytes:
                await config_store.release_claim(reservation, retryable=True)
                return JSONResponse(
                    {"error": "Content-Length does not match the reserved archive size"},
                    status_code=422,
                )

        temporary = config_store.new_temp_path()
        digest = hashlib.sha256()
        size = 0
        try:
            async with await anyio.open_file(temporary, "wb") as handle:
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    size += len(chunk)
                    if (
                        size > reservation.archive_size_bytes
                        or size > DEFAULT_MAX_CONFIG_INPUT_BYTES
                    ):
                        raise ValueError("config archive exceeded the reserved size")
                    digest.update(chunk)
                    await handle.write(chunk)
            if size != reservation.archive_size_bytes:
                raise ValueError("config archive size did not match the reservation")
            if digest.hexdigest() != reservation.archive_sha256:
                raise ValueError("config archive SHA-256 did not match the reservation")
            metadata = await config_store.commit_upload(reservation, temporary)
            await config_store.release_claim(reservation, retryable=False)
            await coordinator.release(reservation.lease_id)
        except ValueError as exc:
            await config_store.discard_temp(temporary)
            await config_store.release_claim(reservation, retryable=True)
            return JSONResponse({"error": str(exc)}, status_code=422)
        except Exception:
            await config_store.discard_temp(temporary)
            await config_store.release_claim(reservation, retryable=True)
            raise

        return JSONResponse(
            {
                "status": "stored",
                "profile": reservation.profile,
                "action": "replaced" if metadata["replaced"] else "created",
                "archive_sha256": metadata["archive_sha256"],
                "archive_size_bytes": metadata["archive_size_bytes"],
                "uploaded_at": metadata["uploaded_at"],
            },
            status_code=200 if metadata["replaced"] else 201,
        )

    async def config_download_transfer(request: Request) -> Response:
        try:
            principal = await authenticate_headers(request.headers)
        except AuthenticationError as exc:
            return JSONResponse(
                {"error": str(exc)},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        except AuthorizationError as exc:
            return JSONResponse({"error": str(exc)}, status_code=403)
        try:
            claims = signer.verify(
                request.path_params["ticket"],
                operation="config-download",
                principal=principal,
            )
        except TicketError as exc:
            return JSONResponse({"error": str(exc)}, status_code=403)
        profile = claims.get("profile")
        version_id = claims.get("version_id")
        lease_id = claims.get("lease_id")
        if (
            not isinstance(profile, str)
            or not isinstance(version_id, str)
            or not isinstance(lease_id, str)
        ):
            return JSONResponse(
                {"error": "invalid config download ticket"},
                status_code=403,
            )
        try:
            profile = validate_config_profile(profile)
            await coordinator.validate(
                lease_id,
                principal=principal,
                mode="read",
            )
            await coordinator.renew(lease_id, ttl_seconds=7200)
        except (ValueError, LeaseNotActiveError):
            return JSONResponse(
                {"error": "config download operation is no longer active"},
                status_code=409,
            )
        try:
            archive_path = await config_store.resolve_version(
                principal,
                profile,
                version_id,
            )
        except ConfigProfileNotFoundError:
            await coordinator.release(lease_id)
            return JSONResponse(
                {"error": "config archive was not found"},
                status_code=404,
            )
        return FileResponse(
            archive_path,
            media_type="application/gzip",
            filename=f"codex-config-{profile}.tar.gz",
            headers={"Cache-Control": "private, no-store"},
            background=BackgroundTask(coordinator.release, lease_id),
        )

    async def upload_transfer(request: Request) -> Response:
        try:
            principal = await authenticate_headers(request.headers)
        except AuthenticationError as exc:
            return JSONResponse(
                {"error": str(exc)},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        except AuthorizationError as exc:
            return JSONResponse({"error": str(exc)}, status_code=403)
        try:
            claims = signer.verify(
                request.path_params["ticket"],
                operation="upload",
                principal=principal,
            )
        except TicketError as exc:
            return JSONResponse({"error": str(exc)}, status_code=403)
        pending_id = claims.get("pending_id")
        if not isinstance(pending_id, str):
            return JSONResponse({"error": "invalid upload ticket"}, status_code=403)
        try:
            reservation = await store.claim_upload(pending_id)
        except PendingUploadNotFoundError:
            return JSONResponse(
                {"error": "upload ticket is expired or already used"},
                status_code=409,
            )
        if reservation.principal != principal:
            await store.release_claim(reservation, retryable=False)
            await coordinator.release(reservation.lease_id)
            return JSONResponse({"error": "upload principal mismatch"}, status_code=403)
        try:
            await coordinator.validate(
                reservation.lease_id,
                principal=principal,
                mode="write",
            )
            await coordinator.renew(reservation.lease_id, ttl_seconds=7200)
        except LeaseNotActiveError:
            await store.release_claim(reservation, retryable=False)
            return JSONResponse(
                {"error": "upload operation is no longer active"},
                status_code=409,
            )

        content_length = request.headers.get("content-length")
        if content_length:
            try:
                declared_length = int(content_length)
            except ValueError:
                declared_length = -1
            if declared_length != reservation.archive_size_bytes:
                await store.release_claim(reservation, retryable=True)
                return JSONResponse(
                    {"error": "Content-Length does not match the reserved archive size"},
                    status_code=422,
                )

        temporary = store.new_temp_path()
        digest = hashlib.sha256()
        size = 0
        search_projection: dict[str, Any] = {
            "enabled": semantic_search is not None,
            "indexed": False,
        }
        try:
            async with await anyio.open_file(temporary, "wb") as handle:
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > reservation.archive_size_bytes or size > settings.max_archive_bytes:
                        raise ValueError("archive exceeded the reserved size")
                    digest.update(chunk)
                    await handle.write(chunk)
            if size != reservation.archive_size_bytes:
                raise ValueError("archive size did not match the reservation")
            if digest.hexdigest() != reservation.archive_sha256:
                raise ValueError("archive SHA-256 did not match the reservation")
            metadata = await store.commit_upload(reservation, temporary)
            await store.release_claim(reservation, retryable=False)
            await coordinator.release(reservation.lease_id)
            search_projection = await update_search_projection(
                metadata,
                state="active",
            )
        except SessionAlreadyExistsError:
            await store.discard_temp(temporary)
            await store.release_claim(reservation, retryable=False)
            await coordinator.release(reservation.lease_id)
            return JSONResponse(
                {"error": f"session name {reservation.session_id!r} is already used"},
                status_code=409,
            )
        except ValueError as exc:
            await store.discard_temp(temporary)
            await store.release_claim(reservation, retryable=True)
            return JSONResponse({"error": str(exc)}, status_code=422)
        except Exception:
            await store.discard_temp(temporary)
            await store.release_claim(reservation, retryable=True)
            raise

        return JSONResponse(
            {
                "status": "stored",
                "session_id": (
                    reservation.source_session_id
                    if reservation.require_new
                    else reservation.session_id
                ),
                "session_name": reservation.session_id,
                "source_session_id": reservation.source_session_id,
                "action": "replaced" if metadata["replaced"] else "created",
                "storage_path": metadata["storage_path"],
                "archive_path": metadata["archive_path"],
                "azure_file_url": _azure_file_url(settings, metadata),
                "archive_sha256": metadata["archive_sha256"],
                "archive_size_bytes": metadata["archive_size_bytes"],
                "uploaded_at": metadata["uploaded_at"],
                "uploaded_by": metadata["uploaded_by"],
                "uploaded_by_email": metadata.get("uploaded_by_email") or "",
                "search_projection": search_projection,
            },
            status_code=200 if metadata["replaced"] else 201,
        )

    async def download_transfer(request: Request) -> Response:
        try:
            principal = await authenticate_headers(request.headers)
        except AuthenticationError as exc:
            return JSONResponse(
                {"error": str(exc)},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        except AuthorizationError as exc:
            return JSONResponse({"error": str(exc)}, status_code=403)
        try:
            claims = signer.verify(
                request.path_params["ticket"],
                operation="download",
                principal=principal,
            )
        except TicketError as exc:
            return JSONResponse({"error": str(exc)}, status_code=403)
        session_id = claims.get("session_id")
        version_id = claims.get("version_id")
        lease_id = claims.get("lease_id")
        if (
            not isinstance(session_id, str)
            or not isinstance(version_id, str)
            or not isinstance(lease_id, str)
        ):
            return JSONResponse({"error": "invalid download ticket"}, status_code=403)
        try:
            await coordinator.validate(
                lease_id,
                principal=principal,
                mode="read",
            )
            await coordinator.renew(lease_id, ttl_seconds=7200)
        except LeaseNotActiveError:
            return JSONResponse(
                {"error": "download operation is no longer active"},
                status_code=409,
            )
        try:
            archive_path = await store.resolve_version(session_id, version_id)
        except SessionNotFoundError:
            await coordinator.release(lease_id)
            return JSONResponse({"error": "session archive was not found"}, status_code=404)
        return FileResponse(
            archive_path,
            media_type="application/gzip",
            filename=f"codex-session-{session_id}.tar.gz",
            headers={"Cache-Control": "private, no-store"},
            background=BackgroundTask(coordinator.release, lease_id),
        )

    mcp_http_app = mcp.http_app(path="/mcp", stateless_http=True)

    @asynccontextmanager
    async def lifespan(parent_app: Starlette):
        async with AsyncExitStack() as stack:
            await store.migrate_legacy_layout()
            await stack.enter_async_context(mcp_http_app.lifespan(parent_app))
            try:
                yield
            finally:
                if semantic_search is not None:
                    await semantic_search.close()

    parent = Starlette(
        routes=[
            Route("/healthz", health, methods=["GET"]),
            Route("/readyz", ready, methods=["GET"]),
            Route(_BOOTSTRAP_PATH, bootstrap_client, methods=["GET"]),
            Route(
                "/v1/config-sync/upload",
                config_sync_upload_reservation,
                methods=["POST"],
            ),
            Route(
                "/v1/config-sync/transfers/upload/{ticket:str}",
                config_upload_transfer,
                methods=["PUT"],
            ),
            Route(
                "/v1/config-sync/transfers/download/{ticket:str}",
                config_download_transfer,
                methods=["GET"],
            ),
            Route("/v1/session-history", session_history_list, methods=["GET"]),
            Route(
                "/v1/session-history/upload",
                session_history_upload_ticket,
                methods=["POST"],
            ),
            Route(
                "/v1/session-history/reindex",
                session_history_reindex,
                methods=["POST"],
            ),
            Route(
                "/v1/session-history/{state:str}/{session_name:str}/archive",
                session_history_archive,
                methods=["GET"],
            ),
            Route(
                "/v1/session-history/active/{session_name:str}/rename",
                session_history_rename,
                methods=["POST"],
            ),
            Route(
                "/v1/session-history/active/{session_name:str}",
                session_history_trash,
                methods=["DELETE"],
            ),
            Route(
                "/v1/session-history/trash/{session_name:str}/restore",
                session_history_restore,
                methods=["POST"],
            ),
            Route(
                "/v1/session-history/{state:str}/{session_name:str}/purge",
                session_history_purge,
                methods=["DELETE"],
            ),
            Route(
                "/v1/session-history/trash/{session_name:str}",
                session_history_purge,
                methods=["DELETE"],
            ),
            Route(
                "/v1/session-history/{state:str}/{session_name:str}",
                session_history_detail,
                methods=["GET"],
            ),
            Route(
                "/v1/transfers/upload/{ticket:str}",
                upload_transfer,
                methods=["PUT"],
            ),
            Route(
                "/v1/transfers/download/{ticket:str}",
                download_transfer,
                methods=["GET"],
            ),
            Mount("/", app=mcp_http_app),
        ],
        lifespan=lifespan,
    )
    parent.state.session_store = store
    parent.state.config_store = config_store
    parent.state.lease_coordinator = coordinator
    parent.state.fastmcp = mcp
    parent.state.auth_provider = auth_provider
    parent.state.semantic_search = semantic_search
    parent.state.settings = settings
    return parent


def main() -> None:
    settings = ServerSettings.from_environment()
    uvicorn.run(
        create_app(settings),
        host="0.0.0.0",
        port=settings.port,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )


if __name__ == "__main__":
    main()
