# Validation evidence

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
