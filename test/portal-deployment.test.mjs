import assert from "node:assert/strict";
import { stat, readFile } from "node:fs/promises";
import test from "node:test";

test("production deployment excludes the retained Session Share MCP source and configuration", async () => {
  const [dockerfile, dockerignore, builder, deploy, source] = await Promise.all([
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../.dockerignore", import.meta.url), "utf8"),
    readFile(new URL("../skills/codey-deploy/scripts/builder.py", import.meta.url), "utf8"),
    readFile(new URL("../skills/codey-deploy/scripts/deploy.py", import.meta.url), "utf8"),
    stat(new URL("../codex-session-share-mcp", import.meta.url)),
  ]);

  assert(source.isDirectory(), "the unused MCP source should remain available locally");
  assert.doesNotMatch(dockerfile, /PORTAL_MCP_PROXY_URL|SESSION_SHARE_PORTAL_CONFIG|session-share\.aca\.json/);
  assert.doesNotMatch(dockerignore, /!config\/session-share\.aca\.json/);
  assert.doesNotMatch(builder, /codey-mcp|mcp_health/);
  assert.doesNotMatch(deploy, /mcp_health/);
});
