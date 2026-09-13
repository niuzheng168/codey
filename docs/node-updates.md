# Owner-confirmed node updates

For a trusted local npm tarball, `codey update /absolute/path/codey-new.tgz`
updates only the application on the current node without publishing a Portal
release. See [local package updates](codey-local-update.md), including native
Windows handling, one-time bootstrap, concurrency and recovery. The feed
workflow below remains the centrally signed, owner-confirmed fleet mechanism.

The local updater also has explicit `codex` and `devtunnel` component commands,
with Codey 0.1.3 as the installed compatibility baseline. These use reviewed local
tool manifests, not this Portal feed. The Portal feed updates only Codey, not the
native Codex/DevTunnel tools. See the same local updater guide.

The Portal brokers **desired package versions**, not remote shell commands. An independent
`codey-node-updater.service` on Linux x64, the original-owner
`Codey Node Updater <nodeId>` logon task on Windows x64, or
`com.codey.node-updater.<nodeId>` LaunchAgent on macOS polls outbound HTTPS. No SSH key, Portal
master, model credential, release signing private key, or new inbound management port is
distributed to nodes. The Windows agent supports only the existing unified,
owner-managed Codey npm installation, never a standalone/system copilot-api or
an unrelated Windows service. See [Windows enrollment and rollout](windows-node-updates.md).
The Mac adapter adopts only the existing owner-managed schema-2 npm/launchd
layout, not a split relay install or Codex Desktop. See [Mac enrollment and
rollout](macos-node-updates.md). Local `codey update`/tool commands remain
Linux/Windows-specific; Mac Portal support does not enable those commands.

## Current Portal UI

Settings presents only the single **Codey npm package**. The node overview reads
`components.codey` from the owner-bound updater heartbeat, never from a desired
release or a standalone Workspace version. Missing reports remain explicitly unknown.

The release picker shows each identical whole-Codey application artifact once,
not once per OS. A shared version/filename/size/hash/build fingerprint groups
the signed platform records; different bytes never collapse just because the
version string matches. Each node's preview pins its own platform release and
digest, and one confirmed mixed-platform batch retains the existing canary gate.
An unpublished platform remains explicitly unavailable instead of asking the
user to select another OS. Platform notes and blockers remain visible in preview.

Visible pages refresh every 10 seconds even without active jobs (5 seconds
while jobs are active). Refresh continues after completion to collect the next
actual version heartbeat and local CLI updates. Background tabs pause polling;
returning refreshes immediately. Requests are deduplicated and a confirmation
is not overwritten by polling. Success/failure status never supplies a guessed
installed version; a terminal job waiting for its next heartbeat is labeled.

The confirmation dialog offers only whole-Codey releases.
The **Download Codey update package** button downloads the selected signed `.tgz`
through an authenticated owner endpoint, with size/SHA-256 verification in both
the service and browser. It creates no upgrade plan, job or agent credential.
This application-only download is separate from the new-machine installation
Skill. On an existing Codey 0.1.6+ installation, use `codey update FILE.tgz --offline`
to reuse identical installed dependencies without registry access; changed locks
or missing/incompatible dependencies are refused in offline mode.
Legacy component releases remain supported by the backend, but are not selectable
in the UI. Older node layouts are shown as needing migration; they are not silently
treated as Codey installations or submitted for a cross-layout update. Selection,
batch canaries, owner checks, offline waiting and confirmation still apply.

## Release once, update many

1. For npm-layout nodes, build/test one Codey npm package with `npm run codey:build`.
   Retain `codey-package.json`, `codey-<version>.tgz` and independent `validation.json`
   evidence. For Linux legacy nodes, retain the deploy Skill's `manifest.json`,
   `validation.json` and two prebuilt `cloudcli.tar.gz` / `gateway.tar.gz` archives.
   A changed upstream commit is not itself sufficient evidence of compatibility.
2. Generate an Ed25519 signing pair once on the owner-only build host:
   `node scripts/publish-node-update.mjs keygen --private-key <private.pem> --public-key <public.pem>`.
   Keep the private key out of Git, ACA and its file share. Back it up through normal private
   operator key custody; do not regenerate it during every deploy.
3. Publish using `publish --manifest <manifest.json> --output <feed> --private-key <private.pem>
   --sequence <increasing integer>`. Optional `--components cloudcli` supports a CloudCLI-only
   legacy release. A `codey-package.json` automatically selects the sole `codey` component.
   The default platform is `linux-x64`. Use `--platform windows-x64` only with the
   validated shared npm artifact: it signs a distinct `codey-windows-…` release ID
   pointing at the SAME tarball and hash. Keep sequence numbers increasing across
   the entire catalog. An explicit `--release-id` can re-authorize unchanged bytes
   with a new ID/sequence; it never overwrites an existing ID.
   macOS uses `--platform macos-arm64` or `--platform macos-x64`, with distinct
   IDs and the same shared tarball. The publisher also inspects the actual archive
   and requires the matching target's `doctor-<platform>.json` native report;
   editing a manifest cannot turn the published Linux/Windows-only 0.1.4 into
   a Mac artifact. Deploy the platform-aware Portal before publishing new
   platform manifests, so older catalog parsers do not reject the feed.
   Specify `--codey-node-majors` or the legacy `--cloudcli-node-majors` /
   `--gateway-node-majors` only for runtimes actually tested; the default is Node 24.
   The publisher verifies evidence and artifact hashes; it never installs an npm package by name.
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

- Existing Linux nodes: owner downloads that node's private updater ZIP, then runs
  `python3 install.py` to inspect the plan and `python3 install.py --apply` to install only
  the updater. Use an existing Python 3.12+ interpreter (including the separately installed
  Azure CLI Python if appropriate); do not upgrade global Node/Codex or restart the apps.
- Existing Windows nodes: Settings → Software Updates → the node's Manage →
  Enroll Updater downloads its own private native ZIP. Run `install.ps1`, then
  `install.ps1 -Apply` in the original owner's non-administrator PowerShell.
  No Python installation, new-machine registration, app restart or model login is
  part of enrollment. The hidden task starts after that owner logs on; it uses a
  separate process-tree Job Object and a kernel-owned file lock.
- Existing Mac npm nodes: download the Mac node's private ZIP. Run `install.py`,
  then `install.py --apply`, with the original installer's Python 3.12+ in that
  Mac owner's terminal. Never sudo, install a new Python, or re-register the
  node. This installs only the independent updater LaunchAgent and reports the
  actual old package version; it does not require Codey 0.1.5 to be installed
  first. See the Mac guide for exact commands and unsupported legacy layouts.
- New nodes: the fixed, credential-free `config-new-codey-machine` download includes one
  Codey npm package and the public trust key. The installer generates per-node credentials
  locally and installs the updater after both internal services pass checks. It cannot
  claim work until Portal activation.
- Re-pair/revoke requires explicit owner confirmation. Rotation preserves the reported
  anti-downgrade high-water mark. Revocation stops new work, not the model services.

The private configuration is `~/.config/codey-updater/config.json` (0600), immutable job
data is in `~/.local/share/codey-updater/jobs/`, and the installed version is recorded
separately from enrollment identity. Updater status intentionally excludes logs, prompts,
model keys, TLS keys and SSO material.
Native Windows/Mac application jobs instead use their original
`~/.local/share/codey-machine-<platform>/local-updates/` directory. Their shared
local transaction marker/lock is under `~/.local/share/codey-local-update`.

## Compatibility and rollback

The agent preserves service units, original Node executables, model/SSO/TLS config and
databases. It stages prebuilt packages and reuses dependencies only for a matching dependency
graph and install fingerprint. For whole-Codey releases only, app/root-lock version labels
are excluded from the reuse comparison; dependency versions, integrity and install hooks
remain covered, and signed package/lock bytes are verified unchanged.
Whole-Codey updates link the owner-checked existing dependency tree
without copying it, installing it again, or rebuilding it. On Linux, a directory anchor's
tree is rebound to its retained backup location before restart and back on rollback;
already immutable release trees are referenced directly. Do not delete referenced releases
or backups. Linux Portal stages write the same `codey-dependency-link.json` contract as
the local CLI: physical modules path, canonical dependency-graph SHA-256, platform/architecture
and original Node ABI. Existing CLI records are verified, donor records are preserved, and
pointer relocation updates the candidate record so subsequent CLI updates remain compatible.
Historical bare links may be adopted only from the existing installed source after package,
lock, physical-owner, dependency-version and internal-link checks. Candidates and recovery
never accept an unrecorded dependency link.
Cold mismatches install locked production dependencies, not another full backend
build. Only changed services are stopped.

Legacy split-component Codex verification reuses the running Workspace service's
`CODEY_CODEX_EXECUTABLE` when configured. That pin must be an executable absolute
file; an invalid pin fails closed rather than selecting another installation.
Only services without a pin fall back to their own `PATH`. The updater never
installs or upgrades Codex to satisfy verification.

The `npm` layout uses one application directory and one `npm-shrinkwrap.json`.
Only a sole `components.codey` release is eligible: both services stop before one
atomic package-pointer switch and both restart afterward. Rollback restores that
one package and its gateway build marker together. Mixed/split releases are rejected
before download; legacy nodes cannot consume npm-layout releases. Deploy the updated
Portal/agent protocol implementation before distributing the new onboarding package.

Codey running sessions, native `codex exec` processes and active model sockets defer
activation. Native app-server tasks may be between requests: finish those tasks before
confirming. This is a short restart, **not a zero-downtime guarantee**.

An independent transaction journal recovers a crash during switching. Whole-Codey updates
require signature/version/package fingerprints, native-module checks, startup and authenticated
local health, including the running target version. They **never send model requests**, create
synthetic sessions or invoke `codex exec` for acceptance, including same-package jobs.
New Windows/Mac requests explicitly use `authenticated-health-v1`; the persisted health proof
binds the job, signed digest, version and entry hash and records `modelRequests: false`.
Historical completed native requests without that marker still require their original genuine
model proof; recovery never reruns inference or converts a failed/rolled-back job to success.
Legacy Linux split-component upgrades retain the existing real Codey and ephemeral Codex
model acceptance. A failure rolls back this transaction's code/pointers/bookkeeping
only; it never restores stale databases or keys and refuses to overwrite another deployment.
Interrupted staging requires a new explicit retry rather than repeating uncertain actions.

`gateway-api-key-v1` is a **prerequisite gate**, not a blind key rotation. Before a key-required
release, migrate every external caller and service environment to the same independently
issued node model key and verify authenticated readiness plus anonymous/wrong-key 401, then
publish the release. Unknown migrations remain blocked. Destructive DB migrations, automatic
Python/Node/Codex upgrades and self-upgrading protocol versions are intentionally unsupported.

Do not run the legacy SSH package activator at the same time as, or silently over, the
pull updater. First-time adoption is explicit. Normal recurring releases publish one feed
and use the owner-confirmed queue.

## Validation

`npm run updates:check`, `npm test`, and on Linux
`python3 -m unittest discover -s test -p test_node_updater.py`.
`npm run updates:test:macos` exercises the Mac filesystem/launchd adapter with
injected OS I/O; it does not invoke live launchctl or models. Native doctor,
real launchd activation/recovery, authenticated health and sleep/login behavior must
still be accepted on a Mac before calling that platform production-ready.
The Python transaction fixtures never invoke real systemctl; they cover directory/symlink
adoption, no-copy dependency rebinding, whole-app health-only acceptance, legacy model-failure
rollback and concurrent-state protection. Only live fleet evidence counts as production
verification; model testing is separate and is not part of routine updates. MCP and Session History
specialized tests remain skipped per the existing release policy.
