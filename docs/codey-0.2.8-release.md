# Codey 0.2.8 — desktop continuation and visualization images

Release preparation: September 30, 2026.

## Included repairs

This release packages the reviewed CloudCLI changes already recorded on main:

- Normalize omitted desktop text-input `text_elements` to an empty array before
  peer submission, including steering/restoration input. Preserve rich input,
  ordering, client identities and writer ownership; reject malformed arrays
  before dispatch.
- Serve native Codex visualization images through the authenticated project
  raw-file API only when the native session belongs to that exact project.
  Validate canonical containment and raster bytes; preserve all write and
  unrelated-file restrictions.
- Classify a desktop steering state-query failure before dispatch as
  `STEER_UNAVAILABLE`, so an unsent queued message remains retryable.
  Post-dispatch uncertainty still requires review; no automatic replay or
  release of previously held messages is introduced.

The symlinked daemon socket and paginated live-history fixes from 0.2.7 remain
included. Details are in `codey-codex-session-interop.md` and
`codey-codex-visualization-images.md`.

## Release and validation boundaries

The package manifest and lock change only the Codey version; runtime dependency
versions and submodule pins are unchanged by this preparation commit.
Already published 0.2.7 bytes and previous node installations remain intact.

Build one shared `.tgz` and complete installation Skill `.zip` from the exact
merged main commit and its recorded submodules. Rerun source, publication,
frontend/backend, gateway and isolated installed-package checks before
publishing. Retain checksums and exact source provenance with the release.

Node rollout uses the original owner's installed `codey update` flow, with
fresh identity, integrity, activity and transaction checks, followed by a
canary and live version/source/health verification. Preserve configuration,
credentials, certificates, sessions, tools and rollback packages. Do not
reinstall nodes, upgrade Node/Codex/DevTunnel, change model providers, rewrite
native transcripts or replay an unconfirmed message. Publishing the installer
alone does not update an already-running node backend.
