# Codey 0.2.3 — Windows history and multiple queued messages

## Windows conversation history

The Windows backend no longer probes Codex Desktop's default Unix filesystem
socket. That probe could fail with `EACCES`, breaking Goal status and returning
an empty conversation from the legacy error handler. Windows now selects the
configured native stdio CLI; explicit owner connections still fail closed.
No permissions, native writer locks or desktop tasks are changed.

History failures are reported rather than cached as successful empty transcripts.
Returning to the window or reconnecting retries failed reads, and a successful
refresh clears the previous error. Goal availability remains independent of
transcript loading.

## Persistent FIFO queues

- Sending while busy appends a new message instead of replacing the previous
  queued message. Existing queued work is also respected between runs.
- Each queued card has its own immediate-append, edit and delete actions.
  Promoting one receipt removes only that receipt, preserving its neighbours
  and the independent textarea draft.
- Per-message database operations avoid overwriting another device's queue or
  resurrecting a message already claimed by the dispatcher.
- Automatic dispatch takes only the first queued message for an idle session.
  Ambiguous immediate delivery is held for review, never silently sent again.
- Legacy single-message drafts remain readable. Uploaded attachments and
  snapshotted execution settings remain attached to their queued messages.
- List mutations use a separate API endpoint, so an older node rejects them
  during rollout rather than overwriting its single queue slot.

Both the shared frontend and the **node package** must be updated. The package
dependency lock is unchanged except for the version; installed native tools,
credentials, configuration and previous releases must be preserved.

## Local validation

Release preparation on September 27, 2026:

- Frontend: 800 passing tests across 84 files.
- Backend: 739 passing tests and 15 opt-in/platform skips.
- Main repository: 622 passing tests and 20 platform skips.
- Production frontend/backend builds, type checks and lint passed (warnings remain).
- Main-source and deployment-tool tests: 5 and 40 passing cases.

The authenticated affected-node probe reproduced successful node access,
zero returned history rows and a Goal `EACCES` error on the default Windows
socket. These are pre-release observations, not post-deployment acceptance.
Publication still requires committed main provenance and safe node availability.
