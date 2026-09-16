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
