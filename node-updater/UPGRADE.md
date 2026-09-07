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
database backups, and switches only changed components. It verifies metadata,
authentication, a Codey model reply and an ephemeral read-only Codex CLI reply.
These synthetic replies may incur normal model usage.

**Finish native Codex tasks before confirming maintenance.** The updater never
terminates Codex clients. It checks Codey's running-session API, active model
connections and independent `codex exec` processes; it does not claim a
zero-downtime or race-free admission barrier for arbitrary external clients.

The API-key migration is a readiness gate in this version. Missing independent
gateway keys or an unknown migration results in **需要迁移/人工处理**, not an
automatic credential rewrite or a bypass of authentication. A runtime change,
irreversible database migration, Windows/macOS node or unknown installation
layout also needs a separately implemented/reviewed migration or adapter.

On a failed activation it restores only this transaction's package pointers,
not stale databases, credentials, certificates or user data. Retained versions,
dependency caches and backups are not automatically deleted. An interrupted
transaction is recovered from the local journal before accepting another job.
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
