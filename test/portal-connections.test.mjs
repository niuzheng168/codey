import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { LEGACY_NODE_CONNECTIONS_ENABLED, PORTAL_CONNECTION_MODE, PORTAL_VIEWS, resolvePortalView } from "../public/portal-features.js";
import { nodesForConnection, readConnectionMode, saveConnectionMode } from "../public/node-transport.js";
import { collectClientOverview } from "../public/client-aggregator.js";
import { controlledOverviewFetch, overviewConfig, overviewNodes, overviewPayload } from "./helpers/overview-fixture.mjs";

const tick = () => new Promise(setImmediate);

const source = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\r?\n/gm, "")
  .replace(/\binitialize\(\);\s*$/, `globalThis.probe = {
    state, initialize, refreshClientNodes, onConnectionModeChange, loadCloudCliNodes,
    renderStatus, openProvisionDialog, renderControls, renderNodeCard, fetchOverview,
  };`);
const tunnel = { id: "tunnel", name: "Tunnel", networkMode: "devtunnel",
  endpoint: "https://tunnel.nodes.example:8443/usage", proxyEndpoint: "/api/node-data/tunnel/usage" };
const legacy = { id: "legacy", name: "Legacy", networkMode: "vnet",
  endpoint: "https://legacy.example:8443/usage", proxyEndpoint: "/api/node-data/legacy/usage" };
const local = { id: "local", name: "Browser local", networkMode: "direct", endpoint: "https://127.0.0.1:8443/usage" };

function page({ savedMode = "direct", response, collectOverview = collectClientOverview } = {}) {
  const elements = new Map();
  const requests = [];
  const redirects = [];
  const storage = [];
  const frames = new Map();
  let frameId = 0;
  const element = (dataset = {}) => ({
    dataset, hidden: false, disabled: false, value: "", src: "", innerHTML: "", textContent: "",
    children: [], listeners: new Map(), classList: { toggle() {} },
    addEventListener(name, handler) { this.listeners.set(name, handler); },
    setAttribute() {},
    append(child) { this.children.push(child); },
    querySelector() {
      if (!this.child) this.child = element();
      return this.child;
    },
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
    nodesForConnection, readConnectionMode, saveConnectionMode, URL, URLSearchParams, console, document, AbortController,
    collectClientOverview: (nodes, config, period, options) =>
      collectOverview(nodes, config, period, { ...options, fetchImpl: context.fetch }),
    window: {
      location: { origin: "https://codey.example", href: "https://codey.example/?workspace_node=legacy",
        search: "?workspace_node=legacy", hash: "",
        assign: value => redirects.push(value), replace: value => redirects.push(value) },
      history: { replaceState() {} }, addEventListener() {},
      requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame(id) { frames.delete(id); },
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
  return { ...context.probe, elements, requests, redirects, storage, document, frames,
    flushFrames() {
      for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
    },
  };
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

test("the dashboard paints completed interfaces while a developing node is still pending", async (t) => {
  const pending = controlledOverviewFetch();
  const p = page({
    response: (url, options) => url === "/api/client-nodes"
      ? Response.json({ ...overviewConfig, nodes: overviewNodes })
      : pending.fetchImpl(url, options),
  });
  const initializing = p.initialize();
  t.after(async () => { p.state.overviewAbortController?.abort(); await initializing; });
  await tick();
  assert.equal(pending.requests.length, 8);
  for (const request of pending.requests.filter((item) =>
    item.url.pathname.includes("/healthy/") && !item.url.pathname.endsWith("/usage"))) {
    request.resolve();
  }
  await tick();
  assert.equal(p.frames.size, 1, "Batch interface updates into one animation frame");
  p.flushFrames();
  assert.equal(p.elements.get("#dashboard").hidden, false);
  assert.equal(p.elements.get("#loading-state").hidden, true);
  assert.match(p.elements.get("#dashboard").innerHTML, /class="node-token-value">100</);
  assert.match(p.elements.get("#connection-label").textContent, /1\/2 节点有响应/);
  assert.match(p.elements.get("#status-region").innerHTML, /正在读取 Healthy、Developing/);
  assert.doesNotMatch(p.elements.get("#status-region").innerHTML, /数据不完整|请求超时/);
  assert.equal(p.state.isLoading, true);
  assert.equal(p.elements.get("#refresh-button").disabled, false);

  pending.requests.find((item) => item.url.pathname === "/api/node-data/healthy/usage").resolve();
  await tick();
  p.flushFrames();
  assert.equal(p.state.data.status.online, 1);
  assert.equal(p.state.data.status.loading, 1);
  assert.match(p.elements.get("#status-region").innerHTML, /正在读取 Developing/);
  for (const request of pending.requests.filter((item) => item.url.pathname.includes("/developing/"))) {
    request.reject(new DOMException("synthetic timeout", "TimeoutError"));
  }
  await initializing;
  assert.match(p.elements.get("#status-region").innerHTML, /Developing：请求超时（4 个接口）/);
  assert.equal(p.state.data.aggregate.totals.total_tokens, 100);
  assert.equal(p.state.isLoading, false);
  assert.equal(p.frames.size, 0);
  assert.ok(p.state.nextRefreshAt > Date.now());
});

test("changing periods and node filters cancels old refreshes and ignores late results", async () => {
  const completed = await collectClientOverview(overviewNodes, overviewConfig, "week", {
    connectionMode: "devtunnel",
    fetchImpl: async (url) => Response.json(overviewPayload(new URL(url, "https://portal.example.test").pathname)),
  });
  const runs = [];
  const p = page({
    response: () => Response.json({ ...overviewConfig, nodes: overviewNodes }),
    collectOverview(nodes, config, period, options) {
      const deferred = Promise.withResolvers();
      runs.push({ period, options, ...deferred });
      return deferred.promise;
    },
  });
  await p.refreshClientNodes(true);
  p.state.selectedNodes = new Set(overviewNodes.map((node) => node.id));
  const first = p.fetchOverview(false);
  await tick();
  runs[0].options.onProgress(completed);
  p.flushFrames();

  p.state.period = "day";
  const second = p.fetchOverview(false);
  await tick();
  assert.equal(runs.length, 2, "A period change is not skipped while loading");
  assert.equal(runs[0].options.signal.aborted, true);
  assert.equal(runs[1].period, "day");
  const day = { ...completed, period: "day" };
  runs[1].options.onProgress(day);
  p.flushFrames();
  // Model an already-queued callback and a transport that completes after cancellation.
  runs[0].options.onProgress(completed);
  runs[0].resolve(completed);
  await first;
  p.flushFrames();
  assert.equal(p.state.data, day);
  assert.equal(p.state.isLoading, true, "Old finally blocks do not finish the current refresh");
  assert.equal(p.state.nextRefreshAt, 0);

  p.state.selectedNodes = new Set(["healthy"]);
  const third = p.fetchOverview(false);
  await tick();
  assert.equal(runs.length, 3, "A node filter change is not skipped while loading");
  assert.equal(runs[1].options.signal.aborted, true);
  assert.deepEqual(Array.from(runs[2].options.nodeIds), ["healthy"]);
  const filtered = { ...day, selectedNodeIds: ["healthy"], nodes: [day.nodes[0]] };
  runs[2].options.onProgress(filtered);
  p.flushFrames();
  runs[1].options.onProgress(day);
  runs[1].resolve(day);
  await second;
  assert.equal(p.state.data, filtered);
  runs[2].resolve(filtered);
  await third;
  assert.equal(p.state.isLoading, false);
  assert.ok(p.state.nextRefreshAt > Date.now());
  assert.doesNotMatch(p.elements.get("#status-region").innerHTML, /刷新失败/);
});

test("manual refresh remains usable while loading and an empty selection cancels pending data", async () => {
  const runs = [];
  const p = page({
    response: () => Response.json({ ...overviewConfig, nodes: overviewNodes }),
    collectOverview(nodes, config, period, options) {
      const deferred = Promise.withResolvers();
      options.signal.addEventListener("abort", () => deferred.reject(options.signal.reason), { once: true });
      runs.push({ options, ...deferred });
      return deferred.promise;
    },
  });
  await p.refreshClientNodes(true);
  p.state.selectedNodes = new Set(["healthy"]);
  const first = p.fetchOverview(false);
  await tick();
  assert.equal(p.elements.get("#refresh-button").disabled, false);
  const second = p.elements.get("#refresh-button").listeners.get("click")();
  await tick();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].options.signal.aborted, true);
  assert.equal(p.state.isLoading, true);
  p.state.selectedNodes.clear();
  await p.fetchOverview(false);
  await Promise.all([first, second]);
  assert.equal(runs[1].options.signal.aborted, true);
  assert.equal(p.state.data, null);
  assert.equal(p.state.isLoading, false);
  assert.match(p.elements.get("#dashboard").innerHTML, /还没有可访问的 DevTunnel 节点/);
  assert.equal(p.elements.get("#status-region").innerHTML, "");
  assert.equal(p.state.nextRefreshAt, 0);
});

test("pending and cached node data are clearly labeled without a false failure notice", () => {
  const p = page();
  const node = {
    ...tunnel, status: "loading", responding: true, tokenUsageAvailable: true, latencyMs: 50,
    totals: { total_tokens: 100, request_count: 1, costs: [] },
    pendingScopes: ["quota", "summary"], staleScopes: ["summary"], errors: [],
  };
  p.renderStatus({ nodes: [node] });
  const status = p.elements.get("#status-region").innerHTML;
  assert.match(status, /正在读取 Tunnel/);
  assert.match(status, /沿用上次结果/);
  assert.doesNotMatch(status, /部分节点数据不完整|数据链路异常/);
  const html = p.renderNodeCard(node, 100);
  assert.match(html, /status-pill loading[^>]*>读取中</);
  assert.match(html, /含上次数据/);
  assert.doesNotMatch(html, /NaN|undefined|null ms/);
});
