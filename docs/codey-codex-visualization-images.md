# Codex desktop screenshots outside a project

## Root cause

Codex desktop can save screenshots under
`CODEX_HOME/visualizations/YYYY/MM/DD/<native-thread-id>/` rather than under the
chat's working directory. The existing Markdown renderer already fetches local
images through the authenticated, node-scoped project-file API. That API,
however, rejected these paths with `403 PATH_OUTSIDE_PROJECT`.

Copying an image into the project makes it visible, but converting its format
or sending the same out-of-project path again does not fix the access failure.
Some desktop screenshots also contain JPEG bytes despite a `.png` extension.

## Fix

The raw-content reader now has a narrowly scoped, read-only Codex visualization
capability:

- Recognize only absolute paths inside the configured Codex home's dated,
  native-thread-specific visualization directory.
- Resolve that native thread through the node's session database and require
  a Codex session whose project matches the requested project exactly. App
  session IDs are not assumed to equal native Codex thread IDs.
- Verify canonical containment in that session directory. Symlinks/junctions
  cannot grant access to another thread, another project, or arbitrary files.
- Permit only PNG, JPEG, GIF and WebP paths with recognized raster signatures.
  Detect the response MIME from bytes, not from the extension, and stream from
  the same open descriptor without copying or rewriting the image.
- Preserve authentication, project/worktree boundaries, and all text, save,
  listing, upload and mutation restrictions. This does not expose Codex auth,
  configuration, transcripts, arbitrary clipboard/temp files, or SVG/HTML.
- Return private, non-cacheable, non-sniffable raw responses; close image
  streams when a browser cancels the request or changes chats.

The existing frontend, saved Markdown, original image files and conversations
need no migration. A different project's chat still cannot read these images,
even if its Markdown contains the original absolute path.

## Validation and release boundary

Regression tests cover the dated desktop paths, custom/symlinked Codex homes,
Windows paths and junctions, native session/project checks, malformed paths,
MIME mismatch, missing files, non-image bytes, unchanged write boundaries,
request cancellation, and historical/streaming Markdown authentication.

Local validation on September 30, 2026:

- 42 File Tree/image backend tests passed, including the independently compiled
  backend output; all 802 frontend tests passed.
- Frontend/backend type checks, isolated production builds and lint passed
  (existing lint and bundle-size warnings remain).
- An isolated loopback HTTP probe used the affected node's **read-only session
  database** and both original screenshots. Correct-project reads returned 200
  with PNG/JPEG MIME types and identical original bytes; unauthenticated,
  cross-project and Codex credential-file requests remained denied.
- The complete backend suite was **not green** on this Windows environment:
  710 passed, 60 failed, 22 skipped. Failures included Unix-domain socket tests,
  POSIX path expectations and a missing ripgrep executable. Those other
  modules were not changed as part of this image fix. A clean pre-change
  baseline has not been run, so these failures are not asserted to be
  pre-existing.

This is a **node backend fix**. Publishing only the Portal/shared UI cannot
enable it on an old node. Build and release a reviewed node package through the
normal main-only release process; do not overwrite or restart a running node
merely to validate this source change.
