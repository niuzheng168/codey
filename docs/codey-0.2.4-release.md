# Codey 0.2.4 — packaged read-only Agency setup

Release preparation: September 28, 2026.

## What changes

- `codey agency setup` now ships in the shared runtime `.tgz`. Users do not
  need a source checkout, Python, a managed Codey node, or a Copilot conversation
  to register Agency's Teams/Mail stdio MCP servers in native Codex.
- The repository helper delegates to the same packaged implementation.
- The complete `.zip` installation Skill and the `.tgz` both contain the
  Agency guide, including Linux dependency installation, direct browser-only
  Teams **and Mail** authentication, Copilot-first login, configuration and
  per-service read verification.
- Headless Linux setup and saved MCP entries use the same pre-authenticated
  AzureAuth environment. This does not enable a global browser override.
- Default behavior remains discovery/validation only. `--apply` backs up and
  atomically updates the managed block; `--verify-read` performs bounded reads.
  The 15 Teams / 5 Mail read-only allowlists are preserved; unknown/write tools
  stay disabled. Existing providers and other MCP entries remain unchanged.

## User workflow

Follow the bundled `onboarding/references/agency-codex-mcp.md` (or
`references/agency-codex-mcp.md` in the installation Skill), install the native
Agency/authentication dependencies, and sign in as the actual Codex host user.
The verified Microsoft Mail resource ends in **`mcp_MailTools`**, not
`mcp_MailServer`. Browser authentication must obey organization policy.

```sh
codey agency setup --verify-read
codey agency setup --apply --verify-read
```

Reload MCP or create a new Codex task on the same host after configuration.
GitHub/model login and merely starting `agency cp` are not access tests.
Do not reset/copy caches or repeatedly sign in when actual reads already work.

## Release and safety boundaries

This is an optional host-local integration. Installing/upgrading Codey does not
install Agency/AzureAuth, sign in, grant consent, change the model/provider, or
automatically enable enterprise tools. No token, cache, message or email is
bundled. Plaintext fallback cache storage on headless Linux requires explicit
organizational acceptance; otherwise use an approved keyring/device.

The shared npm package is still application-only, with no dependency-version
changes and no platform-native Agency binaries. Production publication requires
the committed main SHA, its recorded submodules and a fresh immutable artifact.
Publishing the package does not upgrade/restart any existing node.

## Verification scope

Release-preparation checks on Linux:

- Main Node suite: **666 passed, 20 skipped, 0 failed**.
- Python package/publication contract: **25 passed**.
- Main-source and deployment safety tests: **5 and 40 passed**.
- Syntax checks and the guide's shell examples passed.
- The new packaged CLI source successfully queried Teams and read a Mail preview
  using existing credentials, without changing the actual Codex configuration.

Portable tests cover source and relocated package entrypoints, argument routing,
headless environment, exact allowlists, privacy-preserving read probes, safe
configuration updates and rollback on discovery/native-validation failures.
Package assembly checks that the guide is included in both distributions;
the real npm-install smoke checks the installed command and guide without
enabling MCP or reading user credentials.

Linux authenticated Teams and Mail reads were verified separately. Windows
and macOS fixture coverage is not proof of fresh native tenant authentication
on every OS or of organizational consent on another user's machine.
