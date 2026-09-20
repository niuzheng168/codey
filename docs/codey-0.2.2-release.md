# Codey 0.2.2 — transcript images and desktop-owner controls

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
