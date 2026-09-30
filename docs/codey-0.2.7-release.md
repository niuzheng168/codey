# Codey 0.2.7 — discover symlinked Codex daemon sockets

Release preparation: September 30, 2026.

## Fix

Codex 0.158.0 can expose its default `app-server-control.sock` path as a
symbolic link to a private Unix socket. Codey's previous `lstat().isSocket()`
check inspected the link itself, rejected the running owner and could select
a separate native stdio backend instead.

- Default and explicitly configured Unix endpoints now check the link target
  with `stat()` and still require it to be a socket.
- Connections retain the configured/default alias. They do not cache or
  hard-code the daemon's current private socket location.
- Absolute, relative and chained links work. Missing default endpoints keep
  the existing legacy fallback; missing or non-socket explicit owners remain
  unavailable instead of selecting another backend.
- Permission failures, symlink loops and incompatible handshakes remain
  errors. Submitted requests are not replayed.
- Windows still does not probe the default Unix endpoint. Codey does not
  start, stop, adopt or reconfigure the Codex daemon.

This package also includes the previously merged main-branch repair for
paginated live Codex history. It does not revert that repair while updating
socket discovery.

## Validation and rollout boundaries

Regression coverage uses isolated Unix sockets and synthetic JSON-RPC
responses, including both default and explicit owner selection. It never
starts a model request or changes an existing conversation.

The runtime dependency lock changes only its Codey version. Production
artifacts must be built from the exact pushed main SHA and its recorded
submodules, then inspected and installed in isolation before publication.
Publishing a package does not update nodes, restart services, change model
providers or alter credentials.

After a node has been explicitly updated and verified, a migration-only
`CODEY_CODEX_DAEMON_SOCKET` override pointing at the default daemon's resolved
socket can be removed. Keep overrides that intentionally select a separate
backend. Do not remove the workaround from an older Codey installation.
