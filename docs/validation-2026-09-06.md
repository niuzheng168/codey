# Publication validation — 2026-09-06

This is a source snapshot and a **frontend-only** rollout, not a backend upgrade.

The initial private-mirror layout described below was subsequently corrected:
the same local CloudCLI and copilot-api commits were fast-forwarded into
`niuzheng168/claudecodeui` and `niuzheng168/copilot-api`. The parent now references
those original public forks. This correction changes repository routing and
documentation only; it does not change dependency source trees, merge new
upstream code, redeploy nodes or alter existing fork Actions settings. See the
[current repository layout](./repository-layout.md).

The unused Project Stats template submodule was subsequently removed at the
owner's request. This removes a private-clone permission requirement, not
CloudCLI's plugin system. The template's Git history was backed up locally before
removal; it contained no Codey feature changes.

During native Linux development setup, the management-config test fixture was
made portable: its portal-host key paths now use the current OS's temporary
directory rather than a Windows-only literal. The production absolute-path
validation remains unchanged, including rejection of relative key paths.

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

## Native Linux development verification

A separate development checkout was subsequently prepared on Linux, without
changing the running CloudCLI or copilot-api services. Portal-host path fixtures
now use host-native temporary paths, and the SQLite test fixture selects
`python3` on POSIX with isolated, no-site startup.

- Portal: **102 passed**.
- CloudCLI: **412 frontend tests** and **40 focused Codey backend tests passed**;
  frontend/backend typecheck, the Linux frontend build and native SQLite/PTY
  smoke checks passed.
- copilot-api: **18 focused tests** and typecheck passed.
- MCP: **34 unit tests passed**, excluding the server integration suite.
- The isolated development portal was started and stopped successfully.
  Anonymous node access and access after logout returned 401; the independent
  development login and empty node inventory returned 200.

MCP validation exposed an existing omission in configuration export redaction:
`API_TOKEN`-style keys were not matched. The shared secret-key matcher now covers
these keys in TOML and nested app state, with regression tests for underscore,
hyphen and camel-case variants. Numeric token-limit settings remain intact.
The automation-restore assertion now checks the parsed `PAUSED` status rather
than requiring an incidental trailing newline. These are source changes only;
the running MCP service was not redeployed during development setup.

The full upstream CloudCLI server suite and full MCP integration run exceeded
their time limits. Their owned test processes were stopped; these full suites
are **not** reported as passing. The focused/unit results above are separate
completed runs.

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
The initial private dependency repositories retained upstream history/licenses
and had GitHub Actions disabled before their first push. Detailed machine-specific
verification artifacts remain local and are not part of the public repository.
