# Codey 0.2.10 — message forks and incremental foreground history

Release preparation: October 2, 2026.

## Repairs

- Add Fork session to the mobile bottom sheet, independently of the desktop
  menu. Expose touch-accessible fork controls on text, attachment-only,
  assistant and tool messages, without adding actions to transcript exports.
- Keep fork anchors separate from edit anchors. Explicit native Codex forks
  use the selected runtime's `thread/fork`, exclude full history hydration and
  defer goal continuation. Legacy edit/rewind protections remain in place;
  ambiguous mutations are never resubmitted.
- Resume confirmed history forwards using a stable row boundary, not a
  timestamp-only filter. Replay the anchor inclusively, publish each bounded
  page, preserve older message objects, and retain progress after suspension
  or network failure. Older nodes retain a bounded overlap-based fallback.
- Reuse native item cursors instead of rereading older item history during
  warm recovery. Preserve native item order and same-timestamp messages.
  Cold or evicted snapshots still require reconstruction.
- Reject missing/replaced anchors and protect against an edit arriving while
  a forward request is pending. Explicit Load all cannot mistake a paused
  catch-up snapshot for complete history.

## Validation and publication

Frontend: 832 tests passed. Backend: 797 passed, 16 skipped. Type checking,
client/server builds and lint passed; existing warnings remain. These are
automated regressions, not physical-device or production fork acceptance.

Dependency versions are unchanged. Publish the exact clean main source and
recorded component gitlinks as one shared Workspace UI and one cross-platform
npm/installation Skill release. Both UI and node backend updates are required
for forward synchronization; existing browser tabs must reload.

Use the original owner's installed CLI with the trusted package checksum,
normal identity/operation-lock checks and per-node health/source receipts.
Do not interrupt unrelated active work, upgrade native tool runtimes, alter
credentials or delete prior releases. Unreachable nodes are not considered
updated and receive no unverified queued work.
