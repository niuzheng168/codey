# Codey source repositories

The top-level repository is `niuzheng168/codey` (public). Codey-specific dependency
snapshots are separate **private** repositories in the same account:

| Checkout path | Repository | Branch | Original upstream |
| --- | --- | --- | --- |
| `cloudcli` | `niuzheng168/codey-cloudcli` | `main` | `siteboon/claudecodeui` |
| `copilot-api` | `niuzheng168/codey-copilot-api` | `dev` | `caozhiyuan/copilot-api` |
| `cloudcli/plugins/starter` | `niuzheng168/codey-cloudcli-plugin-starter` | `main` | `cloudcli-ai/cloudcli-plugin-starter` |

The existing public `niuzheng168/claudecodeui` and `niuzheng168/copilot-api` forks
are not overwritten. The private repositories retain upstream history and
licenses. CloudCLI is AGPL-3.0-or-later; copilot-api and the starter plugin are MIT.
This repository does not relicense them. Keep applicable source-offer and
distribution obligations in mind when sharing modified software.

The parent stores Git submodule commit pointers, **not copies of dependency
source**. The starter plugin is nested under the CloudCLI submodule, not also
vendored into the root. The portal, node relay, onboarding skill and
`codex-session-share-mcp` are first-party code maintained in the root repository.
Normal package-manager dependencies remain in their lockfiles; `node_modules`
and build artifacts are not committed.

## Clone

Authenticate Git with a GitHub account that can read all three private
repositories, then run:

```sh
git clone --recurse-submodules https://github.com/niuzheng168/codey.git
cd codey
```

For an existing clone:

```sh
git submodule update --init --recursive
```

An anonymous user can read the public parent but cannot clone the private
submodules. Do not change dependency visibility or redirect a submodule to a
public fork merely to fix an authentication failure.

## Commit dependency changes before parent changes

Work on a named branch inside the relevant submodule, commit and push that branch
to its **private** `origin`, then commit the new pointer in its parent. For the
starter plugin the order is starter → CloudCLI → Codey. For copilot-api the order
is copilot-api → Codey.

`git submodule update` checks out the parent's pinned commit; it is not a request
to pull the latest upstream code. Do not run `--remote`, force-push, discard a
dirty working tree, or update a running service as part of ordinary source sync.
New repositories have GitHub Actions disabled so inherited upstream release
workflows cannot publish packages or trigger deployments without review.

## Configuration and validation

Actual deployment configuration, certificates, `.env`, accounts, session history,
local recovery files, build packages and verification artifacts are excluded from
Git. See `config/README.md` and `.env.example` for setup. Existing operator files
are left in place; publication does not rotate secrets or change services.

The portal uses Node.js 22.13 or newer and has no third-party runtime dependencies.
After copying the appropriate config example:

```sh
npm run skill:build
npm run check
npm test
```

Install CloudCLI's locked dependencies and use its `typecheck`, `test:client`,
`test` (server) and client build scripts when changing that submodule. Do not use
service start/deploy scripts just to validate a source checkout.

Committing or pushing this project is independent of deploying it. UI-only
CloudCLI deployment updates hashed static assets and atomically replaces
`index.html`; it does not require a VM, copilot-api or CloudCLI service restart.

The initial publication's test results and known Windows/backend validation
limitations are recorded in [the validation report](./validation-2026-09-06.md).
