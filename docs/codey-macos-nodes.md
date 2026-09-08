# macOS nodes over private DevTunnel

macOS appears beside Windows and Linux in **Settings → Add node**, with separate
Apple Silicon and Intel source/runtime manifests. Missing releases remain disabled;
there is no Linux/Windows fallback and no fabricated Azure VM identity.

## Data path

```text
Browser → authenticated Codey node ACL
        → private DevTunnel client → Mac loopback HTTPS 3001 (CloudCLI)
                                  → Mac loopback HTTPS 8443 (read-only data)
Mac → its own private DevTunnel host connection
```

Each node has a reserved random ID, its own TLS leaf, owner-bound SSO key,
read-only data ticket key, and a separate tunnel-renewal key. The gateway pins the
node's leaf before sending a ticket or SSO assertion. Connect tokens are never
sent to the browser. The existing Windows tunnel/env-secret path is unchanged.

## Native installer

The personalized package includes `scripts/setup-macos.sh`,
`configure-macos.py`, `macos-service.py`, the reviewed CloudCLI/copilot-api source
archives, and a minimal Portal data-runtime archive. Node is downloaded from the
pinned official architecture-specific distribution and verified by SHA-256.

The Mac must already have its normal Codex/provider login and local model proxy.
This installer reuses them; it does not replace the proxy, rewrite Codex config,
copy another machine's credentials, change global Node/npm, or open inbound ports.
The data adapter reads the existing loopback proxy with its existing key file.
The package's copilot-api source/version is not a claim that the existing proxy
was upgraded.

The default command prints a plan. `--apply` builds a separate release and creates
only this node's user LaunchAgents:

- `codex`: a Codey-owned app-server using the reviewed installed native Codex,
  its own private Unix socket, and the owner's existing Codex home.
- `workspace`: CloudCLI on `127.0.0.1:3001`, with Portal SSO and TLS required.
- `data`: read-only HTTPS on `127.0.0.1:8443`, proxying only usage endpoints and
  reading local session history. Provider credentials are never forwarded off-host.
- `tunnel`: the explicitly named private tunnel, with HTTPS ports 3001/8443 only.
- `renew`: check every five minutes; mint a connect-only token only when the
  previous token has at most eight hours left.

The dedicated Codex socket does not replace the desktop's process or default
socket. Configured-backend failures never fall back to an older exec SDK. Existing
desktop writers remain protected: no writer locks are removed, no prompts are
silently retried, and no automatic forks are used to evade ownership conflicts.
macOS also supports the existing strictly read-only native-history adapter.

Services run as the signed-in OS owner and stop being available when the Mac is
offline or logged out. This is not an OS-level sandbox: another person must not be
given that owner's node access. An Azure login already stored in the owner's home
is still accessible to that OS account; the renewal implementation itself does
not require, provision, or use Azure deployment permissions.

The installer refuses occupied service ports, unrelated installation directories,
architecture mismatches, unreviewed binaries, and existing LaunchAgent collisions.
Failed attempts retain the same node/tunnel journal and private diagnostics.
Only an explicit `--retry-failed` can rebuild this owner's unfinished release.
Successful installs are verified in place, never upgraded/restarted by this script.

## Agent credential endpoint

`POST /api/machine-tunnels/<nodeId>/token` is intentionally separate from browser
authentication. It accepts only a bounded JSON body containing the already-bound
tunnel ID, cluster ID, and a connect-only token.

`Authorization: CodeyTunnel <timestamp>:<nonce>:<signature>` authenticates the
method, exact path, timestamp, nonce, and body hash with a purpose-separated,
node-specific HMAC key. Browser Origin requests, other node keys, old timestamps,
replays, malformed tokens and tunnel rebinding are rejected. Global/per-node
concurrency, replay-cache and renewal-rate limits bound validation work.

Before accepting the token, the server:

1. Checks the signed node registry, owner enabled state, platform, and pending
   expiry or active status.
2. Verifies the real Dev Tunnels service accepts the credential for that exact
   tunnel, both HTTPS ports, and no anonymous or unrelated port access.
3. Rechecks the owner and binding before storing the token.

Tokens are AES-256-GCM encrypted with node-bound associated data in the existing
signed registry. Public APIs/files contain no token or sealed-token fields.
Gateways read fresh credentials via their node-scoped provider; renewal does not
require an ACA secret update, a new revision, or an Azure token on the node.
Cancelled/expired pending identities, removed nodes, and disabled owners cannot
renew. A password session is not an agent credential and vice versa.

## Activation and deployment

After local TLS, SSO, data and Codex-backend checks, the installer writes
`output/codey-machine.json`. It contains only public certificate/routing metadata.
The owner's normal Portal session uploads that file. The server verifies the
real tunnel, pinned TLS, usage/history, SSO, anonymous rejection and WebSocket
upgrade before activating either gateway.

Build/publish both Mac manifests with `scripts/build-machine-bundle.py`, putting
them in their separate `platforms/macos-arm64` / `platforms/macos-x64` release
directories. Publish immutable artifacts before the `active.json` pointer. Only
update the Portal container image; preserve the MCP image, existing node configs,
storage, identity, ingress and unrelated secrets. Existing VNet/Windows nodes are
not reinstalled or restarted.

Before any Mac is activated, a pre-Mac Portal image can still serve the existing
nodes. **After activation, do not blindly roll back to an image that cannot parse
Mac machine records.** Prefer a Mac-compatible forward fix; disabling/removing a
new node before an older-image rollback requires an explicit owner decision.
Never hand-edit the signed registry or drop credentials to make a rollback pass.

## Verification gates

- Root syntax, package/download/platform tests and full Portal regressions.
- Mac installer identity/archive/registry/launchd/renewal unit tests.
- CloudCLI native history, explicit-socket fail-closed behavior, busy-writer,
  permission, SSO and WebSocket regressions; build, typecheck and lint.
- Real Mac native module, HTTPS, WebSocket and PTY smoke test using an isolated
  home/database, followed by termination of only those test processes.
- Actual personalized download and installation on the owner's Mac; live Portal
  activation, model/file/terminal checks and renewal verification.
- Final normal browser view of the Mac node and unchanged existing-node access.

Offline/mocked tests do not prove DevTunnel login, live activation, model access,
Intel hardware execution, sleep/wake recovery, or a real logout/login cycle.
Report each of those separately rather than extrapolating from a green unit suite.
