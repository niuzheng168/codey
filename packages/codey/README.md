# Codey

One npm application containing the Workspace and model gateway, compiled from
CloudCLI and copilot-api. Both use one locked dependency tree. The official
Codex CLI is a separate tool; its SDK JavaScript is inlined into Codey.

## Complete node installation

Use the complete `config-new-codey-machine` release Skill. Its native entrypoints
prepare Node/npm, official Codex, Microsoft DevTunnel, TLS, model configuration,
OS service supervision, tunnel-token renewal and private Portal registration:

- Linux x64: `bash scripts/install-npm.sh --package assets/codey-*.tgz --check`;
  replace `--check` with `--expected-computer "COMPUTER"` after approval.
- Windows x64: `powershell.exe -NoProfile -File .\scripts\install.ps1` to inspect;
  add `-Apply -NetworkApproved -ExpectedComputerName "COMPUTER"` after approval.
- macOS arm64/x64: `bash scripts/install-macos.sh --check`; apply with
  `--apply --network-approved --expected-computer "COMPUTER"` after approval.
  The shell only bootstraps Node when missing; installation and LaunchAgent
  workers run in Node, not Python. A GUI owner login is required.

No Portal upgrade agent or local updater is included. Registration requires
only node access credentials, not an updater secret or release-signing key.
Existing Python/updater-managed nodes need a separate reviewed migration;
installation must not be used as an upgrade, rollback or recovery mechanism.
Never delete an old node's Python/runtime or transaction state just because new
installations no longer need it.

Ports 3001/4141/8443 must be free or verified as this owner's Codey using native
PID, owner, installation path and startup configuration. Any foreign or unknown
listener aborts installation; no process is killed to free a port. Same-release
ready nodes retain their active application, identity, TLS, keys and configuration.
New nodes need `--replace-existing` (Windows: `-ReplaceExisting`) to back up and
replace existing Codex configuration; close unmanaged Codex processes yourself.
Linux has one npm → `codey setup` path, without a second staging/switch installer.
Windows `-RepairServices` is removed. All native installers render the same
`templates/codex-config.toml`, substituting only the local model catalog path.

Normal installation does not require Python or Bun. If a native npm module has
no matching prebuilt binary, its source-build fallback can require a compiler
and Python. Stop and report that dependency rather than silently installing a
toolchain. Build/release tooling in this repository still uses Python and Bun;
those are developer dependencies, not prerequisites for the delivered Skill.

## Runtime-only installation

With Node.js 22.13+ and npm, use the release's adjacent installer and tarball:

```sh
node install-codey.mjs
codey --version
codey doctor
codey auth login --provider copilot
codey start
```

This installs the same checksummed `codey-<version>.tgz` on all four platforms,
prepares native dependencies and adds a private CLI to the user's PATH. It does
**not** configure services, DevTunnel, node TLS or Portal registration.
`--check` still installs and verifies dependencies; it only suppresses CLI/PATH
changes. Open a new terminal after PATH registration.

Source use requires `--package FILE.tgz --sha256 HASH`. The public npm name
`codey` belongs to another project: never run `npm install -g codey` against the
public registry expecting this application.

The optional `--reuse-from EXISTING_CODEY_DIRECTORY` copies a matching locked
dependency tree into a new independent installation, without modifying the
donor. It refuses changed locks, unsafe links or incompatible native modules;
it is not an updater and never switches a running service.

## Commands

- `codey --help`, `codey --version`: help and application version.
- `codey doctor [--package-only] [--json]`: verify the application and local
  native modules. It does not check login, model responses or tunnel access.
- `codey start [--workspace-port PORT] [--gateway-port PORT]`: run Workspace
  and the gateway in the foreground. Defaults: loopback ports 3001/4141.
  Ctrl+C stops both; this does not start DevTunnel or register services.
- `codey workspace --host 127.0.0.1 --port 3001`: Workspace only.
- `codey gateway`: gateway only, loopback port 4141.
- `codey auth login --provider copilot`: authenticate the model gateway.
- `codey gateway debug --json`, `codey gateway --help`, `codey mcp --help`:
  gateway diagnostics and command help. Redact diagnostic output before sharing.
- `codey setup [--config FILE] --check`: check the Linux package/public config.
- `codey setup [--config FILE] --expected-computer NAME [--replace-existing]`:
  Linux x64 managed installation or same-release verification, never an update.

`codey update`, `--update`, tool updates and update recovery are removed.
There is no unified `codey uninstall` command yet. Stop/remove only resources
owned by this installation, with explicit confirmation; keep user data,
credentials, projects, shared tools and cloud resources by default.

## Runtime defaults

Codey sets `CODEY_MANAGED=true` for both internal entrypoints. Gateway Responses
WebSocket transport defaults to off; an explicit existing setting is preserved.
This does not disable Workspace WebSockets. Existing application data and Codex
sessions remain outside the npm package directory.
Managed nodes also enable HTTPS 8443 in the gateway process for read-only data
tickets. HTTP 4141 contains model/admin routes and is not tunneled. Keeping the
two listeners avoids changing local client TLS trust or mixing their access rules.

## Developer build

Build from the repository with `npm run codey:build`, or `npm run machine:build`
for the complete Skill. A machine build needs an explicit HTTPS Portal origin,
not an updater public key. Production builds still require the reviewed main
commit and its recorded submodule commits. Native Windows/macOS acceptance is
separate from portable fixture tests; no release is published by running tests.
