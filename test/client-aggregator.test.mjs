import test from "node:test";
import assert from "node:assert/strict";
import { collectClientOverview } from "../public/client-aggregator.js";

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
