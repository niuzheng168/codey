# Codey 0.2.13 — retain the latest viewport through delayed rendering

Release preparation: October 3, 2026.

The 0.2.12 native fork pager was verified against the reported existing fork:
the newest 20 native items returned in approximately 2 seconds, earlier paging
in 1.9 seconds, and forward refresh in 1.4 seconds. The previous cold request
failed after approximately 43 seconds. These are observations, not guarantees.

Mobile-sized browser acceptance then exposed a separate viewport problem:
all 47 cached rows and the latest identity were restored, with only a signed
forward request, but delayed content reflow left the viewport 641 pixels above
the bottom and incorrectly persisted that as user scroll intent.

This release retains native newest-first paging and:

- Observes transcript row/composer resizing beyond the short initial-render
  timer. A pinned latest view stays at the bottom through delayed image,
  markdown and code rendering.
- Corrects layout-only browser scroll events before they overwrite the saved
  latest checkpoint as a user scroll-up.
- Preserves explicit wheel/touch/keyboard/scrollbar input, older-page requests
  and search ownership. Observers/listeners are removed on session changes.

Regressions cover delayed 641-pixel reflow, viewport resize, event ordering,
cleanup and user-owned older reading. Publish immutable new artifacts from
clean main, rather than replacing the already published 0.2.12 package.
Recheck idle owner nodes, preserve credentials/data/native tools and retain
previous releases. Unreachable nodes remain explicitly incomplete.
