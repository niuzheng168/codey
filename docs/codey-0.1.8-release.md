# Codey 0.1.8

## Corrective release: 0.1.9

The first 0.1.8 Portal attempt rolled back because version verification expected
a bare version instead of the CLI's actual `codey <version>` output. The repair
keeps an exact match against the signed version, including the `codey` prefix.
The Linux verifier is embedded in the application, so its correction ships as
the new immutable 0.1.9 package. Published 0.1.8 bytes and failed job records are
retained unchanged. The dependency graph is unchanged.

## Application-only update contract

Routine Codey updates now replace only the application package when dependencies
are unchanged. They reuse the installed dependency tree through one checked
directory link instead of copying tens of thousands of dependency files.
Windows uses a directory junction; Linux uses a directory symlink. Existing Node,
Codex, DevTunnel, credentials and user data are not replaced.

The link is restricted to the original owner's retained installation and bound
to the dependency graph, platform and Node ABI. Standalone npm updates adjust the
link when the original package is moved into its rollback directory. Subsequent
updates reuse the physical tree directly instead of creating link chains.
Retained dependency directories must not be removed while an application refers
to them. Updates never run npm hooks or write to the reused dependency tree.
Changed dependency locks still require a separate locked dependency installation;
`--offline` refuses that case.

Whole-Codey Portal updates use signature, package fingerprint, native-module,
version and authenticated startup-health checks. They no longer send model
prompts or make successful installation depend on a model's tool-use behavior.
Legacy split-component transactions and recovery of previously recorded model
proofs retain their existing requirements. A failed installation still rolls back
only this transaction's application pointer and version metadata.

The application remains one shared npm tarball, without Node, `node_modules` or
dependency archives. The already published 0.1.7 artifact is immutable and is not
overwritten with these new CLI/updater files. The explicit independent installer's
`--reuse-from` bootstrap still copies dependencies so that the new independent
installation does not depend on its donor's lifetime; routine updates do not.

Release inspection also rejects compressed application packages larger than
8 MiB, including packages supplied through the publisher's in-memory archive
stream. The same limit applies to all platforms, alongside the existing native
binary and dependency-payload exclusions.

Upgrade timing must distinguish staging from the complete transaction and its
confirmed installed-version heartbeat. A staging-only smoke result is not proof
of a completed Portal upgrade. The target for a compatible, idle installation
with normal download connectivity is approximately one minute; time waiting for
active work to become idle must be reported separately, not hidden as switching.
