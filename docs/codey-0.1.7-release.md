# Codey 0.1.7

## Fix

Linux DevTunnel onboarding and token renewal now tolerate the CLI's welcome
banner preceding `--json` output. Previously, the generated renewal script
passed that banner to `JSON.parse`, failed before contacting the Portal, and
left the Portal's connect credential to expire even while the host was running.

The same JSON filter covers user/tunnel discovery, registration-token export
and the self-contained generated renewal script. It rejects missing, malformed,
multiple or trailing JSON, retains CLI failure exit codes and does not print
credential-bearing parse errors. The fix originated in `0c29611`.

No dependency versions, native tools, tunnel IDs, ports, access policies or
credentials are changed by this patch.

## Existing-node boundary

The changed installer is part of the npm application and the independently
published new-machine Skill; both artifacts need a new immutable release.
Never overwrite an existing 0.1.6 archive under its published identity.

Ordinary application updates intentionally preserve the generated
`~/.local/share/codey-machine/renew-devtunnel.sh`. Merely installing 0.1.7 does
**not** repair that old script. Existing affected Linux nodes need a separate,
owner-scoped repair with a backup, followed by a successful renewal and
Portal-to-node connectivity verification. Do not rerun `codey setup` to repair
renewal: that workflow also changes service/model configuration and stops Codex.

The incident node was already repaired independently, without
restarting its Workspace, gateway or tunnel host. Its authenticated Workspace,
Usage and WebSocket path from the Portal was verified after renewal.

## Release scope

This is a Linux onboarding patch. Only the Linux x64 signed feed is targeted
for 0.1.7, using Node 24. The artifact retains the existing shared package format;
this is not new Windows/macOS native acceptance or a new feed release for those
platforms. Their existing releases are retained.

Publishing the signed feed and new-machine Skill creates no node update jobs,
does not perform a fleet rollout and does not deploy/restart the Portal.
The public npm name `codey` belongs to an unrelated project; distribution stays
through Codey's authenticated package and Skill download endpoints.
