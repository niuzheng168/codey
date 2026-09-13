# Codey

One npm application containing the workspace and model gateway, compiled from
the CloudCLI and copilot-api sources. Neither application is installed as an npm
dependency. Both use Codey's single runtime dependency tree and shrinkwrap.

## Install a built package

```sh
npm install --global --umask=0077 ./codey-0.1.4.tgz
codey --version
codey doctor
codey auth login --provider copilot
codey start
```

The **public npm name `codey` is already occupied by another project**. Until
publication rights or a scoped name are arranged, install the local `.tgz` or
use an explicitly configured private registry. Do not run `npm install -g codey`
against the public registry expecting this application.

Node.js 22.13+ is required. Install the official Codex CLI separately; Codey
does not package another Codex binary. The locked SDK's JavaScript is inlined
as an internal module, without its transitive native CLI dependency. Native
dependencies such as SQLite and PTY are installed by npm for the target machine.

## One artifact, platform-specific compatibility

The canonical release is **one `codey-<version>.tgz` with one SHA-256**. Published
0.1.4 supports Linux x64 and Windows x64; the next 0.1.5 source additionally
supports macOS arm64/x64. Never relabel/overwrite a published 0.1.4 archive to
make it a Mac release. Mac native acceptance and publication are separate gates.
Do not rebuild a second `codey-win`/`codey-mac` package or regenerate
its dependency lock on the target machine. Release builds use the repository's
public-npm lock byte-for-byte and normalize text line endings before fingerprinting.
No native executable or installed `node_modules` directory is included.

On Linux/Windows, with Node/npm already installed, place `install-codey.mjs` next to the `.tgz` and
run the same command in Bash, PowerShell or cmd:

```sh
node install-codey.mjs
```

The installer verifies the embedded artifact checksum, installs into a new private
prefix through npm, checks the package before enabling native install hooks, then
runs `codey doctor`. It registers the CLI in the user's PATH without changing
services, DevTunnel, provider credentials or Codex configuration. `--check` still
installs and validates but does not register the CLI or edit PATH. A source checkout
requires explicit `--package FILE.tgz --sha256 HASH`.

Windows uses its native npm directory layout and a `.cmd` launcher; npm is invoked
through `npm-cli.js`, not by trying to spawn `npm.cmd`. Existing unmanaged launchers
are not overwritten. Open a new terminal or use the current-session PATH command
printed by the installer. Native dependencies may need their platform build tools
when no compatible prebuilt binary is available.

**Runtime installation is separate from managed deployment.** Linux retains the
systemd/DevTunnel `codey setup` workflow below. Windows can install and run the same
gateway/workspace npm code, but its existing service/DevTunnel hosting remains
external; the Linux updater and managed setup must not be run on Windows.
`codey doctor` explicitly reports this distinction and never claims model login.
Existing schema-2 Mac npm/launchd nodes instead enroll the independent
[Portal updater](../../docs/macos-node-updates.md). It reuses their original
Python/Node and service definitions and never runs setup or updates Codex/
DevTunnel. `codey update` local/tool commands are still Linux/Windows-only.

## Linux managed installation without a ZIP

Download the machine build's `codey-<version>.tgz` and `install-codey-linux.sh`
from Portal into the same directory, then run:

```sh
bash install-codey-linux.sh
```

The launcher uses npm directly, prepares native dependencies in a **new** private
prefix, validates the package/configuration, and invokes the installed
`codey setup`. It also accepts `--package /path/to/codey.tgz` or an explicit
HTTPS `.tgz` URL. A pinned `codey@VERSION` requires an explicit private
`--registry`; the unrelated public npm package is rejected.
Only the prerequisite Node distribution is extracted by the launcher, not Codey.

For an existing Node.js installation, standard npm installation also works:

```sh
npm install --global --prefix "$HOME/.local" --umask=0077 ./codey-0.1.4.tgz
"$HOME/.local/bin/codey" setup --check
"$HOME/.local/bin/codey" setup
```

Setup uses the existing package root and Node runtime. Both services share this
root; it does not install another copy, move npm-managed files, or overwrite the
target of npm's `codey` symlink. Use an OS-user-owned HOME prefix compatible with
the updater, not `sudo npm install` into a system prefix.

Setup creates a stable `$HOME/.local/bin/codey` launcher and persistently adds
`$HOME/.local/bin` to PATH in `.profile`, `.bashrc`, and any existing
`.bash_profile` / `.bash_login`. The PATH block preserves other shell settings,
and repeated installation or shell loading does not duplicate entries.
Open a new Bash terminal afterward, or run `export PATH="$HOME/.local/bin:$PATH"`
in the current one; the installer cannot change its parent shell's environment.
Installing the npm package alone or using `--check` does not edit shell profiles.

### Linux DevTunnel renewal fix in 0.1.7

The Linux installer and generated renewal script accept the DevTunnel CLI's
welcome banner before its JSON output. Invalid/trailing output and failed CLI
commands still fail closed, without printing credential-bearing parse errors.
The new-machine Skill and its embedded npm installer must both contain this fix.

An ordinary `codey update` preserves the already-generated
`~/.local/share/codey-machine/renew-devtunnel.sh`; upgrading the application alone
does **not** repair that file on an existing node. Existing affected nodes need a
separate owner-scoped script repair and successful token renewal. Do not rerun
`codey setup` for this bug: setup also replaces service/model configuration and
stops existing Codex processes.

`machine:build` embeds only public Portal configuration (origin and updater public
key), with `platform: "auto"` so the application artifact is not tied to the Linux
installer. Linux managed setup resolves that public configuration to `linux-x64`.
A generic `codey:build` needs `codey setup --config FILE`; the file has the
same public fields as `onboarding/setup.json`, without node identity or credentials.
`codey setup --check` does not change services or contact models.
The launcher's `--check` still installs npm dependencies, but does not deploy.
Actual setup requires Python 3.12+, sudo and the owner's interactive provider login.
It replaces service/model settings and stops old Codex processes, retaining auth
and session files. Merely installing the npm package never invokes setup.

## Update only Codey from a local npm package

Routine updates directly reuse the installed dependency tree when dependency
locks match, using a Windows directory junction or a Linux directory link.
Only the Codey application is unpacked: no dependency files are copied, no Node
or dependency archives are downloaded, and no npm install/rebuild hooks run.
Owner, dependency graph, link target and Node ABI checks bind the retained tree;
native probes still verify it before activation. Changed locks use the normal npm
path; add `--offline` to refuse that path rather than attempt a download.
Keep referenced old dependency directories: updates retain them for reuse and
rollback, and never modify their contents. The 0.1.6/0.1.7 CLI's earlier copy-based
implementation remains unchanged in those immutable published packages.

For a one-time offline bootstrap from an older CLI, use the new release's installer
with `--check --reuse-from /absolute/path/to/existing/node_modules/codey`, then run
the resulting new CLI with `update PACKAGE.tgz --offline --installed-root OLD_ROOT`.
`--check` leaves PATH and services untouched. This explicit independent bootstrap
copies dependencies so the separate installation does not depend on the donor's
lifetime; normal `codey update` does not perform that copy.
Do not use plain `npm install` for offline dependency reuse: normal npm installation
still resolves the declared runtime dependencies. A fresh machine must supply its
dependencies separately; a 7 MB application-only archive cannot replace them.

Run from an external terminal as the original OS owner:

```sh
codey update /absolute/path/codey-new.tgz --offline --check
codey update /absolute/path/codey-new.tgz --offline
```

`--check` validates the shared artifact, installed layout and existing Node
compatibility without installing dependencies, writing an update job or changing
services. An optional `--sha256 HASH` checks an independently obtained checksum.
Only trusted, tested local `.tgz` files are accepted, never public npm names,
tags or URLs.

The update stages a fresh private npm installation with the **existing** Node/npm,
validates packed files before enabling native dependency hooks, and runs
`codey doctor`. It then checks for concurrent deployment/active work and switches
only the application. It never invokes `setup`, installs Codex/Node/Python/
DevTunnel, rotates model keys, changes provider configuration or calls a model.

- **Managed Linux x64:** reuse the existing updater's package-pointer transaction
  and restart only Workspace/gateway. Briefly pause/resume the existing pull
  updater without replacing it; pending Portal jobs block local maintenance.
  Preserve its signed-release high-water mark and label the install as local,
  not a signed Portal release.
- **Recognized Windows x64 node tasks:** change only the package fields in the
  existing native runtime descriptor and restart its Codey task.
  Keep the existing Node, Codex, DevTunnel, service helpers, tunnel/renew tasks,
  credentials and registration. No whole-machine installation is performed;
  unknown external Windows service arrangements are not taken over.
- **Unmanaged user-owned npm installation:** stop foreground Codey yourself.
  The package and CLI keep their existing path; no service is installed or
  started. Unknown/partial/legacy managed layouts are refused.

Finish native Codex tasks first. There is a short interruption, not a
zero-downtime guarantee. Failed activation restores this transaction's package
pointer/descriptor and version metadata, never stale databases or credentials.
Concurrent changes are not overwritten. Old packages, staged dependencies and
private journals are retained; use `codey update --recover` for an interrupted
local transaction instead of reinstalling or manually clearing its lock.

An older CLI without `update` needs a one-time bootstrap: use the new release's
`install-codey.mjs --check` to install/verify a separate runtime without changing
PATH or services, then invoke that new CLI with
`update /absolute/path/codey-new.tgz --installed-root /absolute/path/old/codey`.
The target must still be the actual owner-managed service package (or an existing
user npm installation); the bootstrap does not bypass compatibility/idle checks.
See `docs/codey-local-update.md` in the source repository for recovery and validation.

## Update the managed Codex or DevTunnel runtime independently

The updater in **Codey 0.1.4** uses **installed Codey >=0.1.3** as its compatibility
baseline. The already-published 0.1.3 artifact is immutable: use the 0.1.4 CLI
(or its explicit `--installed-root` bootstrap), not the old 0.1.3 executable.

```sh
codey update codex /absolute/codex-bundle/tool-update.json --sha256 "$TRUSTED_SHA256" --check
codey update codex /absolute/codex-bundle/tool-update.json --sha256 "$TRUSTED_SHA256"
codey update devtunnel /absolute/tunnel-bundle/tool-update.json --sha256 "$TRUSTED_TUNNEL_SHA256" --allow-disconnect
```

Select exactly one component. The native bundle contains the **entire** reviewed
vendor distribution, not just a copied exe; `scripts/build-tool-update.mjs` in the
source repository creates its declarative manifest without downloading/executing
an installer. The independently obtained manifest SHA-256 is mandatory and binds
all companion files. `--check` is read-only and never runs the candidate binary.

Codex CLI and `codex app-server` are one native distribution. The updater follows
the actual managed CLI pin, not an unrelated PATH/Desktop installation. It checks
the candidate's exact version and app-server JSONL handshake in an isolated HOME,
with no thread creation or model request. External CLI/Desktop work blocks the
switch rather than being killed. The existing owner CLI entrypoint is retained.

DevTunnel updates keep the original tunnel, login and renewal configuration.
They briefly disconnect the host: use a terminal independent of that tunnel and
explicitly pass `--allow-disconnect`. Only the managed host/necessary owner task
is restarted; Windows renewal is not killed and reads the new executable on its
next invocation. Node/Python, model settings, keys and user data are untouched.
All local components share a lock, rollback journal and `codey update --recover`.

This does **not** add tool releases to the Portal's signed Linux Codey feed or add
a Windows pull agent. No existing node is deployed automatically. Windows owner
ACLs, Task Scheduler and actual network recovery still require native acceptance
testing; portable/mock tests are not production validation.

## Commands

- `codey start`: run both services in the foreground; stop both on Ctrl+C or
  if either service exits. Defaults to loopback ports 3001 and 4141.
- `codey workspace --port 3001`: run just the workspace.
- `codey gateway start --headless --host 127.0.0.1 --port 4141`: run just the gateway.
- `codey auth …`, `codey mcp …`, `codey gateway debug --json`: gateway tools
  through the same executable.
- `codey doctor [--package-only] [--json]`: verify the common package and local native modules without services or models.
- `codey update PACKAGE.tgz [--check] [--sha256 HASH]`: update this application's package only.
- `codey update codey PACKAGE.tgz …`: explicit alias for the existing package-only command.
- `codey update codex TOOL-UPDATE.json --sha256 HASH [--check]`: update the managed native CLI/app-server distribution.
- `codey update devtunnel TOOL-UPDATE.json --sha256 HASH [--check | --allow-disconnect]`: update the managed tunnel host.
- `codey update --recover`: recover an interrupted local package or tool update.
- `codey setup [--config FILE] [--check]`: configure an installed Linux node.

Existing environment configuration, gateway data and Codex sessions remain in
their original user data directories. Service startup commands do not install
system services, rewrite credentials or update either component. Only the explicit
`codey setup` command runs the managed onboarding installer.

## Gateway defaults

Codey sets `CODEY_MANAGED=true` before loading the gateway. Responses API
WebSocket transport defaults to **off** (`useResponsesApiWebSocket: false`) for
both a new config and an existing config that omits the setting. This does not
disable the workspace's own WebSockets.

An explicit `useResponsesApiWebSocket: true` or `false` in the gateway's
`config.json` takes precedence. No configuration rewrite or installer override
is required for the default. Standalone copilot-api outside Codey retains its
existing default.

## Build from the Codey repository

```sh
npm run codey:build -- --output artifacts/codey-npm-test
```

Build once on Linux x64 from the checked-out submodule commits in isolated directories.
The same output is installed on Windows; a Windows source build is not a separate
release. The builder installs the unified runtime dependencies from
`packages/codey/package-lock.json`, checks
native modules and entrypoints, then runs `npm pack`. The package contains one
application manifest, `bin/codey.mjs`, workspace output in `dist-server/` and
`dist/`, gateway output in `gateway/` and `pages/`, and the managed node updater.
There are no embedded application tarballs, application-specific package
manifests, or application-specific `node_modules` trees. `install-codey.mjs` and
the artifact checksum are emitted alongside the npm package.

Source commits and output fingerprints are recorded in `codey-build.json`;
`sourceDirty` marks local uncommitted Codey packaging/updater changes (the commit
is then the base revision, not a claim that those changes have been committed).
Managed nodes upgrade and roll back this entire npm application atomically;
the legacy two-application updater format is rejected for this layout.
CloudCLI's AGPL-3.0-or-later license and copilot-api's MIT notice are included in
`LICENSE` and `licenses/`.

To validate a built artifact in a disposable npm prefix and HOME, without real
credentials or model calls:

```sh
CODEY_PACKAGE_TGZ="$PWD/artifacts/codey-npm-test/codey-0.1.4.tgz" \
  node --test test/codey-package-shared-install.test.mjs test/codey-package-install.test.mjs
```

The shared-install test also runs natively on Windows:

```powershell
$env:CODEY_PACKAGE_TGZ = (Resolve-Path .\artifacts\codey-npm-test\codey-0.1.4.tgz).Path
node --test test/codey-package-shared-install.test.mjs
```

Windows path/dispatch unit tests are not a substitute for that native test. Keep
the Linux and Windows validation reports tied to the **same artifact hash**.
