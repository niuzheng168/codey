from __future__ import annotations

import hashlib
import json
import subprocess
import time
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx
import pytest
from fastmcp import FastMCP
from fastmcp.server.auth import AccessToken, MultiAuth
from fastmcp.server.auth.providers.azure import AzureProvider
from fastmcp.server.auth.providers.jwt import StaticTokenVerifier
from key_value.aio.stores.memory import MemoryStore

from codex_session_share.auth import (
    ApiKeyRegistry,
    AuthConfigurationError,
    AuthorizationError,
    AzureCliBearerAuth,
    AzureCliTokenProvider,
    EntraManagedIdentityAzureProvider,
    EntraRoleTokenVerifier,
    HashedApiKeyVerifier,
    authorize_entra_access_token,
    create_entra_oauth_provider,
    entra_user_email,
    require_entra_role,
)


@pytest.mark.asyncio
async def test_hashed_api_key_registry_and_fastmcp_verifier() -> None:
    alice_key = "alice-secret-key"
    bob_key = "bob-secret-key"
    registry = ApiKeyRegistry(
        {
            "alice": hashlib.sha256(alice_key.encode()).hexdigest(),
            "bob": f"sha256:{hashlib.sha256(bob_key.encode()).hexdigest()}",
        }
    )

    assert registry.authenticate(alice_key).key_id == "alice"
    assert registry.authenticate(bob_key).key_id == "bob"
    assert registry.authenticate("wrong") is None
    assert registry.authenticate_headers({"authorization": f"Bearer {alice_key}"}).key_id == "alice"
    assert registry.authenticate_headers({"x-api-key": bob_key}).key_id == "bob"

    verifier = HashedApiKeyVerifier(registry)
    token = await verifier.verify_token(alice_key)
    assert token is not None
    assert token.client_id == "alice"
    assert await verifier.verify_token("wrong") is None


def test_registry_rejects_invalid_hash() -> None:
    with pytest.raises(AuthConfigurationError):
        ApiKeyRegistry({"bad": "not-a-sha256"})


@pytest.mark.asyncio
async def test_entra_verifier_requires_expected_tenant_scope_and_role() -> None:
    inner = StaticTokenVerifier(
        {
            "valid": {
                "client_id": "azure-cli",
                "scopes": ["access_as_user"],
                "tid": "tenant-1",
                "oid": "user-1",
                "roles": ["SessionShare.Contributor"],
            },
            "missing-role": {
                "client_id": "azure-cli",
                "scopes": ["access_as_user"],
                "tid": "tenant-1",
                "oid": "user-1",
                "roles": [],
            },
            "wrong-tenant": {
                "client_id": "azure-cli",
                "scopes": ["access_as_user"],
                "tid": "other-tenant",
                "oid": "user-1",
                "roles": ["SessionShare.Contributor"],
            },
        },
        required_scopes=["access_as_user"],
    )
    verifier = EntraRoleTokenVerifier(
        tenant_id="tenant-1",
        app_id="app-1",
        required_role="SessionShare.Contributor",
        token_verifier=inner,
    )
    access_token = await verifier.authenticate_token("valid")
    assert access_token.client_id == "tenant-1:user-1"
    assert access_token.scopes == ["access_as_user"]

    with pytest.raises(AuthorizationError, match="application role"):
        await verifier.authenticate_token("missing-role")
    assert await verifier.verify_token("missing-role") is None
    assert await verifier.verify_token("wrong-tenant") is None


def test_entra_role_authorization_supports_oauth_proxy_claims() -> None:
    token = AccessToken(
        token="oauth-token",
        client_id="upstream-client",
        scopes=["access_as_user"],
        claims={
            "upstream_claims": {
                "tid": "tenant-1",
                "oid": "user-1",
                "roles": ["SessionShare.Contributor"],
                "preferred_username": "User.One@Microsoft.com",
            }
        },
    )

    authorized = authorize_entra_access_token(
        token,
        tenant_id="tenant-1",
        required_role="SessionShare.Contributor",
    )

    assert authorized.client_id == "tenant-1:user-1"
    assert authorized.subject == "user-1"
    assert entra_user_email(authorized) == "user.one@microsoft.com"
    require_entra_role(
        authorized,
        tenant_id="tenant-1",
        required_role="SessionShare.Contributor",
    )
    with pytest.raises(AuthorizationError, match="SessionShare.Admin"):
        require_entra_role(
            authorized,
            tenant_id="tenant-1",
            required_role="SessionShare.Admin",
        )

    refreshed_claims = token.model_copy(
        update={
            "claims": {
                "tid": "tenant-1",
                "oid": "user-2",
                "roles": ["SessionShare.Contributor"],
                "upstream_claims": {
                    "tid": "tenant-1",
                    "oid": "stale-user",
                    "roles": [],
                },
            }
        }
    )
    assert (
        authorize_entra_access_token(
            refreshed_claims,
            tenant_id="tenant-1",
            required_role="SessionShare.Contributor",
        ).client_id
        == "tenant-1:user-2"
    )

    missing_role = token.model_copy(
        update={
            "claims": {
                "upstream_claims": {
                    "tid": "tenant-1",
                    "oid": "user-1",
                    "roles": [],
                }
            }
        }
    )
    with pytest.raises(AuthorizationError, match="application role"):
        authorize_entra_access_token(
            missing_role,
            tenant_id="tenant-1",
            required_role="SessionShare.Contributor",
        )


@pytest.mark.asyncio
async def test_entra_oauth_provider_advertises_codex_compatible_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeManagedIdentityCredential:
        def __init__(self, *, client_id: str) -> None:
            assert client_id == "managed-identity-client"

        async def get_token(self, scope: str) -> SimpleNamespace:
            assert scope == "api://AzureADTokenExchange/.default"
            return SimpleNamespace(token="managed-identity-assertion")

        async def close(self) -> None:
            return None

    monkeypatch.setattr(
        "codex_session_share.auth.ManagedIdentityCredential",
        FakeManagedIdentityCredential,
    )
    provider = create_entra_oauth_provider(
        tenant_id="72f988bf-86f1-41af-91ab-2d7cd011db47",
        app_id="11111111-1111-1111-1111-111111111111",
        managed_identity_client_id="managed-identity-client",
        jwt_signing_key=b"s" * 32,
        base_url="https://session-share.example",
        required_role="SessionShare.Contributor",
        required_scope="access_as_user",
        accept_azure_cli_tokens=True,
        client_storage=MemoryStore(),
    )
    assert isinstance(provider, MultiAuth)
    assert isinstance(provider.server, EntraManagedIdentityAzureProvider)
    assert isinstance(provider.server, AzureProvider)
    async with provider.server._upstream_oauth_client() as upstream_client:
        assert upstream_client.client_secret is None
        assert upstream_client.token_endpoint_auth_method == "private_key_jwt"
        auth_method = upstream_client._auth_methods["private_key_jwt"]
        _uri, _headers, request_body = auth_method(
            upstream_client,
            "POST",
            provider.server._upstream_token_endpoint,
            {},
            "grant_type=authorization_code&code=test",
        )
    assert (
        parse_qs(request_body)["client_assertion"][0]
        == "managed-identity-assertion"
    )
    assert parse_qs(request_body)["client_id"] == [
        "11111111-1111-1111-1111-111111111111"
    ]

    app = FastMCP("OAuth metadata test", auth=provider).http_app(
        path="/mcp",
        stateless_http=True,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="https://session-share.example",
    ) as client:
        auth_metadata = (
            await client.get("/.well-known/oauth-authorization-server")
        ).json()
        resource_metadata = (
            await client.get("/.well-known/oauth-protected-resource/mcp")
        ).json()
        registration = await client.post(
            "/register",
            json={
                "client_name": "Codex",
                "redirect_uris": ["http://127.0.0.1:49152/callback"],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            },
        )
        registered_client = registration.json()
        authorization = await client.get(
            "/authorize",
            params={
                "response_type": "code",
                "client_id": registered_client["client_id"],
                "redirect_uri": "http://127.0.0.1:49152/callback",
                "scope": "access_as_user",
                "state": "test-state",
                "code_challenge": "A" * 43,
                "code_challenge_method": "S256",
                "resource": "https://session-share.example/mcp",
            },
        )

    assert auth_metadata["authorization_endpoint"] == (
        "https://session-share.example/authorize"
    )
    assert auth_metadata["registration_endpoint"] == (
        "https://session-share.example/register"
    )
    assert auth_metadata["code_challenge_methods_supported"] == ["S256"]
    assert auth_metadata["client_id_metadata_document_supported"] is True
    assert resource_metadata == {
        "resource": "https://session-share.example/mcp",
        "authorization_servers": ["https://session-share.example/"],
        "scopes_supported": ["access_as_user"],
        "bearer_methods_supported": ["header"],
    }
    assert registration.status_code == 201
    assert registered_client["token_endpoint_auth_method"] == "none"
    assert registered_client["scope"] == "access_as_user"
    assert authorization.status_code == 302
    assert authorization.headers["location"].startswith(
        "https://session-share.example/consent?txn_id="
    )


@pytest.mark.asyncio
async def test_async_azure_identity_transport_is_installed() -> None:
    from azure.core.pipeline.transport import AioHttpTransport

    transport = AioHttpTransport()
    await transport.close()


def test_azure_cli_token_provider_caches_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    def run(arguments: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(arguments)
        return subprocess.CompletedProcess(
            arguments,
            0,
            stdout=json.dumps(
                {
                    "accessToken": "entra-token",
                    "expires_on": int(time.time()) + 3600,
                    "tenant": "tenant-1",
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", run)
    provider = AzureCliTokenProvider(
        "api://session-share",
        tenant_id="tenant-1",
    )

    assert provider.get_token().token == "entra-token"
    assert provider.get_token().token == "entra-token"
    assert calls == [
        [
            provider.executable,
            "account",
            "get-access-token",
            "--resource",
            "api://session-share",
            "--output",
            "json",
        ]
    ]

    request = httpx.Request("GET", "https://session-share.example/mcp")
    flow = AzureCliBearerAuth(provider).auth_flow(request)
    authenticated = next(flow)
    assert authenticated.headers["Authorization"] == "Bearer entra-token"
