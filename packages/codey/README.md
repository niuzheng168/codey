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

## Commands

- `codey start`: run both services in the foreground; stop both on Ctrl+C or
  if either service exits. Defaults to loopback ports 3001 and 4141.
- `codey workspace --port 3001`: run just the workspace.
- `codey gateway start --headless --host 127.0.0.1 --port 4141`: run just the gateway.
- `codey auth …`, `codey mcp …`, `codey gateway debug --json`: gateway tools
  through the same executable.

Existing environment configuration, gateway data and Codex sessions remain in
their original user data directories. The CLI does not install system services,
rewrite credentials, or update either component on its own. Managed machine
installation still uses the Codey onboarding installer.

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
