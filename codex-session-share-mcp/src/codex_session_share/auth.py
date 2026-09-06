"""Authentication helpers for Entra bearer tokens and local API-key development."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import threading
import time
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
from authlib.common.urls import add_params_to_qs
from authlib.integrations.httpx_client import AsyncOAuth2Client
from authlib.oauth2.rfc7523 import PrivateKeyJWT
from azure.identity.aio import ManagedIdentityCredential
from fastmcp.server.auth import AccessToken, AuthProvider, MultiAuth, TokenVerifier
from fastmcp.server.auth.providers.azure import AzureProvider
from fastmcp.server.auth.providers.jwt import JWTVerifier


class AuthConfigurationError(RuntimeError):
    """Raised when authentication settings are incomplete or invalid."""


class AuthenticationError(RuntimeError):
    """Raised when a request does not contain a valid authenticated identity."""


class AuthorizationError(RuntimeError):
    """Raised when an authenticated identity lacks the required application role."""


class AzureCliCredentialError(RuntimeError):
    """Raised when a bearer token cannot be acquired from the Azure CLI."""


@dataclass(frozen=True)
class ApiPrincipal:
    """Identity associated with one configured API key."""

    key_id: str


@dataclass(frozen=True)
class AzureCliAccessToken:
    """Short-lived token returned by ``az account get-access-token``."""

    token: str
    expires_at: int
    tenant_id: str


class ApiKeyRegistry:
    """Validate raw API keys against SHA-256 hashes without storing plaintext."""

    def __init__(self, key_hashes: Mapping[str, str]) -> None:
        normalized: dict[str, str] = {}
        for key_id, digest in key_hashes.items():
            key_id = str(key_id).strip()
            digest = str(digest).lower().removeprefix("sha256:").strip()
            if not key_id:
                raise AuthConfigurationError("API key IDs must be non-empty")
            if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
                raise AuthConfigurationError(
                    f"API key hash for {key_id!r} must be a SHA-256 hex digest"
                )
            normalized[key_id] = digest
        if not normalized:
            raise AuthConfigurationError("at least one API key hash is required")
        self._key_hashes = normalized

    @classmethod
    def from_environment(cls) -> ApiKeyRegistry:
        """Load one or more key hashes from environment variables."""

        raw_json = os.environ.get("SESSION_SHARE_API_KEYS_JSON", "").strip()
        if raw_json:
            try:
                parsed = json.loads(raw_json)
            except json.JSONDecodeError as exc:
                raise AuthConfigurationError(
                    "SESSION_SHARE_API_KEYS_JSON must be valid JSON"
                ) from exc
            if not isinstance(parsed, dict):
                raise AuthConfigurationError(
                    "SESSION_SHARE_API_KEYS_JSON must be an object of key-id to SHA-256 hash"
                )
            return cls({str(key): str(value) for key, value in parsed.items()})

        digest = os.environ.get("SESSION_SHARE_API_KEY_SHA256", "").strip()
        if digest:
            key_id = os.environ.get("SESSION_SHARE_API_KEY_ID", "shared").strip() or "shared"
            return cls({key_id: digest})

        raise AuthConfigurationError(
            "set SESSION_SHARE_API_KEY_SHA256 or SESSION_SHARE_API_KEYS_JSON"
        )

    @staticmethod
    def hash_key(raw_key: str) -> str:
        """Return the lowercase SHA-256 digest used by server configuration."""

        return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()

    def authenticate(self, raw_key: str | None) -> ApiPrincipal | None:
        """Return the matching principal, using constant-time digest comparison."""

        if not raw_key:
            return None
        candidate = self.hash_key(raw_key)
        matched: str | None = None
        for key_id, expected in self._key_hashes.items():
            if hmac.compare_digest(candidate, expected):
                matched = key_id
        return ApiPrincipal(matched) if matched else None

    def authenticate_headers(self, headers: Mapping[str, str]) -> ApiPrincipal | None:
        """Accept standard Bearer auth and an X-API-Key compatibility header."""

        authorization = headers.get("authorization", "")
        raw_key: str | None = None
        if authorization.lower().startswith("bearer "):
            raw_key = authorization.split(" ", 1)[1].strip()
        if not raw_key:
            raw_key = headers.get("x-api-key")
        return self.authenticate(raw_key)


class HashedApiKeyVerifier(TokenVerifier):
    """FastMCP bearer-token verifier backed by :class:`ApiKeyRegistry`."""

    def __init__(self, registry: ApiKeyRegistry) -> None:
        super().__init__()
        self.registry = registry

    async def verify_token(self, token: str) -> AccessToken | None:
        principal = self.registry.authenticate(token)
        if principal is None:
            return None
        return AccessToken(
            token=token,
            client_id=principal.key_id,
            subject=principal.key_id,
            scopes=["sessions:read", "sessions:write"],
            claims={"sub": principal.key_id, "key_id": principal.key_id},
        )


def authorize_entra_access_token(
    access_token: AccessToken,
    *,
    tenant_id: str,
    required_role: str,
) -> AccessToken:
    """Validate Entra identity and role claims and return a stable user principal."""

    expected_tenant = tenant_id.strip().lower()
    expected_role = required_role.strip()
    if not expected_tenant:
        raise AuthConfigurationError("SESSION_SHARE_ENTRA_TENANT_ID is required")
    if not expected_role:
        raise AuthConfigurationError("SESSION_SHARE_REQUIRED_ROLE is required")

    claims = dict(access_token.claims or {})
    identity_claims = entra_identity_claims(access_token)
    actual_tenant = str(identity_claims.get("tid") or "").strip().lower()
    object_id = str(identity_claims.get("oid") or "").strip().lower()
    if actual_tenant != expected_tenant or not object_id:
        raise AuthenticationError("Entra token identity claims are invalid")

    require_entra_role(
        access_token,
        tenant_id=expected_tenant,
        required_role=expected_role,
    )

    return access_token.model_copy(
        update={
            "client_id": f"{actual_tenant}:{object_id}",
            "subject": object_id,
            "claims": claims,
        }
    )


def require_entra_role(
    access_token: AccessToken,
    *,
    tenant_id: str,
    required_role: str,
) -> None:
    """Require one application role without changing the authenticated identity."""

    expected_tenant = tenant_id.strip().lower()
    expected_role = required_role.strip()
    if not expected_tenant:
        raise AuthConfigurationError("SESSION_SHARE_ENTRA_TENANT_ID is required")
    if not expected_role:
        raise AuthConfigurationError("required Entra application role is empty")
    identity_claims = entra_identity_claims(access_token)
    actual_tenant = str(identity_claims.get("tid") or "").strip().lower()
    object_id = str(identity_claims.get("oid") or "").strip().lower()
    if actual_tenant != expected_tenant or not object_id:
        raise AuthenticationError("Entra token identity claims are invalid")
    raw_roles = identity_claims.get("roles")
    roles = (
        {str(role) for role in raw_roles}
        if isinstance(raw_roles, list)
        else {str(raw_roles)}
        if isinstance(raw_roles, str)
        else set()
    )
    if expected_role not in roles:
        raise AuthorizationError(
            f"authenticated user requires the {expected_role!r} application role"
        )


def entra_identity_claims(access_token: AccessToken) -> dict[str, Any]:
    """Return the upstream Entra claims represented by an access token."""

    claims = dict(access_token.claims or {})
    upstream_claims = claims.get("upstream_claims")
    if not claims.get("tid") and isinstance(upstream_claims, dict):
        return dict(upstream_claims)
    return claims


def entra_user_email(access_token: AccessToken) -> str:
    """Return the best available Entra username/email claim for display and audit."""

    claims = entra_identity_claims(access_token)
    for claim_name in ("preferred_username", "email", "upn"):
        value = claims.get(claim_name)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    return ""


class EntraRoleTokenVerifier(TokenVerifier):
    """Validate Entra JWTs and require a delegated scope plus application role."""

    def __init__(
        self,
        *,
        tenant_id: str,
        app_id: str,
        required_role: str,
        required_scope: str = "access_as_user",
        token_verifier: TokenVerifier | None = None,
    ) -> None:
        self.tenant_id = tenant_id.strip().lower()
        self.app_id = app_id.strip().lower()
        self.required_role = required_role.strip()
        self.required_scope = required_scope.strip()
        if not self.tenant_id:
            raise AuthConfigurationError("SESSION_SHARE_ENTRA_TENANT_ID is required")
        if not self.app_id:
            raise AuthConfigurationError("SESSION_SHARE_ENTRA_APP_ID is required")
        if not self.required_role:
            raise AuthConfigurationError("SESSION_SHARE_REQUIRED_ROLE is required")
        if not self.required_scope:
            raise AuthConfigurationError("SESSION_SHARE_REQUIRED_SCOPE is required")
        super().__init__(required_scopes=[self.required_scope])
        self.token_verifier = token_verifier or JWTVerifier(
            jwks_uri=(
                f"https://login.microsoftonline.com/{self.tenant_id}"
                "/discovery/v2.0/keys"
            ),
            issuer=f"https://login.microsoftonline.com/{self.tenant_id}/v2.0",
            audience=[self.app_id, f"api://{self.app_id}"],
            algorithm="RS256",
            required_scopes=[self.required_scope],
        )

    async def authenticate_token(self, token: str) -> AccessToken:
        access_token = await self.token_verifier.verify_token(token)
        if access_token is None:
            raise AuthenticationError("invalid or expired Entra access token")
        return authorize_entra_access_token(
            access_token,
            tenant_id=self.tenant_id,
            required_role=self.required_role,
        )

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            return await self.authenticate_token(token)
        except (AuthenticationError, AuthorizationError):
            return None


class EntraTrustedAppTokenVerifier(TokenVerifier):
    """Accept app-only Entra tokens from explicitly allowlisted client IDs."""

    def __init__(
        self,
        *,
        tenant_id: str,
        app_id: str,
        required_role: str,
        trusted_client_ids: list[str] | tuple[str, ...],
        token_verifier: TokenVerifier | None = None,
    ) -> None:
        self.tenant_id = tenant_id.strip().lower()
        self.app_id = app_id.strip().lower()
        self.required_role = required_role.strip()
        self.trusted_client_ids = {
            value.strip().lower() for value in trusted_client_ids if value.strip()
        }
        super().__init__(required_scopes=[])
        self.token_verifier = token_verifier or JWTVerifier(
            jwks_uri=(
                f"https://login.microsoftonline.com/{self.tenant_id}"
                "/discovery/v2.0/keys"
            ),
            issuer=f"https://login.microsoftonline.com/{self.tenant_id}/v2.0",
            audience=[self.app_id, f"api://{self.app_id}"],
            algorithm="RS256",
            required_scopes=[],
        )

    async def verify_token(self, token: str) -> AccessToken | None:
        access_token = await self.token_verifier.verify_token(token)
        if access_token is None:
            return None
        claims = entra_identity_claims(access_token)
        client_id = str(claims.get("azp") or claims.get("appid") or "").lower()
        if client_id not in self.trusted_client_ids:
            return None
        try:
            return authorize_entra_access_token(
                access_token,
                tenant_id=self.tenant_id,
                required_role=self.required_role,
            )
        except (AuthenticationError, AuthorizationError):
            return None


class EntraCertificateAzureProvider(AzureProvider):
    """Azure OAuth proxy that authenticates token requests with a certificate."""

    def __init__(
        self,
        *,
        private_key_pem: str,
        certificate_thumbprint_sha256: str,
        certificate_thumbprint_sha1: str = "",
        **kwargs: Any,
    ) -> None:
        self._certificate_private_key = private_key_pem
        self._certificate_thumbprint_sha256 = certificate_thumbprint_sha256
        self._certificate_thumbprint_sha1 = certificate_thumbprint_sha1
        if not self._certificate_private_key.strip():
            raise AuthConfigurationError(
                "SESSION_SHARE_ENTRA_PRIVATE_KEY_B64 is required"
            )
        if not self._certificate_thumbprint_sha256.strip():
            raise AuthConfigurationError(
                "SESSION_SHARE_ENTRA_CERT_THUMBPRINT_SHA256 is required"
            )
        super().__init__(client_secret=None, **kwargs)

    def _create_upstream_oauth_client(self) -> AsyncOAuth2Client:
        headers = {"x5t#S256": self._certificate_thumbprint_sha256}
        if self._certificate_thumbprint_sha1:
            headers["x5t"] = self._certificate_thumbprint_sha1
        client = AsyncOAuth2Client(
            client_id=self._upstream_client_id,
            client_secret=self._certificate_private_key,
            token_endpoint_auth_method="private_key_jwt",
            timeout=30,
        )
        client.register_client_auth_method(
            PrivateKeyJWT(
                self._upstream_token_endpoint,
                headers=headers,
                alg="PS256",
            )
        )
        return client


class _FederatedClientAssertion:
    name = "private_key_jwt"

    def __init__(self, assertion: str) -> None:
        self.assertion = assertion

    def __call__(
        self,
        auth: Any,
        _method: str,
        uri: str,
        headers: dict[str, str],
        body: str,
    ) -> tuple[str, dict[str, str], str]:
        body = add_params_to_qs(
            body or "",
            [
                ("client_id", auth.client_id),
                (
                    "client_assertion_type",
                    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
                ),
                ("client_assertion", self.assertion),
            ],
        )
        return uri, headers, body


class EntraManagedIdentityAzureProvider(AzureProvider):
    """Azure OAuth proxy authenticated by an ACA managed-identity assertion."""

    def __init__(self, *, managed_identity_client_id: str, **kwargs: Any) -> None:
        self._managed_identity_client_id = managed_identity_client_id.strip()
        if not self._managed_identity_client_id:
            raise AuthConfigurationError(
                "SESSION_SHARE_MANAGED_IDENTITY_CLIENT_ID is required"
            )
        super().__init__(client_secret=None, **kwargs)

    @asynccontextmanager
    async def _upstream_oauth_client(self) -> AsyncIterator[AsyncOAuth2Client]:
        credential = ManagedIdentityCredential(
            client_id=self._managed_identity_client_id
        )
        client: AsyncOAuth2Client | None = None
        try:
            assertion = await credential.get_token(
                "api://AzureADTokenExchange/.default"
            )
            client = AsyncOAuth2Client(
                client_id=self._upstream_client_id,
                token_endpoint_auth_method="private_key_jwt",
                timeout=30,
            )
            client.register_client_auth_method(
                _FederatedClientAssertion(assertion.token)
            )
            yield client
        finally:
            if client is not None:
                await client.aclose()
            await credential.close()


def create_entra_oauth_provider(
    *,
    tenant_id: str,
    app_id: str,
    client_secret: str = "",
    certificate_private_key: str = "",
    certificate_thumbprint_sha256: str = "",
    certificate_thumbprint_sha1: str = "",
    managed_identity_client_id: str = "",
    jwt_signing_key: str | bytes | None = None,
    base_url: str,
    required_role: str,
    required_scope: str = "access_as_user",
    accept_azure_cli_tokens: bool = True,
    trusted_app_client_ids: list[str] | tuple[str, ...] = (),
    client_storage: Any | None = None,
) -> AuthProvider:
    """Create direct MCP OAuth backed by Entra, with optional raw-token compatibility."""

    tenant_id = tenant_id.strip().lower()
    app_id = app_id.strip().lower()
    client_secret = client_secret.strip()
    base_url = base_url.strip().rstrip("/")
    required_role = required_role.strip()
    required_scope = required_scope.strip()
    if not tenant_id:
        raise AuthConfigurationError("SESSION_SHARE_ENTRA_TENANT_ID is required")
    if not app_id:
        raise AuthConfigurationError("SESSION_SHARE_ENTRA_APP_ID is required")
    if not client_secret and not certificate_private_key and not managed_identity_client_id:
        raise AuthConfigurationError(
            "an Entra client secret, certificate, or managed identity is required"
        )
    if not client_secret and jwt_signing_key is None:
        raise AuthConfigurationError(
            "SESSION_SHARE_SIGNING_KEY is required for certificate Entra OAuth"
        )
    if not base_url:
        raise AuthConfigurationError("SESSION_SHARE_PUBLIC_BASE_URL is required")
    if not required_role:
        raise AuthConfigurationError("SESSION_SHARE_REQUIRED_ROLE is required")
    if not required_scope:
        raise AuthConfigurationError("SESSION_SHARE_REQUIRED_SCOPE is required")

    common_provider_kwargs: dict[str, Any] = {
        "client_id": app_id,
        "tenant_id": tenant_id,
        "required_scopes": [required_scope],
        "base_url": base_url,
        "resource_base_url": base_url,
        "identifier_uri": f"api://{app_id}",
        "client_storage": client_storage,
        "jwt_signing_key": jwt_signing_key,
        "require_authorization_consent": "remember",
        "token_expiry_threshold_seconds": 60,
        "enable_cimd": True,
    }
    if managed_identity_client_id:
        oauth_provider = EntraManagedIdentityAzureProvider(
            managed_identity_client_id=managed_identity_client_id,
            **common_provider_kwargs,
        )
    elif certificate_private_key:
        oauth_provider = EntraCertificateAzureProvider(
            private_key_pem=certificate_private_key,
            certificate_thumbprint_sha256=certificate_thumbprint_sha256,
            certificate_thumbprint_sha1=certificate_thumbprint_sha1,
            **common_provider_kwargs,
        )
    else:
        oauth_provider = AzureProvider(
            client_secret=client_secret,
            **common_provider_kwargs,
        )
    verifiers: list[TokenVerifier] = []
    if accept_azure_cli_tokens:
        verifiers.append(
            EntraRoleTokenVerifier(
                tenant_id=tenant_id,
                app_id=app_id,
                required_role=required_role,
                required_scope=required_scope,
            )
        )
    if trusted_app_client_ids:
        verifiers.append(
            EntraTrustedAppTokenVerifier(
                tenant_id=tenant_id,
                app_id=app_id,
                required_role=required_role,
                trusted_client_ids=trusted_app_client_ids,
            )
        )
    if not verifiers:
        return oauth_provider

    return MultiAuth(
        server=oauth_provider,
        verifiers=verifiers,
    )


class AzureCliTokenProvider:
    """Acquire and cache a custom-resource token from the current ``az login``."""

    def __init__(
        self,
        resource: str,
        *,
        tenant_id: str = "",
        executable: str | None = None,
        refresh_margin_seconds: int = 300,
    ) -> None:
        self.resource = resource.strip()
        self.tenant_id = tenant_id.strip().lower()
        self.executable = executable or ("az.cmd" if os.name == "nt" else "az")
        self.refresh_margin_seconds = refresh_margin_seconds
        self._cached: AzureCliAccessToken | None = None
        self._lock = threading.Lock()
        if not self.resource:
            raise AuthConfigurationError(
                "provide --entra-resource or set CODEX_SESSION_SHARE_ENTRA_RESOURCE"
            )

    def get_token(self) -> AzureCliAccessToken:
        with self._lock:
            now = int(time.time())
            if (
                self._cached is not None
                and self._cached.expires_at - self.refresh_margin_seconds > now
            ):
                return self._cached
            completed = subprocess.run(
                [
                    self.executable,
                    "account",
                    "get-access-token",
                    "--resource",
                    self.resource,
                    "--output",
                    "json",
                ],
                capture_output=True,
                text=True,
            )
            if completed.returncode != 0:
                detail = completed.stderr.strip() or completed.stdout.strip()
                raise AzureCliCredentialError(
                    "unable to obtain an Entra token from Azure CLI; run `az login` first"
                    + (f": {detail}" if detail else "")
                )
            try:
                payload = json.loads(completed.stdout)
                token = str(payload["accessToken"]).strip()
                expires_at = int(payload["expires_on"])
                tenant_id = str(payload["tenant"]).strip().lower()
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                raise AzureCliCredentialError(
                    "Azure CLI returned an invalid access-token response"
                ) from exc
            if not token:
                raise AzureCliCredentialError("Azure CLI returned an empty access token")
            if self.tenant_id and tenant_id != self.tenant_id:
                raise AzureCliCredentialError(
                    f"Azure CLI is logged into tenant {tenant_id}, expected {self.tenant_id}"
                )
            self._cached = AzureCliAccessToken(
                token=token,
                expires_at=expires_at,
                tenant_id=tenant_id,
            )
            return self._cached


class AzureCliBearerAuth(httpx.Auth):
    """HTTPX bearer authentication backed by :class:`AzureCliTokenProvider`."""

    def __init__(self, provider: AzureCliTokenProvider) -> None:
        self.provider = provider

    def auth_flow(self, request: httpx.Request):
        request.headers["Authorization"] = f"Bearer {self.provider.get_token().token}"
        yield request


class StaticBearerAuth(httpx.Auth):
    """HTTPX bearer authentication used by the legacy API-key fallback."""

    def __init__(self, token: str) -> None:
        self.token = token

    def auth_flow(self, request: httpx.Request):
        request.headers["Authorization"] = f"Bearer {self.token}"
        yield request
