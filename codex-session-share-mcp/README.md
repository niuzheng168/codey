# Codex Session Share MCP

This project provides:

- A remote **FastMCP 3.4.4** service with three tools:
  `upload_session`, `download_session`, and `rename_session`.
- An authenticated session-history REST API for list/search, metadata and
  transcript inspection, archive download, rename, recoverable trash, restore,
  and permanent purge.
- Optional Azure AI Search hybrid retrieval over full shared-session
  transcripts. The searchable projection is chunked and embedded separately;
  the original verified Azure Files archive remains unchanged and downloadable.
- Direct Microsoft Entra OAuth authorization-code authentication with PKCE,
  refresh tokens, dynamic client registration, and the
  `SessionShare.Contributor` and `SessionShare.Admin` application roles.
- Atomic, persistent session replacement by session ID, plus create-only named
  shares.
- A local `codex-session-share` bridge for uploads and optional manual
  transfers.
- Zero-install native downloads: Codex executes a temporary standard-library
  client returned by the authenticated MCP tool.
- Direct Streamable HTTP MCP configuration; adding the server to Codex does
  not require Python, pip, an API key, or an Azure CLI login.
- Azure Container Apps deployment assets with an Azure Files mount.

## Direct MCP connection versus the optional local bridge

Codex connects directly to the remote MCP server and completes Entra sign-in
through its standard OAuth flow. This connection requires no local package.

An MCP server running in Azure cannot read or write another machine's local
`$CODEX_HOME`, working tree, attachments, or SQLite files. Uploads therefore
still use the local bridge to:

1. Captures the current rollout JSONL, thread metadata, goal, thread memory,
   referenced attachments, shell snapshot, and workspace files.
2. Calls the `upload_session` MCP tool to obtain a short-lived transfer ticket.
3. Streams the bundle to persistent server storage.

Downloads do not require the bridge to be installed. The authenticated
`download_session` tool returns a short-lived `local_execution.command`.
Codex runs that command with its local shell; it downloads a temporary `.pyz`,
uses the current Azure CLI login, verifies and restores the archive, registers
the resumable task, and deletes the temporary client.

Credentials, Codex auth state, MCP OAuth state, global logs, ignored secret
files, virtual environments, and live processes are excluded.

## Local development

```bash
python -m venv .venv
.venv/bin/pip install -e '.[test]'

export SESSION_SHARE_API_KEY_SHA256="$(
  printf '%s' 'replace-with-a-long-random-key' | sha256sum | cut -d' ' -f1
)"
export SESSION_SHARE_AUTH_MODE=api-key
export SESSION_SHARE_SIGNING_KEY="$(openssl rand -hex 32)"
export SESSION_SHARE_DATA_DIR=/tmp/codex-session-share-data

.venv/bin/codex-session-share-server
```

API-key mode is retained only as a local-development fallback. Production uses
direct Entra OAuth. Add this configuration on each Codex machine:

```toml
[mcp_servers.session_share]
url = "https://YOUR_APP_FQDN/mcp"
auth = "oauth"
default_tools_approval_mode = "prompt"
tool_timeout_sec = 1800
```

Restart Codex, then select **Authenticate** for `session_share` or run:

```bash
codex mcp login session_share
```

No package or shared credential is installed for downloads. After `az login`,
ask Codex:

```text
Download session 019fb689-c996-7c71-ac58-8253c100adb7
```

Codex calls the MCP tool and executes its returned zero-install command. The
machine needs `python3` and Azure CLI, but does not need pip or the
`codex-session-share` package.

For uploads, renames, or manual transfer control, the optional bridge can still
be installed from this repository:

```bash
python -m pip install .
az login
export CODEX_SESSION_SHARE_MCP_URL=https://YOUR_APP_FQDN/mcp
export CODEX_SESSION_SHARE_ENTRA_RESOURCE=api://YOUR_ENTRA_APP_ID
export CODEX_SESSION_SHARE_ENTRA_TENANT_ID=YOUR_ENTRA_TENANT_ID

# Uses CODEX_THREAD_ID when run from a Codex session.
codex-session-share upload

# Stores the source GUID under a unique shared name. Named uploads never
# overwrite an existing share.
codex-session-share upload \
  --session-id 019fb689-c996-7c71-ac58-8253c100adb7 \
  --name shared_session_123

# Optional manual download fallback.
codex-session-share download SESSION_ID

# Changes both the lookup name and Azure Files directory.
codex-session-share rename SESSION_ID dashboard-demo
```

After an upload completes, the bridge prints the archive's Azure Files URL.
The deployment stores archives in Azure Files rather than Azure Blob Storage,
so the URL uses the storage account's `file.core.windows.net` endpoint.
Each session directory also contains `current.json`, including the immutable
Entra tenant/object identity in `uploaded_by` and the uploader's current
username/email claim in `uploaded_by_email`.

The downloaded native thread can also be opened separately with the printed
`codex resume LOCAL_CLONE_ID -C WORKSPACE` command.

Portable uploads stop at the latest completed Codex turn, so invoking the
upload bridge from inside the task does not archive its still-running tool
call. Downloads also repair older bundles by dropping an incomplete active
tail, removing backend-bound encrypted compaction items, and applying path/ID
rewrites without cascading into newly inserted destination paths. Version
0.7.0 and later also accept the pre-0.6 archive layout and rewrite the source user home
in both JSON values and path-keyed maps, so paths such as `/home/source-user`
do not leak into a recipient's runnable task.

By default, downloads do **not** register the source thread ID on the second
machine. The bridge derives a stable machine-local clone ID from the machine,
MCP endpoint, and source thread ID. This prevents ChatGPT desktop from treating
the two hosts as the same thread and hiding one host's entry. Re-downloading on
the same machine updates the same local clone; a different machine gets a
different clone ID.

Advanced identity options:

```bash
# Force another independent local copy.
codex-session-share download SESSION_NAME --new-copy

# Preserve the source UUID (not recommended with multiple connected hosts).
codex-session-share download SESSION_NAME --preserve-session-id
```

If a receiving machine already imported the session with version 0.2 or
earlier, download it once with the new bridge, verify the new local clone, then
remove the legacy same-ID copy on that receiving machine:

```bash
codex-session-share download SESSION_NAME --delete-legacy-source-id
```

Do not run that cleanup option on the machine that owns the original thread.

## Session history API

All endpoints require an Entra bearer token with `access_as_user` and
`SessionShare.Contributor`. Mutating endpoints additionally require
`SessionShare.Admin`.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/session-history?state=active&q=&start_at=0&limit=50&offset=0` | Contributor | List and search active/trash sessions uploaded at or after the optional Unix timestamp |
| `GET` | `/v1/session-history/{state}/{name}` | Contributor | Read metadata and bounded transcript |
| `GET` | `/v1/session-history/{state}/{name}/archive` | Contributor | Stream the verified archive |
| `POST` | `/v1/session-history/upload` | Contributor | Reserve a verified archive upload using the same upload pipeline as the MCP tool |
| `POST` | `/v1/session-history/active/{name}/rename` | Admin | Rename an active share |
| `DELETE` | `/v1/session-history/active/{name}` | Admin | Move to recoverable trash |
| `DELETE` | `/v1/session-history/active/{name}/purge` | Admin | Permanently delete an active share without moving it to trash |
| `POST` | `/v1/session-history/trash/{name}/restore` | Admin | Restore a trashed share |
| `DELETE` | `/v1/session-history/trash/{name}` | Admin | Permanently purge metadata and archive |
| `POST` | `/v1/session-history/reindex` | Admin | Rebuild the Azure AI Search projection |

Trash and restore update the Azure Files directory and `current.json`
atomically. All mutations use the same filesystem-backed cross-replica leases
as uploads and downloads.

## Deploy to Azure Container Apps

The deployment defaults to the `CIG-Speech` subscription
(`42b416ee-e2a0-44b2-b016-db59f7a1e8f2`), the existing `zhn-devbox` resource
group, `japaneast`, and a **D8 dedicated profile**. The container requests
**8 vCPU and 16 GiB RAM** from the D8 node's 8-vCPU/32-GiB capacity. It creates
one always-on dedicated node and one app replica, so it incurs
dedicated-profile costs. Because the replica uses all eight vCPUs, updates
briefly drain the prior revision before starting the replacement.

```bash
az login
./deploy/aca/deploy.sh
```

The script creates:

- A Microsoft Entra application registration and service principal.
- An Entra confidential Web client authenticated through the ACA
  user-assigned managed identity and the
  `https://APP_FQDN/auth/callback` redirect URI.
- An `access_as_user` delegated API scope.
- A `SessionShare.Contributor` application role assigned to the configured
  team security group.
- A `SessionShare.Admin` application role assigned only to the currently
  signed-in deploying user by default. Override the principal with
  `SESSION_SHARE_ENTRA_ADMIN_PRINCIPAL_ID`.
- An Azure AI Search **Basic** service and a `text-embedding-3-large`
  Azure OpenAI deployment, both in `zhn-devbox` by default. The ACA managed
  identity receives Search Index Data Reader/Contributor and Cognitive Services
  OpenAI User roles. Local authentication is disabled on both services.
- A Japan East Container Apps environment in the configured resource group
  (creating the group only when it does not already exist).
- A `share-d8` D8 dedicated workload profile with an 8-vCPU/16-GiB container
  request.
- Azure Container Registry plus a user-assigned pull identity.
- A 1-TiB Azure Files share mounted read/write at `/data`.
- Persistent encrypted OAuth client and refresh state under `/data/fastmcp`.
- An externally reachable HTTPS MCP endpoint.
- A sourceable client environment file at
  `~/.config/codex-session-share/client.env`.
- A ready-to-copy Codex MCP configuration at
  `~/.config/codex-session-share/client-config.toml`.

Deployment metadata is written to
`~/.config/codex-session-share/deployment.json`. All resource names and the
subscription can be overridden with the environment variables declared at the
top of `deploy/aca/deploy.sh`. The default group is `VoiceFirstAgentDevs`
(`4adec457-1c72-43b3-b6d1-bb390788dc69`); override it with
`SESSION_SHARE_ENTRA_GROUP_ID`. The app registration uses this repository's
Service Tree reference (`60f68487-af6c-49c0-a045-53fc7b4127da`); override it
with `SESSION_SHARE_SERVICE_MANAGEMENT_REFERENCE` when deploying for another
service.

## Security model

- Codex authenticates users directly through Entra authorization code + PKCE;
  the server refreshes upstream tokens and no client-side secret or persistent
  download package is distributed.
- The Entra app has no password or certificate credential. It trusts the ACA
  user-assigned managed identity through workload identity federation; only
  the FastMCP signing key remains in Container Apps secrets.
- The application validates token signature, issuer, audience, lifetime, and
  the delegated `access_as_user` scope against Microsoft Entra metadata.
- The application additionally requires the `SessionShare.Contributor` role.
- Rename, trash, restore, and permanent purge additionally require the
  `SessionShare.Admin` role.
- Transfer URLs are HMAC-signed, short-lived, one-time upload tickets.
- Archives are streamed with size and SHA-256 validation.
- Upload completion atomically changes the current version pointer.
- Session directories use the validated session name directly:
  `sessions/SESSION_NAME/`. A user-selected upload name must be 1-128
  characters and contain only letters, numbers, or `_`; it must not already
  exist. Source session IDs and legacy renamed sessions retain the broader
  safe path format.
- Existing SHA-256-named directories are migrated to readable session names
  when the service starts.
- Filesystem-backed read/write leases prevent upload, download, and rename
  races across users and replicas. Conflicting operations return a busy error;
  multiple concurrent downloads are allowed.
- All authenticated users can download a known session ID, which is the
  intended cross-user sharing model. Use separate deployments or application
  roles if stronger tenant isolation is needed.
- Session history is intentionally unredacted. Review it before sharing.
- Search documents contain the same intentionally unredacted user/assistant
  transcript content as the downloadable archive. Search remains behind the
  Session Share contributor role; Azure AI Search and Azure OpenAI are accessed
  only through the ACA managed identity.
- Workspace files matching `.env*`, private-key formats, credential files,
  ignored dependency trees, and common secret directories are excluded unless
  `--include-sensitive` is explicitly supplied.
