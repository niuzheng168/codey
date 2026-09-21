# Codey 0.2.2 — native titles, worktree files and transcript images

## Automatic native titles

New Codey-created Codex conversations now generate a short title from their
first user message and persist it through the native metadata RPC, so Codex
desktop no longer has to display only the working-directory path.

The bounded background request uses the thread's configured custom Responses
provider. It creates no extra conversation or turn, does not read conversation
history, and never takes over the native writer. Imported threads, resumes,
forks, and explicit user titles are not automatically renamed. Unsupported
authentication, model failures, or a concurrent rename leave the conversation
unaffected.

## Related-worktree files

A conversation may retain the main checkout as its project while linking to an
absolute file path in another worktree. Text reads, media/raw previews and text
saves now accept those links after verifying Git's worktree inventory and the
candidate's canonical common Git directory.

Workspace and per-project boundaries remain enforced, including matching
subdirectory scope in the other checkout. Unrelated paths, stale registrations,
relative traversal and escaping symlinks are rejected. This does not fall back
to a Home project or broaden create, rename, delete, listing or upload access.

The editor now displays the backend's actual error and cannot save an error
diagnostic over the original file. Late reads for a previously opened file
cannot replace the current document.

These title and file-access changes require the new **node package**. Publishing
only the Portal or shared frontend cannot enable them on an older node.

## Transcript images

Model replies often contain Markdown such as
`![Render](/workspace/project/output/render.png)`. Previously the browser tried
to load that operating-system path from the Portal, without the node/project
API or its authentication. Existing files consequently appeared as broken
images, even when the node's file viewer could read them.

- Historical and streaming replies now read local images through the existing
  authenticated project-file API. Nested tool Markdown inherits the same
  transcript project.
- Relative paths, POSIX/Windows absolute paths and local `file:`/`sandbox:`
  references are supported. The backend still enforces the project boundary;
  there is no new arbitrary-file endpoint or basename-based asset fallback.
- Public HTTP(S) images retain normal browser loading and receive no node
  credentials. Unsupported schemes remain blocked; link sanitization is
  unchanged.
- Requests are aborted and blob URLs revoked on project/path changes and
  unmount. Late responses cannot replace another project's image.
- Offline, missing, forbidden or invalid images show an explanation and a
  retry action rather than an unexplained broken-image icon.

The original Markdown/history and image files do not need rewriting or
regeneration. Refreshing the old conversation works once its browser loads
the new frontend and its node can still read the referenced files.

## Desktop-owner controls

Includes the live owner observation, steering, queueing and explicit Stop
repair documented in [Codex session interoperability](codey-codex-session-interop.md).
The native desktop remains the writer and approval owner. This is a backend
change and requires an explicit node package update, unlike the image renderer.

## Rollout boundaries

Portal workspaces load a shared immutable frontend: upgrading only a Mac node
does **not** update that UI. Publish the committed shared UI using the existing
expected-current guard; retain the old release and do not restart unrelated
nodes or Portal services.

Use a checksum-pinned Codey package for the local node. Preserve its identity,
TLS, credentials, native tools and previous release. macOS updates require an
external owner terminal, not the active Codey/Codex process tree; do not bypass
that guard to restart the conversation performing the update.

The dependency versions are unchanged. This version bump reserves distinct
package bytes instead of replacing the already released 0.2.1 archive.

## Validation

Combined release preparation on September 21, 2026:

- Backend: 697 passing tests and 15 opt-in/environment-dependent skips across
  all 102 test files. The 73 focused file/worktree tests also passed against the
  compiled backend.
- Frontend: 736 passing tests across 77 files, including error diagnostics,
  safe saving and stale-response regressions.
- The compiled production router returned 200 for related-worktree text, raw
  content and saves, and 403 for unrelated paths and escaping symlinks.
- A read-only candidate probe on the affected node opened the reported file as
  text and raw content without modifying the document or restarting the node.
- Production builds, type checks and lint passed; existing lint and bundle-size
  warnings remain.

Earlier transcript-image and desktop-owner validation:

- Frontend: 713 passing tests, including 40 image regressions covering
  historical/streaming messages, project and node scoping, standalone/SSO
  authentication, path formats, unsafe URLs, retry and blob cleanup.
- Backend: 611 passing tests and 13 opt-in/platform skips.
- All six opt-in native interoperability tests passed with isolated homes and
  a localhost model. One initial run hit a late native plugin-cache write during
  fixture deletion; bounded temporary-directory cleanup retries fixed that race
  without changing RPC assertions or model/turn deadlines.
- Production build and frontend/backend type checks passed. Lint has no errors
  and the existing 129 warnings; existing bundle-size warnings remain.
- Codey package checks: 56 passed and nine platform-specific skips, including
  the Python package/publication contract. Main-source and shared-UI publication
  checks passed (five and ten cases). Package checks used the pinned Node
  24.20.0/npm 11.19.0 and canonical macOS temporary paths; system npm 12 omits
  the shrinkwrap file and is not the release toolchain.
