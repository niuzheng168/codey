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
`installation.json` in the configured private state directory. A renewal failure
sets a nonzero task result and `needs_attention`; it never makes the tunnel public.
Stopping a watchdog can also stop children it launched. Maintenance must target
these three exact task names, never the protected `Codey Local Copilot API` task.

Offline tests: run `test-codey-windows-automation.py` with isolated Python.
A manually triggered task proves that execution context works; it does **not**
prove a real sign-out/sign-in cycle. Do not force a user logoff/reboot for testing.
