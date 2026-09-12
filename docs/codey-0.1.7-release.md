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

## Published artifacts — 2026-09-12 UTC

- Clean build source: `d789e7ab5aaa65315c0a5e43b86dac61b7e48470`.
- Application: `codey-0.1.7.tgz`, 7,368,115 bytes, 849 archive entries.
- Application SHA-256:
  `928e51e4a13d92b67af15c4df2d6b145f99472a3e21ddb5a6c3e8043a231951d`.
- Linux signed release: `codey-928e51e4a13d92b6`, sequence **15**,
  published at **18:10:01 UTC**.
- New-machine Skill: `machine-586acc61044c10f0`, 7,443,799 bytes,
  activated at **18:09:52 UTC**.
- Skill SHA-256:
  `586acc61044c10f003f8f0eb7e6d10018e3b0d3e292790a26af9e5e98259b849`.

The install and update stores contain the exact same npm tarball. The npm
package and Skill ZIP both contain the fixed installer byte-for-byte.
Existing signed releases and the previous installation Skill are retained;
the signing key was neither rotated nor distributed.

## Acceptance

- Source checks passed: 511 Node tests passed, 11 skipped; 38 Linux updater
  tests passed.
- Native Linux Node 24 doctor passed SQLite, bcrypt, ripgrep, PTY and SDK checks.
- Both artifact installation cases passed: cold installation and offline
  dependency reuse from a separately installed, private 0.1.6 donor into 0.1.7.
  The real Workspace/gateway HTTP and anonymous-denial checks passed.
- These unchanged cases/timeouts ran sequentially in a private tmpfs namespace
  as the original non-root user. Earlier evidence is retained: the concurrent
  disk run exceeded the startup readiness deadline, and using a writable build
  scratch directory as a donor was correctly refused by the ownership guard.
- Uploaded bytes and catalog signatures were independently read back and
  checked. The running Portal's existing catalog and machine-package loaders
  accepted 0.1.7 and verified the same npm artifact in both stores, without a
  deployment. All three public download routes continued to reject anonymous
  requests with 401. The Portal revision and production service PIDs were
  unchanged; no node update jobs or real model requests were created.

Full local build, acceptance and publication receipts are retained under
`artifacts/codey-release-0.1.7-20260912/`. These checks do not claim native
Windows/macOS acceptance, an authenticated browser session test, or automatic
repair of other nodes' previously generated renewal scripts.
