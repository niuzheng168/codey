import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRelayServer } from "../node-relay/server.mjs";
import { issueClientTicket } from "../src/client-ticket.mjs";

const origin = "https://codey.example.test";
const signingKey = "s".repeat(48);

async function startRelay(t, options = {}) {
  const history = {
    async list(nodeId, options) {
      return {
        items: [{ source_id: nodeId, session_name: "session", state: "active" }],
        total: 1,
        limit: options.limit,
        offset: options.offset,
      };
    },
    async detail(nodeId, state, sessionName) {
      return {
        session: {
          source_id: nodeId,
          session_name: sessionName,
          state,
        },
        transcript: { messages: [] },
      };
    },
  };
  const server = createRelayServer({
    nodeId: "jpe2",
    nodeName: "JPE2",
    nodeRegion: "Japan East",
    nodeAccent: "#34d399",
    allowedOrigin: origin,
    signingKey,
    sessionRoot: process.cwd(),
    history,
    fetchImpl: async (url) =>
      new Response(JSON.stringify({ path: new URL(url).pathname }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("node relay validates tickets, CORS, and read-only routes", async (t) => {
  const baseUrl = await startRelay(t);
  const ticket = issueClientTicket({
    signingKey,
    nodeId: "jpe2",
    principalId: "principal",
  }).token;

  const preflight = await fetch(`${baseUrl}/usage`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
      "access-control-request-private-network": "true",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");

  const unauthorized = await fetch(`${baseUrl}/usage`, {
    headers: { origin },
  });
  assert.equal(unauthorized.status, 401);

  const usage = await fetch(`${baseUrl}/usage`, {
    headers: { origin, authorization: `Bearer ${ticket}` },
  });
  assert.equal(usage.status, 200);
  assert.equal((await usage.json()).path, "/usage");

  const history = await fetch(`${baseUrl}/session-history?state=all&limit=5`, {
    headers: { origin, authorization: `Bearer ${ticket}` },
  });
  assert.equal(history.status, 200);
  assert.equal((await history.json()).total, 1);

  const detail = await fetch(
    `${baseUrl}/session-history/active/session`,
    { headers: { origin, authorization: `Bearer ${ticket}` } },
  );
  assert.equal((await detail.json()).session.source_id, "jpe2");

  const mutation = await fetch(`${baseUrl}/usage`, {
    method: "POST",
    headers: { origin, authorization: `Bearer ${ticket}` },
  });
  assert.equal(mutation.status, 405);
});

test("unavailable Copilot quota remains an error while independent token statistics and History stay authenticated", async (t) => {
  const calls = [];
  const baseUrl = await startRelay(t, { fetchImpl: async url => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    return new Response(JSON.stringify(pathname === "/usage"
      ? { error: "Failed to fetch Copilot usage" } : { totals: { requests: 1 } }),
    { status: pathname === "/usage" ? 500 : 200, headers: { "content-type": "application/json" } });
  } });
  const token = issueClientTicket({ signingKey, nodeId: "jpe2", principalId: "principal" }).token;
  const headers = { authorization: `Bearer ${token}` };
  const usage = await fetch(baseUrl + "/usage", { headers });
  assert.equal(usage.status, 500, "Do not fabricate quota success or zero usage");
  assert.deepEqual(await usage.json(), { error: "Failed to fetch Copilot usage" });
  const tokens = await fetch(baseUrl + "/token-usage", { headers });
  assert.equal(tokens.status, 200);
  assert.equal((await tokens.json()).totals.requests, 1);
  assert.equal((await fetch(baseUrl + "/session-history", { headers })).status, 200);
  for (const pathname of ["/usage", "/token-usage", "/session-history"]) {
    assert.equal((await fetch(baseUrl + pathname)).status, 401);
  }
  assert.deepEqual(calls, ["/usage", "/token-usage"], "Unauthenticated requests never reach the existing proxy");
});
