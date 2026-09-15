import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicBuildInfo, readBuildInfo } from "../src/build-info.mjs";
import { validateReleaseSource } from "../src/release-source.mjs";
import { createPortalServer, createMultiUserPortalServer } from "../src/server.mjs";
import { validateConfig } from "../src/config.mjs";
import { mainSource } from "./release-source-fixture.mjs";

test("build provenance is baked, bounded, main-only and never inferred from the environment", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-build-info-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "codey-source.json");
  assert.equal(await readBuildInfo(file), null);
  assert.deepEqual(publicBuildInfo(null), { sourceCommit: null, provenance: "unavailable" });
  const source = mainSource();
  await writeFile(file, JSON.stringify(source));
  assert.deepEqual(await readBuildInfo(file), source);
  assert.equal(publicBuildInfo(source).sourceCommit, source.commit);
  for (const value of [
    { ...source, sourceDirty: true }, { ...source, ref: "refs/heads/dev" },
    { ...source, commit: [source.commit] }, { ...source, tree: null },
    { ...source, schema: true }, { ...source, credentials: "must-not-be-exposed" },
    { ...source, submodules: { cloudcli: source.submodules.cloudcli } },
  ]) {
    assert.throws(() => validateReleaseSource(value), /main provenance/);
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(readBuildInfo(file), /main provenance/);
  }
  await writeFile(file, "x".repeat(8193));
  await assert.rejects(readBuildInfo(file), /Oversized/);
  await writeFile(file, "{");
  await assert.rejects(readBuildInfo(file), SyntaxError);
});

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("the version endpoint follows authentication and does not consult nodes", async t => {
  const source = mainSource();
  const config = validateConfig({ nodes: [] });
  const options = { config, buildInfo: source, fetchImpl: async () => { throw new Error("No node probe"); } };
  const base = await listen(t, createPortalServer({ ...options, auth: { username: "fixture", password: "fixture" } }));
  assert.equal((await fetch(base + "/api/version")).status, 401);
  const headers = { authorization: "Basic " + Buffer.from("fixture:fixture").toString("base64") };
  assert.deepEqual(await (await fetch(base + "/api/version", { headers })).json(), publicBuildInfo(source));
  assert.equal((await fetch(base + "/api/version", { headers, method: "HEAD" })).status, 200);
  const multi = await listen(t, createMultiUserPortalServer({
    ...options,
    userConfigStore: { load: async () => ({ config, revision: 1 }) },
    passwordAuthenticator: {
      handle: async () => false,
      principal: async req => req.headers.cookie === "fixture=yes" ? { id: "fixture-owner" } : null,
      reject: (_req, res) => { res.writeHead(401); res.end(); },
    },
  }));
  assert.equal((await fetch(multi + "/api/version")).status, 401);
  const response = await fetch(multi + "/api/version", { headers: { cookie: "fixture=yes" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), publicBuildInfo(source));
});
