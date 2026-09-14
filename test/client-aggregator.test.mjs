import test from "node:test";
import assert from "node:assert/strict";
import { collectClientOverview } from "../public/client-aggregator.js";
import { controlledOverviewFetch, overviewConfig, overviewNodes, overviewPayload } from "./helpers/overview-fixture.mjs";

const tick = () => new Promise(setImmediate);

function response(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("browser aggregator fetches every node directly with its ticket", async () => {
  const requests = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    requests.push({ url: url.toString(), options });
    if (url.pathname === "/usage") {
      return response({
        login: "user",
        copilot_plan: "enterprise",
        quota_snapshots: {},
      });
    }
    if (url.pathname === "/token-usage") {
      return response({
        totals: { total_tokens: 100, request_count: 1 },
        byModel: [{ model: "gpt-test", total_tokens: 100, request_count: 1 }],
      });
    }
    if (url.pathname === "/token-usage/daily") {
      return response({
        days: [
          {
            date: "2026-09-04",
            totals: { total_tokens: 100, request_count: 1 },
            byModel: [],
          },
        ],
      });
    }
    if (url.pathname === "/token-usage/events") {
      return response({
        items: [
          {
            id: "event",
            created_at_ms: 1,
            model: "gpt-test",
            total_tokens: 100,
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const nodes = [
    {
      id: "local",
      name: "Local",
      region: "Local",
      accent: "#8b5cf6",
      endpoint: "https://127.0.0.1:8443/usage",
      ticket: "local-ticket",
    },
    {
      id: "jpe2",
      name: "JPE2",
      region: "Japan East",
      accent: "#34d399",
      endpoint: "https://jpe2.example.test/usage",
      ticket: "jpe2-ticket",
    },
  ];
  const result = await collectClientOverview(
    nodes,
    {
      requestTimeoutMs: 1000,
      eventsPerNode: 2,
      maxRecentEvents: 5,
    },
    "day",
    { fetchImpl },
  );
  assert.equal(result.status.online, 2);
  assert.equal(result.aggregate.totals.total_tokens, 200);
  assert.deepEqual(result.selectedNodeIds, ["local", "jpe2"]);
  assert.equal(requests.length, 8);
  assert.equal(
    requests.find((item) => item.url.startsWith("https://127.0.0.1:8443"))
      .options.targetAddressSpace,
    "loopback",
  );
  assert.equal(
    requests.find((item) => item.url.startsWith("https://jpe2"))
      .options.headers.authorization,
    "Bearer jpe2-ticket",
  );
});

test("usage, daily data and events publish before slow quota and other nodes finish", async (t) => {
  const { requests, fetchImpl } = controlledOverviewFetch();
  const controller = new AbortController();
  const snapshots = [];
  let finished = false;
  const result = collectClientOverview(overviewNodes, overviewConfig, "week", {
    fetchImpl, connectionMode: "devtunnel", signal: controller.signal,
    onProgress: (snapshot) => snapshots.push(snapshot),
  }).then((value) => { finished = true; return value; });
  t.after(async () => { controller.abort(); await result.catch(() => {}); });
  assert.equal(requests.length, 8, "All node interfaces start concurrently");
  const initial = JSON.stringify(snapshots[0]);
  const request = (path) => requests.find((item) => item.url.pathname === `/api/node-data/healthy${path}`);

  request("/token-usage/daily").resolve();
  request("/token-usage/events").resolve();
  await tick();
  assert.equal(finished, false);
  assert.equal(snapshots.at(-1).aggregate.days[0].totals.total_tokens, 100);
  assert.equal(snapshots.at(-1).aggregate.recentEvents[0].total_tokens, 100);
  assert.equal(snapshots.at(-1).nodes[0].tokenUsageAvailable, false);
  assert.equal(snapshots.at(-1).nodes[0].responding, true);

  request("/token-usage").resolve();
  await tick();
  assert.equal(snapshots.at(-1).aggregate.totals.total_tokens, 100);
  assert.deepEqual(snapshots.at(-1).nodes[0].pendingScopes, ["quota"]);
  assert.equal(snapshots.at(-1).status.offline, 0, "Pending is not offline");
  assert.equal(snapshots.at(-1).nodes[1].responding, false);
  assert.equal(finished, false, "Usage is visible without quota or the other node");

  request("/usage").resolve();
  await tick();
  assert.equal(snapshots.at(-1).status.online, 1);
  assert.equal(snapshots.at(-1).status.loading, 1);
  for (const item of requests.filter((item) => item.url.pathname.includes("/developing/"))) {
    item.reject(new DOMException("synthetic slow node", "TimeoutError"));
  }
  const final = await result;
  assert.equal(final.status.offline, 1);
  assert.equal(final.status.online, 1);
  assert.equal(final.status.loading, 0);
  assert.equal(final.aggregate.totals.total_tokens, 100);
  assert.equal(final.nodes[1].errors.length, 4);
  assert.ok(final.nodes[1].errors.every((error) => error.message === "请求超时"));
  assert.deepEqual(final.selectedNodeIds, ["healthy", "developing"]);
  assert.equal(JSON.stringify(snapshots[0]), initial, "Published snapshots are not mutated later");
});

test("refresh retains selected-node data by scope, marks stale failures and replaces successful fields", async (t) => {
  const previousData = await collectClientOverview(overviewNodes, overviewConfig, "week", {
    connectionMode: "devtunnel",
    fetchImpl: async (input) => Response.json(overviewPayload(new URL(input, "https://portal.example.test").pathname)),
  });
  const previousJson = JSON.stringify(previousData);
  const { requests, fetchImpl } = controlledOverviewFetch();
  const controller = new AbortController();
  const snapshots = [];
  const result = collectClientOverview(overviewNodes, overviewConfig, "week", {
    nodeIds: ["healthy"], connectionMode: "devtunnel", previousData,
    fetchImpl, signal: controller.signal, onProgress: (value) => snapshots.push(value),
  });
  t.after(async () => { controller.abort(); await result.catch(() => {}); });
  assert.deepEqual(snapshots[0].selectedNodeIds, ["healthy"]);
  assert.equal(snapshots[0].aggregate.totals.total_tokens, 100, "Deselected cached data is not included");
  assert.deepEqual(snapshots[0].nodes[0].staleScopes, ["quota", "summary", "daily", "events"]);
  requests.find((item) => item.url.pathname.endsWith("/events"))
    .resolve(overviewPayload("/token-usage/events", 200));
  await tick();
  assert.equal(snapshots.at(-1).aggregate.recentEvents[0].total_tokens, 200);
  assert.equal(snapshots.at(-1).aggregate.recentEvents.length, 1, "Replace events instead of appending duplicates");
  for (const item of requests.filter((item) => !item.url.pathname.endsWith("/events"))) {
    item.reject(new DOMException("synthetic timeout", "TimeoutError"));
  }
  const partial = await result;
  assert.equal(partial.status.partial, 1);
  assert.equal(partial.aggregate.totals.total_tokens, 100);
  assert.equal(partial.aggregate.days[0].totals.total_tokens, 100);
  assert.deepEqual(partial.nodes[0].staleScopes, ["quota", "summary", "daily"]);
  assert.equal(partial.nodes[0].errors.length, 3);
  assert.equal(JSON.stringify(previousData), previousJson);

  const recovered = await collectClientOverview(overviewNodes, overviewConfig, "week", {
    nodeIds: ["healthy"], connectionMode: "devtunnel", previousData: partial,
    fetchImpl: async (input) => Response.json(overviewPayload(new URL(input, "https://portal.example.test").pathname, 300)),
  });
  assert.equal(recovered.aggregate.totals.total_tokens, 300);
  assert.equal(recovered.aggregate.recentEvents.length, 1);
  assert.deepEqual(recovered.nodes[0].staleScopes, []);
  assert.deepEqual(recovered.nodes[0].errors, []);
  assert.equal(recovered.status.online, 1);

  const empty = await collectClientOverview(overviewNodes, overviewConfig, "week", {
    nodeIds: ["healthy"], connectionMode: "devtunnel", previousData: recovered,
    fetchImpl: async () => Response.json({}),
  });
  assert.equal(empty.aggregate.totals.total_tokens, 0, "A successful empty response replaces cached usage");
  assert.deepEqual(empty.aggregate.days, []);
  assert.deepEqual(empty.aggregate.recentEvents, []);
  assert.deepEqual(empty.accounts, []);
  assert.deepEqual(empty.nodes[0].staleScopes, []);
});

test("cached usage never crosses periods, routes or changed node endpoints", async () => {
  const previousData = await collectClientOverview(overviewNodes, overviewConfig, "week", {
    connectionMode: "devtunnel",
    fetchImpl: async (input) => Response.json(overviewPayload(new URL(input, "https://portal.example.test").pathname)),
  });
  for (const [period, connectionMode, nodes] of [
    ["day", "devtunnel", overviewNodes],
    ["week", "direct", overviewNodes],
    ["week", "vnet", overviewNodes],
    ["week", "devtunnel", overviewNodes.map((node) => ({ ...node, endpoint: `https://new-${node.id}.example.test/usage` }))],
  ]) {
    const snapshots = [];
    await collectClientOverview(nodes, overviewConfig, period, {
      connectionMode, previousData, onProgress: (value) => snapshots.push(value),
      fetchImpl: async () => Response.json({}),
    });
    assert.equal(snapshots[0].aggregate.totals.total_tokens, 0);
    assert.ok(snapshots[0].nodes.every((node) => !node.tokenUsageAvailable && !node.staleScopes.length));
  }
});

test("superseding a refresh aborts all pending requests without publishing offline errors", async () => {
  const controller = new AbortController();
  const { requests, fetchImpl } = controlledOverviewFetch();
  const snapshots = [];
  const result = collectClientOverview(overviewNodes, overviewConfig, "week", {
    connectionMode: "devtunnel", fetchImpl, signal: controller.signal,
    onProgress: (value) => snapshots.push(value),
  });
  const count = snapshots.length;
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  await tick();
  assert.ok(requests.every((request) => request.signal.aborted));
  assert.equal(snapshots.length, count);
  assert.ok(snapshots.every((snapshot) => snapshot.nodes.every((node) => !node.errors.length)));
  await assert.rejects(collectClientOverview(overviewNodes, overviewConfig, "week", {
    fetchImpl: () => assert.fail("Already-cancelled refresh must not send requests"),
    signal: controller.signal,
  }), { name: "AbortError" });
});

test("per-interface timeouts still work when a refresh cancellation signal is supplied", async () => {
  const controller = new AbortController();
  const { requests, fetchImpl } = controlledOverviewFetch();
  const result = await collectClientOverview([overviewNodes[0]], { ...overviewConfig, requestTimeoutMs: 20 }, "week", {
    connectionMode: "devtunnel", fetchImpl, signal: controller.signal,
  });
  assert.equal(result.status.offline, 1);
  assert.equal(result.nodes[0].errors.length, 4);
  assert.ok(result.nodes[0].errors.every((error) => error.message === "请求超时"));
  assert.equal(requests.length, 4, "No retries or automatic route fallbacks");
  assert.equal(controller.signal.aborted, false, "Node timeouts do not cancel the whole refresh");
});
