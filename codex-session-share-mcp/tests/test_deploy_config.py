from __future__ import annotations

import tomllib
from pathlib import Path


def test_generated_client_template_uses_direct_oauth_http() -> None:
    config_path = (
        Path(__file__).resolve().parents[1] / "deploy" / "aca" / "client-config.toml"
    )
    config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    server = config["mcp_servers"]["session_share"]

    assert server["url"] == "https://REPLACE_WITH_APP_FQDN/mcp"
    assert server["auth"] == "oauth"
    assert "command" not in server
    assert "bearer_token_env_var" not in server


def test_deployment_defaults_to_cig_speech_and_reuses_existing_group() -> None:
    deploy_path = (
        Path(__file__).resolve().parents[1] / "deploy" / "aca" / "deploy.sh"
    )
    deploy = deploy_path.read_text(encoding="utf-8")

    assert (
        'SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-'
        '42b416ee-e2a0-44b2-b016-db59f7a1e8f2}"'
    ) in deploy
    assert 'RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-zhn-devbox}"' in deploy
    assert "if ! az group show" in deploy
    assert "session-share-aca-mi-${RESOURCE_SUFFIX}" in deploy
    assert (
        'ENTRA_ADMIN_ROLE_VALUE="${SESSION_SHARE_ENTRA_ADMIN_ROLE_VALUE:'
        '-SessionShare.Admin}"'
    ) in deploy
    assert "az ad signed-in-user show --query id" in deploy
    assert '"name": "SESSION_SHARE_ADMIN_ROLE"' in deploy
    assert 'SEARCH_SERVICE_NAME="${SESSION_SHARE_SEARCH_SERVICE_NAME:-' in deploy
    assert 'OPENAI_ACCOUNT_NAME="${SESSION_SHARE_OPENAI_ACCOUNT_NAME:-' in deploy
    assert "--sku basic" in deploy
    assert "text-embedding-3-large" in deploy
    assert "Search Index Data Contributor" in deploy
    assert "Search Index Data Reader" in deploy
    assert "Search Service Contributor" in deploy
    assert "Cognitive Services OpenAI User" in deploy
    assert '"name": "SESSION_SHARE_SEARCH_ENDPOINT"' in deploy
