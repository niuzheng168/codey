# Codey 0.2.5 — find Agency's Linux installation without PATH changes

Release preparation: September 28, 2026.

## Fix

Agency's Linux installer can report `already installed` / `Existing binary
installed through the CTF path` while Codey 0.2.4 still reports that Agency
cannot be found. The previous discovery list omitted the installer's actual
per-user directory when it was absent from the invoking process's PATH.

Codey 0.2.5 includes `$HOME/.config/agency/CurrentVersion/agency` in Linux
discovery. It handles home paths containing spaces, deduplicates PATH entries
and retains the existing newest-installed-Agency selection. Explicit `--agency`
and `AGENCY_BIN` overrides still work. Windows/macOS discovery and discovery
of the separate Codex CLI are unchanged.

After completing the host user's organization-approved Teams/Mail browser login:

```sh
codey agency setup --apply --verify-read
```

For an existing 0.2.4 installation, use this workaround until that node is
explicitly updated:

```sh
codey agency setup \
  --agency "$HOME/.config/agency/CurrentVersion/agency" \
  --apply --verify-read
```

Finding the binary is not authentication. No reinstall, cache clearing,
device-code login, global PATH edit, automatic authorization or model/provider
change is introduced. The 15 Teams / 5 Mail read-only allowlists are unchanged.
The full authentication/configuration guide remains bundled with both the
runtime `.tgz` and complete installation `.zip`.

## Validation and release boundaries

- Release-preparation checks: **668 Node tests passed, 20 skipped, 0 failed**;
  **25** package/publication, **5** main-source and **40** deployment-safety
  Python tests passed. Syntax and documented shell examples also passed.
- Regression cases cover missing/empty PATH, spaces, deduplication and separation
  from Codex discovery, plus execution of the discovered native candidate.
- The corrected source discovery was tested on `zhn-jpe-2` with PATH restricted
  to `/usr/bin:/bin`; it found the installed Agency `2026.9.26.2` without an
  explicit path, sign-in, MCP call or configuration write.
- Production packages must be built from the exact pushed main SHA and its
  recorded submodules, then installed/inspected before activation.
- Runtime dependency versions are unchanged. The new package version preserves
  immutable 0.2.4 artifacts; publishing does not update or restart existing nodes.
