# Codey 0.2.6 — tolerate slow Agency version probes

Release preparation: September 28, 2026.

## Fix

On `zhn-jpe-3`, valid Agency `2026.9.26.2` version probes took approximately
19–23 seconds. Codey 0.2.4/0.2.5 killed them after a fixed ten seconds, then
misreported the result as `invalid version output` or claimed Agency was not
installed. This was not an installation, version or authentication failure.

- `codey agency setup --timeout SECONDS` now controls each Agency/Codex version
  probe as well as each MCP request: default **120 seconds**, range **1–600**.
- Direct resolver callers use a bounded 60-second default.
- Errors distinguish deadlines, invalid version output, nonzero exit codes,
  signals and output-size limits, without printing child stdout/stderr.
- Automatic discovery retains failures for existing executables instead of
  incorrectly classifying a timed-out installation as absent.
- The Linux PathInstaller-directory fix from 0.2.5 is retained. The setup CLI,
  native configuration checks and 15 Teams / 5 Mail read-only allowlists are
  unchanged.

After organization-approved host-local browser authentication:

```sh
codey agency setup --apply --verify-read

# Only if this machine needs a longer bounded wait:
codey agency setup --apply --verify-read --timeout 180
```

Raising `--timeout` in 0.2.4/0.2.5 does not fix the executable-probe deadline;
the installed Codey package must be updated. Do not reinstall Agency, clear
authentication caches or edit integrity-checked installed files for this error.
Version probes do not authorize Teams/Mail and do not make service calls.

## Verification and rollout boundaries

Release preparation passed **672 Node tests**, with **20 skips and 0 failures**;
the Python package/publication, main-source and deployment-safety suites passed
**25, 5 and 40** tests respectively. Syntax checks and documented shell examples
also passed.

Regression coverage includes default/custom timeout forwarding to both
executables and MCP clients, bounded timeout values, distinct private-safe
diagnostics and automatic-discovery failures. Corrected source discovery was
verified with the installed Node 24 runtime on `zhn-jpe-3`, without signing in
or changing configuration.

The runtime dependency lock changes only its Codey version. Production builds
use the exact pushed main SHA and recorded submodules. Both `.tgz` and `.zip`
include the updated Agency guide. Verify real package installation and the
slow-start path before activating the new immutable release.

Owner-requested node updates use the installed native `codey update` flow,
preserve credentials/configuration/old releases, and verify live versions plus
health. They do not install or sign in to Agency, change model providers,
upgrade Node/Codex/DevTunnel, or automatically retry ambiguous operations.
