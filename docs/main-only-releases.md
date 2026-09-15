# Main-only releases

Deployment is not a development operation. Production inputs are one exact
`origin/main` commit, the two submodule gitlinks recorded by that commit, and
explicit external runtime configuration. Deployment must not fix code, bump a
version, commit/push, or ship a development worktree.

## One-time cutover

The September 15, 2026 release included reviewed but uncommitted code. Do not
overwrite it with the older clean main merely to obtain a matching label.

1. Review the retained release diff and the existing local changes. Separate
   unrelated work; do not indiscriminately stage every modified file.
2. Put the intended runtime/installer fixes, parent submodule pins, and this
   publication contract through the normal review and merge process. If npm
   package contents change, prepare a new version in that change; do not replace
   the already published 0.1.14 bytes.
3. Merge into main. Use a fresh, clean checkout with its recorded submodules.
4. Publish from the resulting full main SHA. Verify the image's source SHA and
   the UI/installer artifact fingerprints, not just a version label.
5. Only then enable the optional CI rollout. No step here authorizes discarding
   local work or stopping a busy node.

## Enforced source contract

- The controller rejects dirty, untracked, stale or non-main production
  checkouts. This includes uncommitted deployment-tool changes and moved
  submodule checkouts. Use CI's separate checkout instead of stashing/resetting
  an active development directory.
- Source export uses `git archive` of a selected main commit. Submodules are
  fetched by their **recorded commit IDs**, never independently selected
  `origin/main`, `origin/dev`, or `git submodule update --remote`.
- Only private fetch refs and ignored build artifacts are written. The
  developer's branch, index, source/version files and `FETCH_HEAD` are not
  publication outputs.
- `--reviewed-working-tree` and the worker's old `portalSnapshot` input fail
  closed. A build-time repair requires a reviewed main change and a new release
  attempt; it is not a reason to edit the exported snapshot.
- Frozen source bytes are checked against Git objects, including added source
  files; committed `eol=crlf` conversion is recognized for Windows scripts.
  Shared-UI inputs are bound to the exported gitlink. The only supported
  source substitution is the existing compiler's Codey-version replacement in
  the copied CloudCLI package manifest.
- Production npm/Skill publishers require matching main provenance inside the
  actual tarball. Azure UI publication requires committed parent provenance.
  Existing historical artifacts remain readable; they are not retroactively
  relabeled or silently eligible for a new unproven publication.

The external runtime JSON files, public node CA, existing Azure secrets,
accounts, databases and node state are **not** Git source. Configuration drift,
owner confirmation, canary, idle and rollback guards continue to apply.

## Commands from a clean main checkout

Portal-only, on the existing Linux build host:

```sh
SHA="$(git rev-parse HEAD)"
python3 skills/codey-deploy/scripts/deploy.py \
  --workspace "$PWD" --remote-root "$PWD" --local-builder --scope portal \
  --expected-portal-commit "$SHA" --apply
```

The deployer checks the current remote main before freezing; it refuses a stale
requested SHA instead of silently substituting a different commit.

Application and complete installation Skill builders also default to main:

```sh
python3 scripts/build-codey-package.py \
  --source-commit "$SHA" --output "artifacts/codey-$SHA"

python3 scripts/build-machine-bundle.py \
  --source-commit "$SHA" --output "artifacts/machine-$SHA" \
  --portal-origin "$CODEY_PORTAL_ORIGIN" \
  --updater-public-key-file "$CODEY_RELEASE_PUBLIC_KEY"
```

Use a new empty output directory. The Skill uses installer sources from the
**same** frozen root as its npm package. `--allow-reviewed-diff` is development
only; the resulting package/Skill cannot pass production publication.

Standalone shared UI:

```sh
npm run workspace:build -- --production --source-commit "$SHA"
```

Azure `workspace:publish` builds from main when no package is supplied, or
validates an existing package's committed provenance. Local `--local` previews
may still use development output and cannot claim a production main SHA.

Version changes belong in a release preparation change, not in these commands.
Portal image tags include the full source SHA and a unique build ID; ACA uses
the resolved immutable image digest.

## Runtime acceptance

The generated `codey-source.json` is copied into the image, excluded from Git,
and checked during image construction against `CODEY_SOURCE_COMMIT`. The
authenticated `GET /api/version` reports the baked root SHA, tree, component
commits and Codey version. An ACA environment override does not choose that
reported SHA.

Production acceptance compares this endpoint with the selected source and
retains the image digest plus UI/installer checksums. Missing or mismatched
provenance fails acceptance. Local development without the generated file
explicitly reports unavailable provenance, not an invented SHA.

## Optional GitHub Actions rollout

`.github/workflows/deploy-portal.yml` deploys **only Portal**, on pushes to main
or a main-branch manual run. It deliberately does not restart personal nodes or
publish every npm version on every commit. Their existing explicit publication
and owner-confirmed update flows remain separate, under the same source gates.

Before enabling:

- Configure a trusted Linux x64 self-hosted runner labeled `codey-deploy`, with
  Git 2.43+, the existing Node/Python/Azure CLI build dependencies and authorized access
  to the existing Codey Azure resources. Prefer a dedicated CI identity.
- Set the `production` environment and its reviewers/access controls. Protect
  main through the repository's normal review/test policy.
- Set `CODEY_RUNTIME_CONFIG_DIR` to a private directory **outside** the CI
  checkout containing the six named runtime-config files used by the workflow.
  Files are copied only into the disposable CI checkout and never uploaded.
- For private submodules, configure a read-only `CODEY_SOURCE_READ_TOKEN` that
  can read those repositories; otherwise the normal read-only GitHub token is
  used. Tokens are not included in build archives or artifact reports.
- Set the repository variable `CODEY_DEPLOY_ENABLED=true` only after cutover.
  Adding or merging the workflow alone does not enable production deployment.

Deployments are serialized without cancelling an in-progress rollout. Failed
tests leave the previous production revision in place. Main and production may
therefore differ while a release is pending/failed, but a successful release
must identify its exact committed source; no silent repair or relabeling is
allowed. Direct administrator Azure access is outside these code-level gates;
restrict production write access to CI if this must also be an access-control
boundary.

CI uploads only explicitly listed sanitized reports. Private ACA snapshots,
logs, signing keys, credentials, runtime configuration and source archives are
not artifact-upload inputs.
