# Agency + Codex: read-only Teams and Mail

The maintained guide now ships with both the Codey npm package and the complete
installation Skill:

[Agency installation, Teams/Mail browser authentication, configuration and verification](../skills/config-new-codey-machine/references/agency-codex-mcp.md).

From Codey 0.2.4 onward, use `codey agency setup --apply --verify-read`.
The repository-only `node scripts/configure-agency-mcp.mjs` entrypoint remains
compatible. Agency sign-in is separate; neither command grants consent.
