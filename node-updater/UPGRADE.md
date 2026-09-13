# Codey existing-node updater

This is an **existing-machine updater**, not the new-machine enrollment Skill.
It preserves the node ID, account ownership, certificates, SSO keys, model
provider configuration, databases, Node runtime and Codex installation.

## One-time installation by the machine's OS owner

1. On Codey's settings page, use **接入升级器** for the machine you own.
2. Keep the downloaded ZIP private. It contains an updater-only credential, not
   a model API key, and must not be installed on a different machine.
3. Transfer/extract it on the existing Linux x64 node. Python 3.12+, OpenSSL 3,
   the existing owner user services, and outbound HTTPS to Codey are required.
4. As the service owner (never root):

   ```sh
   python3 install.py --config config.json
   python3 install.py --config config.json --apply
   ```

The first command checks node/account identity and prints the exact scope.
The second installs **only** `codey-node-updater.service`. It does not restart
copilot-api or CloudCLI, change networking, register a new node, rotate model
keys or upgrade any package. User-service linger, if needed after logout, is a
separate OS-owner/admin choice; the installer does not run sudo.

## Actual upgrades

Select a signed release and one or more machines in the settings page, review
the version/component/migration plan, and confirm it. An offline node remains
queued. A batch claims one canary first; a failed canary blocks its remaining
nodes, while a successful canary permits at most three concurrent updates.

The local agent checks the pinned release signature, digest, platform, runtime,
monotonic release sequence and migration prerequisites. It downloads only
assigned artifacts, stages immutable candidate directories, reuses compatible
locked dependencies, waits for Codey/model requests to become idle, takes online
database backups, and switches only changed components. Whole-Codey acceptance checks
the package/version, native modules, startup and authenticated local health. It never
sends a model request, creates a synthetic session or runs `codex exec`, even for an
unchanged package. Only legacy split-component Linux releases retain the original
Codey/ephemeral Codex model checks and their possible usage charges.

Nodes installed from the single `codey` npm package report the `npm` layout.
They accept only a whole `codey-<version>.tgz` release, prepare dependencies from
its shrinkwrap, and stop both internal services around one atomic package switch.
Matching dependencies are linked directly without a full copy, reinstall or rebuild.
Whole-Codey reuse compares the CLI's dependency graph rather than app/root-lock version labels,
so an app-only patch still reuses its dependencies. Dependency versions, integrity and
install hooks remain covered; signature and exact lock-byte checks are not relaxed.
The original owner-checked tree remains in a retained release or transaction backup;
directory-anchor activation and rollback rebind references before restarting services.
Linux stages use the CLI-compatible `codey-dependency-link.json` record, binding the
physical donor, canonical dependency graph, Linux x64 and the existing Node ABI.
Existing records are validated. A historical unrecorded source link can be adopted only
after verifying the original package, physical owner-scoped tree, locked versions and
internal link boundaries. Candidates always require a record; relocation updates both
pointer and record.
Do not delete any referenced release/backup. Different dependency graphs or install
fingerprints still require locked installation.
Rollback restores the entire package. Legacy per-app releases and npm releases
are not interchangeable; the agent rejects the wrong layout before downloading.

**Finish native Codex tasks before confirming maintenance.** The updater never
terminates Codex clients. It checks Codey's running-session API, active model
connections and independent `codex exec` processes; it does not claim a
zero-downtime or race-free admission barrier for arbitrary external clients.

The API-key migration is a readiness gate in this version. Missing independent
gateway keys or an unknown migration results in **需要迁移/人工处理**, not an
automatic credential rewrite or a bypass of authentication. A runtime change,
irreversible database migration, Windows/macOS node or unknown installation
layout also needs a separately implemented/reviewed migration or adapter.

Gateway JSON is compared semantically across the copilot-api 2.5.3 renames
`responsesTransport` to `upstreamTransport` and `headersTimeoutMsV2` to
`headersTimeoutMs`. Only identical values are equivalent; conflicting aliases
block the update. API keys, providers, transport values and all other settings
remain covered by the configuration fingerprint. The updater does not rewrite
the configuration or exempt arbitrary migrations.

On a failed activation it restores only this transaction's package pointers,
not stale databases, credentials, certificates or user data. Retained versions,
dependency caches and backups are not automatically deleted. An interrupted
transaction is recovered from the local journal before accepting another job.
New whole-app receipts identify `authenticated-health-v1` and bind health to the job,
signed digest, version and entry hash with `modelRequests: false`. Historical completed
native journals still require their original model proof; recovery never reruns inference
or changes a terminal rollback to success.
Do not run the old SSH package updater concurrently with this agent.

## Diagnostics

```sh
systemctl --user status codey-node-updater.service
python3 ~/.local/share/codey-updater/agent-v1/updater.py status
python3 ~/.local/share/codey-updater/agent-v1/updater.py once
```

Credential/configuration: `~/.config/codey-updater` (owner-only).
Jobs, private diagnostic logs, candidates and rollback backups:
`~/.local/share/codey-updater`. Do not post those logs publicly.
The website receives only bounded version/status/error-code reports.
