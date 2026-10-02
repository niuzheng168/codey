# Codey 0.2.11 — durable history reopen checkpoints

Release preparation: October 2, 2026.

## Diagnosis

A reported native conversation had 5,065 rendered records and approximately
25.8 MB of normalized history. The browser's previous 16 MiB whole-entry cache
silently rejected larger writes while leaving an earlier entry in place.
Displaying newer rows therefore did not guarantee that reopening could restore
them. A native cold history read measured roughly 27 seconds; a warm forward
read of the same final boundary measured roughly 1.3 seconds.

These are observations of one read-only diagnostic, not performance guarantees.

## Repairs

- Persist a bounded recent confirmed window (normally 200 rows, at most 4 MiB),
  not all loaded history. Older rows remain available from the provider and
  the live store. Never preserve an obsolete checkpoint merely because a
  newer full transcript no longer fits the cache.
- Commit each forward page before requesting the next. Persist unfinished
  catch-up state so reopening resumes immediately, even when its last saved
  page is recent. Flush viewport state on hide/pagehide; throttle rather than
  endlessly debounce during streams. Fence older-tab writes.
- Restore a retained reading row by identity and relative offset where
  possible. Do not apply pixel offsets from a discarded transcript prefix.
- Return a session-bound, signed native resume cursor independent of the
  snapshot LRU. Forward recovery after snapshot eviction does not traverse
  thousands of older native items. Node process restarts invalidate these
  cursors and still require one fresh authoritative history read.

## Validation and publication

Regressions cover the reported 5,065-row/25 MB scale, browser-store recreation,
page-by-page durability before a pending HTTP reply, background flushing,
reading anchors, stale-tab writes, expired snapshots and tampered/cross-session
resume cursors. Initial cold loading is distinct from reopening a confirmed
cache; quota/storage denial still falls back to the provider.

Publish both shared UI and node package from clean main and its recorded
gitlinks. Preserve node identity, credentials, data, native tools and old
releases. Recheck every owner node; do not count unavailable nodes as upgraded.
