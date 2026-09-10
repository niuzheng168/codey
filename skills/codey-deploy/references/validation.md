# Validation evidence

> Current deployment status as of September 10, 2026: ACA deploys only the
> `portal` container. `codex-session-share-mcp/` remains in the repository for
> local reference, but its image, sidecar, proxy configuration and health probe
> are no longer part of a release. MCP references below are historical evidence
> from releases completed before this removal.

## First measured full E2E: September 7, 2026

Run: `fast-20260907-120150-509f08`. **432.468 seconds (7 minutes 12.468
seconds), complete, below the 600-second target, no deployment retry.**

This was a real rollout, not an unchanged-version no-op: both ACA images were
built, a new ACA revision was activated, shared UI was published, and all four
nodes switched to new versioned packages. The build used verified warm
dependency caches but reran non-MCP source checks/tests.

| Timed phase | Seconds |
| --- | ---: |
| Source/node preflight and origin snapshots | 27.531 |
| Build/test once, parallel images | 82.437 |
| Download and parallel node staging | 23.203 |
| Canary activation and Codey/Codex calls | 28.031 |
| ACA, shared UI and remaining nodes in parallel | 245.485 |
| Final fleet E2E and MCP sidecar health | 24.140 |
| Controller setup / final lock release | 1.641 |

- ACA revision: `codey--f-20260907-120150-509f08`.
- Shared UI: `ui-fast-20260907-120150-509f08`.
- Source: Portal `746af563b63c5be486f20c3f0cb61c8aec7f47da`,
  CloudCLI `a9bded2982592297cdbca986d5819b3b83e5ae12`,
  copilot-api `e63ed216a9633650036a7e4bae05bfcc2dee28ee`.
- All four nodes: new packages active; matching locked local dependencies
  reused; no node-local compilation or full test runs.
- Four Codey WebSocket model calls and four fresh-login ephemeral Codex CLI
  model calls passed with `gpt-6-astra` / `max`.
- Actual MCP container HTTP health: 200; its test suite was not run.
- SSO/Usage 200; anonymous 401 and foreign-origin POST 403 on all nodes.
- Synthetic Codey sessions archived; temporary Portal sessions revoked.
- Protected local gateway PID **12972**, executable and process start time
  unchanged. Existing uncommitted application changes were not deployed.
- Release-tool offline tests: **16 passed**. Skill frontmatter validator passed
  in the builder's existing Azure Python environment (local Python lacks PyYAML).

Authoritative report:
`Q:\codex_manager\artifacts\fast-20260907-120150-509f08\report.json`.
The 7m12s figure measures the automated release, **not the earlier one-time work
to implement this release tool and skill**. It is an observation, not a cloud
latency guarantee for future releases.

## Report layout

### Portal-only follow-up: Session History hidden

On September 7, 2026, the first Portal-only attempt
`fast-20260907-123417-c19c20` took **290.203 seconds but failed production
acceptance**: `/portal-features.js` was missing from the server's static route
allowlist, preventing the home-page module from loading.

The previous healthy image was restored in
`codey--restore-0907-124307`. The static route was added, and an HTTP regression
now checks every static module imported by `app.js`, including anonymous
rejection. Do not count the failed attempt as a successful sub-10-minute release.

The successful retry `fast-20260907-124718-53a670` took **174.172 seconds**:

| Phase | Seconds |
| --- | ---: |
| Preflight and reviewed source snapshot | 24.079 |
| Portal checks and image build | 80.000 |
| ACA revision rollout | 53.171 |
| Production acceptance | 15.407 |

**Total elapsed time from the first release start through final success was
955.121 seconds (15m55s), including diagnosis, rollback, and the retry.**
The whole attempt did not meet the ten-minute target.

Production verified the hidden navigation entry and all three changed public
files, Workspace SSO and Usage on all four nodes, and actual MCP sidecar health.
The MCP image, shared UI, remote service PIDs/start times and protected local
gateway were unchanged. No inference calls were counted in this Portal-only run.
Eight dedicated History tests are temporarily skipped; authentication/isolation
tests remain active. The release tool's 17 offline checks passed.

These application changes were deployed from a reviewed immutable Git tree,
not committed or pushed. The History implementation remains intact. To restore
the feature deliberately, change `SESSION_HISTORY_ENABLED` in
`public/portal-features.js` and run the retained suites with
`CODEY_SESSION_HISTORY_TESTS=1`; update the feature-off expectations accordingly.

Combined report:
`Q:\codex_manager\artifacts\fast-20260907-124718-53a670\combined-outcome.json`.

The release command writes the authoritative evidence rather than encoding a
permanent timing promise in the skill:

- `report.json`: total wall-clock time, phase intervals, all four node results,
  model calls, protected-local before/after identity, and target attainment.
- `manifest.json`: frozen origin commits, unique image tags/digests, built-package
  hashes, lockfile identities and shared-UI manifest.
- Builder `validation.json`: one source validation per non-MCP component, cache
  mode and command durations. MCP tests remain explicitly skipped.
- Builder `mcp-health.json`: an actual HTTP health request made inside the
  deployed MCP container. Portal's public `/healthz` is **not** a substitute.
- Per-node `activation.json`, `codex-result.json`, and retained `backup/`.

## Offline release-tool regressions

Run `python scripts/test_deploy.py` from this skill's folder. Coverage includes
package traversal, duplicate members, overwrite refusal, hardlink/symlink policy,
configuration drift versus irrelevant timestamps, immutable release IDs,
credential-safe Azure reads, atomic reports, and explicit apply gating.

These tests are release-tool tests, **not the MCP test suite**.

## Performance boundaries

Warm dependency caches may be reused only with matching lockfiles and the
supported runtime ABI. Source tests and actual image builds still run in the
timed release. Each VM avoids a repeat compiler/test cycle; existing native
dependencies remain on their original Node runtime. The first changed-lockfile
release, Azure scheduling, active user tasks or rollback can exceed the target;
the measured report must show this rather than weakening acceptance.

## Signed updater E2E — 2026-09-07 UTC release

`fast-20260907-155055-8c3549` completed in **392.516 seconds** (6m32s),
including clean-source preparation, one full component validation/build, signed feed
publication, ACA/MCP and shared UI, updater implementation refresh, canary/batch
activation and final acceptance. The explicit targets were `zhn-a100`, `jpe3`,
`westus2`; **jpe2 was skipped at the user's request because of a long-running job**.

- ACA: `codey--f-20260907-155055-8c3549`; both containers ready and MCP actually probed.
- Portal: 174 tests, 166 passed, 8 retained History tests skipped; Linux updater
  transaction suite: 14 passed. The release-tool suite passed 18 checks.
- Three real Codey responses and three real ephemeral Codex CLI responses passed.
  Identical application packages were not restarted; their PIDs and the protected
  Windows copilot-api PID/start time remained unchanged.
- Production settings/module hashes matched the frozen source. A real personalized
  new-machine ZIP contained the current updater and its separate owner/node-bound
  credential. Its pending identity could not claim updates and was cancelled after
  this check. No new VM or Windows tunnel was activated.

This successful run is **not the duration of the whole development/recovery task**.
The preceding release/recovery window totaled 3265.011 seconds (54m25s) from the
first release attempt to this successful run's completion. Retain the failures:

- `fast-20260907-150303-e124c1`: coordinated interruption for a concurrent worktree
  writer, Windows PowerShell module-autoload failure during private-file ACL setup,
  then a false configuration-drift result caused by Codex registering the synthetic
  probe directory. Native ACL tooling, isolated Python imports, and narrowly scoped
  TOML comparison now have regression coverage. Its failed model-check job is not
  counted as a successful upgrade.
- `fast-20260907-154415-95e71e`: 105.172 seconds, failed before deployment because
  newly added Portal SDK dependencies were not installed for its tests. Portal
  dependencies now use a lock/ABI-matched cache, installed with lifecycle scripts disabled.
- During earlier diagnostics, a HOME `copy.py` shadowed the standard library on
  A100 and triggered copying to `/data/g`. The three identified diagnostic processes
  were stopped; destination files were not deleted or restored. Details and the
  known uncertainty are retained in `artifacts/node-updater-validation-20260907/probe-shadowing-incident.json`.
  Executable updater entrypoints now self-isolate, and orchestration uses `-I`.

Evidence: the successful run's `report.json`, builder `validation.json`,
`node-update-progress.json`, and `final-updater-acceptance.json`. The extra
personalized-ZIP check performed no additional model calls.
