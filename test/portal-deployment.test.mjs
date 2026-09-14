import assert from "node:assert/strict";
import { stat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MachineUpdates } from "../src/machine-updates.mjs";

test("Portal image includes every package library required by Windows and macOS updater downloads", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const dockerignore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
  const copied = dockerfile.split("\n").filter((line) => line.startsWith("COPY ")).join("\n");
  const updates = Object.assign(Object.create(MachineUpdates.prototype), {
    sourceRoot: fileURLToPath(new URL("../node-updater", import.meta.url)),
  });
  for (const platform of ["windows-x64", "macos-arm64", "macos-x64"]) {
    for (const entry of await updates.sources(platform)) {
      const match = entry.name.match(/^codey-updater\/(?:windows\/)?lib\/(.+)$/);
      if (!match || match[1] === "node-update-manifest.mjs") continue;
      const source = `packages/codey/lib/${match[1]}`;
      assert(copied.includes(source), `${platform} bootstrap dependency missing from Docker COPY: ${source}`);
      assert(dockerignore.split("\n").includes(`!${source}`), `${source} is excluded from the image build context`);
    }
  }
});

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
