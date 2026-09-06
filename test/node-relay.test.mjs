import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRelayServer } from "../node-relay/server.mjs";
import { issueClientTicket } from "../src/client-ticket.mjs";

const origin = "https://codey.example.test";
const signingKey = "s".repeat(48);

async function startRelay(t) {
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
