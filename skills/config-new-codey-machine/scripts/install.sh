#!/usr/bin/env bash
# Compatibility entry for the complete Skill. No second installation workflow.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "ERROR: $*" >&2; exit 1; }
[[ -f "$ROOT/scripts/install-npm.sh" ]] || die "Use the complete Skill's install-npm.sh."
packages=("$ROOT"/assets/codey-*.tgz)
[[ "${#packages[@]}" == 1 && -f "${packages[0]}" ]] || die "The complete Skill must contain exactly one Codey npm package."
(cd "$ROOT/assets" && grep -Fqx "$(sha256sum -- "${packages[0]##*/}")" SHA256SUMS) || die "The Skill's package checksum does not match."
exec bash "$ROOT/scripts/install-npm.sh" --package "${packages[0]}" "$@"
