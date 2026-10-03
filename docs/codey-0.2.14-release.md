# Codey 0.2.14 — keep tail anchoring across incremental appends

Release preparation: October 3, 2026.

Live browser acceptance of the reported fork received additional native
messages while the page was closed. Forward paging correctly retained the
cached prefix and appended those messages, but rebuilding the resize observer
on every row-count change forgot the layout immediately before the append.

Keep that observer for the lifetime of the displayed transcript rather than
for one page length. Its existing child observer discovers appended rows.
This preserves the latest viewport through both delayed rendering and new
forward pages, while explicit older reading and search still own their view.

A hook regression verifies that appending a message does not recreate the
observer. Browser acceptance permits genuinely newer messages, checks that
the cached prefix is retained, and still requires signed incremental requests
and the bottom viewport. The native newest-first pager and all preservation,
source-verification and idle-node rollout guards remain unchanged.
