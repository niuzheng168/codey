# Publication validation — 2026-09-06

This is a source snapshot and a **frontend-only** rollout, not a backend upgrade.

## Deployed UI

- Four remote CloudCLI instances received the new composer static assets.
- The installer verified the archive and previous HTML checksums, preserved old
  hashed assets, backed up the previous HTML and atomically replaced `index.html`.
- Before/after checks confirmed unchanged CloudCLI PID, copilot-api PID, active
  backend release and VM boot ID on every node.
- All four Workspace pages loaded through ACA. An existing A100 conversation
  displayed the new voice-options and more-tools controls.
- No chat messages were sent, no real microphone recording was made, and no VM
  reboot, network change, copilot-api restart or local portal start was performed.

## Tests

| Check | Result |
| --- | --- |
| Portal syntax check | Passed |
| Portal tests | 102 passed |
| Voice deployment helper unit tests | 6 passed |
| CloudCLI frontend tests | 412 passed across 61 files |
| Composer visual/interaction fixtures | Wide, narrow, dark, recording and popup cases passed |
| CloudCLI frontend + backend typecheck | Passed |
| copilot-api Codey ticket/HTTPS/browser tests | 18 passed |
| copilot-api typecheck | Passed |
| copilot-api focused lint | Passed after verified CRLF-only normalization |

The CloudCLI frontend tests and builds were run immediately before this rollout;
the publication edits do not change that built UI.

## Known validation limitations

- CloudCLI's full server suite on native Windows: **402 passed, 8 failed, 1
  skipped**. Two failures expect POSIX paths where Windows returns backslashes;
  six are Claude authentication/home-directory fixtures. Their upstream test and
  implementation modules are unchanged by the Codey snapshot.
- Full CloudCLI lint reports **two existing module-boundary errors**, in
  `server/modules/auth/auth.middleware.ts` and
  `server/modules/websocket/services/websocket-auth.service.ts`, plus existing
  warnings. The publication does not silently refactor backend auth code to hide
  these failures.
- The MCP pytest suite was not rerun in this Windows publication environment:
  its available Python interpreter does not have pytest installed.
- This initial snapshot is committed after explicit validation rather than
  relying on platform-specific pre-commit hooks. Hook skips, where used, are
  per-process; repository/global hook configuration is not disabled.

## Source safety

Current source and reachable dependency history were scanned with a
checksum-verified Gitleaks binary and checked for the locally configured secret
values without printing those values. The scanner's findings were individually
reviewed: they are environment variable names, comments, UI permission-mode
descriptions, deterministic unit-test data and `your_*_key` documentation
placeholders. No real credentials were found in the selected publication content.

Actual node configuration, deployment certificates, `.env`, account/session data,
backups, test recordings and generated build artifacts are excluded from Git.
Private dependency repositories retain their upstream history/licenses and
GitHub Actions is disabled before the first push. Detailed machine-specific
verification artifacts remain local and are not part of the public repository.
