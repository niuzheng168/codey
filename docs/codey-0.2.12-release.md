# Codey 0.2.12 — native fork history, newest page first

Release preparation: October 3, 2026.

## Diagnosis

The reported fork retained its inherited native history, but opening it without
a browser checkpoint still traversed the complete thread before slicing the
last page. A read-only production diagnostic failed after approximately 43
seconds; reading its newest native item and validating the reverse boundary
took approximately 45 milliseconds. These observations are not timing guarantees.
The 0.2.11 durable-cache repair addressed warm reopen, not this cold-load path.

## Repairs

- Cold native history requests read the newest 20 visible native items directly
  in descending order, then render that page chronologically. Scrolling upwards
  seeks earlier items with a signed, session-bound cursor, not full-history
  materialization or offsets relative to a growing tail.
- Forward refresh replays the final item and fetches only subsequent pages.
  Atomic native items preserve multi-row projections such as multi-file edits.
  Per-row older seek points survive trimming the durable browser window.
- Reopen retains the existing bounded local checkpoint and per-page commits.
  Expired/restarted native cursor chains recover through one bounded latest
  page, never legacy full-history bridging.
- Do not display a fabricated total when native history has not been counted.
  Explicit load-all/export walks bounded older pages; ordinary opening does not.
- Reads do not fork again, copy transcript files, resume a writer or submit
  model requests. Invalid native pages fail explicitly without silent fallback.

## Validation and publication

Regression coverage includes a 100,000-item inherited fork, backwards traversal
without gaps or duplicates, forward growth, multi-row replay, trimmed cache
boundaries, expired/cross-session cursors, invalid native pages and live ordering.

Publish the shared UI and node package from clean main and its recorded
gitlinks. Verify the reported existing fork in a fresh mobile browser context
and recheck all owner nodes. Preserve identities, credentials, native tools,
configuration, conversation data and old releases. Unreachable or busy nodes
must not be represented as successfully updated.
