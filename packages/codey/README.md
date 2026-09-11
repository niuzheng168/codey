# Codey

One npm application containing the workspace and model gateway, compiled from
the CloudCLI and copilot-api sources. Neither application is installed as an npm
dependency. Both use Codey's single runtime dependency tree and shrinkwrap.

## Install a built package

```sh
npm install --global ./codey-0.1.0.tgz
codey --version
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
npm install --global --prefix "$HOME/.local" ./codey-0.1.0.tgz
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
key). A generic `codey:build` needs `codey setup --config FILE`; the file has the
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

Builds from the checked-out submodule commits in isolated directories, installs
the unified runtime dependencies from `packages/codey/package-lock.json`, checks
native modules and entrypoints, then runs `npm pack`. The package contains one
application manifest, `bin/codey.mjs`, workspace output in `dist-server/` and
`dist/`, gateway output in `gateway/` and `pages/`, and the managed node updater.
There are no embedded application tarballs, application-specific package
manifests, or application-specific `node_modules` trees.

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
CODEY_PACKAGE_TGZ="$PWD/artifacts/codey-npm-test/codey-0.1.0.tgz" \
  node --test test/codey-package-install.test.mjs
```
