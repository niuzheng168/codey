# Owner-confirmed node updates

The Portal brokers **desired package versions**, not remote shell commands. An independent
`codey-node-updater.service` on each Linux x64 node polls outbound HTTPS. No SSH key, Portal
master, model credential, release signing private key, or new inbound management port is
distributed to nodes. Windows local copilot-api is excluded.

## Release once, update many

1. Build/test one immutable full release with the deploy Skill. Retain its `manifest.json`,
   `validation.json` and the two prebuilt `cloudcli.tar.gz` / `gateway.tar.gz` archives.
   A changed upstream commit is not itself sufficient evidence of compatibility.
2. Generate an Ed25519 signing pair once on the owner-only build host:
   `node scripts/publish-node-update.mjs keygen --private-key <private.pem> --public-key <public.pem>`.
   Keep the private key out of Git, ACA and its file share. Back it up through normal private
   operator key custody; do not regenerate it during every deploy.
3. Publish using `publish --manifest <manifest.json> --output <feed> --private-key <private.pem>
   --sequence <increasing integer>`. Optional `--components cloudcli` supports a CloudCLI-only
   release. Specify `--cloudcli-node-majors` / `--gateway-node-majors` only for runtimes actually
   tested; the default is Node 24. The publisher verifies evidence and artifact hashes.
4. Upload the immutable `releases/<release>/` files and public PEM to the existing private
   Azure Files share. Upload `catalog.json` **last** under an operator publishing lock and
   atomically rename it into place. Never expose the signing private key or an unauthenticated
   artifact URL. Set `PORTAL_NODE_UPDATE_ROOT=/data/node-updates` and
   `PORTAL_NODE_UPDATE_PUBLIC_KEY_FILE=/data/node-updates/release-public.pem` on ACA.
5. The owner chooses one, selected, or all eligible machines in Settings, previews the exact
   release and any blockers, and confirms. First available idle node is the batch canary;
   only success unlocks up to three concurrent remaining nodes. Offline/busy nodes stay queued.

The signed manifest pins component version/commit, tar and entry hashes, supported Node
major versions, platform, protocol/config schema, expiry and migration requirements. Both
Portal and agent verify it. Sequence numbers prevent downgrade; repeated release IDs cannot
be republished. Sign a **new higher-sequence release** to deliberately roll code back.
Never set a version from `latest` or execute an arbitrary command supplied by a browser.

## Bootstrap old and new machines

- Existing nodes: owner downloads that node's private updater ZIP, then runs
  `python3 install.py` to inspect the plan and `python3 install.py --apply` to install only
  the updater. Use an existing Python 3.12+ interpreter (including the separately installed
  Azure CLI Python if appropriate); do not upgrade global Node/Codex or restart the apps.
- New nodes: the personalized `config-new-codey-machine` download includes the updater
  source, public trust key and a separate per-node credential. The installer installs it
  automatically after the two new apps pass TLS/auth checks. Re-downloading a pending
  identity reuses its updater credential. It cannot claim work until Portal activation.
- Re-pair/revoke requires explicit owner confirmation. Rotation preserves the reported
  anti-downgrade high-water mark. Revocation stops new work, not the model services.

The private configuration is `~/.config/codey-updater/config.json` (0600), immutable job
data is in `~/.local/share/codey-updater/jobs/`, and the installed version is recorded
separately from enrollment identity. Updater status intentionally excludes logs, prompts,
model keys, TLS keys and SSO material.

## Compatibility and rollback

The agent preserves service units, original Node executables, model/SSO/TLS config and
databases. It stages prebuilt packages and reuses dependencies only for a matching lock and
install fingerprint. Cold mismatches install locked production dependencies, not another
full backend build. Only changed services are stopped.

Codey running sessions, native `codex exec` processes and active model sockets defer
activation. Native app-server tasks may be between requests: finish those tasks before
confirming. This is a short restart, **not a zero-downtime guarantee**.

An independent transaction journal recovers a crash during switching. Authenticated health,
a real Codey WebSocket response and a real ephemeral readonly Codex CLI response are all
required before success. A failure rolls back this transaction's code/pointers/bookkeeping
only; it never restores stale databases or keys and refuses to overwrite another deployment.
Interrupted staging requires a new explicit retry rather than repeating uncertain actions.

`gateway-api-key-v1` is a **prerequisite gate**, not a blind key rotation. Before a key-required
release, migrate every external caller and service environment to the same independently
issued node model key, verify anonymous/wrong-key 401 and both clients' real responses, then
publish the release. Unknown migrations remain blocked. Destructive DB migrations, automatic
Python/Node/Codex upgrades and self-upgrading protocol versions are intentionally unsupported.

Do not run the legacy SSH package activator at the same time as, or silently over, the
pull updater. First-time adoption is explicit. Normal recurring releases publish one feed
and use the owner-confirmed queue.

## Validation

`npm run updates:check`, `npm test`, and on Linux
`python3 -m unittest discover -s test -p test_node_updater.py`.
The Python transaction fixtures never invoke real systemctl; they cover directory/symlink
adoption, partial-component changes, model-failure rollback and concurrent-state protection.
Only live fleet evidence counts as production/model verification. MCP and Session History
specialized tests remain skipped per the existing release policy.
