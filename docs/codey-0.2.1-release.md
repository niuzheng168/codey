# Codey 0.2.1 — native session titles

## Scope

This is a node application update. Portal and shared Workspace UI do not need
redeployment. Publish the versioned `codey-0.2.1.zip` installation Skill and its
matching `codey-0.2.1.tgz` through the existing package store. Existing nodes
only acquire the fix after an explicit local Codey package update.

The requested installation scope is this Linux machine only, using the normal
independent `codey update --background` transaction. Other nodes, native Codex,
Node, DevTunnel, credentials and TLS identities are not upgrade targets.

## Behavior and migration

- Automatic titles, including Codey-generated initial-message labels, follow
  Codex's native name. Native polling notices renames even without a changed
  thread timestamp.
- The JSONL fallback reads the last appended name. Index-only changes are
  watched independently of rollout birthtime, and older JSONL metadata cannot
  replace a newer native database name.
- Explicit Codey renames are marked `custom_name_source=user`. Both upsert
  paths protect them at write time, including concurrent indexing. Rename
  provenance survives app/provider duplicate merging and explicit fork titles.
- Historical Codey versions did not record title provenance. Upgrade backs up
  existing Codex labels in `sessions.legacy_custom_name` before allowing them to
  follow native names. Old manual labels cannot reliably be distinguished from
  stale caches and can be reapplied through Codey's rename action. Backups and
  new manual-name flags survive subsequent starts.
- Codex's storage is read-only throughout. No native rename, writer handoff,
  model request or conversation-history rewrite is needed.

## Validation

- CloudCLI backend: 596 passed, 11 opt-in/platform tests skipped.
- CloudCLI frontend: 673 passed.
- Type checks, lint and production build passed; existing lint and bundle-size
  warnings remain.
- Codey package JavaScript checks: 62 passed, 3 platform-specific cases skipped.
- Package/build/publication Python checks: 24 passed.
- Main-only release-source checks: 5 passed.

The first full backend run used `/tmp`, which the existing workspace-path
validator intentionally rejects. The complete suite was rerun with
`TMPDIR=/var/tmp`, isolated `HOME`, and inherited native Codex configuration
unset. No runtime guard, assertion or test timeout was relaxed.

Publication/source/checksum receipts, the read-only reproduction using a
private database copy, and local update/doctor results are retained under the
ignored release directory identified by `artifacts/session-title-release-path`.
Do not publish those private database backups or session records.
