import assert from "node:assert/strict";
import test from "node:test";
import { collectClientOverview } from "../public/client-aggregator.js";
import { fetchClientHistoryDetail, fetchClientHistoryList } from "../public/client-history.js";
import { fetchNodeJson, nodesForConnection, readConnectionMode, saveConnectionMode } from "../public/node-transport.js";

const remote = {
  id: "jpe2", name: "JPE2", endpoint: "https://jpe2.example.test:8443/usage",
  ticket: "browser-ticket", proxyEndpoint: "/api/node-data/jpe2/usage",
};
const local = { id: "local", name: "Local", endpoint: "https://127.0.0.1:8443/usage", ticket: "local-ticket" };
const config = { requestTimeoutMs: 1000, eventsPerNode: 2, maxRecentEvents: 5 };

test("connection choice defaults to direct, survives reload, and has no automatic fallback", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(readConnectionMode(storage), "direct");
  saveConnectionMode(storage, "vnet");
  assert.equal(readConnectionMode(storage), "vnet");
  saveConnectionMode(storage, "direct");
  assert.equal(readConnectionMode(storage), "direct");
  assert.equal(readConnectionMode({ getItem() { throw new Error("Storage denied"); } }), "direct");
  assert.equal(readConnectionMode({ getItem() { return "unrecognized"; } }), "direct");
  assert.deepEqual(nodesForConnection([local, remote], "vnet"), [remote]);
  const seen = [];
  const result = await collectClientOverview([remote], config, "day", {
    fetchImpl: async (url) => { seen.push(String(url)); throw new TypeError("Corpnet unreachable"); },
  });
  assert.equal(result.status.offline, 1);
  assert.equal(seen.length, 4);
  assert.ok(seen.every((url) => url.startsWith("https://jpe2.example.test:8443/")));
});

test("VNet usage exclusively calls the authenticated same-origin API, excludes local, and carries no node bearer", async () => {
  const seen = [];
  const result = await collectClientOverview([local, remote], config, "day", {
    connectionMode: "vnet",
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return Response.json({ totals: { total_tokens: 42 }, days: [], items: [] });
    },
  });
  assert.equal(result.connectionMode, "vnet");
  assert.equal(result.status.online, 1);
  assert.equal(result.aggregate.totals.total_tokens, 42);
  assert.deepEqual(result.selectedNodeIds, ["jpe2"]);
  assert.equal(seen.length, 4);
  for (const { url, options } of seen) {
    assert.ok(url.startsWith("/api/node-data/jpe2/"));
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.mode, "same-origin");
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.targetAddressSpace, undefined);
  }
});

test("VNet history list and detail use the selected route while Shared remains on the existing API", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url: String(url), options });
    return Response.json({
      items: [{ session_name: "session-1", source_session_id: "session-1", state: "active" }],
      total: 1, session: { session_name: "session-1" },
    });
  };
  const serverFetch = async (url) => {
    assert.ok(url.startsWith("/api/session-history"));
    return { items: [], total: 0, has_more: false };
  };
  const result = await fetchClientHistoryList({
    nodes: [local, remote], source: "all", state: "all", query: "", limit: 20,
    offset: 0, range: "all", connectionMode: "vnet", fetchImpl, serverFetch,
  });
  assert.equal(result.total, 1);
  assert.equal(result.source_errors.length, 0);
  assert.deepEqual(result.sources.map((source) => source.id), ["all", "shared", "jpe2"]);
  await fetchClientHistoryDetail({
    nodes: [local, remote], sourceId: "jpe2", state: "active", sessionName: "session-1",
    connectionMode: "vnet", fetchImpl, serverFetch,
  });
  assert.equal(seen.length, 2);
  assert.ok(seen[0].url.startsWith("/api/node-data/jpe2/session-history?"));
  assert.equal(seen[1].url, "/api/node-data/jpe2/session-history/active/session-1");
  assert.ok(seen.every((request) => request.options.credentials === "same-origin" && !request.options.headers.authorization));
});

test("VNet cannot silently fall back to direct or forward cookies to an arbitrary URL or loopback", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error("Unexpected request"); };
  for (const node of [
    local, { ...remote, proxyEndpoint: null }, { ...remote, proxyEndpoint: "https://evil.example/usage" },
    { ...local, proxyEndpoint: "/api/node-data/local/usage" },
  ]) {
    await assert.rejects(fetchNodeJson(node, node.endpoint, { connectionMode: "vnet", fetchImpl }), /未配置 VNet/);
  }
  assert.equal(requests, 0);
});

test("DevTunnel usage excludes direct/VNet/local entries and only sends authenticated same-origin requests", async () => {
  const tunnel = { ...remote, id: "tunnel", networkMode: "devtunnel", proxyEndpoint: "/api/node-data/tunnel/usage" };
  const invalidLocal = { ...local, networkMode: "devtunnel", proxyEndpoint: "/api/node-data/local/usage" };
  const seen = [];
  const result = await collectClientOverview([local, remote, invalidLocal, tunnel], config, "day", {
    connectionMode: "devtunnel",
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return Response.json({ totals: { total_tokens: 42 }, days: [], items: [] });
    },
  });
  assert.deepEqual(result.selectedNodeIds, ["tunnel"]);
  assert.equal(result.aggregate.totals.total_tokens, 42);
  assert.equal(seen.length, 4);
  for (const { url, options } of seen) {
    assert.ok(url.startsWith("/api/node-data/tunnel/"));
    assert.equal(options.mode, "same-origin");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.targetAddressSpace, undefined);
  }
});

test("DevTunnel failures cannot fall back to VNet/direct or request browser-local access", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error("Unexpected direct request"); };
  for (const node of [
    local, remote, { ...remote, networkMode: "vnet" },
    { ...remote, networkMode: "devtunnel", proxyEndpoint: null },
    { ...remote, networkMode: "devtunnel", proxyEndpoint: "https://evil.example/usage" },
    { ...local, networkMode: "devtunnel", proxyEndpoint: "/api/node-data/local/usage" },
  ]) {
    await assert.rejects(fetchNodeJson(node, node.endpoint, { connectionMode: "devtunnel", fetchImpl }), /DevTunnel/);
  }
  assert.equal(requests, 0);
  const tunnel = { ...remote, networkMode: "devtunnel" };
  const result = await collectClientOverview([tunnel], config, "day", {
    connectionMode: "devtunnel", fetchImpl: async () => Response.json({ error: "denied" }, { status: 401 }),
  });
  assert.equal(result.status.offline, 1);
  assert.match(JSON.stringify(result.nodes[0].errors), /门户登录已失效/);
  assert.doesNotMatch(JSON.stringify(result.nodes[0].errors), /直连|VNet/);
});

test("the retained history client uses DevTunnel routes without exposing legacy sources", async () => {
  const tunnel = { ...remote, networkMode: "devtunnel" };
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return Response.json({ items: [], total: 0, session: { session_name: "test-session" } });
  };
  const result = await fetchClientHistoryList({
    nodes: [local, { ...remote, id: "old" }, tunnel], source: "all", state: "all", query: "",
    limit: 20, offset: 0, range: "all", connectionMode: "devtunnel", fetchImpl,
    serverFetch: async () => ({ items: [], total: 0, has_more: false }),
  });
  assert.deepEqual(result.sources.map(source => source.id), ["all", "shared", "jpe2"]);
  await fetchClientHistoryDetail({
    nodes: [local, tunnel], sourceId: "jpe2", state: "active", sessionName: "test-session",
    connectionMode: "devtunnel", fetchImpl,
  });
  assert.equal(seen.length, 2);
  assert.ok(seen.every(request => request.url.startsWith("/api/node-data/jpe2/") &&
    request.options.credentials === "same-origin" && !request.options.headers.authorization));
});
