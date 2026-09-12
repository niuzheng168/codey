# Codey 0.1.6

## Application artifact

One `codey-0.1.6.tgz` is shared by Linux x64 and Windows x64:

- Size: 7,367,256 bytes (7.03 MiB), 848 files.
- SHA-256: `f148411a5034dd20c120cdef1d1bbb80475b79d9c0b8f7d045400c45f305a167`.
- No Node distribution, `node_modules`, native binaries or dependency cache.
- Required dependencies remain declared in the manifest and shared lock.

The artifact was built and validated before the source changes were committed.
Its original build provenance (`sourceDirty: true`) and bytes are retained; it
must not be relabeled or rebuilt under the same published artifact identity.

## Changes

Identical dependency locks reuse a private copy of the installed dependency
tree, without npm registry access, install hooks or native rebuilds. `--offline`
requires that path and fails explicitly for changed, incomplete or incompatible
dependencies. Cold installation uses `npm ci` after checked npm extraction so
dependency ranges cannot silently resolve differently from the release lock.

The standalone installer supports `--check --reuse-from OLD_CODEY_DIRECTORY`
for one-time offline bootstrap. Existing Node/native ABI compatibility, owner
checks, idle checks, transactional activation and rollback remain enforced.

The PTY doctor probe runs in a bounded child process. Windows PTY background
handles cannot keep the main doctor alive after a successful probe.

Settings -> Software Updates provides an authenticated download of the selected
signed whole-Codey artifact, with SHA-256 verification. Downloading creates no
node update job and leaves the new-machine installation Skill unchanged.

## Acceptance and boundaries

Windows managed installation completed `0.1.4 -> 0.1.6-rc.1 -> 0.1.6`.
An isolated A100 Linux installation completed
`0.1.5 -> 0.1.6-rc.1 -> 0.1.6`. Both final upgrades used the installed CLI.
Both platforms passed independent offline installation, SQLite/bcrypt/ripgrep/
PTY/SDK checks, Workspace/gateway HTTP checks and cleanup.

Windows Node, Codex, DevTunnel, node identity and service configuration were
preserved. A100's existing legacy production services were not migrated or
restarted. This evidence is not a fleet rollout or a new model-call acceptance.
Only Node 24 is advertised in this release's signed native feeds. macOS was not
validated for this release and is not newly published as a supported feed target.

Use `codey update FILE.tgz --offline` on a compatible existing installation.
Plain `npm install` still resolves declared dependencies; a fresh machine needs
Node and runtime dependencies prepared separately.
