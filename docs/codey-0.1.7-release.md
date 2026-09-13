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

The application change is a Linux onboarding patch. The initial publication
targeted Linux x64 on Node 24. Subsequent Windows x64 native acceptance passed
against the exact same tarball, enabling an additional Windows signature without
rebuilding the application. macOS has no new native acceptance or feed release.

The Portal groups identical application artifacts into one version and resolves
each node's signed platform record automatically. It continues refreshing actual
installed-version heartbeats after terminal jobs and while idle. A target version
or a completed task never substitutes for a node's installed-version report.

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

Full initial build, Linux acceptance and publication receipts are retained under
`artifacts/codey-release-0.1.7-20260912/`. Those original receipts remain unchanged.

## Additional Windows acceptance — 2026-09-13

The original 7,368,115-byte artifact passed an isolated native Windows offline
installation from a private 0.1.6 dependency donor on Node 24.20.0. SQLite, bcrypt,
ripgrep, PTY and SDK checks passed, as did real Workspace/gateway startup,
authenticated access, anonymous denial and the installed CLI's next update check.
No Node or dependency payload was added to the archive.

The independent Windows updater also needed fixes outside the application:
accept the actual schema-2 descriptor without an invented required `platform`
field, reuse checked dependencies during Portal staging, and compare running
Task Scheduler instances rather than retry-trigger timestamps. Refreshing this
agent preserves its credential and does not restart Codey, its tunnel or renewal
task. Failed historical tasks remain failed; publishing does not upgrade nodes.

These checks do not claim macOS acceptance, an authenticated browser session
test, or automatic repair of other nodes' previously generated renewal scripts.

## Unified publication — 2026-09-13 UTC

- Added Windows signed release `codey-windows-928e51e4a13d92b6`, sequence **16**,
  at **05:02:53 UTC**, retaining the original Linux sequence-15 signature.
- Both authenticated platform download routes returned the exact same original
  tarball and SHA-256; both anonymous routes returned 401. The existing new-machine
  Skill pointer was unchanged.
- Portal revision `codey--f-20260913-045927-d3f735` deployed source
  `3d78042f28da5d907096bf96d852d4cb80187c31`, including unified version selection,
  continued heartbeat polling and the repaired independent updater bootstrap.
- The Windows updater was safely refreshed with its existing credential. Its
  authenticated descriptor probe passed, all three application task instances
  were unchanged, and its live heartbeat still correctly reported **0.1.6**.
  The earlier two failed tasks did not install a newer application.
- Publication created no node update jobs. Receipts are retained under
  `artifacts/unified-017-20260913/` on the publishing host; Windows artifact
  acceptance and download receipts are also saved in `Downloads\Codey-0.1.7`.
