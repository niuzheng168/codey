# Codey / Codex desktop session interoperability

## Failure observed on 2026-09-06

New Codey conversations did not appear automatically in Codex app, although
explicitly opening their IDs with `codex resume` worked. App-created sessions
were visible in Codey, but neither they nor Codey sessions continued in the App
could then be continued by Codey's bundled SDK:

```text
thread-store conflict: thread ... already has an active writer
```

These are separate problems:

- The SDK creates `source=exec` threads. Codex's default `thread/list` includes
  interactive `cli` and `vscode` sources, not `exec`. Opening an ID directly
  bypasses this list filter; it does not necessarily change the stored source.
- Codey's legacy indexer discovered only JSONL files by creation time.
  Desktop sessions can use native paginated history, so a JSONL export is not
  a reliable discovery mechanism or complete history source.
- Codey's SDK launches an independent `codex exec` process for a turn.
  A desktop daemon can retain the thread writer even while the UI is idle.
  Starting another process for the same thread is not a supported handoff.

The presence of a lock file alone does not prove a live writer. Never delete
writer locks, rewrite Codex databases, or silently fork the conversation to
work around a writer conflict.

## Implementation

On Linux hosts with a running desktop daemon, the provider connects to the
existing Unix socket under `CODEX_HOME/app-server-control`. It does not start,
upgrade, stop, or restart the daemon.

- **Discovery:** merge `thread/list` results into Codey's provider-id mapping.
  Include the main `cli`, `vscode`, `exec`, and `appServer` sources, not
  subagents. A missing rollout path remains null, so orphan cleanup does not
  delete a native-only session. A six-second index poll supplements the
  existing filesystem watcher.
- **History:** use `thread/read` for native paginated sessions. Keep the
  existing rich JSONL reader for legacy sessions. Do not substitute a partial
  export when native history is unavailable, or cache native history against
  an export's unchanged file timestamp. Preserve stable item IDs.
- **Creation:** use the same daemon's `thread/start` for new web sessions and
  map its ID before submitting the first turn. On the tested westus2 daemon,
  this creates `source=vscode`, included in the default list, without
  impersonating a desktop client or rewriting metadata. Apply Codey's selected
  permissions when creating its own new thread and when starting its turn.
- **Continuation:** use `thread/resume` and `turn/start` on the existing
  daemon, preserving the provider thread ID. Attach without permission
  overrides. If idle, apply the permission mode supplied with the Codey
  message at `turn/start`; omitted modes retain inherited settings. If active,
  ordinary messages use `turn/steer` with the verified current turn ID and
  inherit that turn's settings. Do not resume by starting a second writer.
- **Events:** forward the tracked turn's text, tool progress, and completion
  notifications, including desktop turns steered from Codey. Buffer events that
  precede the submission acknowledgement; ignore other threads and turns.
- **Safety:** steering never transfers ownership of a desktop turn. Automatic
  cancellation affects only Codey-started work; an authenticated, explicit Stop
  bound to the observed run can also interrupt its verified desktop turn
  (updated 2026-09-15). A stale turn ID, timeout or disconnect never retries the
  prompt or redirects it through exec or a new turn.
- **Local lifecycle:** preserve Codey renames/archives and exclude locally
  removed sessions from subsequent imports. These actions do not rename,
  archive, or delete the original Codex thread. Permanent deletion of native
  history must be performed in Codex app, not by unlinking its JSONL export.

New and legacy sessions can still use the SDK when no daemon exists, with the
old discovery limitations. Native paginated sessions require their daemon; a
read-only metadata lookup prevents sending them to the older SDK by mistake.
Existing `exec` sessions are not rewritten or silently forked to migrate them;
opening such an old session explicitly in the App can still be necessary.

## Scope and remaining limitations

### Large native histories on Windows, Linux and macOS (2026-09-23)

The native history reader previously requested up to 100 full turns per RPC.
Screenshot-heavy threads could exceed the stdio transport's 16-MiB frame
limit; reducing the turn page size alone is insufficient when one turn is
already larger than that limit.

The shared reader now requests lightweight turn metadata and loads full items
through `thread/items/list`, scoped to each turn and ordered by native cursors.
One item per response prevents adjacent screenshots from forming an oversized
frame. The same implementation serves Windows/macOS/Linux stdio readers and
Linux/macOS Unix-socket daemons. Thread, turn and item identities, ordering and
the original writer are preserved; no thread is resumed, forked or rewritten.

Only an explicit initial unsupported-method response allows the older
full-turn protocol, with one turn per page. Partial pages, repeated cursors or
items, foreign turn IDs, summaries, later capability failures and reader-owned
threads fail closed rather than falling back to incomplete JSONL exports.
Snapshots remain bounded by 20,000 turns, 100,000 items, 128 MiB and a
60-second traversal deadline (individual RPC deadlines still apply). An
individual item must still fit the existing transport frame limit.

The desktop owner's separate IPC state snapshot is not paginated. Its bounded
receive allowance is now 64 MiB on both Windows named pipes and Unix sockets;
outgoing requests retain their 16-MiB limit. Fragmented frames are assembled
once instead of repeatedly copying the growing payload. Owner/thread/revision
checks and submission/interrupt safeguards are unchanged.

Regression fixtures cover histories over 40 MiB, individual turns over
16 MiB, fragmented desktop snapshots, malformed pages, legacy compatibility
and unchanged writer ownership. The `Codex Native History` CI workflow runs
them on Windows, Ubuntu and macOS with Node 22 and 24. This is a **node
backend** fix; a Portal/shared-UI-only deployment cannot apply it.

### Files linked from related Git worktrees (2026-09-21)

A native conversation can retain the main checkout as its `cwd` while linking
to an absolute file path in another worktree. Codey's File Tree API previously
rejected those links with `403: Path must be under project root`, even when the
file was readable and Codex desktop could open it.

Single-file text reads, media/raw reads, and text saves now resolve absolute
out-of-project paths against the source repository's NUL-delimited Git worktree
inventory. The candidate must still be a real checkout with the same canonical
Git common directory. Prunable, missing, replaced, and unrelated worktrees fail
closed. A project registered below the repository root only gains access to the
corresponding subdirectory in the other checkout.

This does not register the worktree as a project or fall back to a Home project.
Workspace-root checks, canonical filesystem boundaries, and relative traversal
rejection still apply; symlinks cannot escape the selected root. Directory
listing, create, rename, delete, and upload keep their original project scope.
Git metadata queries are bounded, disable optional locks, and ignore inherited
repository-selection environment variables.

The editor displays the backend's concrete error message and cannot save a
failed-load diagnostic as file contents. A late response for a previously opened
file cannot replace the current editor buffer.

The access fix is in the **node backend** and requires a node package update;
publishing only the Portal cannot enable it on older nodes. Error presentation
also requires the updated workspace frontend. Source tests cover real linked
repositories, narrow projects, stale registrations, unusual paths, symlink
escapes, raw/text/save routes, and editor error/reload behavior.

### Automatic titles for Codey-created threads (2026-09-21)

The earlier fix synchronized names that Codex already had, but a conversation
created in Codey only received a local first-message prefix. Its native `name`
could remain empty. The node backend now supplies the missing creation path:

- The runtime dispatcher observes the first native ID of a newly allocated
  Codey conversation. Both native and SDK creation events are deduplicated;
  ordinary resumes, imports, forks and passive observation do not trigger it.
- A separate background job summarizes up to 4,000 characters of the first
  user message in its language, using the selected model and the effective
  custom Responses provider returned by native `config/read`. It reuses
  configured environment-key/header credentials, never ChatGPT OAuth tokens
  or an unrelated provider/account.
- This is one tool-free, non-streaming model request with a requested output
  budget of 512 tokens. Strict JSON, an 80-character single-line title limit,
  a 64-KiB response-body limit, two concurrent jobs, 32 total admitted jobs and
  a 30-second deadline bound the background work. Failure does not fail or
  delay a user turn; neither model calls nor uncertain name writes are retried.
- After fresh native and local name checks, `thread/name/set` assigns the name
  only to a still-unnamed thread. Its read-back is verified before caching and
  broadcasting the automatic title. Manual Codey names, removed/archived rows
  and changed provider-ID mappings are protected at the database write too.
- A desktop name notification cancels pending generation. Native naming has
  no compare-and-set API, so its final empty-name check cannot provide atomic
  exclusion against another client renaming at precisely the same instant.
- The metadata connection does not resume/load the user's thread or acquire
  its writer. No title-generation prompt is added to conversation history.
  Isolated real-native tests cover naming while a user turn is active in both
  legacy and paginated storage, with an offline localhost model fixture.

This feature requires an updated **Codey node package**, not a Portal/shared-UI
deployment. Existing unnamed conversations are not bulk-renamed. Empty-text,
attachment-only conversations and unsupported provider authentication retain
the existing fallback behavior. Implementation/testing alone does not install
or publish a new running-node package.

Validation: 672 backend tests passed (15 opt-in/platform cases skipped), all
719 frontend tests passed, and type checks, lint and production build passed
with existing warnings. The two automatic-title native cases additionally
passed with Codex 0.154.0 and an offline model fixture. One bounded synthetic
Chinese prompt against the configured real model produced a valid Chinese
summary title; it did not create/rename a native thread or modify user history.

### Native session title synchronization (2026-09-20)

This fix belongs to the node's CloudCLI backend, not Portal or the shared UI.
Nodes must install the new Codey package; publishing Portal alone cannot change
their session indexes.

- Automatic Codey titles follow Codex's current native name. A name change is
  detected even if the thread timestamp is unchanged. The append-only
  `session_index.jsonl` fallback uses its last record, not its first.
- Explicit Codey renames are recorded separately as `custom_name_source=user`
  and survive both native polling and rollout indexing, including concurrent
  sync writes. App-generated first-message titles are not manual overrides.
- Index-only renames are watched and refresh existing titles outside the
  rollout birthtime cursor. A stale index cannot replace a newer native
  database name. Local archives, removals, provider IDs and recency are retained.
- Old versions recorded no title provenance. Upgrade preserves their Codex
  labels in `sessions.legacy_custom_name` before enabling native-name following.
  Historical manual names cannot be distinguished from stale caches; they can
  be reapplied using Codey's rename action. Later starts preserve both the
  backup and new manual-rename flags.
- Only Codey's metadata database is migrated. Codex storage is read-only; no
  native rename, thread resume, model request or history rewrite is required.

### Live desktop-owner controls (2026-09-20)

The earlier owner-delivery repair enabled continuation but not in-flight
controls: `desktopQueue` explicitly disabled steering and Stop, and private
stdio connections were excluded from `prepareObservation`. In addition,
resuming an idle desktop thread before discovering its UI owner could acquire
a second process's writer, blocking desktop input during a Codey continuation.

The peer path now:

- Discovers an existing desktop owner **before** a private `thread/resume` for
  ordinary messages. Idle continuation stays on that owner, preserving its
  session ID, model, permissions and approvals. No locks or metadata are edited.
- Attaches to a live desktop turn on Codey subscription without sending a
  prompt or acquiring a writer. An owner-pinned, versioned IPC snapshot supplies
  the active turn; another process's disk `interrupted` status is not evidence
  that the desktop is idle.
- Supports native `thread-follower-steer-turn` and explicit, run-bound
  `thread-follower-interrupt-turn`. The owner is not transferred. Disconnects,
  automatic cleanup and generic cancellation do not stop desktop work.
- Enables the existing durable Codey queue/atomic queued-card promotion via
  the same negotiated gateway capabilities used on Linux. Desktop-origin
  inputs and native steering receipts are also streamed back to Codey with
  their original identities and ordered transcript positions.
- Keeps the old native queue fallback for owners without a control channel.
  A verified peer uses fresh live state rather than a delayed disk snapshot
  when deciding whether its paused/idle session needs an explicit start.

Snapshots are scoped to the discovered owner, host and conversation. Canonical
history uses its ordered current tail, never an old unfinished turn or an
unordered entity map. Stale snapshot revisions are ignored. Owner discovery
allows the native router's full 10-second discovery window; the former
8-second timeout could reject a legitimate `no-client-found` result.

Before steering, Codey checks the owner's active turn and validates the native
returned turn ID. The desktop's version-1 steering protocol itself selects
its active turn (unlike direct daemon RPC, it does not accept a caller-supplied
`expectedTurnId`). If a turn rolls over during delivery or the receipt is
missing/wrong, Codey reports **unconfirmed**, keeps the queued draft held for
review and never retries or automatically queues the same input. Stop uses
the native version-4 expected-turn guard.

This is capability-based, not a blanket OS promise: an undiscoverable desktop,
an incompatible peer protocol, legacy exec-only execution, and native goal/
mode changes do not acquire these peer controls. New Codey-only threads with
no desktop owner retain the native execution path; this change does not
advertise a fabricated desktop owner for their private writer.

Validation adds isolated peer/runtime regressions and opt-in tests with two
real native processes, an IPC owner fixture and a localhost model. They cover
paginated and legacy histories, interleaved Codey/desktop steering, desktop
queue consumption during a Codey continuation, and explicit Stop. These tests
do not submit prompts into an existing user conversation or constitute a
real-desktop UI end-to-end test. Applying the repair requires a node backend
update; publishing the shared UI alone cannot change the runtime.

Local validation of this development repair:

- 596 backend tests passed; 13 opt-in/platform/fixture cases were skipped.
- All 673 frontend tests passed.
- All six opt-in native interoperability cases passed with desktop fixture
  `0.155.0-alpha.9.2` and reader `0.152.0`, including the two new bidirectional
  peer/queue/Stop cases.
- Production build and frontend/backend type checks passed. Lint reported
  zero errors and the existing 129 warnings; bundle-size warnings remain.
- The final backend run used a clean environment, private `HOME`, short
  `TMPDIR=/var/tmp` socket paths and two file workers, without concurrent
  frontend builds. Earlier inherited runtime settings, macOS socket-path
  truncation and parallel-build contention caused fixture failures; those
  environments were corrected, not the assertions or deadlines.
- No running node or desktop was restarted. This conversation is itself
  inside the managed Codey/Codex process tree, so the macOS updater's
  external-terminal requirement must be respected.

The local installable candidate is based on the **installed** `0.2.0` source
revision `91c3ca3`, not the worktree's older `0.1.18` package declaration.
Detached, private worktrees preserve the installed Windows-update fix and the
unchanged dependency lock; the user's checked-out revisions were not reset.
The original `0.1.18` packaging attempt was not offered for installation.

The compatible archive and a checksum-pinned `install.zsh` are under the ignored
`artifacts/mac-peer-controls-0.2.0.189rzc/` directory. Archive SHA-256:
`d52b90abc5b7e5af971815f94b2b2a0ce0d34fe1d07fedbeec73bbafe3792c4f`.
The installed updater's `--check --offline` validation passed, confirming an
in-place `0.2.0` patch with existing dependencies and no downloads. This is a
local development artifact, not an npm release or an already-applied update.
Run its installer from an external macOS terminal after current Codey work
finishes; do not bypass the internal-terminal guard to restart this session.

### Paused desktop queues and owner delivery (2026-09-20, macOS local time)

The start-only behavior in this historical repair is extended by the live
controls described above.

The cross-platform queue fallback alone did **not** fix the reported session.
Its previous turn had been explicitly interrupted. The native owner retained
the writer and paused automatic queue consumption: `thread/queue/add` succeeded,
but no model turn started. A read-only helper cannot wake it with
`thread/queue/start` because that operation requires the loaded owner.
The earlier offline tests only covered a normally completed previous turn.

After the exact native foreign-writer refusal, Codey now discovers the existing
owner through the desktop's native peer IPC protocol. An idle owner receives an
explicit `thread-follower-start-turn` with the original browser input identity
and `inheritThreadSettings: true`. This retains the native session ID, model,
effort, permissions and desktop tool approvals; Codey neither claims the writer
nor uses GUI automation. The adapter identifies itself as Codey, pins the
discovered owner, and never advertises ownership of any thread.

- Linux/macOS use the user-private `CODEX_HOME/ipc/ipc.sock`; untrusted or
  symlinked endpoints fail closed. Windows uses the native named pipe only for
  the shared default profile, not an unrelated custom `CODEX_HOME`.
- Active desktop work still receives native queued input, not a competing
  direct turn. A paused owner without the peer capability is rejected before
  adding another message. An idle, unstarted compatibility queue now reports
  the problem after 30 seconds instead of waiting silently for a day.
- Existing pending inputs are never deleted, replayed or leapfrogged by this
  automatic path. A real native regression proved that direct `turn/start`
  **does not deduplicate** an input still queued with the same client ID.
- Lost, rejected, wrong-owner or malformed acknowledgements never trigger a
  queue fallback, another writer, or an automatic retry. Started desktop turns
  remain desktop-owned; Stop may remove only Codey's unclaimed queue entry and
  requires an explicit `deleted: true` acknowledgement.
- Output is read from complete native turn pages and correlated by client ID.
  Only a durable completion timestamp proves that the foreign turn ended.

With the user's explicit authorization, the reported real conversation was
also tested, not merely its history endpoint. The stuck input was privately
backed up, cancelled through the installed Codey WebSocket using its captured
run ID, and independently checked to be absent from both the native queue and
turn history before resubmitting its original text and client ID once.

The candidate's actual Codey WebSocket gateway, strict request-bound SSO,
verified TLS, provider runtime, real desktop owner and real model then completed
two consecutive turns in the original conversation. The first answered the
original question; the second correctly summarized that context and returned a
fresh nonce. Both produced assistant text, successful Codey completion events,
exactly one matching persisted native turn, and an empty queue. The desktop
process and writer-lock inode were unchanged. The candidate used a fresh Codey
database containing only the target's mapping; no schedules, plugins or fake
model were started by the test harness.

Private receipts are under the ignored path recorded in
`artifacts/live-native-queue-goal-path` (`recover-e2e-result.json` and
`followup-e2e-result.json`). They contain conversation data and must not be
published. This establishes real **candidate** interoperability, not installation
of that candidate into the running node.

The opt-in offline native suite additionally covers paginated and legacy
histories after both normal completion and interruption, using owner
`0.155.0-alpha.9.2` and helper `0.152.0`. Its peer wire fixture forwards to the
real native owner but is not a substitute for the real-desktop test above.
Linux and Windows transport contracts are tested; their native binaries have
not been executed on this Mac.

Validation of CloudCLI `3c05a02`:

- 581 backend tests passed, 11 opt-in/platform/fixture cases skipped.
- All 673 frontend tests passed; the four opt-in real native cases also passed.
- Production build, frontend/backend type checks and lint passed with existing
  bundle-size/lint warnings.
- The final mixed backend run used an isolated `HOME` with inherited
  `CODEX_HOME` unset and four test-file workers; frontend used two workers.
  An initial run with an overriding `CODEX_HOME` and excessive parallel builds
  produced fixture failures/timeouts. The environment was corrected and the
  complete suites rerun; test assertions and timeouts were not weakened.
- CloudCLI was fast-forwarded to `main` and pushed. The parent integrated the
  latest remote `main` (`854c976`); Copilot API remains at the freshly verified
  remote `dev` tip `3c90b6f`. Runtime dependency specifications are unchanged.

#### Authorized local installation and follow-up

The macOS development package built from parent `b73bd15` / CloudCLI `3c05a02`
was installed using the existing CLI's verified offline update. Archive SHA-256:
`96a033c83a8a63e19cbe5547bdba20ddfd4f2a72d7c9374c9aab6dec6fe6adfe`.
The original settings, identity, credentials, TLS, native tools and prior
release were retained; no npm release or other-node rollout was performed.

The first automatic post-check stopped on tunnel readiness after the package
switch had already succeeded. Follow-up inspection passed all 16 doctor
checks without repeating the update. At 09:40 CST on 2026-09-20, the **actually
installed** Codey WebSocket returned a genuine context-aware nonce response in
the original conversation, with successful completion, exactly one persisted
matching turn and an empty native queue.

By that time the desktop had released this idle thread's writer, so this final
installed test exercised ordinary native continuation. The two earlier live
turns covered the interrupted, desktop-held owner path. A test must not require
an idle writer lock to remain present forever, or make an unused peer-discovery
probe a prerequisite for the gateway's own capability selection. Preliminary
follow-up probes stopped before submitting input; no model prompt was replayed.
The private installation and conversation receipts are referenced by
`artifacts/live-native-queue-goal-path`.

### Cross-platform native continuation (2026-09-19)

The reported macOS desktop session used paginated storage and had a live
desktop writer, but the desktop app communicated over stdio rather than the
Unix control socket. Keeping the app open therefore could not satisfy Codey's
daemon-only continuation guard. The earlier Windows queue repair was still
behind a `win32` condition.

Discovery, native history and execution now share a capability-based connector
on Linux, macOS and Windows:

- Prefer the existing owner socket. If the default socket is absent and an
  absolute `CODEY_CODEX_EXECUTABLE` is configured, use that native CLI over
  stdio with the same `CODEX_HOME`. Explicit stdio is no longer Windows-only.
- Explicit socket selections remain authoritative. Connection/protocol
  failures never switch executables, start exec, or retry a submitted prompt.
- A native resume that specifically refuses the same thread's active writer
  can use the existing desktop queue on every platform. The original owner
  runs the input under the original ID; Codey does not remove locks, rewrite
  thread metadata, or fork a replacement conversation.
- Native-only threads can be indexed without JSONL. Native history is read
  with `thread/read(includeTurns=false)` and complete `thread/turns/list`
  pages. An older backend may use inclusive `thread/read` only after an
  explicit unsupported-method response, never a partial export.
- Queue observation also uses full turn pages: some native versions support
  legacy thread queues but reject `thread/items/list` for legacy histories.
  Correlation still requires the submission's native client ID and a durable
  completion timestamp.
- Temporary read-only helpers load no thread and close only themselves.
  Queue executions retain desktop model, effort, permissions, approvals and
  started-turn interruption ownership.

Unconfigured legacy source installations retain their existing SDK behavior.
An incompatible native CLI still fails explicitly; “cross-platform” is not a
promise to reinterpret unsupported native formats. Native fork/edit remains a
separate limitation.

The fix needs a **node backend** build/deployment. Publishing the shared UI
alone does not change the running adapter. Verification uses isolated homes,
mock owners and opt-in real native CLIs against an offline localhost model;
it must not submit probes into the reported user session.

Validation on 2026-09-19:

- 506 backend tests passed in a clean environment; three were skipped (the two
  opt-in native tests and the existing missing-rollout fork fixture).
- Four offline real-CLI round trips passed on macOS: both paginated and legacy
  histories with CLI `0.152.0` on both sides, and with desktop owner
  `0.155.0-alpha.9.2` plus Codey's `0.152.0` helper. The owner executes queued
  input, releases its writer, and resumes Codey-created/continued threads under
  the same IDs. Ordinary desktop discovery includes the new Codey threads.
- Transport-selection regressions exercise `linux`, `darwin`, and `win32`.
  Actual Linux/Windows native binaries were not run in this validation.
- Build, frontend/backend type checks and lint passed; existing bundle-size
  and lint warnings remain.
- The pre-existing submodule checkout (`31c2e25`) was not reset. An isolated
  forward-port to the parent-pinned `8c294f1` also passed backend type checking
  and 33 runtime/steering regressions, retaining the newer goal/plan guards and
  desktop observation logic. Do not deploy the older checkout wholesale over
  a newer node; merge this repair into that node's release line.
- No package was published and no running service was replaced or restarted.
  The reported user conversation was not used for test input or modified.

### Integration with current release branches

The parent `main` was first fast-forwarded to `66f02fd`. The repair is now
integrated as CloudCLI `02a9228` on top of the parent-pinned `52918b0`, including
CloudCLI's remote `main` baseline `40563c2`. This retains the newer goal/plan
guards, runtime identity and Workspace reconnect safeguards rather than
replacing them with the older development checkout.

Copilot API `3c90b6f` merges remote `dev` baseline `20e4dee` (version `2.6.1`)
with the parent-pinned `b4a3e91` Codey GitHub-login integration. Both direct
GitHub authentication and upstream's cross-process Codex credential locking
and account-removal changes are retained. Neither component changes its
runtime dependency specifications; the parent's unified manifest and frozen
dependency lock pass the packaging compatibility checks.

Validation of the integrated source:

- CloudCLI: 563 backend tests passed, nine skipped; all 673 frontend tests
  passed. Build, frontend/backend type checks and lint passed.
- Two additional offline native round trips passed on macOS, covering both
  paginated and legacy histories with desktop owner `0.155.0-alpha.9.2` and
  Codey helper `0.152.0`. The platform-selection matrix also covers Linux and
  Windows; their native binaries were not executed on this Mac.
- Copilot API: all 959 tests passed, including the 76-test auth/token
  regression group. Build, type checking and full lint passed with the frozen
  Bun dependency lock.
- Parent: 587 tests passed, 40 platform/opt-in cases skipped, and syntax checks
  passed with Node `24.20.0` / npm `11.19.0`. The ignored skill download was
  rebuilt from source before testing. On macOS, use a canonical temporary
  directory (not the `/var` symlink) for filesystem-safety fixtures.

This records source integration, not a node rollout. No npm/machine package
was published and no node backend was manually deployed or restarted.
Tests used isolated homes; the reported user conversation was not used for
validation.

### Windows desktop-owned sessions (2026-09-09)

The Windows stdio history reader is not itself the desktop writer. Starting
another stdio process cannot resume an already owned thread, even when the
desktop UI is idle. Windows now handles the exact native writer refusal with
`thread/queue/add`: the existing desktop process executes the queued text and
image inputs without releasing its lock or changing the thread ID.

Codey correlates the resulting persisted turn by the submitted user-message
`clientId`, reads paginated items, and waits for `completedAt`. A read-only
snapshot can label a still-running foreign-process turn `interrupted`, so that
status alone is not a completion signal. Unknown acknowledgements are not
retried. Only the caller's still-pending queue entry may be cancelled.

This path inherits desktop execution settings and keeps desktop approvals and
started-turn interruption in the desktop. Incompatible explicit browser model,
effort or permission selections are refused before submission. It does not
rewrite Codex configuration, remove locks, fork histories, or restart the app.
This queue path is separate from the shared-daemon steering path below.

### Active shared-daemon turns (2026-09-13)

The original Unix adapter explicitly rejected every active desktop turn with
`This session is currently running in Codex app`. Ordinary messages now attach
to the existing owner and append input to that same turn:

- Read the thread's runtime status without loading its history, then fetch
  only the newest turn using `thread/turns/list` with `itemsView: full`.
  Paginated threads do not support `thread/read(includeTurns=true)` on the
  bundled CLI. Verify the thread identity, a single nonempty turn ID,
  `inProgress`, and no durable completion timestamp; never guess an older
  unfinished turn or follow it onto another turn.
- Seed existing in-flight items, subscribe before submitting, and call
  `turn/steer` with `expectedTurnId`. Buffer output/completion that arrives
  before acknowledgement. The acknowledgement must match the expected ID.
- Do not forward model, effort, permission or collaboration-mode overrides
  to an in-flight correction. A visible notice explains that the current
  desktop settings remain in effect. Native `/goal` activations and Plan Mode
  changes still require an idle session.
- After acknowledgement, the existing Codey correction UI can send further
  same-turn input. The original 2026-09-13 implementation advertised
  `canSteer: true` but `canInterrupt: false` and required Stop in the desktop.
  The explicit-Stop/observation correction below supersedes that restriction;
  automatic cancellation and desktop approval ownership remain unchanged.
- If the turn ends or changes before steering, or an acknowledgement is lost,
  fail without an automatic retry, queue submission, fork, or `turn/start`.
  Closing Codey's observer connection does not stop the original task.

The change requires a CloudCLI **backend** release; publishing only the shared
frontend does not activate it. Development tests use mock sockets and opt-in,
isolated real Codex instances with a localhost model fixture, not existing
user conversations or model credentials.

Validation on 2026-09-13:

- 535 backend tests passed, with one existing missing-rollout fork fixture
  skipped; all 641 frontend tests passed. Build, type checks and lint passed
  (existing bundle-size and lint warnings remain).
- The real two-client steering tests passed against both the bundled CLI
  `0.146.0` and the locally installed `0.154.0`, for paginated and legacy
  threads. Initial and subsequent corrections reached the model fixture and
  persisted under the original turn ID; no competing turn was started.
- Backend validation used isolated homes/databases and `TMPDIR=/var/tmp`.
  The existing filesystem-root test fails under the forbidden `/tmp` path;
  that failure was also reproduced from unmodified HEAD. No workspace
  validation or permission restrictions were changed to make it pass.
- No deployment or running-service restart was performed.

### Live/history user-message reconciliation (2026-09-14)

The 0.1.11 active-turn repair delivered each correction once, but the browser
could show it twice: a persisted native row plus the optimistic/accepted echo.
Native history timestamps all items with the enclosing turn's start, so a
correction typed later exceeded the old ten-second clock-skew match. Accepted
`steer_*` rows were not handled by the old `local_*`-only reconciliation either.
The original task's two test inputs were read back once each from native history;
their records were not deleted, rewritten, or submitted again.

The fix carries one opaque input identity from the browser/native submission
through `clientUserMessageId`, native `clientId` (legacy JSONL `client_id`), and
normalized `clientMessageId`. First sends, same-turn corrections and the Windows
desktop queue preserve that identity. History and WebSocket rows reconcile
one-to-one within the same provider/session, independent of content and turn
timestamps. Different known identities never fall back to fuzzy text matching;
legacy inputs without identity retain the existing bounded compatibility path.

Deploy the corrected node backend **and shared Workspace UI**, then refresh the
browser. Backend-only publication does not update the browser store, and a UI-only
publication cannot invent identities for older native submissions. Browser
refresh clears old transient echoes; no native history repair is required.

### Mobile handoff, transcript order and explicit Stop (2026-09-15)

A read-only comparison of the reported native session index and `thread/read`
found both in chronological order. The reversed-looking transcript came from
Codey's merge, not reversed native execution:

- Codey's native-history adapter had assigned every item the enclosing turn's start time,
  while websocket snapshots used their arrival time. Replaying earlier output
  against a newer history page could place the earlier output below that page.
- Native input/output can arrive before `turn/steer` acknowledges acceptance.
  The later gateway user echo could therefore appear below its own answer.
- An ID match also let an older, partial history snapshot hide newer cumulative
  live text after joining an already-streaming item.
- Equal turn timestamps could stop history-page bridging too early. Page
  boundaries now use native positions, and distinct native positions or input
  receipts cannot masquerade as overlapping rows just because their text matches.

Native history and runtime projections now carry `nativePosition`: the turn
identity, its start time, and the item index counting **all** native items,
including hidden reasoning/tools. The store uses this order rather than
comparing synthetic history timestamps with arrival times. It reconciles
identity-bearing native user receipts with optimistic/accepted echoes in either
arrival order and retains a newer cumulative snapshot until history catches up.
Legacy JSONL keeps its existing clock-based compatibility path.

Opening a Codey session now checks for an already-active shared-daemon turn
before acknowledging `chat.subscribe`. Preparation is read-only and does not
reserve an idle Codey session. After registry admission, observation attaches
without input or settings changes, verifies the same native turn again, and
checks for completion during attachment. Concurrent subscribers share admission;
a concurrent real send wins without being replaced by an observer.

Consequently, after switching from the desktop to a phone:

- The running state and queue/steer capabilities are available **before the
  first Codey message**. Send can persist the normal queue, and its existing
  steering action can promote that exact queued receipt immediately.
- Explicit Stop carries the displayed gateway run ID. The gateway checks the
  requesting user and run, then the runtime interrupts only its captured native
  thread/turn. Reconnect and capability-only status events restore
  `canInterrupt` instead of retaining an older non-interruptible state.
- Automatic scheduled interruption, cleanup and disconnects do not gain the
  ability to stop desktop turns. Unverified attachment, stale run IDs and failed
  interruption acknowledgements do not falsely complete a run or flush its queue.
- Native completion is forwarded after this runtime releases its slot/connection,
  so a queued successor cannot race the previous adapter's cleanup.
- The old warning is not emitted merely for opening an active session. If a
  send races observation and uses the existing direct-steer path, its informational
  receipt appears only after native acceptance and no longer says Stop is desktop-only.

These controls apply to an accessible **shared daemon**, not the separate
Windows foreign-writer queue transport. Desktop approvals remain in Codex app.
Observation follows the verified turn; it does not silently follow a newer turn,
start a parallel writer, fork history, retry a prompt, remove locks, or restart
the desktop. It is not continuous discovery of every later desktop-initiated
turn in an already-open browser.

Deploy the node backend **and shared Workspace UI**, then refresh the browser.
Refreshing an already-completed session can clear old transient display rows;
the native conversation itself does not require rewriting. Development used
mock transports and isolated real Codex instances with a localhost model fixture.
No prompts or interruption requests were sent to the reported conversation, and
no running service was restarted or deployment performed.

Validation:

- All 661 frontend tests passed. The full backend suite passed 546 tests,
  with seven opt-in/legacy-fixture skips and no failures.
- Eight isolated real two-client cases passed against Codex CLI `0.146.0`
  and `0.154.0`, covering both paginated and legacy history, corrections,
  prompt-free observation, and explicit Stop. They also verified that native
  interruption rejects a stale turn ID without stopping its successor.
- Production build, frontend/backend type checks, lint, and whitespace checks
  passed. Build retained bundle-size warnings; lint reported 129 warnings and
  no errors.

### General limitations

- These are same-host integrations, not database replication between different
  machines. Both clients must address the same host and Codex home.
- It enables discovery, reading, and safe continuation. The six-second index
  refresh is not token-level mirroring of every desktop-initiated background
  turn into an already-open Codey chat.
- Appending to an active shared-daemon turn uses its existing settings rather
  than starting a parallel turn. `expectedTurnId` protects against sending to
  a different turn, but a preflight check for idle/new-turn execution is not a
  cross-client transaction or collaborative editing lock.
- Desktop-specific interactive tools and approval dialogs still require the
  desktop client. Codey surfaces a notice and does not automatically approve,
  reject, or take over these requests.
- Native-only histories do not advertise legacy edit-message anchors.
  Native paginated fork/edit support is outside this change.
- The daemon protocol is version-sensitive. Verify read/attach compatibility
  before deploying to another node; do not assume that updating only the npm
  CLI changes the running desktop daemon.

## Validation

The provider regression suite uses a mock daemon on an isolated Unix socket
and a temporary Codey database. It covers discovery without JSONL, identity
mapping, new-thread creation, permissions, native history, early notifications,
busy/locked threads, abort ownership, lost acknowledgements/connections, legacy
fallback, and approvals. It does not send test prompts into a user's actual
conversation.

Initial focused validation: 57 tests passed and one legacy real-fork fixture
was skipped. `npm run build`, `npm run typecheck`, and `npm run lint` succeeded
(the build/lint retain existing warnings). An earlier full backend run had one
unrelated CLI-bootstrap authentication failure under the workspace's managed
SSO environment; the same failure was reproduced against the unmodified
baseline. This change does not alter authentication to make that test pass.

An actual-daemon smoke test on 2026-09-06 also exercised the compiled runtime:

- The running westus2 daemon reported version `0.147.0`.
- A new Codey thread had `source=vscode` and appeared in `thread/list` with
  its default source filter.
- A second client attached and remained connected. Codey then continued the
  same thread ID successfully, and the attached client received the turn's
  completion event. History contained exactly the two test turns.
- Only the dedicated smoke-test thread was archived afterwards. Existing
  user conversations were not used for test prompts.

Protocol details were verified against that running daemon: `thread/start`
accepts `workspace-write` / `danger-full-access` and `untrusted` / `never`.
Do not confuse these strings with the camelCase tags in the returned sandbox
policy. Ephemeral threads can be listed as loaded, but cannot be resumed from
a rollout or read with `includeTurns` on this version; they are insufficient
for an end-to-end continuation test.

Deploying the source change requires publishing the CloudCLI backend. A
frontend-only UI publish does not activate this runtime change.
The development/validation turn did not restart the existing service because
the current Codey conversation is a child process of that service.

## Permission selection correction: 2026-09-07

The original shared-daemon adapter applied Codey's permission selection only
to `thread/start`. It omitted both permission fields from every `turn/start`,
so changing the composer to Full Access on an existing thread did not change
the permissions under which that thread ran. The composer label was not an
acknowledgement of the daemon's effective policy.

For the reported command-approval screenshot, the matching turn's local
`turn_context` records `approval_policy=untrusted` and a `workspace-write`
sandbox with networking disabled. The global Codex configuration was already
`approval_policy=never` and `sandbox_mode=danger-full-access`; changing that
global file would not repair the missing per-turn propagation. The available
log does not establish when the browser's Full Access selection was made.

The correction sends explicit permission selections on every Codey-started
turn, including the first:

| Codey mode | `approvalPolicy` | `sandboxPolicy.type` |
| --- | --- | --- |
| `default` | `untrusted` | `workspaceWrite` |
| `acceptEdits` | `never` | `workspaceWrite` |
| `bypassPermissions` (Full Access) | `never` | `dangerFullAccess` |

These fields are supported by the running daemon's generated 0.147.0 schema.
They are deliberately not applied to `thread/resume`, which must remain safe
when the preflight discovers an already-active desktop turn. Omitted modes
continue to inherit the thread's settings. The daemon can reject a requested
policy; Codey reports that rejection without an exec fallback or retry.

This is permission propagation, not automatic approval. Outstanding approvals
and desktop-specific interactions still require the desktop client. Changing
the composer does not retroactively modify an in-flight turn or answer its
pending requests. The correction requires a backend deployment to take effect.

Validation: all 26 interop tests passed; the broader Codex/history/session
suite passed 67 tests with one existing legacy-fork skip. All 489 frontend
tests, the production build, type checks, and lint passed (existing warnings
remain). Run the mixed backend suite with a temporary home and inherited
`CODEX_HOME` unset: the legacy history fixtures override `os.homedir()`, not
that environment variable. The final isolated run did not use the live daemon.
No running service was restarted during development. The subsequent authorized
combined rollout, including its self-hosted-node handoff, is recorded in
`docs/codey-combined-fleet-release-2026-09-07.md`.

## Authorized fleet rollout: 2026-09-06

The subsequent deployment request covers all four CloudCLI workspace nodes:
`zhn-a100`, `jpe2`, `jpe3`, and `westus2`. The usage dashboard's `local` entry
is not another deployed CloudCLI workspace service.

- Release: `20260906-152209-codex-interop`.
- Application patch manifest SHA-256:
  `8808ca91e0c2d13965f835936a43b62c3a5c7dde294894ca4b0f64b8706105ea`.
- Each candidate starts from that node's own release and installed
  dependencies. Only the seven changed and five new TypeScript components,
  plus their compiled outputs, are overlaid after baseline/hash checks.
  Existing frontend assets, package dependencies, TLS/SSO settings, provider
  credentials and service-unit files are preserved.
- Each node reruns the 23 interop tests using its own production Node/dependency
  versions, and verifies access to its existing daemon before activation.
  Node 22's test runner initially rejected the Azure agent's inaccessible
  working directory; the deployment harness was corrected to run validation
  in the candidate directory, and all four validations then passed.
- Activation first makes a SQLite online backup, waits for no Codey child
  processes, atomically switches `current`, and restarts **only**
  `codey-cloudcli.service`. Failed local health checks restore the prior release.
- `jpe2` is the canary. Portal SSO, projects API, frontend integrity and
  WebSocket authentication are checked before rolling out the other nodes.
  No real conversations or model prompts are used for deployment probes.
- `westus2` hosted the deployment conversation itself. Its independent
  maintenance unit waited for that Codex process to exit and for 12 seconds of
  idle time before activation. It then verified all four nodes through the
  Portal without cutting off the requesting turn.

The fleet rollout completed at **2026-09-06 15:51:34 UTC**. All four nodes
reported `deployed`, with TLS health `200`, authenticated Portal/project APIs
`200`, and WebSocket upgrades `101`. Anonymous and cross-origin WebSocket
requests remained rejected (`401` and `403`). The final verification session
was removed and its revocation confirmed; temporary private transfer blobs
and read-only download grants were also removed.

The authoritative per-node/final results, rollback locations and verification
reports are in:

```text
artifacts/codex-interop-deploy-20260906-152209/deployment-summary.json
artifacts/codex-interop-deploy-20260906-152209/http-final.json
```

The summary is `awaiting-westus2` while the final maintenance job is queued,
`complete` only after all four activations and final Portal checks pass, or
`needs-attention` on a failed handoff/check. Node-local backups are retained
under `~/.local/share/codey-cloudcli/backups/20260906-152209-codex-interop`.

## Source publication and latest-version audit: 2026-09-06

The repository release records CloudCLI commit `8ab1190` and this rollout
document in the parent repository. The unchanged `copilot-api` revision is
`620b85c`.

A fresh audit compared a clean build of `8ab1190` with the running installation
on **all four nodes**, rather than trusting the release directory name:

- All 804 backend source and compiled-output files matched on every node,
  with no missing, different, or extra code files.
- Each node passed all 23 interop regression tests with its own installed
  Node/dependency versions and an isolated temporary database and home.
- Each existing desktop daemon accepted a read-only native-list probe.
  TLS health was `200`; anonymous access remained `401`. The prior releases
  and online database backups were still present.
- The Portal's 44 runtime/public files matched the current source, and its
  five production configuration files were unchanged.
- All 599 shared-UI build inputs matched the already-published package.
  All four nodes served `ui-20260906t133855z-20bb3a16`; the 161 publicly served
  shared assets matched their manifest hashes.
- Fresh Portal SSO, project APIs, voice configuration, per-node routing/PWA
  scopes, and WebSocket handshakes passed. Both speech providers and rewrite
  configuration remained available. Anonymous and cross-origin WebSocket
  requests were rejected. The temporary verification session was deleted and
  its revocation checked.

The clean-source validation passed 120 Portal tests, 451 frontend tests,
65 Codex/history/session regressions, and eight authentication/WebSocket
regressions. One legacy real-fork fixture remained skipped. Production build,
frontend/backend type checks, and lint passed; lint checked 736 files with
zero errors and 127 existing warnings. Tests used isolated data, not the
running application's database or user conversations.

The previously activated fleet release was therefore already the latest
runtime code. No additional package publication, service restart, dependency
upgrade, or real model call was required for this reconciliation. This avoids
interrupting active conversations merely to redeploy identical files.

Fresh source, node, Portal/UI, and Git publication records are retained in:

```text
artifacts/latest-fleet-release-20260906-165049/
```
