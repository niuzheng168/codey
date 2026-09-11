import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { LEGACY_NODE_CONNECTIONS_ENABLED, PORTAL_CONNECTION_MODE, PORTAL_VIEWS, resolvePortalView } from "../public/portal-features.js";
import { nodesForConnection, readConnectionMode, saveConnectionMode } from "../public/node-transport.js";

const source = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\r?\n/gm, "")
  .replace(/\binitialize\(\);\s*$/, `globalThis.probe = {
    state, initialize, refreshClientNodes, onConnectionModeChange, loadCloudCliNodes,
    renderStatus, openProvisionDialog, renderControls, renderNodeCard,
  };`);
const tunnel = { id: "tunnel", name: "Tunnel", networkMode: "devtunnel",
  endpoint: "https://tunnel.nodes.example:8443/usage", proxyEndpoint: "/api/node-data/tunnel/usage" };
const legacy = { id: "legacy", name: "Legacy", networkMode: "vnet",
  endpoint: "https://legacy.example:8443/usage", proxyEndpoint: "/api/node-data/legacy/usage" };
const local = { id: "local", name: "Browser local", networkMode: "direct", endpoint: "https://127.0.0.1:8443/usage" };

function page({ savedMode = "direct", response } = {}) {
  const elements = new Map();
  const requests = [];
  const redirects = [];
  const storage = [];
  const element = (dataset = {}) => ({
    dataset, hidden: false, disabled: false, value: "", src: "", innerHTML: "", textContent: "",
    children: [], listeners: new Map(), classList: { toggle() {} },
    addEventListener(name, handler) { this.listeners.set(name, handler); },
    setAttribute() {},
    append(child) { this.children.push(child); },
    querySelectorAll() { return []; },
  });
  const tabs = ["usage", "sessions", "workspace"].map(portalView => element({ portalView }));
  const document = {
    documentElement: { dataset: {} },
    createElement: () => element(),
    querySelector(selector) {
      // Exercise the real removed markup, not a fake element that hides null errors.
      if (selector === "#local-connect-button") return null;
      if (!elements.has(selector)) elements.set(selector, element());
      const result = elements.get(selector);
      if (selector === "#provision-form") result.elements = { platform: element() };
      return result;
    },
    querySelectorAll(selector) { return selector === "[data-portal-view]" ? tabs : []; },
    addEventListener() {},
  };
  const context = {
    LEGACY_NODE_CONNECTIONS_ENABLED, PORTAL_CONNECTION_MODE, PORTAL_VIEWS, resolvePortalView,
    nodesForConnection, readConnectionMode, saveConnectionMode, URL, URLSearchParams, console, document,
    window: {
      location: { origin: "https://codey.example", href: "https://codey.example/?workspace_node=legacy",
        search: "?workspace_node=legacy", hash: "",
        assign: value => redirects.push(value), replace: value => redirects.push(value) },
      history: { replaceState() {} }, addEventListener() {},
      localStorage: {
        getItem() { storage.push("read"); return savedMode; },
        setItem() { storage.push("write"); },
      },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (response) return response(url, options);
      if (url === "/api/client-nodes") return Response.json({
        directMode: false, connectionModes: ["direct", "vnet"], nodes: [local, legacy, tunnel],
      });
      if (url === "/api/cloudcli/nodes") return Response.json({
        nodes: [legacy, tunnel].map(node => ({ ...node, path: `/cloudcli/${node.id}/` })),
      });
      throw new Error("Unexpected request: " + url);
    },
    setInterval() {},
  };
  runInNewContext(source, context);
  return { ...context.probe, elements, requests, redirects, storage, document };
}

test("shipped markup removes both connection selectors and the browser-local entry", async () => {
  assert.equal(LEGACY_NODE_CONNECTIONS_ENABLED, false);
  assert.equal(PORTAL_CONNECTION_MODE, "devtunnel");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /vnet-connection-toggle|node-connection-options|local-connect-button|VNet|浏览器直连/);
  assert.match(html, /私有 DevTunnel/);
});

test("the Portal ignores saved legacy preferences and lists only configured DevTunnel data routes", async () => {
  for (const savedMode of ["direct", "vnet"]) {
    const p = page({ savedMode });
    assert.equal(p.state.connectionMode, "devtunnel");
    await p.refreshClientNodes(true);
    assert.deepEqual(Array.from(p.state.nodes, node => node.id), ["tunnel"]);
    assert.equal(p.state.directMode, true, "Use the scoped same-origin client data API, not the legacy server aggregator");
    assert.equal(p.document.documentElement.dataset.connectionMode, "devtunnel");
    p.renderControls();
    assert.doesNotMatch(p.elements.get("#node-filters").innerHTML, /127\.0\.0\.1|legacy\.example|data-node-id="local"/);
    await p.onConnectionModeChange({ currentTarget: { checked: false } });
    assert.equal(p.state.connectionMode, "devtunnel");
    assert.deepEqual(p.storage, []);
    assert.deepEqual(p.requests.map(request => request.url), ["/api/client-nodes"]);
  }
});

test("a missing tunnel configuration never falls back to legacy APIs, and local failure hints stay absent", async () => {
  const p = page({ response: () => Response.json({ error: "fixture unavailable" }, { status: 503 }) });
  await p.initialize();
  assert.deepEqual(p.requests.map(request => request.url), ["/api/client-nodes"]);
  p.renderStatus({ nodes: [{ ...local, status: "offline", errors: [] }] });
  assert.doesNotMatch(p.elements.get("#status-region").innerHTML, /VNet|本机|浏览器|证书|直连/);
  p.openProvisionDialog();
  assert.deepEqual(p.redirects, ["/settings#add-node"]);
});

test("Workspace selection discards a saved legacy node without exposing its connection", async () => {
  const p = page();
  await p.loadCloudCliNodes();
  assert.equal(p.state.cloudCli.selectedId, "tunnel");
  assert.deepEqual(Array.from(p.state.cloudCli.nodes, node => node.id), ["tunnel"]);
  assert.equal(p.elements.get("#cloudcli-frame").src, "https://codey.example/cloudcli/tunnel/");
  assert.deepEqual(p.requests.map(request => request.url), ["/api/cloudcli/nodes"]);
});

test("failed data requests are not presented as proof that the entire machine is offline", () => {
  const p = page();
  const html = p.renderNodeCard({
    ...tunnel, status: "offline", tokenUsageAvailable: false, latencyMs: 100,
    totals: { total_tokens: 0, request_count: 0, costs: [] },
    errors: ["quota", "summary", "daily", "events"].map(scope => ({ scope, message: "门户返回 HTTP 502" })),
  }, 0);
  assert.match(html, /status-pill offline[^>]*>数据链路异常</);
  assert.match(html, /title="[^"]*不代表机器[^"]*心跳/);
  assert.match(html, /HTTP 502（4 个接口）/);
  assert.doesNotMatch(html, />离线</);
});
