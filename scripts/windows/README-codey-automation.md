# Windows Workspace: logon startup and tunnel-token renewal

These scripts maintain an **already enrolled** Windows Workspace and its private
Dev Tunnel. They do not install or modify copilot-api, enroll another owner, alter
network/firewall rules, grant tunnel access, or change Windows power policies.

## Execution model

- `Codey Windows Workspace Watchdog`: at the original owner's logon, after 30 seconds.
- `Codey Windows Dev Tunnel Watchdog`: same trigger.
- `Codey Windows Tunnel Renewal`: same logon trigger plus an hourly check.
- All use `InteractiveToken`, `LeastPrivilege`, and the existing Azure CLI
  `pythonw.exe`. No password, SYSTEM, S4U, elevation, or no-login boot trigger.
- Watchdogs first adopt an exact matching process with the correct executable,
  entry point/tunnel ID, and owner SID. They do not restart an existing process.
  On exit they use the existing pinned launchers, with hidden windows and
  bounded 10–300-second crash backoff (5 seconds after a stable run).
- Process inventory queries only the matching executable. Transient WMI/query
  failures retry with bounded 5–60-second backoff instead of ending the watchdog.
  Unknown inventory never triggers a new service; wrong-owner/duplicate-process
  findings still fail closed. A manual replacement is adopted, not duplicated.
- The tunnel watchdog also reads the existing tunnel's **cloud host connection
  count** once a minute. A surviving CLI PID alone is not connectivity. After
  three confirmed zero-host observations and a 90-second startup grace, it
  revalidates the PID, executable and SID, then replaces only that disconnected
  host. A five-minute recovery cooldown prevents restart loops. Authentication,
  network-query failures and malformed results remain unknown, not restart permission.
- `tunnel-health.json` records the real host count, failed observations and
  recovery reason separately from process inventory. Every state report includes
  the executing worker's source digest. Superseded resident code/config may not
  cold-start a replacement service: it exits for Task Scheduler to reload instead.
- Windows must remain logged in and the Dev Box must remain running. This does
  not prevent sleep, shutdown, sign-out, or Azure Dev Box automatic stop.

## Private inputs

Prepare an owner-restricted `automation.json` before installation. It references
the existing owner-bound runtime configuration and includes:

- `schema`, `ownerSid`, `runtimeConfig`, `stateRoot`;
- `powershellExe`, `pythonExe`, `workerPath`, `workspaceLauncher`, `tunnelLauncher`;
- SHA-256 `fileHashes` for the worker and both launchers;
- optionally `acceptedPreviousEntries` for non-disruptive adoption;
- the shared `deploymentLock`, subscription/resource group/app scope;
- `tunnelId`, `clusterId`, `tokenEnvironment`, `renewBeforeSeconds` (normally 28800).

Keep code and state readable only by the owner, SYSTEM, and Administrators.
Never include an account password or connect token in this configuration.
The original owner's existing Dev Tunnels and Azure CLI sign-ins must work.
Microsoft/organization policies can still require the owner to sign in again;
the scripts do not bypass MFA or copy another account's authentication cache.

## Native desktop history and continuation on Windows

The Workspace launcher sets `CODEY_CODEX_EXECUTABLE` from the existing reviewed
`runtime.codexExe`. Native desktop histories can then be read by that CLI over
temporary **stdio**, without a Unix daemon, extra listener, or new network rule.
The reader permits only initialization, `thread/read`, and `thread/loaded/list`;
it verifies the requested ID, complete turn data, and an empty loaded-thread
list before returning. It never resumes/starts/forks a thread or treats a partial
JSONL export as complete. Missing/incompatible readers fail explicitly.

The launcher also explicitly sets `CODEY_CODEX_RUNTIME_TRANSPORT=stdio` for
execution. Each Codey run owns a separate native app-server child. It can resume
an available existing thread, including paginated history, without using the
Unix-only daemon lifecycle or the bundled legacy exec reader. The native thread
ID is retained across turns; completion is delivered only after the owned
process exits and releases its writer. Inherited helper pipe handles are not
proof that the native writer is still alive.

For an existing desktop-owned thread, the exact native `active writer` refusal
selects **Codex's native queue**, not another execution process. Queue APIs work
without acquiring its writer; the original desktop process executes the input,
including `localImage` attachments, even when it was idle. Codey observes only
the turn whose user-message `clientId` matches its unique queue submission.
Its bounded, paginated history observer never substitutes the newest unrelated
turn. An unfinished foreign-process snapshot can say `interrupted`; a durable
`completedAt` timestamp is required before reporting completion.

Queued desktop turns inherit the desktop model, effort and permissions.
Incompatible explicit model/effort selections or stricter browser permission
restrictions are rejected before enqueueing, not silently ignored or widened.
Unclaimed queue entries can be cancelled by their exact ID. Once the desktop
starts the turn, interruption and desktop tool approvals remain there. There
is no lock deletion, desktop restart, fork, configuration rewrite or automatic
prompt retry after an ambiguous acknowledgement.

For Codey-owned runs, one-shot command/file/permission approvals use
the existing Codey permission UI; unsupported desktop-only interactions fail
explicitly rather than hang or silently approve. Existing Unix nodes retain
their daemon transport. Activating an update requires a controlled
Workspace-only restart and atomic pinned launcher/configuration references;
do not restart the protected copilot-api.

Acceptance must include an **existing Desktop-created, Desktop-owned thread**,
not only a new standalone stdio test thread. Upload a fresh image through Codey,
have that desktop thread identify its contents, continue the same ID for another
turn, and verify the prior history and desktop/copilot-api PIDs remain unchanged.
This native-queue path was checked with Desktop CLI `0.153.1`; an older CLI that
lacks the queue API must fail explicitly before submitting input.

## Full Windows package acceptance

A manually enrolled, already provisioned Dev Box is not evidence that the
downloadable full installer works on a clean machine. Keep its download disabled
until a separate clean Windows acceptance run proves:

1. Owner-bound package download, dry run, and native dependency installation
   without overwriting existing global Node/Codex/provider settings.
2. TLS and SSO validation, correct owner/node identity, rejection of anonymous
   and wrong-owner access, and remote access through the intended transport.
3. Usage/history plus real new and same-ID continued conversations.
4. An actual owner sign-out/sign-in startup cycle, disconnected-host recovery,
   token renewal, repeat installation behavior, and documented rollback.

Do not log off or reboot a busy owner, modify another machine, or provision
Azure resources merely to mark this checklist complete. Source/unit tests and
an existing node's successful upgrade do not replace fresh-install acceptance.

## Installation and validation

Run `install-codey-windows-automation.ps1 -ConfigPath <absolute-path>` to validate
the four task definitions without registering them. Add `-Apply` to install.
Installation first runs a temporary same-owner, non-elevated authentication
probe. Only after it passes are the three real tasks enabled and started.
The temporary task is removed. Existing matching installations are not replaced;
unknown task-name collisions fail closed.

The worker uses Azure CLI's Python with `-X utf8 -I -B`. `pythonw.exe` has no
console streams, so Azure CLI initialization receives null-device handles.
No child stdout/stderr or credential-bearing exceptions are saved.

When Azure CLI supplies a 32-bit Python, the worker resolves an explicitly
configured System32 Windows PowerShell through its native-host alias instead
of inadvertently starting SysWOW64 PowerShell. The launcher child also builds
its own `PSModulePath`, rather than inheriting incompatible PowerShell 7 modules.
These are process-local compatibility fixes: no execution policy, persistent
environment, task principal, or network setting is changed.

## Renewal invariants

The hourly task renews only when the current token has at most eight hours left.
It mints a connect-only token and rotates the **existing** ACA secret in place.
ARM preserves all other secret values server-side using secure parameters;
they are not downloaded to Windows. A new revision reloads the environment
without changing images, identity, ingress, or unrelated configuration.

The shared deployment lock prevents conflicting controllers. A credential-free
pending journal reconciles interrupted submissions instead of blindly deploying
again. ARM completion and ACA replica readiness are separate checks. Secret
metadata is compared by unique name because Azure can reorder the returned list.
Do not delete pending state or another controller's lock to force a retry.

Inspect `workspace.json`, `tunnel.json`, `renew.json`, `renewal-state.json`, and
`tunnel-health.json` / `installation.json` in the configured private state directory. A renewal failure
sets a nonzero task result and `needs_attention`; it never makes the tunnel public.
Stopping a watchdog can also stop children it launched. Maintenance must target
these three exact task names, never the protected `Codey Local Copilot API` task.

Offline tests: run `test-codey-windows-automation.py` with isolated Python.
A manually triggered task proves that execution context works; it does **not**
prove a real sign-out/sign-in cycle. Do not force a user logoff/reboot for testing.

After changing shared worker code, explicitly reload each affected watchdog
when its owned service can be safely stopped, or adopt a separately restarted
service. Verify its reported source digest, not just the on-disk file. Exercise
an actual cold start in the same scheduled-task context; an adopted manual host
does not prove that the watchdog's launcher works.
