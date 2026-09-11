# Codey

One npm application containing the workspace and model gateway, compiled from
the CloudCLI and copilot-api sources. Neither application is installed as an npm
dependency. Both use Codey's single runtime dependency tree and shrinkwrap.

## Install a built package

```sh
npm install --global ./codey-0.1.1.tgz
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

## One artifact for Linux and Windows

The canonical release is **one `codey-<version>.tgz` with one SHA-256**, shared by
Linux x64 and Windows x64. Do not rebuild a second `codey-win` package or regenerate
its dependency lock on the target machine. Release builds use the repository's
public-npm lock byte-for-byte and normalize text line endings before fingerprinting.
No native executable or installed `node_modules` directory is included.

With Node/npm already installed, place `install-codey.mjs` next to the `.tgz` and
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
npm install --global --prefix "$HOME/.local" ./codey-0.1.1.tgz
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

## Commands

- `codey start`: run both services in the foreground; stop both on Ctrl+C or
  if either service exits. Defaults to loopback ports 3001 and 4141.
- `codey workspace --port 3001`: run just the workspace.
- `codey gateway start --headless --host 127.0.0.1 --port 4141`: run just the gateway.
- `codey auth …`, `codey mcp …`, `codey gateway debug --json`: gateway tools
  through the same executable.
- `codey doctor [--package-only] [--json]`: verify the common package and local native modules without services or models.
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
CODEY_PACKAGE_TGZ="$PWD/artifacts/codey-npm-test/codey-0.1.1.tgz" \
  node --test test/codey-package-shared-install.test.mjs test/codey-package-install.test.mjs
```

The shared-install test also runs natively on Windows:

```powershell
$env:CODEY_PACKAGE_TGZ = (Resolve-Path .\artifacts\codey-npm-test\codey-0.1.1.tgz).Path
node --test test/codey-package-shared-install.test.mjs
```

Windows path/dispatch unit tests are not a substitute for that native test. Keep
the Linux and Windows validation reports tied to the **same artifact hash**.
