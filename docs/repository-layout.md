# Codey source repositories

The top-level repository is `niuzheng168/codey` (public). Its two main dependencies
reuse the owner's **existing public forks**, which are the canonical development
and deployment sources. They keep both GitHub's fork relationship and local
`upstream` remotes:

| Checkout path | Repository | Branch | Visibility | Upstream |
| --- | --- | --- | --- | --- |
| `cloudcli` | `niuzheng168/claudecodeui` | `main` | Public fork | `siteboon/claudecodeui` |
| `copilot-api` | `niuzheng168/copilot-api` | `dev` | Public fork | `caozhiyuan/copilot-api` |

On 2026-09-06, the locally committed Codey customizations were fast-forwarded into
the two original forks without rewriting their history or changing source trees.
The redundant `codey-cloudcli` and `codey-copilot-api` private mirrors are no longer
submodule sources. They have not been deleted; the original working copies retain
them only as `private-backup` remotes.

Dependencies retain upstream history and licenses. CloudCLI is AGPL-3.0-or-later;
copilot-api is MIT.
This repository does not relicense them. Keep applicable source-offer and
distribution obligations in mind when sharing modified software.

The parent stores Git submodule commit pointers, **not copies of dependency
source**. The unused Project Stats starter template has been removed from the
CloudCLI checkout and is no longer a submodule. CloudCLI's plugin manager and its
optional upstream plugin catalog remain available; core Codey features do not
depend on the template. The portal, node relay, onboarding skill and
`codex-session-share-mcp` are first-party code maintained in the root repository.
Normal package-manager dependencies remain in their lockfiles; `node_modules`
and build artifacts are not committed.

## Clone

The parent and both submodules are public, so read-only cloning does not require
a GitHub token:

```sh
git clone --recurse-submodules https://github.com/niuzheng168/codey.git
cd codey
```

For an existing clone:

```sh
git submodule sync --recursive
git submodule update --init --recursive
```

First fetch/pull the intended Codey revision on a clean parent checkout. The
`sync` command is important for older clones: it replaces cached private-mirror
URLs with the original fork URLs recorded in the updated `.gitmodules`.

Pushing changes still requires write access to the corresponding original fork.
Do not add unused example repositories as mandatory dependencies.

## Commit dependency changes before parent changes

Work on a named branch inside the relevant submodule, commit and push that branch
to its canonical `origin`, then commit the new pointer in Codey. For either
dependency, the order is submodule commit/push → Codey pointer commit/push.

`git submodule update` checks out the parent's pinned commit; it is not a request
to pull the latest upstream code. Do not run `--remote`, force-push, discard a
dirty working tree, or update a running service as part of ordinary source sync.
The existing public forks keep their original Actions settings. Their release
workflows require tags/manual dispatch; ordinary source synchronization does not
request a deployment. The Codey parent and private backup repositories
retain their existing disabled Actions settings.

## Sync upstream while preserving Codey changes

These are manual maintenance steps, not an automation installed by Codey. Start
with clean working trees and check that `origin` is the owner's original fork and
`upstream` is the corresponding upstream from the table above.

```sh
git -C cloudcli fetch upstream
git -C cloudcli switch main
git -C cloudcli merge upstream/main

git -C copilot-api fetch upstream
git -C copilot-api switch dev
git -C copilot-api merge upstream/dev
```

If a merge conflicts, stop and resolve it explicitly, preserving Codey's auth,
node isolation, HTTPS and voice changes. Do not reset to upstream, discard local
changes, or use a force synchronization that removes custom commits. If upstream
reintroduces the optional starter-template submodule, preserve its intentional
removal unless Codey actually adopts that plugin.

Validate the merged submodules before publishing, then push children first:

```sh
git -C cloudcli push origin main
git -C copilot-api push origin dev
git add cloudcli copilot-api
git commit -m "chore: update node dependency revisions"
git push origin main
```

Changing a fork or submodule commit is separate from updating a running node.
Build and deploy a reviewed revision only when explicitly requested.

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
