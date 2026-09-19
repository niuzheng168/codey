# Codey

One npm application containing the Workspace and model gateway, compiled from
CloudCLI and copilot-api. Both use one locked dependency tree. The official
Codex CLI is a separate tool; its SDK JavaScript is inlined into Codey.

The published manifest contains only dependencies used by the Node runtime.
React, CodeMirror, Mermaid and other browser dependencies stay in CloudCLI's
build environment; their compiled UI assets are still included. Unused desktop
automation packages are not installed. Browser Use's existing on-demand
Playwright installation remains separate.

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

If GitHub CLI is already signed in (`gh auth login`), the installer and Codey
commands reuse it when their own credentials are absent. No second GitHub
authorization is needed. Existing independent accounts are preserved; gh account
bindings pin the username/ID and CLI location without copying its token.
GitHub CLI is optional and is not installed or logged in automatically.

No Portal upgrade agent or persistent local updater is included. Installation only exports
a private registration JSON; importing it is a separate user action. Registration requires
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
The complete Skill uses one Node workflow and native OS adapters. Linux standalone
npm setup calls that same workflow directly, without a staging/switch installer.
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
codey doctor --runtime-only
codey copilot login
codey start --foreground
```

This installs the same checksummed `codey-<version>.tgz` on all four platforms,
prepares native dependencies and adds a private CLI to the user's PATH. It does
**not** configure services, DevTunnel, node TLS or Portal registration.
`--check` is read-only: it verifies the archive digest and reports deferred checks
without npm, downloads or filesystem changes. `--no-launcher` installs/verifies
dependencies without changing CLI/PATH. Open a new terminal after PATH registration.

Source use requires `--package FILE.tgz --sha256 HASH`. The public npm name
`codey` belongs to another project: never run `npm install -g codey` against the
public registry expecting this application.

The optional `--reuse-from EXISTING_CODEY_DIRECTORY` copies a matching locked
dependency tree into a new independent installation, without modifying the
donor. It refuses changed locks, unsafe links or incompatible native modules;
it is not an updater and never switches a running service.

## Commands

The [CLI reference](../../skills/config-new-codey-machine/references/codey-cli.md)
groups commands by `codey <command>`, with separate entries for each Copilot and
DevTunnel subcommand. Each entry includes usage, parameter meanings, aliases,
defaults, constraints and examples. It ships at `onboarding/references/codey-cli.md`
in the npm package; parameter details are maintained there rather than duplicated here.

`codey copilot login` now ensures authentication rather than always reauthorizing;
use `--force` for an explicit new device login. Startup reuses gh without prompting.
DevTunnel uses gh for management and passes only a host-scoped token to the
official CLI on stdin. The existing native supervisor rotates it before expiry;
connect tokens retain their separate renewal path. A raw `devtunnel user show`
can therefore still say "Not logged in"; use `codey doctor` for Codey's state.

`codey guard` enables and starts all installed native supervisors: CloudCLI/Copilot API,
DevTunnel host and token renewal, plus tunnel health monitoring on Linux.
It shares background `codey start`'s idempotent operation, without another daemon.
`codey start --foreground` runs only CloudCLI and Copilot API; `codey copilot start`
runs only the API. CloudCLI has no separate public command.

On Linux, `codey update FILE.tgz --background` uses a single-use systemd user job
that survives a disconnected client. Updates invoked inside Codex/Workspace
automatically use this mode. Preparation happens while the old services run;
switching briefly interrupts connections. Unchanged native tunnel units stay up.
Use `codey update --status` and `codey doctor` to verify completion: acceptance
is not update success. Active requests and Workspace terminal commands may be
interrupted and are never automatically replayed. Session files are retained;
in-memory task state is not transparently migrated. Windows/macOS and older CLIs
still require an external owner context. This does not add a resident updater.
Configuration, tools, ports and service state are rechecked immediately before
switching. Pre-switch refusals never trigger a service-stop rollback. Status
rechecks the final report after consulting systemd, including when a completed
transient job has already been collected.
The opt-in `test/codey-reconnect-native.mjs` acceptance harness submits from a
simulated Codex ancestor, terminates only its dedicated submitter service, and
checks authenticated WebSocket reconnection, protected-file hashes and health.
See [reconnectable update design and validation](../../docs/codey-reconnect-update.md)
for failure handling, platform boundaries and native acceptance evidence.

Installation and removal are described in the
[machine Skill](../../skills/config-new-codey-machine/SKILL.md).
There is no public `codey setup` or unified `codey uninstall` command.

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

Runtime dependency specs must match the upstream components, but their entire
frontend dependency lists must not be copied into Codey. After compilation,
`scripts/check-codey-runtime-dependencies.mjs` audits the emitted Node imports
(including literal lazy imports and `require`) for both missing and unused
dependencies. It uses the build's existing TypeScript parser, not a new user
dependency. Native-module and real-server smoke tests cover runtime execution.
