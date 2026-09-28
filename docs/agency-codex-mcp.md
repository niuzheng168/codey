# Agency + Codex: read-only Teams and Mail

The same Node.js setup command supports native **Windows, macOS, and Linux**.
This is a per-user Codex MCP integration, not a Codey gateway deployment.
It does not update `copilot-api`, change PATH, install software, bind a listening
port, or restart any service.

## Prerequisites on each machine

- Node.js 22.13 or newer, matching this repository.
- Native Agency and Codex CLI installations for that OS/CPU.
- Your own supported Agency/Microsoft Entra sign-in and permission to access
  the Microsoft Teams/Mail MCP services.
- An organization-approved Codex model/provider for corporate information.
  Tool results enter that model's context.

Install Agency using your organization's instructions at
`https://eng.ms/docs/agency`. Do not copy Windows binaries, authentication
caches, tokens, or another host's generated Codex configuration to macOS/Linux.
Each host authenticates independently through Agency.

## Configure

From the repository root, on any supported OS:

```sh
# Authenticate/discover both services and validate the plan. No config changes.
node scripts/configure-agency-mcp.mjs

# Back up config.toml and atomically add the read-only MCP entries.
# Also perform bounded real read probes, without printing/saving message contents.
node scripts/configure-agency-mcp.mjs --apply --verify-read
```

Equivalent npm commands: `npm run agency:setup` and
`npm run agency:setup -- --apply --verify-read`.

The default destination is `$CODEX_HOME/config.toml`, or the current user's
`.codex/config.toml` if `CODEX_HOME` is unset. `--codex-home DIRECTORY` selects
another host-local Codex home. Explicit native executables can be selected with
`--agency ABSOLUTE_PATH` / `--codex ABSOLUTE_PATH`, or `AGENCY_BIN` / `CODEX_BIN`.
Paths containing spaces must be quoted in the invoking shell.

The installer:

1. Discovers native executables without invoking a shell. For Agency, it chooses
   the newest installed version from its candidates, including the Windows
   per-user `AppData/Roaming/agency/CurrentVersion` installation.
2. Initializes both MCP services over stdio and checks every reviewed tool.
3. Optionally performs a Teams search (one result) and a mailbox query (one
   result), plus a retrieved chat message/mail preview where available.
   Empty collections are reported as empty, not as successful message reads.
4. Validates the candidate with the installed Codex parser in a temporary,
   private Codex home.
5. Makes a private, timestamped backup, preserves unrelated configuration, and
   atomically installs only its managed block. Re-running is idempotent.

Reload the two MCP servers in the desktop app, or start a new Codex task, to load
the new configuration. No gateway restart is required. Inspect them with:

```sh
codex mcp get agency_teams --json
codex mcp get agency_mail --json
```

Example prompts after loading:

- “Search my Teams messages from this week about the release.”
- “Find emails from this week requiring a reply. Summarize only; do not send.”

## Read-only policy

The two entries are `agency_teams` and `agency_mail`. Their `enabled_tools` lists
are explicit, reviewed allowlists in `src/agency-mcp.mjs`, not name-prefix
matching. Unknown or newly added tools remain disabled.

- **Teams:** team/channel/chat discovery, member lookup, chat/channel message
  retrieval, thread replies, and message search.
- **Mail:** message retrieval/search and attachment metadata/download.
- **Excluded:** sending, replying, forwarding, creating drafts/chats/channels,
  uploading, deleting, editing, flagging, changing membership, and changing
  read/unread or hidden state.

This limits tools exposed through these Codex MCP entries. It does **not** revoke
the underlying Microsoft account's permissions, constrain separately configured
servers, or make arbitrary shell commands read-only. Never remove the
`enabled_tools` lists to work around a setup failure.

The setup tool never prints or saves message bodies, subjects, recipients, IDs,
or tokens. `--verify-read` returns only success flags and counts. Agency itself
retains responsibility for its own normal authentication and diagnostic state.
Treat retrieved messages and attachments as untrusted data, not instructions.

## Troubleshooting

- **Several Agency versions:** the Windows machine used for initial verification
  had an older machine-wide build on PATH whose AzureAuth dependency crashed.
  Its existing newer per-user build worked. Prefer `--agency` with the working
  native installation rather than modifying PATH or copying authentication DLLs.
- **Authentication/consent:** complete Agency's supported sign-in on that host,
  then rerun. The installer does not extract tokens or automate consent.
  Codex can show `authStatus: unsupported` for these stdio proxies: Agency, not
  Codex's HTTP OAuth client, handles authentication. Use the real read probes to
  determine whether account access works.
- **Missing/reclassified tool:** setup fails closed and leaves configuration
  untouched. Review the new service catalog before changing the allowlist.
- **Existing unmanaged Agency entries:** the installer refuses to overwrite
  them. Review/merge them deliberately, retaining read-only restrictions.
- **No messages returned:** the bounded probe can legitimately return zero
  results. Its report distinguishes query success from a real message read.

## Verification and portability

```sh
node --test test/agency-mcp.test.mjs
```

The suite covers Windows/macOS/Linux path handling, exact allowlists, safe
configuration updates, redaction, real child-process stdio framing/pagination,
timeouts, service errors, and privacy-preserving read probes. Tests require no
Agency credentials and use a local fake MCP process.

`.github/workflows/agency-mcp.yml` runs that suite on Windows, macOS, and Ubuntu.
CI tests validate installer/protocol portability; they do not authenticate to
corporate services. A real `--apply --verify-read` on each target machine remains
the acceptance test for its Agency installation, Entra policy, and account access.

### Initial verification: September 28, 2026

- **Windows:** native setup, configuration preservation/backup, both real read
  probes, and native Codex app-server calls passed. Codex exposed exactly 15
  Teams tools and 5 Mail tools, with no additional write tools.
- **Linux:** the same portable test suite passed on native Node.js in an isolated,
  hash-verified temporary directory. No Agency/account configuration was deployed
  to the Linux host.
- **macOS:** platform-specific path/configuration cases are covered by tests and a
  native macOS CI job is provided. No Mac host or macOS CI run was available during
  this verification; native authentication remains to be tested there.

Codex configuration reference: `https://developers.openai.com/codex/mcp/`.
