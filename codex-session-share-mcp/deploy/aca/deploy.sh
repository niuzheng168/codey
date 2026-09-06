#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-42b416ee-e2a0-44b2-b016-db59f7a1e8f2}"
LOCATION="${AZURE_LOCATION:-japaneast}"
RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-zhn-devbox}"
APP_NAME="${ACA_APP_NAME:-codex-session-share}"
ENVIRONMENT_NAME="${ACA_ENVIRONMENT_NAME:-codex-session-share-env-jpe}"
IDENTITY_NAME="${ACA_IDENTITY_NAME:-codex-session-share-mi}"
WORKLOAD_PROFILE_NAME="${ACA_WORKLOAD_PROFILE_NAME:-share-d8}"
WORKLOAD_PROFILE_TYPE="${ACA_WORKLOAD_PROFILE_TYPE:-D8}"
OLD_WORKLOAD_PROFILE_NAME="${ACA_OLD_WORKLOAD_PROFILE_NAME:-share-e32}"
CONTAINER_CPU="${ACA_CONTAINER_CPU:-8}"
CONTAINER_MEMORY="${ACA_CONTAINER_MEMORY:-16Gi}"
MIN_NODES="${ACA_MIN_NODES:-1}"
MAX_NODES="${ACA_MAX_NODES:-1}"
MAX_ARCHIVE_BYTES="${SESSION_SHARE_MAX_ARCHIVE_BYTES:-2147483648}"
IMAGE_TAG="${ACA_IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
REVISION_SUFFIX="${ACA_REVISION_SUFFIX:-r$(date -u +%Y%m%d%H%M%S)}"
SKIP_BUILD="${ACA_SKIP_BUILD:-false}"

RESOURCE_SUFFIX="$(
  printf '%s' "${SUBSCRIPTION_ID}" | sha256sum | cut -c1-10
)"
ACR_NAME="${ACA_ACR_NAME:-codexshare${RESOURCE_SUFFIX}}"
STORAGE_ACCOUNT="${ACA_STORAGE_ACCOUNT:-codexshr${RESOURCE_SUFFIX}}"
FILE_SHARE="${ACA_FILE_SHARE:-session-data}"
ENV_STORAGE_NAME="${ACA_ENV_STORAGE_NAME:-sessiondata}"
SEARCH_SERVICE_NAME="${SESSION_SHARE_SEARCH_SERVICE_NAME:-codexsearch${RESOURCE_SUFFIX}}"
SEARCH_INDEX_NAME="${SESSION_SHARE_SEARCH_INDEX_NAME:-codex-session-history-v1}"
OPENAI_ACCOUNT_NAME="${SESSION_SHARE_OPENAI_ACCOUNT_NAME:-codexembed${RESOURCE_SUFFIX}}"
EMBEDDING_DEPLOYMENT_NAME="${SESSION_SHARE_EMBEDDING_DEPLOYMENT:-text-embedding-3-large}"
EMBEDDING_MODEL_NAME="${SESSION_SHARE_EMBEDDING_MODEL_NAME:-text-embedding-3-large}"
EMBEDDING_MODEL_VERSION="${SESSION_SHARE_EMBEDDING_MODEL_VERSION:-1}"
EMBEDDING_DIMENSIONS="${SESSION_SHARE_EMBEDDING_DIMENSIONS:-3072}"
EMBEDDING_CAPACITY="${SESSION_SHARE_EMBEDDING_CAPACITY:-350}"

CONFIG_DIR="${SESSION_SHARE_CONFIG_DIR:-${HOME}/.config/codex-session-share}"
CLIENT_ENV_FILE="${SESSION_SHARE_CLIENT_ENV_FILE:-${CONFIG_DIR}/client.env}"
CLIENT_CONFIG_FILE="${SESSION_SHARE_CLIENT_CONFIG_FILE:-${CONFIG_DIR}/client-config.toml}"
DEPLOYMENT_FILE="${SESSION_SHARE_DEPLOYMENT_FILE:-${CONFIG_DIR}/deployment.json}"
mkdir -p "${CONFIG_DIR}"
chmod 0700 "${CONFIG_DIR}"

TENANT_ID="$(az account show --subscription "${SUBSCRIPTION_ID}" --query tenantId -o tsv)"
ENTRA_APP_DISPLAY_NAME="${SESSION_SHARE_ENTRA_APP_DISPLAY_NAME:-codex-session-share-${RESOURCE_SUFFIX}}"
ENTRA_APP_ID="${SESSION_SHARE_ENTRA_APP_ID:-}"
ENTRA_GROUP_ID="${SESSION_SHARE_ENTRA_GROUP_ID:-4adec457-1c72-43b3-b6d1-bb390788dc69}"
ENTRA_ROLE_DISPLAY_NAME="${SESSION_SHARE_ENTRA_ROLE_DISPLAY_NAME:-Session Share Contributor}"
ENTRA_ROLE_VALUE="${SESSION_SHARE_ENTRA_ROLE_VALUE:-SessionShare.Contributor}"
ENTRA_ADMIN_ROLE_DISPLAY_NAME="${SESSION_SHARE_ENTRA_ADMIN_ROLE_DISPLAY_NAME:-Session Share Admin}"
ENTRA_ADMIN_ROLE_VALUE="${SESSION_SHARE_ENTRA_ADMIN_ROLE_VALUE:-SessionShare.Admin}"
ENTRA_ADMIN_PRINCIPAL_ID="${SESSION_SHARE_ENTRA_ADMIN_PRINCIPAL_ID:-}"
ENTRA_SCOPE_VALUE="${SESSION_SHARE_ENTRA_SCOPE_VALUE:-access_as_user}"
ENTRA_FEDERATED_CREDENTIAL_NAME="${SESSION_SHARE_ENTRA_FEDERATED_CREDENTIAL_NAME:-session-share-aca-mi-${RESOURCE_SUFFIX}}"
SERVICE_MANAGEMENT_REFERENCE="${SESSION_SHARE_SERVICE_MANAGEMENT_REFERENCE:-60f68487-af6c-49c0-a045-53fc7b4127da}"
AZURE_CLI_CLIENT_ID="04b07795-8ddb-461a-bbee-02f9e1bf7b46"

if [[ -z "${ENTRA_APP_ID}" && -f "${DEPLOYMENT_FILE}" ]]; then
  ENTRA_APP_ID="$(python3 - "${DEPLOYMENT_FILE}" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
try:
    print(json.loads(path.read_text(encoding="utf-8")).get("entra_app_id", ""))
except (OSError, json.JSONDecodeError):
    print("")
PY
)"
fi

SIGNING_KEY="${SESSION_SHARE_SIGNING_KEY:-}"

az account show --subscription "${SUBSCRIPTION_ID}" --output none
if [[ -z "${ENTRA_ADMIN_PRINCIPAL_ID}" ]]; then
  ENTRA_ADMIN_PRINCIPAL_ID="$(az ad signed-in-user show --query id -o tsv)"
fi
if [[ -z "${ENTRA_ADMIN_PRINCIPAL_ID}" ]]; then
  echo "Unable to resolve the signed-in Entra user for SessionShare.Admin" >&2
  exit 1
fi

if [[ -z "${ENTRA_APP_ID}" ]]; then
  mapfile -t MATCHING_ENTRA_APPS < <(
    az ad app list \
      --display-name "${ENTRA_APP_DISPLAY_NAME}" \
      --query "[?displayName=='${ENTRA_APP_DISPLAY_NAME}'].appId" -o tsv
  )
  if [[ "${#MATCHING_ENTRA_APPS[@]}" -gt 1 ]]; then
    echo "Multiple Entra applications are named ${ENTRA_APP_DISPLAY_NAME}" >&2
    exit 1
  fi
  if [[ "${#MATCHING_ENTRA_APPS[@]}" == "1" ]]; then
    ENTRA_APP_ID="${MATCHING_ENTRA_APPS[0]}"
  else
    ENTRA_APP_ID="$(az ad app create \
      --display-name "${ENTRA_APP_DISPLAY_NAME}" \
      --sign-in-audience AzureADMyOrg \
      --service-management-reference "${SERVICE_MANAGEMENT_REFERENCE}" \
      --query appId -o tsv)"
  fi
fi

if ! az ad sp show --id "${ENTRA_APP_ID}" >/dev/null 2>&1; then
  az ad sp create --id "${ENTRA_APP_ID}" --output none
fi

ENTRA_APP_OBJECT_ID="$(az ad app show --id "${ENTRA_APP_ID}" --query id -o tsv)"
ENTRA_SP_OBJECT_ID="$(az ad sp show --id "${ENTRA_APP_ID}" --query id -o tsv)"
if [[ "$(az ad group show --group "${ENTRA_GROUP_ID}" --query securityEnabled -o tsv)" \
  != "true" ]]; then
  echo "Entra group ${ENTRA_GROUP_ID} is not security-enabled" >&2
  exit 1
fi
ENTRA_CURRENT="$(mktemp /tmp/codex-session-share-entra-current.XXXXXX.json)"
ENTRA_PATCH="$(mktemp /tmp/codex-session-share-entra.XXXXXX.json)"
export \
  AZURE_CLI_CLIENT_ID ENTRA_APP_ID ENTRA_ROLE_DISPLAY_NAME ENTRA_ROLE_VALUE \
  ENTRA_ADMIN_ROLE_DISPLAY_NAME ENTRA_ADMIN_ROLE_VALUE \
  ENTRA_SCOPE_VALUE SERVICE_MANAGEMENT_REFERENCE
az ad app show --id "${ENTRA_APP_ID}" -o json >"${ENTRA_CURRENT}"
python3 - "${ENTRA_CURRENT}" "${ENTRA_PATCH}" <<'PY'
import json
import os
from pathlib import Path
import sys
import uuid

source = Path(sys.argv[1])
path = Path(sys.argv[2])
application = json.loads(source.read_text(encoding="utf-8"))
api = dict(application.get("api") or {})
scopes = list(api.get("oauth2PermissionScopes") or [])
scope_value = os.environ["ENTRA_SCOPE_VALUE"]
scope = next((item for item in scopes if item.get("value") == scope_value), None)
if scope is None:
    scope = {
        "id": str(uuid.uuid4()),
        "adminConsentDescription": "Access the Codex Session Share MCP server",
        "adminConsentDisplayName": "Access Codex Session Share",
        "isEnabled": True,
        "type": "User",
        "userConsentDescription": "Access the Codex Session Share MCP server",
        "userConsentDisplayName": "Access Codex Session Share",
        "value": scope_value,
    }
    scopes.append(scope)
else:
    scope["isEnabled"] = True

roles = list(application.get("appRoles") or [])

def ensure_role(value: str, display_name: str, description: str) -> None:
    role = next((item for item in roles if item.get("value") == value), None)
    desired = {
        "allowedMemberTypes": ["User"],
        "description": description,
        "displayName": display_name,
        "isEnabled": True,
        "value": value,
    }
    if role is None:
        roles.append({"id": str(uuid.uuid4()), **desired})
    else:
        role.update(desired)

ensure_role(
    os.environ["ENTRA_ROLE_VALUE"],
    os.environ["ENTRA_ROLE_DISPLAY_NAME"],
    "Upload and download shared Codex sessions",
)
ensure_role(
    os.environ["ENTRA_ADMIN_ROLE_VALUE"],
    os.environ["ENTRA_ADMIN_ROLE_DISPLAY_NAME"],
    "Rename, trash, restore, and permanently purge shared Codex sessions",
)

body = {
    "identifierUris": [f"api://{os.environ['ENTRA_APP_ID']}"],
    "serviceManagementReference": os.environ["SERVICE_MANAGEMENT_REFERENCE"],
    "api": {
        "oauth2PermissionScopes": scopes,
        "preAuthorizedApplications": list(api.get("preAuthorizedApplications") or []),
        "requestedAccessTokenVersion": 2,
    },
    "appRoles": roles,
}
path.write_text(json.dumps(body), encoding="utf-8")
PY
az rest \
  --method patch \
  --uri "https://graph.microsoft.com/v1.0/applications/${ENTRA_APP_OBJECT_ID}" \
  --headers "Content-Type=application/json" \
  --body "@${ENTRA_PATCH}" \
  --output none
python3 - "${ENTRA_CURRENT}" "${ENTRA_PATCH}" <<'PY'
from pathlib import Path
import sys
for value in sys.argv[1:]:
    Path(value).unlink(missing_ok=True)
PY

ENTRA_SCOPE_ID="$(az ad app show \
  --id "${ENTRA_APP_ID}" \
  --query "api.oauth2PermissionScopes[?value=='${ENTRA_SCOPE_VALUE}'] | [0].id" -o tsv)"
if [[ -z "${ENTRA_SCOPE_ID}" ]]; then
  echo "Unable to resolve the ${ENTRA_SCOPE_VALUE} delegated scope" >&2
  exit 1
fi

ENTRA_PREAUTH_CURRENT="$(mktemp /tmp/codex-session-share-preauth-current.XXXXXX.json)"
ENTRA_PREAUTH_PATCH="$(mktemp /tmp/codex-session-share-preauth.XXXXXX.json)"
az ad app show --id "${ENTRA_APP_ID}" -o json >"${ENTRA_PREAUTH_CURRENT}"
AZURE_CLI_CLIENT_ID="${AZURE_CLI_CLIENT_ID}" \
ENTRA_SCOPE_ID="${ENTRA_SCOPE_ID}" \
python3 - "${ENTRA_PREAUTH_CURRENT}" "${ENTRA_PREAUTH_PATCH}" <<'PY'
import json
import os
from pathlib import Path
import sys

application = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
api = dict(application.get("api") or {})
preauthorized = list(api.get("preAuthorizedApplications") or [])
client_id = os.environ["AZURE_CLI_CLIENT_ID"]
scope_id = os.environ["ENTRA_SCOPE_ID"]
azure_cli = next(
    (item for item in preauthorized if item.get("appId") == client_id),
    None,
)
if azure_cli is None:
    preauthorized.append(
        {
            "appId": client_id,
            "delegatedPermissionIds": [scope_id],
        }
    )
else:
    delegated = list(azure_cli.get("delegatedPermissionIds") or [])
    if scope_id not in delegated:
        delegated.append(scope_id)
    azure_cli["delegatedPermissionIds"] = delegated

Path(sys.argv[2]).write_text(
    json.dumps({"api": {"preAuthorizedApplications": preauthorized}}),
    encoding="utf-8",
)
PY
az rest \
  --method patch \
  --uri "https://graph.microsoft.com/v1.0/applications/${ENTRA_APP_OBJECT_ID}" \
  --headers "Content-Type=application/json" \
  --body "@${ENTRA_PREAUTH_PATCH}" \
  --output none
python3 - "${ENTRA_PREAUTH_CURRENT}" "${ENTRA_PREAUTH_PATCH}" <<'PY'
from pathlib import Path
import sys
for value in sys.argv[1:]:
    Path(value).unlink(missing_ok=True)
PY

ENTRA_ROLE_ID="$(az ad app show \
  --id "${ENTRA_APP_ID}" \
  --query "appRoles[?value=='${ENTRA_ROLE_VALUE}'] | [0].id" -o tsv)"
if [[ -z "${ENTRA_ROLE_ID}" ]]; then
  echo "Unable to resolve the ${ENTRA_ROLE_VALUE} Entra application role" >&2
  exit 1
fi

if [[ "$(az rest \
  --method get \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${ENTRA_SP_OBJECT_ID}/appRoleAssignedTo?\$top=999" \
  --query "value[?principalId=='${ENTRA_GROUP_ID}' && appRoleId=='${ENTRA_ROLE_ID}'] | length(@)" \
  -o tsv)" == "0" ]]; then
  az rest \
    --method post \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${ENTRA_SP_OBJECT_ID}/appRoleAssignedTo" \
    --headers "Content-Type=application/json" \
    --body "{
      \"principalId\": \"${ENTRA_GROUP_ID}\",
      \"resourceId\": \"${ENTRA_SP_OBJECT_ID}\",
      \"appRoleId\": \"${ENTRA_ROLE_ID}\"
    }" \
    --output none
fi

ENTRA_ADMIN_ROLE_ID="$(az ad app show \
  --id "${ENTRA_APP_ID}" \
  --query "appRoles[?value=='${ENTRA_ADMIN_ROLE_VALUE}'] | [0].id" -o tsv)"
if [[ -z "${ENTRA_ADMIN_ROLE_ID}" ]]; then
  echo "Unable to resolve the ${ENTRA_ADMIN_ROLE_VALUE} Entra application role" >&2
  exit 1
fi
if [[ "$(az rest \
  --method get \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${ENTRA_SP_OBJECT_ID}/appRoleAssignedTo?\$top=999" \
  --query "value[?principalId=='${ENTRA_ADMIN_PRINCIPAL_ID}' && appRoleId=='${ENTRA_ADMIN_ROLE_ID}'] | length(@)" \
  -o tsv)" == "0" ]]; then
  az rest \
    --method post \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${ENTRA_SP_OBJECT_ID}/appRoleAssignedTo" \
    --headers "Content-Type=application/json" \
    --body "{
      \"principalId\": \"${ENTRA_ADMIN_PRINCIPAL_ID}\",
      \"resourceId\": \"${ENTRA_SP_OBJECT_ID}\",
      \"appRoleId\": \"${ENTRA_ADMIN_ROLE_ID}\"
    }" \
    --output none
fi

for provider in \
  Microsoft.App \
  Microsoft.ContainerRegistry \
  Microsoft.ManagedIdentity \
  Microsoft.OperationalInsights \
  Microsoft.Search \
  Microsoft.CognitiveServices \
  Microsoft.Storage; do
  az provider register \
    --subscription "${SUBSCRIPTION_ID}" \
    --namespace "${provider}" \
    --wait \
    --output none
done

if ! az group show \
  --subscription "${SUBSCRIPTION_ID}" \
  --name "${RESOURCE_GROUP}" >/dev/null 2>&1; then
  az group create \
    --subscription "${SUBSCRIPTION_ID}" \
    --name "${RESOURCE_GROUP}" \
    --location "${LOCATION}" \
    --output none
fi

if ! az identity show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${IDENTITY_NAME}" >/dev/null 2>&1; then
  az identity create \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${IDENTITY_NAME}" \
    --location "${LOCATION}" \
    --output none
fi
IDENTITY_ID="$(az identity show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${IDENTITY_NAME}" \
  --query id -o tsv)"
IDENTITY_PRINCIPAL_ID="$(az identity show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${IDENTITY_NAME}" \
  --query principalId -o tsv)"
IDENTITY_CLIENT_ID="$(az identity show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${IDENTITY_NAME}" \
  --query clientId -o tsv)"

if ! az search service show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${SEARCH_SERVICE_NAME}" >/dev/null 2>&1; then
  az search service create \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${SEARCH_SERVICE_NAME}" \
    --location "${LOCATION}" \
    --sku basic \
    --partition-count 1 \
    --replica-count 1 \
    --disable-local-auth true \
    --public-network-access enabled \
    --semantic-search free \
    --output none
fi
SEARCH_SERVICE_ID="$(az search service show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${SEARCH_SERVICE_NAME}" \
  --query id -o tsv)"
SEARCH_ENDPOINT="https://${SEARCH_SERVICE_NAME}.search.windows.net"

if ! az cognitiveservices account show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${OPENAI_ACCOUNT_NAME}" >/dev/null 2>&1; then
  az cognitiveservices account create \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${OPENAI_ACCOUNT_NAME}" \
    --location "${LOCATION}" \
    --kind OpenAI \
    --sku S0 \
    --custom-domain "${OPENAI_ACCOUNT_NAME}" \
    --yes \
    --output none
fi
OPENAI_ACCOUNT_ID="$(az cognitiveservices account show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${OPENAI_ACCOUNT_NAME}" \
  --query id -o tsv)"
az resource update \
  --subscription "${SUBSCRIPTION_ID}" \
  --ids "${OPENAI_ACCOUNT_ID}" \
  --set properties.disableLocalAuth=true properties.publicNetworkAccess=Enabled \
  --output none
EMBEDDING_ENDPOINT="$(az cognitiveservices account show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${OPENAI_ACCOUNT_NAME}" \
  --query properties.endpoint -o tsv)"
az cognitiveservices account deployment create \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${OPENAI_ACCOUNT_NAME}" \
  --deployment-name "${EMBEDDING_DEPLOYMENT_NAME}" \
  --model-format OpenAI \
  --model-name "${EMBEDDING_MODEL_NAME}" \
  --model-version "${EMBEDDING_MODEL_VERSION}" \
  --sku-name Standard \
  --sku-capacity "${EMBEDDING_CAPACITY}" \
  --output none

ensure_role_assignment() {
  local assignee_object_id="$1"
  local principal_type="$2"
  local role_name="$3"
  local scope="$4"
  if [[ "$(az role assignment list \
    --subscription "${SUBSCRIPTION_ID}" \
    --scope "${scope}" \
    --assignee-object-id "${assignee_object_id}" \
    --query "[?roleDefinitionName=='${role_name}'] | length(@)" -o tsv)" == "0" ]]; then
    az role assignment create \
      --subscription "${SUBSCRIPTION_ID}" \
      --assignee-object-id "${assignee_object_id}" \
      --assignee-principal-type "${principal_type}" \
      --role "${role_name}" \
      --scope "${scope}" \
      --output none
  fi
}

ensure_role_assignment \
  "${IDENTITY_PRINCIPAL_ID}" ServicePrincipal \
  "Search Index Data Contributor" "${SEARCH_SERVICE_ID}"
ensure_role_assignment \
  "${IDENTITY_PRINCIPAL_ID}" ServicePrincipal \
  "Search Index Data Reader" "${SEARCH_SERVICE_ID}"
ensure_role_assignment \
  "${IDENTITY_PRINCIPAL_ID}" ServicePrincipal \
  "Cognitive Services OpenAI User" "${OPENAI_ACCOUNT_ID}"
ensure_role_assignment \
  "${ENTRA_ADMIN_PRINCIPAL_ID}" User \
  "Search Service Contributor" "${SEARCH_SERVICE_ID}"
ensure_role_assignment \
  "${ENTRA_ADMIN_PRINCIPAL_ID}" User \
  "Search Index Data Reader" "${SEARCH_SERVICE_ID}"
ensure_role_assignment \
  "${ENTRA_ADMIN_PRINCIPAL_ID}" User \
  "Search Index Data Contributor" "${SEARCH_SERVICE_ID}"

SEARCH_INDEX_FILE="$(mktemp /tmp/codex-session-share-search-index.XXXXXX.json)"
SEARCH_INDEX_NAME="${SEARCH_INDEX_NAME}" \
EMBEDDING_DIMENSIONS="${EMBEDDING_DIMENSIONS}" \
python3 - "${SEARCH_INDEX_FILE}" <<'PY'
import json
import os
from pathlib import Path
import sys

def field(name, type_, **kwargs):
    return {"name": name, "type": type_, **kwargs}

value = {
    "name": os.environ["SEARCH_INDEX_NAME"],
    "fields": [
        field("id", "Edm.String", key=True, filterable=True),
        field(
            "session_name",
            "Edm.String",
            searchable=True,
            filterable=True,
            facetable=True,
        ),
        field("source_session_id", "Edm.String", searchable=True, filterable=True),
        field("version_id", "Edm.String", filterable=True),
        field("state", "Edm.String", filterable=True, facetable=True),
        field("uploaded_at", "Edm.Int64", filterable=True, sortable=True),
        field("uploaded_by_email", "Edm.String", searchable=True, filterable=True),
        field("archive_size_bytes", "Edm.Int64", filterable=True),
        field("handoff_summary", "Edm.String", searchable=True),
        field("kind", "Edm.String", filterable=True, facetable=True),
        field("role", "Edm.String", filterable=True, facetable=True),
        field("message_index", "Edm.Int32", filterable=True, sortable=True),
        field("chunk_index", "Edm.Int32", filterable=True, sortable=True),
        field("timestamp", "Edm.String", filterable=True),
        field("content", "Edm.String", searchable=True),
        field(
            "content_vector",
            "Collection(Edm.Single)",
            searchable=True,
            retrievable=False,
            dimensions=int(os.environ["EMBEDDING_DIMENSIONS"]),
            vectorSearchProfile="session-vector-profile",
        ),
    ],
    "vectorSearch": {
        "algorithms": [
            {
                "name": "session-hnsw",
                "kind": "hnsw",
                "hnswParameters": {
                    "m": 4,
                    "efConstruction": 400,
                    "efSearch": 500,
                    "metric": "cosine",
                },
            }
        ],
        "profiles": [
            {
                "name": "session-vector-profile",
                "algorithm": "session-hnsw",
            }
        ],
    },
}
Path(sys.argv[1]).write_text(json.dumps(value), encoding="utf-8")
PY
for attempt in $(seq 1 30); do
  SEARCH_TOKEN="$(az account get-access-token \
    --resource https://search.azure.com \
    --tenant "${TENANT_ID}" \
    --query accessToken -o tsv)"
  if curl --fail --silent --show-error \
    --request PUT \
    --header "Authorization: Bearer ${SEARCH_TOKEN}" \
    --header "Content-Type: application/json" \
    --data "@${SEARCH_INDEX_FILE}" \
    "${SEARCH_ENDPOINT}/indexes/${SEARCH_INDEX_NAME}?api-version=2024-07-01" \
    >/dev/null; then
    break
  fi
  if [[ "${attempt}" == "30" ]]; then
    echo "Unable to create the Azure AI Search index after RBAC propagation" >&2
    exit 1
  fi
  sleep 10
done
rm -f "${SEARCH_INDEX_FILE}"

FEDERATED_CREDENTIAL_FILE="$(mktemp /tmp/codex-session-share-fic.XXXXXX.json)"
ENTRA_FEDERATED_CREDENTIAL_NAME="${ENTRA_FEDERATED_CREDENTIAL_NAME}" \
TENANT_ID="${TENANT_ID}" \
IDENTITY_PRINCIPAL_ID="${IDENTITY_PRINCIPAL_ID}" \
python3 - "${FEDERATED_CREDENTIAL_FILE}" <<'PY'
import json
import os
from pathlib import Path
import sys

Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "name": os.environ["ENTRA_FEDERATED_CREDENTIAL_NAME"],
            "issuer": f"https://login.microsoftonline.com/{os.environ['TENANT_ID']}/v2.0",
            "subject": os.environ["IDENTITY_PRINCIPAL_ID"],
            "description": "Trust the session-share ACA managed identity",
            "audiences": ["api://AzureADTokenExchange"],
        }
    ),
    encoding="utf-8",
)
PY
if az ad app federated-credential show \
  --id "${ENTRA_APP_ID}" \
  --federated-credential-id "${ENTRA_FEDERATED_CREDENTIAL_NAME}" \
  >/dev/null 2>&1; then
  az ad app federated-credential update \
    --id "${ENTRA_APP_ID}" \
    --federated-credential-id "${ENTRA_FEDERATED_CREDENTIAL_NAME}" \
    --parameters "${FEDERATED_CREDENTIAL_FILE}" \
    --output none
else
  az ad app federated-credential create \
    --id "${ENTRA_APP_ID}" \
    --parameters "${FEDERATED_CREDENTIAL_FILE}" \
    --output none
fi
python3 - "${FEDERATED_CREDENTIAL_FILE}" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).unlink(missing_ok=True)
PY

if ! az acr show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ACR_NAME}" >/dev/null 2>&1; then
  az acr create \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${ACR_NAME}" \
    --location "${LOCATION}" \
    --sku Basic \
    --admin-enabled false \
    --output none
fi
ACR_ID="$(az acr show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ACR_NAME}" \
  --query id -o tsv)"
ACR_SERVER="$(az acr show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ACR_NAME}" \
  --query loginServer -o tsv)"
if [[ "$(az role assignment list \
  --subscription "${SUBSCRIPTION_ID}" \
  --scope "${ACR_ID}" \
  --assignee-object-id "${IDENTITY_PRINCIPAL_ID}" \
  --query "[?roleDefinitionName=='AcrPull'] | length(@)" -o tsv)" == "0" ]]; then
  az role assignment create \
    --subscription "${SUBSCRIPTION_ID}" \
    --assignee-object-id "${IDENTITY_PRINCIPAL_ID}" \
    --assignee-principal-type ServicePrincipal \
    --role AcrPull \
    --scope "${ACR_ID}" \
    --output none
fi

IMAGE="${ACR_SERVER}/codex-session-share:${IMAGE_TAG}"
if [[ "${SKIP_BUILD}" != "true" ]]; then
  az acr build \
    --subscription "${SUBSCRIPTION_ID}" \
    --registry "${ACR_NAME}" \
    --image "codex-session-share:${IMAGE_TAG}" \
    --file "${ROOT}/Dockerfile" \
    "${ROOT}"
fi

if ! az storage account show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${STORAGE_ACCOUNT}" >/dev/null 2>&1; then
  az storage account create \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${STORAGE_ACCOUNT}" \
    --location "${LOCATION}" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --allow-blob-public-access false \
    --min-tls-version TLS1_2 \
    --output none
fi
AZURE_FILE_SERVICE_URL="$(az storage account show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${STORAGE_ACCOUNT}" \
  --query primaryEndpoints.file -o tsv)"
AZURE_FILE_BASE_URL="${AZURE_FILE_SERVICE_URL%/}/${FILE_SHARE}"
if [[ "$(az storage share-rm exists \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --storage-account "${STORAGE_ACCOUNT}" \
  --name "${FILE_SHARE}" \
  --query exists -o tsv)" != "true" ]]; then
  az storage share-rm create \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --storage-account "${STORAGE_ACCOUNT}" \
    --name "${FILE_SHARE}" \
    --quota 1024 \
    --enabled-protocols SMB \
    --output none
fi
STORAGE_KEY="$(az storage account keys list \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --account-name "${STORAGE_ACCOUNT}" \
  --query "[0].value" -o tsv)"

if ! az containerapp env show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ENVIRONMENT_NAME}" >/dev/null 2>&1; then
  az containerapp env create \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${ENVIRONMENT_NAME}" \
    --location "${LOCATION}" \
    --enable-workload-profiles true \
    --logs-destination none \
    --output none
fi
ENVIRONMENT_DEFAULT_DOMAIN="$(az containerapp env show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ENVIRONMENT_NAME}" \
  --query properties.defaultDomain -o tsv)"
if [[ -z "${ENVIRONMENT_DEFAULT_DOMAIN}" ]]; then
  echo "Unable to resolve the Container Apps environment default domain" >&2
  exit 1
fi
FQDN="${APP_NAME}.${ENVIRONMENT_DEFAULT_DOMAIN}"
PUBLIC_BASE_URL="https://${FQDN}"
OAUTH_REDIRECT_URI="${PUBLIC_BASE_URL}/auth/callback"

ENTRA_REDIRECT_CURRENT="$(mktemp /tmp/codex-session-share-redirect-current.XXXXXX.json)"
ENTRA_REDIRECT_PATCH="$(mktemp /tmp/codex-session-share-redirect.XXXXXX.json)"
az ad app show --id "${ENTRA_APP_ID}" -o json >"${ENTRA_REDIRECT_CURRENT}"
OAUTH_REDIRECT_URI="${OAUTH_REDIRECT_URI}" \
python3 - "${ENTRA_REDIRECT_CURRENT}" "${ENTRA_REDIRECT_PATCH}" <<'PY'
import json
import os
from pathlib import Path
import sys

application = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
redirect_uri = os.environ["OAUTH_REDIRECT_URI"]
web = dict(application.get("web") or {})
web_redirects = list(web.get("redirectUris") or [])
if redirect_uri not in web_redirects:
    web_redirects.append(redirect_uri)
web["redirectUris"] = web_redirects
spa = dict(application.get("spa") or {})
spa["redirectUris"] = [
    value for value in list(spa.get("redirectUris") or []) if value != redirect_uri
]
Path(sys.argv[2]).write_text(
    json.dumps(
        {
            "web": web,
            "spa": spa,
            "isFallbackPublicClient": False,
        }
    ),
    encoding="utf-8",
)
PY
az rest \
  --method patch \
  --uri "https://graph.microsoft.com/v1.0/applications/${ENTRA_APP_OBJECT_ID}" \
  --headers "Content-Type=application/json" \
  --body "@${ENTRA_REDIRECT_PATCH}" \
  --output none
python3 - "${ENTRA_REDIRECT_CURRENT}" "${ENTRA_REDIRECT_PATCH}" <<'PY'
from pathlib import Path
import sys
for value in sys.argv[1:]:
    Path(value).unlink(missing_ok=True)
PY

if [[ -z "${SIGNING_KEY}" ]] && az containerapp show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${APP_NAME}" >/dev/null 2>&1; then
  SIGNING_KEY="$(az containerapp secret list \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${APP_NAME}" \
    --show-values \
    --query "[?name=='ticket-signing-key'].value | [0]" -o tsv)"
fi
if [[ -z "${SIGNING_KEY}" ]]; then
  SIGNING_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
fi

PROFILE_JSON="$(az containerapp env workload-profile list-supported \
  --subscription "${SUBSCRIPTION_ID}" \
  --location "${LOCATION}" \
  --query "[?name=='${WORKLOAD_PROFILE_TYPE}'] | [0].properties" -o json)"
if [[ "${PROFILE_JSON}" == "null" || -z "${PROFILE_JSON}" ]]; then
  echo "Workload profile ${WORKLOAD_PROFILE_TYPE} is unavailable in ${LOCATION}" >&2
  exit 1
fi
PROFILE_CPU="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["cores"])' <<<"${PROFILE_JSON}")"
PROFILE_MEMORY="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["memoryGiB"])' <<<"${PROFILE_JSON}")"
PROFILE_CPU="${PROFILE_CPU}" \
PROFILE_MEMORY="${PROFILE_MEMORY}" \
CONTAINER_CPU="${CONTAINER_CPU}" \
CONTAINER_MEMORY="${CONTAINER_MEMORY}" \
python3 - <<'PY'
import os
import re

profile_cpu = float(os.environ["PROFILE_CPU"])
profile_memory = float(os.environ["PROFILE_MEMORY"])
container_cpu = float(os.environ["CONTAINER_CPU"])
match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)Gi", os.environ["CONTAINER_MEMORY"])
if not match:
    raise SystemExit("ACA_CONTAINER_MEMORY must use Gi units, for example 16Gi")
container_memory = float(match.group(1))
if container_cpu > profile_cpu or container_memory > profile_memory:
    raise SystemExit(
        f"Container request {container_cpu} vCPU/{container_memory} GiB exceeds "
        f"profile capacity {profile_cpu} vCPU/{profile_memory} GiB"
    )
PY

if az containerapp env workload-profile show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ENVIRONMENT_NAME}" \
  --workload-profile-name "${WORKLOAD_PROFILE_NAME}" >/dev/null 2>&1; then
  az containerapp env workload-profile update \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${ENVIRONMENT_NAME}" \
    --workload-profile-name "${WORKLOAD_PROFILE_NAME}" \
    --min-nodes "${MIN_NODES}" \
    --max-nodes "${MAX_NODES}" \
    --output none
else
  az containerapp env workload-profile add \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${ENVIRONMENT_NAME}" \
    --workload-profile-name "${WORKLOAD_PROFILE_NAME}" \
    --workload-profile-type "${WORKLOAD_PROFILE_TYPE}" \
    --min-nodes "${MIN_NODES}" \
    --max-nodes "${MAX_NODES}" \
    --output none
fi

az containerapp env storage set \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ENVIRONMENT_NAME}" \
  --storage-name "${ENV_STORAGE_NAME}" \
  --access-mode ReadWrite \
  --azure-file-account-name "${STORAGE_ACCOUNT}" \
  --azure-file-account-key "${STORAGE_KEY}" \
  --azure-file-share-name "${FILE_SHARE}" \
  --output none

ENVIRONMENT_ID="$(az containerapp env show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ENVIRONMENT_NAME}" \
  --query id -o tsv)"
APP_BODY="$(mktemp /tmp/codex-session-share-app.XXXXXX.json)"
cleanup() {
  python3 - "${APP_BODY}" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).unlink(missing_ok=True)
PY
}
trap cleanup EXIT

export \
  APP_BODY APP_NAME LOCATION ENVIRONMENT_ID IDENTITY_ID ACR_SERVER IMAGE \
  SIGNING_KEY MAX_ARCHIVE_BYTES REVISION_SUFFIX ENV_STORAGE_NAME \
  WORKLOAD_PROFILE_NAME CONTAINER_CPU CONTAINER_MEMORY TENANT_ID ENTRA_APP_ID \
  ENTRA_ROLE_VALUE ENTRA_ADMIN_ROLE_VALUE ENTRA_SCOPE_VALUE \
  IDENTITY_CLIENT_ID AZURE_FILE_BASE_URL \
  PUBLIC_BASE_URL SEARCH_ENDPOINT SEARCH_INDEX_NAME EMBEDDING_ENDPOINT \
  EMBEDDING_DEPLOYMENT_NAME EMBEDDING_DIMENSIONS
python3 - <<'PY'
import json
import os
from pathlib import Path

identity_id = os.environ["IDENTITY_ID"]
body = {
    "location": os.environ["LOCATION"],
    "identity": {
        "type": "UserAssigned",
        "userAssignedIdentities": {identity_id: {}},
    },
    "properties": {
        "managedEnvironmentId": os.environ["ENVIRONMENT_ID"],
        "workloadProfileName": os.environ["WORKLOAD_PROFILE_NAME"],
        "configuration": {
            "activeRevisionsMode": "Single",
            "ingress": {
                # Keep the app private until the Entra-validating revision is ready.
                "external": False,
                "targetPort": 8000,
                "transport": "Auto",
                "allowInsecure": False,
                "traffic": [{"latestRevision": True, "weight": 100}],
            },
            "registries": [
                {
                    "server": os.environ["ACR_SERVER"],
                    "identity": identity_id,
                }
            ],
            "secrets": [
                {"name": "ticket-signing-key", "value": os.environ["SIGNING_KEY"]},
            ],
        },
        "template": {
            "revisionSuffix": os.environ["REVISION_SUFFIX"],
            "containers": [
                {
                    "name": os.environ["APP_NAME"],
                    "image": os.environ["IMAGE"],
                    "env": [
                        {"name": "SESSION_SHARE_AUTH_MODE", "value": "entra"},
                        {
                            "name": "SESSION_SHARE_ENTRA_TENANT_ID",
                            "value": os.environ["TENANT_ID"],
                        },
                        {
                            "name": "SESSION_SHARE_ENTRA_APP_ID",
                            "value": os.environ["ENTRA_APP_ID"],
                        },
                        {
                            "name": "SESSION_SHARE_MANAGED_IDENTITY_CLIENT_ID",
                            "value": os.environ["IDENTITY_CLIENT_ID"],
                        },
                        {
                            "name": "SESSION_SHARE_REQUIRED_ROLE",
                            "value": os.environ["ENTRA_ROLE_VALUE"],
                        },
                        {
                            "name": "SESSION_SHARE_ADMIN_ROLE",
                            "value": os.environ["ENTRA_ADMIN_ROLE_VALUE"],
                        },
                        {
                            "name": "SESSION_SHARE_REQUIRED_SCOPE",
                            "value": os.environ["ENTRA_SCOPE_VALUE"],
                        },
                        {
                            "name": "SESSION_SHARE_SIGNING_KEY",
                            "secretRef": "ticket-signing-key",
                        },
                        {"name": "SESSION_SHARE_DATA_DIR", "value": "/data"},
                        {
                            "name": "SESSION_SHARE_PUBLIC_BASE_URL",
                            "value": os.environ["PUBLIC_BASE_URL"],
                        },
                        {
                            "name": "SESSION_SHARE_AZURE_FILE_BASE_URL",
                            "value": os.environ["AZURE_FILE_BASE_URL"],
                        },
                        {
                            "name": "SESSION_SHARE_SEARCH_ENDPOINT",
                            "value": os.environ["SEARCH_ENDPOINT"],
                        },
                        {
                            "name": "SESSION_SHARE_SEARCH_INDEX_NAME",
                            "value": os.environ["SEARCH_INDEX_NAME"],
                        },
                        {
                            "name": "SESSION_SHARE_EMBEDDING_ENDPOINT",
                            "value": os.environ["EMBEDDING_ENDPOINT"],
                        },
                        {
                            "name": "SESSION_SHARE_EMBEDDING_DEPLOYMENT",
                            "value": os.environ["EMBEDDING_DEPLOYMENT_NAME"],
                        },
                        {
                            "name": "SESSION_SHARE_EMBEDDING_DIMENSIONS",
                            "value": os.environ["EMBEDDING_DIMENSIONS"],
                        },
                        {"name": "FASTMCP_HOME", "value": "/data/fastmcp"},
                        {
                            "name": "SESSION_SHARE_MAX_ARCHIVE_BYTES",
                            "value": os.environ["MAX_ARCHIVE_BYTES"],
                        },
                        {"name": "SESSION_SHARE_TICKET_TTL_SECONDS", "value": "300"},
                        {"name": "PORT", "value": "8000"},
                    ],
                    "resources": {
                        "cpu": float(os.environ["CONTAINER_CPU"]),
                        "memory": os.environ["CONTAINER_MEMORY"],
                    },
                    "volumeMounts": [
                        {"volumeName": "session-data", "mountPath": "/data"}
                    ],
                    "probes": [
                        {
                            "type": "Startup",
                            "httpGet": {"path": "/readyz", "port": 8000},
                            "initialDelaySeconds": 2,
                            "periodSeconds": 5,
                            "failureThreshold": 60,
                        },
                        {
                            "type": "Liveness",
                            "httpGet": {"path": "/healthz", "port": 8000},
                            "initialDelaySeconds": 10,
                            "periodSeconds": 30,
                        },
                        {
                            "type": "Readiness",
                            "httpGet": {"path": "/readyz", "port": 8000},
                            "initialDelaySeconds": 5,
                            "periodSeconds": 10,
                        },
                    ],
                }
            ],
            "scale": {"minReplicas": 1, "maxReplicas": 1},
            "volumes": [
                {
                    "name": "session-data",
                    "storageType": "AzureFile",
                    "storageName": os.environ["ENV_STORAGE_NAME"],
                }
            ],
        },
    },
}
Path(os.environ["APP_BODY"]).write_text(json.dumps(body), encoding="utf-8")
PY
chmod 0600 "${APP_BODY}"

if az containerapp show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${APP_NAME}" >/dev/null 2>&1; then
  # The replica can occupy all available vCPUs on the dedicated node. Drain
  # the previous revision before creating the replacement.
  az containerapp revision set-mode \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${APP_NAME}" \
    --mode multiple \
    --output none
  for revision in $(az containerapp revision list \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${APP_NAME}" \
    --query "[?properties.active].name" -o tsv); do
    az containerapp revision deactivate \
      --subscription "${SUBSCRIPTION_ID}" \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${APP_NAME}" \
      --revision "${revision}" \
      --output none
  done
  for attempt in $(seq 1 120); do
    ACTIVE_COUNT="$(az containerapp revision list \
      --subscription "${SUBSCRIPTION_ID}" \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${APP_NAME}" \
      --query "[?properties.active] | length(@)" -o tsv)"
    REPLICA_COUNT="$(az containerapp revision list \
      --subscription "${SUBSCRIPTION_ID}" \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${APP_NAME}" \
      --query "sum([].properties.replicas)" -o tsv)"
    REPLICA_COUNT="${REPLICA_COUNT:-0}"
    if [[ "${ACTIVE_COUNT}" == "0" && "${REPLICA_COUNT}" == "0" ]]; then
      break
    fi
    if [[ "${attempt}" == "120" ]]; then
      echo "Previous Container App revisions did not drain" >&2
      exit 1
    fi
    sleep 5
  done
fi

az rest \
  --method put \
  --uri "https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/containerApps/${APP_NAME}?api-version=2026-01-01" \
  --body "@${APP_BODY}" \
  --output none

for attempt in $(seq 1 120); do
  STATE="$(az containerapp show \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${APP_NAME}" \
    --query properties.provisioningState -o tsv 2>/dev/null || true)"
  if [[ "${STATE}" == "Succeeded" ]]; then
    break
  fi
  if [[ "${STATE}" == "Failed" ]]; then
    echo "Container App provisioning failed" >&2
    az containerapp show \
      --subscription "${SUBSCRIPTION_ID}" \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${APP_NAME}" \
      --query properties -o jsonc >&2 || true
    exit 1
  fi
  if [[ "${attempt}" == "120" ]]; then
    echo "Container App provisioning timed out" >&2
    exit 1
  fi
  sleep 5
done

LATEST_REVISION="$(az containerapp show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${APP_NAME}" \
  --query properties.latestRevisionName -o tsv)"
for attempt in $(seq 1 120); do
  READY_COUNT="$(az containerapp replica list \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${APP_NAME}" \
    --revision "${LATEST_REVISION}" \
    --query "[?properties.containers[0].ready==\`true\`] | length(@)" \
    -o tsv 2>/dev/null || true)"
  if [[ "${READY_COUNT:-0}" != "0" ]]; then
    break
  fi
  if [[ "${attempt}" == "120" ]]; then
    echo "Latest revision ${LATEST_REVISION} did not become ready" >&2
    az containerapp revision show \
      --subscription "${SUBSCRIPTION_ID}" \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${APP_NAME}" \
      --revision "${LATEST_REVISION}" -o jsonc >&2 || true
    exit 1
  fi
  sleep 5
done

az containerapp auth update \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${APP_NAME}" \
  --enabled false \
  --yes \
  --output none

az containerapp ingress enable \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${APP_NAME}" \
  --type external \
  --target-port 8000 \
  --transport auto \
  --allow-insecure false \
  --output none

ACTUAL_FQDN="$(az containerapp show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${APP_NAME}" \
  --query properties.configuration.ingress.fqdn -o tsv)"
if [[ "${ACTUAL_FQDN}" != "${FQDN}" ]]; then
  echo "Container App FQDN ${ACTUAL_FQDN} does not match OAuth FQDN ${FQDN}" >&2
  exit 1
fi

for attempt in $(seq 1 120); do
  if curl -fsS --max-time 10 "https://${FQDN}/readyz" >/dev/null 2>&1; then
    break
  fi
  if [[ "${attempt}" == "120" ]]; then
    echo "Container App did not become ready at https://${FQDN}/readyz" >&2
    az containerapp logs show \
      --subscription "${SUBSCRIPTION_ID}" \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${APP_NAME}" \
      --tail 100 >&2 || true
    exit 1
  fi
  sleep 5
done

curl -fsS --max-time 15 \
  "https://${FQDN}/.well-known/oauth-authorization-server" >/dev/null
curl -fsS --max-time 15 \
  "https://${FQDN}/.well-known/oauth-protected-resource/mcp" >/dev/null

if [[ -n "${OLD_WORKLOAD_PROFILE_NAME}" \
  && "${OLD_WORKLOAD_PROFILE_NAME}" != "${WORKLOAD_PROFILE_NAME}" ]] \
  && az containerapp env workload-profile show \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${ENVIRONMENT_NAME}" \
    --workload-profile-name "${OLD_WORKLOAD_PROFILE_NAME}" >/dev/null 2>&1; then
  az containerapp env workload-profile delete \
    --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${ENVIRONMENT_NAME}" \
    --workload-profile-name "${OLD_WORKLOAD_PROFILE_NAME}" \
    --output none
fi

export \
  DEPLOYMENT_FILE SUBSCRIPTION_ID RESOURCE_GROUP LOCATION APP_NAME ENVIRONMENT_NAME \
  WORKLOAD_PROFILE_NAME WORKLOAD_PROFILE_TYPE CONTAINER_CPU CONTAINER_MEMORY \
  ACR_NAME STORAGE_ACCOUNT FILE_SHARE FQDN CLIENT_ENV_FILE CLIENT_CONFIG_FILE IMAGE \
  TENANT_ID ENTRA_APP_ID ENTRA_APP_DISPLAY_NAME ENTRA_GROUP_ID \
  ENTRA_ROLE_DISPLAY_NAME ENTRA_ROLE_VALUE ENTRA_ADMIN_ROLE_DISPLAY_NAME \
  ENTRA_ADMIN_ROLE_VALUE ENTRA_ADMIN_PRINCIPAL_ID ENTRA_SCOPE_VALUE \
  AZURE_FILE_BASE_URL \
  OAUTH_REDIRECT_URI IDENTITY_CLIENT_ID IDENTITY_PRINCIPAL_ID \
  ENTRA_FEDERATED_CREDENTIAL_NAME SEARCH_SERVICE_NAME SEARCH_ENDPOINT \
  SEARCH_INDEX_NAME OPENAI_ACCOUNT_NAME EMBEDDING_ENDPOINT \
  EMBEDDING_DEPLOYMENT_NAME EMBEDDING_MODEL_NAME EMBEDDING_MODEL_VERSION \
  EMBEDDING_DIMENSIONS
python3 - <<'PY'
import json
import os
import shlex
from pathlib import Path

client_env = Path(os.environ["CLIENT_ENV_FILE"])
client_env.write_text(
    "export CODEX_SESSION_SHARE_MCP_URL="
    + shlex.quote(f"https://{os.environ['FQDN']}/mcp")
    + "\nexport CODEX_SESSION_SHARE_ENTRA_RESOURCE="
    + shlex.quote(f"api://{os.environ['ENTRA_APP_ID']}")
    + "\nexport CODEX_SESSION_SHARE_ENTRA_TENANT_ID="
    + shlex.quote(os.environ["TENANT_ID"])
    + "\n",
    encoding="utf-8",
)
client_env.chmod(0o600)

client_config = Path(os.environ["CLIENT_CONFIG_FILE"])
client_config.write_text(
    "\n".join(
        [
            "[mcp_servers.session_share]",
            f'url = "https://{os.environ["FQDN"]}/mcp"',
            'auth = "oauth"',
            'default_tools_approval_mode = "prompt"',
            "tool_timeout_sec = 1800",
            "",
        ]
    ),
    encoding="utf-8",
)
client_config.chmod(0o600)

value = {
    "subscription_id": os.environ["SUBSCRIPTION_ID"],
    "resource_group": os.environ["RESOURCE_GROUP"],
    "location": os.environ["LOCATION"],
    "app_name": os.environ["APP_NAME"],
    "environment_name": os.environ["ENVIRONMENT_NAME"],
    "workload_profile_name": os.environ["WORKLOAD_PROFILE_NAME"],
    "workload_profile_type": os.environ["WORKLOAD_PROFILE_TYPE"],
    "container_cpu": float(os.environ["CONTAINER_CPU"]),
    "container_memory": os.environ["CONTAINER_MEMORY"],
    "acr_name": os.environ["ACR_NAME"],
    "storage_account": os.environ["STORAGE_ACCOUNT"],
    "file_share": os.environ["FILE_SHARE"],
    "azure_file_base_url": os.environ["AZURE_FILE_BASE_URL"],
    "search_service_name": os.environ["SEARCH_SERVICE_NAME"],
    "search_endpoint": os.environ["SEARCH_ENDPOINT"],
    "search_index_name": os.environ["SEARCH_INDEX_NAME"],
    "openai_account_name": os.environ["OPENAI_ACCOUNT_NAME"],
    "embedding_endpoint": os.environ["EMBEDDING_ENDPOINT"],
    "embedding_deployment": os.environ["EMBEDDING_DEPLOYMENT_NAME"],
    "embedding_model_name": os.environ["EMBEDDING_MODEL_NAME"],
    "embedding_model_version": os.environ["EMBEDDING_MODEL_VERSION"],
    "embedding_dimensions": int(os.environ["EMBEDDING_DIMENSIONS"]),
    "fqdn": os.environ["FQDN"],
    "mcp_url": f"https://{os.environ['FQDN']}/mcp",
    "client_env_file": os.environ["CLIENT_ENV_FILE"],
    "client_config_file": os.environ["CLIENT_CONFIG_FILE"],
    "image": os.environ["IMAGE"],
    "entra_tenant_id": os.environ["TENANT_ID"],
    "entra_app_id": os.environ["ENTRA_APP_ID"],
    "entra_app_display_name": os.environ["ENTRA_APP_DISPLAY_NAME"],
    "entra_resource": f"api://{os.environ['ENTRA_APP_ID']}",
    "entra_group_id": os.environ["ENTRA_GROUP_ID"],
    "entra_role_display_name": os.environ["ENTRA_ROLE_DISPLAY_NAME"],
    "entra_role_value": os.environ["ENTRA_ROLE_VALUE"],
    "entra_admin_role_display_name": os.environ["ENTRA_ADMIN_ROLE_DISPLAY_NAME"],
    "entra_admin_role_value": os.environ["ENTRA_ADMIN_ROLE_VALUE"],
    "entra_admin_principal_id": os.environ["ENTRA_ADMIN_PRINCIPAL_ID"],
    "entra_scope_value": os.environ["ENTRA_SCOPE_VALUE"],
    "entra_credential_type": "managed-identity-federation",
    "entra_federated_credential_name": os.environ[
        "ENTRA_FEDERATED_CREDENTIAL_NAME"
    ],
    "managed_identity_client_id": os.environ["IDENTITY_CLIENT_ID"],
    "managed_identity_principal_id": os.environ["IDENTITY_PRINCIPAL_ID"],
    "oauth_redirect_uri": os.environ["OAUTH_REDIRECT_URI"],
    "oauth_mode": "entra-authorization-code-pkce",
}
path = Path(os.environ["DEPLOYMENT_FILE"])
path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
path.chmod(0o600)
PY

echo "Deployment succeeded."
echo "MCP URL: https://${FQDN}/mcp"
echo "Health: https://${FQDN}/healthz"
echo "Entra application: ${ENTRA_APP_DISPLAY_NAME} (${ENTRA_APP_ID})"
echo "Assigned group: ${ENTRA_GROUP_ID}"
echo "Required role: ${ENTRA_ROLE_VALUE}"
echo "Admin role: ${ENTRA_ADMIN_ROLE_VALUE} (${ENTRA_ADMIN_PRINCIPAL_ID})"
echo "Entra credential: ACA managed identity federation"
echo "OAuth redirect URI: ${OAUTH_REDIRECT_URI}"
echo "Client environment: ${CLIENT_ENV_FILE}"
echo "Codex MCP config: ${CLIENT_CONFIG_FILE}"
echo "Authenticate after installing the config: codex mcp login session_share"
echo "Deployment metadata: ${DEPLOYMENT_FILE}"
echo "Workload profile: ${WORKLOAD_PROFILE_TYPE} (${PROFILE_CPU} vCPU, ${PROFILE_MEMORY} GiB)"
echo "Container request: ${CONTAINER_CPU} vCPU, ${CONTAINER_MEMORY}"
echo "Persistent share: ${STORAGE_ACCOUNT}/${FILE_SHARE}"
echo "Azure Files URL: ${AZURE_FILE_BASE_URL}"
echo "Azure AI Search: ${SEARCH_SERVICE_NAME}/${SEARCH_INDEX_NAME}"
echo "Embedding deployment: ${OPENAI_ACCOUNT_NAME}/${EMBEDDING_DEPLOYMENT_NAME}"
