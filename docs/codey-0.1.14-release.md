# Codey 0.1.14 — 2026-09-15 publication

## Source and scope

The requested root `origin/main` and CloudCLI `origin/main` pulls were already
current. The configured gateway `origin/dev` fast-forwarded to 2.5.10.

- Root baseline: `d6c87da3b8cc3c7845caaf22bbeac6f99fab0dd9`.
- CloudCLI: `b397c08adaa064d16a4ba7dde12603d27cfde8ac`.
- Gateway: `3c98fab6529916dbd18aa75fc977c28fd994434b`.
- The release also includes the reviewed, previously uncommitted installer
  changes. Its embedded provenance explicitly records `sourceDirty: true`.
  No user-source commit or push was performed.

Do not redeploy the unmodified root `origin/main` over this reviewed snapshot:
that would omit the newly published installation and maintenance fixes. Commit
and push the reviewed changes before returning to the normal remote-only flow.

## Published

- Portal revision: `codey--f-20260915-124959-f8544e`.
- Shared Workspace UI: `ui-20260915-codey-0114-124248`.
- Installation Skill: `machine-b775833b323cf978`.
- One shared signed Codey release: `codey-shared-aa6683f9c429cc92`, sequence 23.
- Application: `codey-0.1.14.tgz`, 7,464,240 bytes, SHA-256
  `aa6683f9c429cc92adaf9bcd4bffcef4819a8dfecee2997bf41f260767bf9f38`.
- Skill ZIP: 7,711,889 bytes, SHA-256
  `b775833b323cf978a7c830339a7879bea13ff4a530ffec9b252ddd31dfbec05c`.

The installer includes native Windows certificate generation without OpenSSL,
verified download reuse and progress, unchanged-updater reuse, and the Linux
DevTunnel health monitor. Independent Linux updaters and that monitor were
refreshed on the three registered Linux nodes without restarting their
application services during maintenance.

## Existing nodes

The owner-confirmed two-node batch used the normal signed updater canary gate.
Both `zhn-jpe-2` and `zhn-jpe-3` completed their jobs and subsequently reported
Codey 0.1.14, gateway 2.5.10, the expected build fingerprint and sequence 23.
Authenticated running `/health` responses independently confirmed 0.1.14.

The fleet is **not fully updated**:

- `zhn-usw2-1`: native tasks were active; application remains 0.1.12. Its
  independent updater and tunnel monitor are current. No application job was
  queued and the original application PIDs were preserved.
- `CPC-zhn-VZO0BX3`: updater reports `configuration_changed` and unsupported
  layout. No configuration guard was bypassed and no update was queued.
- `zhn-mac`: no enrolled updater. No bootstrap credential or update job was
  created.

No successful Windows or Mac Workspace health response was obtained during
final checks; their application versions must not be inferred from desired
releases.

## Validation

- Portal: 578 passed, 17 skipped; Linux updater Python transactions: 56 passed.
- CloudCLI: 535 backend tests passed, 5 skipped; 650 frontend tests passed.
- Gateway: 939 passed; type checks and lint passed.
- Package builder: 18 passed; Mac updater adapter: 25 passed.
- Deployment safety: 37 passed.
- Real isolated npm installation, both application servers, native doctor and
  linked-dependency staging passed. Portable PowerShell checks passed; this is
  not native Windows or Mac installation acceptance.
- Production Portal login/static assets, shared browser JavaScript on both
  Japanese nodes, authenticated Skill and npm downloads, SHA-256, anonymous
  download rejection, and actual installed-version heartbeats passed.
- No model inference was performed during this release.

Initial failed checks are retained. They exposed test-harness issues: long
Unix-socket paths, ignored lint roots, Python test module shadowing, missing
private XDG runtime, and a test donor outside its private HOME/permissions.
These were corrected without relaxing runtime guards or skipping failing tests.
The initial production download probe incorrectly sent a JSON body to a
body-free endpoint; its corrected browser-equivalent request passed.

Evidence is retained under
`artifacts/full-release-20260915-124248/`, including source snapshots, original
failures, publication receipts, rollout jobs and final production acceptance.
