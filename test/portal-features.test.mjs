import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { once } from "node:events";
import { createPortalServer } from "../src/server.mjs";
import { validateConfig } from "../src/config.mjs";
import { PORTAL_VIEWS, SESSION_HISTORY_ENABLED, resolvePortalView } from "../public/portal-features.js";

test("shipped Portal exposes Usage and Workspace, while old history links fall back to Usage", () => {
  assert.equal(SESSION_HISTORY_ENABLED, false);
  assert.deepEqual(PORTAL_VIEWS, ["usage", "workspace"]);
  for (const view of ["sessions", null, "", "unknown"]) assert.equal(resolvePortalView(view), "usage");
  assert.equal(resolvePortalView("usage"), "usage");
  assert.equal(resolvePortalView("workspace"), "workspace");
  assert.equal(resolvePortalView("sessions", ["usage", "sessions", "workspace"]), "sessions");
});

test("history markup and implementation remain, but the entry is hidden before JavaScript loads", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<button[^>]+data-portal-view="sessions"[^>]+\bhidden\b/);
  assert.match(html, /<section[^>]+id="session-history-view"[^>]+\bhidden\b/);
  for (const view of ["usage", "workspace"]) {
    const button = html.match(new RegExp(`<button[^>]+data-portal-view="${view}"[^>]*>`))?.[0];
    assert.ok(button);
    assert.doesNotMatch(button, /\bhidden\b/);
  }
  assert.ok((await readFile(new URL("../public/client-history.js", import.meta.url), "utf8")).length > 0);
});

test("every shipped app module is served over authenticated HTTP, including the feature flag module", async (t) => {
  const server = createPortalServer({
    config: validateConfig({ nodes: [{ id: "test", name: "Test", endpoint: "http://127.0.0.1:9/usage" }] }),
    auth: { username: "test", password: "synthetic-test-only" },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: "Basic " + Buffer.from("test:synthetic-test-only").toString("base64") };
  const app = await fetch(`${base}/app.js`, { headers });
  assert.equal(app.status, 200);
  const imports = [...(await app.text()).matchAll(/from\s+["']\.\/([^"']+\.js)["']/g)].map((match) => match[1]);
  assert.ok(imports.includes("portal-features.js"));
  for (const filename of imports) {
    assert.equal((await fetch(`${base}/${filename}`)).status, 401, filename);
    const result = await fetch(`${base}/${filename}`, { headers });
    assert.equal(result.status, 200, filename);
    assert.match(result.headers.get("content-type"), /javascript/, filename);
    assert.equal(await result.text(), await readFile(new URL(`../public/${filename}`, import.meta.url), "utf8"));
  }
});

test("history deep links and synthetic clicks cannot activate the retained view or request history", async () => {
  const source = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\r?\n/gm, "")
    .replace(/\binitialize\(\);\s*$/, "globalThis.probe = { state, renderActiveView, fetchHistoryList };");
  const nodes = new Map();
  const element = (dataset = {}) => ({
    dataset, hidden: false, disabled: false, value: "", innerHTML: "",
    listeners: new Map(), classList: { toggle() {} },
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    setAttribute() {},
  });
  const tabs = ["usage", "sessions", "workspace"].map((portalView) => element({ portalView }));
  let historyRequests = 0;
  const context = {
    PORTAL_VIEWS, resolvePortalView, URL, URLSearchParams, console,
    readConnectionMode: () => "direct", saveConnectionMode() {}, nodesForConnection: (value) => value,
    document: {
      documentElement: { dataset: {} },
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, element());
        const result = nodes.get(selector);
        if (selector === "#provision-form") result.elements = { platform: element() };
        return result;
      },
      querySelectorAll(selector) { return selector === "[data-portal-view]" ? tabs : []; },
      addEventListener() {},
    },
    window: {
      location: { href: "https://codey.example/?view=sessions", search: "?view=sessions", hash: "" },
      localStorage: {}, history: { replaceState() {} }, addEventListener() {},
    },
    fetch() { historyRequests++; throw new Error("No request should occur"); },
    setInterval() {},
  };
  runInNewContext(source, context);
  assert.equal(context.probe.state.activeView, "usage");
  context.probe.renderActiveView();
  assert.equal(tabs[1].hidden, true);
  assert.equal(tabs[1].disabled, true);
  assert.equal(tabs[0].hidden, false);
  assert.equal(tabs[2].hidden, false);
  tabs[1].listeners.get("click")();
  await context.probe.fetchHistoryList();
  assert.equal(context.probe.state.activeView, "usage");
  assert.equal(nodes.get("#session-history-view").hidden, true);
  assert.equal(historyRequests, 0);
});
