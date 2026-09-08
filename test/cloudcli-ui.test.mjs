import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, readFile, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { CloudCliGateway } from "../src/cloudcli-gateway.mjs";
import { CloudCliUi } from "../src/cloudcli-ui.mjs";
import { readUiPackage, readUiPackageFile, validateUiManifest, validateUiTemplate } from "../src/cloudcli-ui-package.mjs";
import { validateConfig } from "../src/config.mjs";
import { createPortalServer } from "../src/server.mjs";
import { packageCloudCliUi } from "../scripts/build-cloudcli-ui.mjs";
import { uiFixture } from "./helpers/cloudcli-ui.mjs";

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function portal(t, options) {
  const fixture = await uiFixture(t, "ui-one", options);
  const seen = [];
  const backend = await listen(t, http.createServer((req, res) => {
    seen.push({ path: req.url, prefix: req.headers["x-forwarded-prefix"] });
    res.end("NODE_BACKEND");
  }));
  const ui = new CloudCliUi(fixture.store);
  const gateway = new CloudCliGateway({
    nodes: ["node-a", "node-b"].map((id) => ({ id, name: `Display name ${id}`, basePath: `/cloudcli/${id}`, upstream: new URL(backend) })),
  }, { ui });
  const url = await listen(t, createPortalServer({
    config: validateConfig({ nodes: ["node-a", "node-b"].map((id) => ({ id, name: id, endpoint: `${backend}/usage` })) }),
    cloudCliGateway: gateway, cloudCliUi: ui,
  }));
  return { ...fixture, ui, seen, url };
}

test("one package serves both node shells without contacting either backend", async (t) => {
  const fixture = await portal(t);
  for (const node of ["node-a", "node-b"]) {
    const response = await fetch(`${fixture.url}/cloudcli/${node}/session/example`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, new RegExp(`<title>cloudcli - ${node}</title>`));
    assert.doesNotMatch(html, /CloudCLI UI|Display name/);
    assert.match(html, /src="\/cloudcli-ui\/ui-one\/assets\/app.js"/);
    assert.ok(html.includes(`src="/cloudcli/${node}/_ui/runtime.js"`));
    assert.ok(html.includes(`href="/cloudcli/${node}/manifest.json"`));
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-codey-ui-release"), "ui-one");
    const runtime = await (await fetch(`${fixture.url}/cloudcli/${node}/_ui/runtime.js`)).text();
    assert.ok(runtime.includes(`window.__CLOUDCLI_BASE_PATH__="/cloudcli/${node}/"`));
    assert.ok(runtime.includes(`window.__ROUTER_BASENAME__="/cloudcli/${node}"`));
    assert.doesNotMatch(runtime, /cloudcli-ui|token|password|upstream/);
  }
  assert.deepEqual(fixture.seen, []);
  const script = await fetch(`${fixture.url}/cloudcli-ui/ui-one/assets/app.js`);
  assert.equal(await script.text(), "window.TEST_SHARED_UI=true;");
  assert.match(script.headers.get("cache-control"), /private.*immutable/);
  const cached = await fetch(`${fixture.url}/cloudcli-ui/ui-one/assets/app.js`, {
    headers: { "if-none-match": script.headers.get("etag") },
  });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
});

test("every SPA shell has its routed node title without modifying the immutable shared template", async (t) => {
  const fixture = await portal(t);
  for (const node of ["node-a", "node-b"]) {
    for (const suffix of ["/", "/session/example", "/future-client-route"]) {
      const response = await fetch(`${fixture.url}/cloudcli/${node}${suffix}`);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.deepEqual(html.match(/<title>[^<]*<\/title>/g), [`<title>cloudcli - ${node}</title>`]);
    }
  }
  const bundle = await fixture.ui.active();
  assert.match((await readUiPackageFile(bundle, "index.html")).toString("utf8"), /<title>CloudCLI UI<\/title>/);
  assert.deepEqual(fixture.seen, []);
});

test("older shared templates without a title also receive the node-specific shell title", async (t) => {
  const fixture = await portal(t, { title: null });
  const response = await fetch(`${fixture.url}/cloudcli/node-b/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(html.match(/<title>[^<]*<\/title>/g), ["<title>cloudcli - node-b</title>"]);
  assert.deepEqual(fixture.seen, []);
});

test("API, SSE, health and legacy per-node assets are still proxied, not turned into HTML", async (t) => {
  const fixture = await portal(t);
  for (const suffix of ["/api/projects", "/API/projects", "/api/events?stream=1", "/api/plugins/example/ui.js", "/health", "/assets/old.js", "/shell", "/plugin-ws"]) {
    const result = await fetch(`${fixture.url}/cloudcli/node-b${suffix}`);
    assert.equal(await result.text(), "NODE_BACKEND");
    assert.deepEqual(fixture.seen.at(-1), { path: suffix, prefix: "/cloudcli/node-b" });
  }
  const page = await fetch(`${fixture.url}/cloudcli/node-b/future-client-route`);
  assert.match(await page.text(), /cloudcli-ui\/ui-one/);
  assert.equal((await fetch(`${fixture.url}/cloudcli/node-b/_ui/unknown`)).status, 404);
});

test("activation switches every node without restarting and old asset versions remain available", async (t) => {
  const fixture = await portal(t);
  const next = await uiFixture(t, "ui-two");
  await fixture.activate(next.packageRoot);
  for (const node of ["node-a", "node-b"]) {
    const response = await fetch(`${fixture.url}/cloudcli/${node}/`);
    assert.match(await response.text(), /\/cloudcli-ui\/ui-two\/assets\/app.js/);
    assert.equal(response.headers.get("x-codey-ui-release"), "ui-two");
  }
  assert.equal((await fetch(`${fixture.url}/cloudcli-ui/ui-one/assets/app.js`)).status, 200);
  assert.equal((await fetch(`${fixture.url}/cloudcli-ui/ui-two/assets/app.js`)).status, 200);
  assert.deepEqual(fixture.seen, []);
  // Rollback only changes the pointer; the same server instance keeps serving all versions.
  await fixture.activate();
  assert.equal((await fetch(`${fixture.url}/cloudcli/node-a/`)).headers.get("x-codey-ui-release"), "ui-one");
});

test("node PWA manifest, push icons and worker scope remain node-specific", async (t) => {
  const fixture = await portal(t);
  for (const node of ["node-a", "node-b"]) {
    const manifest = await (await fetch(`${fixture.url}/cloudcli/${node}/manifest.json`)).json();
    assert.equal(manifest.id, `/cloudcli/${node}/`);
    assert.equal(manifest.start_url, `/cloudcli/${node}/`);
    assert.equal(manifest.scope, `/cloudcli/${node}/`);
    assert.equal(manifest.icons[0].src, "/cloudcli-ui/ui-one/icons/icon.png");
    const worker = await fetch(`${fixture.url}/cloudcli/${node}/sw.js`);
    assert.equal(worker.headers.get("service-worker-allowed"), `/cloudcli/${node}/`);
    assert.equal(worker.headers.get("cache-control"), "private, no-store");
    const info = await (await fetch(`${fixture.url}/cloudcli/${node}/_ui/version.json`)).json();
    assert.deepEqual(info, { release: "ui-one", cloudCliVersion: "1.37.2", apiContract: 1, shared: true });
    const icon = await fetch(`${fixture.url}/cloudcli/${node}/icons/icon.png`);
    assert.equal(await icon.text(), "test-png");
  }
  assert.deepEqual(fixture.seen, []);
});

test("shared routes are read-only, HEAD has no body, and metadata/path traversal cannot escape the package", async (t) => {
  const fixture = await portal(t);
  const head = await fetch(`${fixture.url}/cloudcli/node-a/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get("content-length")) > 0);
  assert.equal(await head.text(), "");
  for (const route of ["/cloudcli/node-a/", "/cloudcli/node-a/_ui/runtime.js", "/cloudcli-ui/ui-one/assets/app.js"]) {
    assert.equal((await fetch(fixture.url + route, { method: "POST" })).status, 405);
  }
  for (const suffix of [
    "ui-one/ui-package.json", "ui-one/index.html", "ui-one/sw.js", "ui-one/manifest.json",
    "ui-one/not-public.env", "ui-one/assets/%2e%2e%2fui-package.json", "ui-one/assets/missing.js",
    "missing/assets/app.js", "ui-one/assets/%5c..%5cactive.json",
  ]) {
    assert.equal((await fetch(`${fixture.url}/cloudcli-ui/${suffix}`)).status, 404, suffix);
  }
  assert.deepEqual(fixture.seen, []);
});

test("missing or corrupt active packages fail closed instead of falling back to a stale node UI", async (t) => {
  const fixture = await portal(t);
  await writeFile(path.join(fixture.store, "active.json"), JSON.stringify({
    schema: 1, release: "ui-missing", manifestSha256: "a".repeat(64),
  }));
  const unavailable = await fetch(`${fixture.url}/cloudcli/node-a/`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "WORKSPACE_UI_UNAVAILABLE" });
  assert.deepEqual(fixture.seen, []);
  await fixture.activate();
  await writeFile(path.join(fixture.store, "releases/ui-one/assets/app.js"), "altered");
  assert.equal((await fetch(`${fixture.url}/cloudcli-ui/ui-one/assets/app.js`)).status, 503);
});

test("packager excludes unrelated files and refuses overwritten releases, invalid manifests and symlinks", async (t) => {
  const fixture = await uiFixture(t);
  const bundle = await readUiPackage(fixture.packageRoot);
  assert.equal(await readUiPackageFile(bundle, "not-public.env"), null);
  assert.equal(await readUiPackageFile(bundle, "clear-cache.html"), null);
  assert.throws(() => validateUiManifest({ ...bundle.manifest, release: "../secrets" }));
  assert.throws(() => validateUiManifest({ ...bundle.manifest, apiContract: 99 }));
  assert.throws(() => validateUiTemplate("<html>No node bootstrap</html>"), /bootstrap/);
  assert.throws(() => validateUiManifest({ ...bundle.manifest, files: {
    ...bundle.manifest.files, "../secret.js": { bytes: 1, sha256: "a".repeat(64) },
  } }));
  await assert.rejects(() => packageCloudCliUi(fixture.built, fixture.packageRoot, {
    release: "ui-one", cloudCliVersion: "1.37.2", sourceSha256: "a".repeat(64),
  }), /EEXIST/);
  const linked = path.join(fixture.root, "linked");
  await cp(fixture.packageRoot, linked, { recursive: true });
  await symlink(path.join(fixture.built, "assets/app.js"), path.join(linked, "assets/escape.js"));
  const manifest = JSON.parse(await readFile(path.join(linked, "ui-package.json"), "utf8"));
  manifest.files["assets/escape.js"] = manifest.files["assets/app.js"];
  await writeFile(path.join(linked, "ui-package.json"), JSON.stringify(manifest));
  await assert.rejects(() => readUiPackage(linked).then((value) => readUiPackageFile(value, "assets/escape.js")), /Unsafe/);
});
