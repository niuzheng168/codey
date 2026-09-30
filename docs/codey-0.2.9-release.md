# Codey 0.2.9 — mobile foreground recovery

Release preparation: September 30, 2026.

## Repairs

- Replace the chat WebSocket on a genuine background-to-foreground transition,
  network restoration or back/forward-cache restoration, even when the old
  transport still reports OPEN. Retire old callbacks and retry timers, bound
  stalled handshakes, and retain authentication gates.
- Publish the actual connected socket identity so batched close/open state
  updates cannot hide a transport replacement from session subscriptions.
- Recover persisted replies on foreground entry without waiting for the
  WebSocket handshake. Defer automatic latest-history reads while the document
  is hidden; coalesce refresh signals using the existing history coordinator.
- Keep live replay/status subscription independent of history loading.
  Subscribe once per socket/session selection, not after a delayed history
  response or a same-session sidebar object refresh.

Recovery never resends a prompt, aborts/resumes a provider turn, clears drafts,
changes model configuration or takes ownership of a native desktop run.
Previously loaded history and reading position remain owned by the session
store. The changes retain the existing API contract and require no new node
endpoint.

## Validation and publication

Regression tests simulate silently dead OPEN sockets, suspended handshakes,
foreground event bursts, late retired callbacks, authentication refresh/logout,
completed replies, live progress with slow REST, hidden Chat tabs and navigation
while a refresh is pending. These are automated lifecycle simulations, not a
claim of testing on a physical phone.

Publish both the centrally hosted Workspace UI and the versioned node package
from the exact clean main source and its recorded component gitlinks. Updating
only node packages does not change the browser's centrally hosted UI. Existing
browser tabs must reload to adopt the new frontend.

The version bump leaves dependency versions unchanged. Node updates use the
original owner's installed native CLI, exact package checksums and normal
identity/operation-lock checks. Preserve credentials, configuration, sessions,
tool runtimes and previous releases; retain per-node health and source receipts.
