# Existing macOS node: enroll the independent updater

This private ZIP belongs to **one node and its original OS/Workspace owner**.
Do not share it, upload it to Git, paste `config.json`/logs, or run it as root.
It is not a Mac installer, registration repair, tool updater or a copy of Codey.

## First enrollment

Use the already installed schema-2 `codey-macos-oneclick` npm layout at
`$HOME/.config/codey-machine-macos/runtime.json`. Apple Silicon and Intel have
separate signed release platforms. An older split CloudCLI/data-relay layout
is not silently migrated. `--check`/the default command must succeed first.

In the Mac owner's external terminal, enter the extracted `codey-updater`
directory. Use **the original Python interpreter recorded by that installation**,
not a new Python/Homebrew installation:

```sh
chmod 600 config.json
PYTHON="$(/usr/bin/plutil -extract pythonExe raw -o - \
  "$HOME/.config/codey-machine-macos/runtime.json")"
"$PYTHON" -I -S -B ./install.py
"$PYTHON" -I -S -B ./install.py --apply
```

If the original Python cannot be resolved, the runtime descriptor is missing,
or its interpreter is not Python 3.12+, stop and inspect the installation.
Do not use the Linux installer, change the platform field, re-register the node,
or run `sudo` to get past a refusal.

The plan checks the existing layout, owner, identity, processes, source hashes,
TLS/SSO/model authentication readiness and native Node. It does not send a model
prompt, download dependencies or change a service. Apply installs only this
owner's `com.codey.node-updater.<nodeId>` LaunchAgent and private agent files.
The original Codey, Codex, Node, DevTunnel, configuration, TLS keys, tunnel and
renewal LaunchAgents are retained. Keep the original owner logged in; an offline,
sleeping or logged-out Mac cannot perform an update.

After a heartbeat, Portal shows the **actual installed package version**. A
missing/broken/unknown installation still reports a reason, not a made-up 0.1.4.
The private config can subsequently be rotated by explicitly re-enrolling the
same node/owner; pending jobs or unresolved recovery block replacement, and the
signed sequence high-water mark is retained.

## Normal updates

Choose a compatible macOS release in Portal, preview it, then explicitly confirm
the job. The Mac pulls outbound over HTTPS; no listening updater port is opened.
The published **0.1.4 Linux/Windows-only archive is not a macOS release**. The
macOS-capable application changes are prepared as **0.1.5**, which still needs
building, native acceptance and publication. Do not rebuild/overwrite 0.1.4.

Finish Codey tasks and close this Mac's native Codex/Desktop work before a changed
package is activated. An external Codex/Desktop process whose activity cannot be
proved idle is conservatively busy; it is never killed. There is no force flag.
Staging uses the original Node/npm, the signed `.tgz`, locked `npm ci`, native
rebuild and `codey doctor`, all before stopping an application.

Under the original Mac `install.lock`, the agent rechecks every staged app file,
configuration and activity, then stops/starts **only the existing Codey
LaunchAgent**. It changes only the descriptor's package location/fingerprint and
release ID. Node, Python, the Codex CLI/app-server/Desktop, DevTunnel, helpers,
credentials, auth/session databases and the other LaunchAgents are not updated.
Rollback never restores an old database or old model keys.

Authenticated local health, one isolated Codey model check, one ephemeral
read-only Codex CLI check and archival of the synthetic Codey session are required
before recording success. The updater is independent of the app it restarts.
It saves completion before acknowledging Portal; lost acknowledgement/restarts
never repeat a completed model check or reinstall.

## Recovery

Recovery runs locally before contacting Portal. Interrupted activation rolls
back this job's code pointer only when there is no new user work or config drift.
Failed recovery is blocked, not retried in an endless service-stop loop. Retain
the package directories, journals and locks for inspection.

For an explicit `rollback_failed` repair, use the installed binding and original
Python in an external owner terminal. First unload only the updater, then use
the host's same OS lock for one recovery attempt; start it again only on success:

```sh
CFG="$HOME/.config/codey-updater"
PYTHON="$(/usr/bin/plutil -extract pythonExe raw -o - "$CFG/binding.json")"
AGENT="$(/usr/bin/plutil -extract agentDirectory raw -o - "$CFG/binding.json")"
NODE_ID="$(/usr/bin/plutil -extract nodeId raw -o - "$CFG/binding.json")"
LABEL="com.codey.node-updater.$NODE_ID"
/bin/launchctl bootout "gui/$(id -u)/$LABEL"
"$PYTHON" -I -S -B "$AGENT/macos/host.py" --config "$CFG/config.json" recover &&
  /bin/launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LABEL.plist"
```

Do not delete locks, invent model proofs, edit the signed sequence, or overwrite
an unknown runtime to make recovery succeed. A busy/newly changed node requires
inspection or completion of its user work. No automatic tool update is included.

This implementation requires target-Mac acceptance (including native modules,
launchd restart, real models and sleep/login behavior). Passing Linux fixtures
is **not** evidence that those tests ran on `zhn-mac` or an Intel Mac.
