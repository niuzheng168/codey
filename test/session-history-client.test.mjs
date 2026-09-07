import test from "./helpers/optional-history.mjs";
import assert from "node:assert/strict";
import { SessionHistoryClient } from "../src/session-history-client.mjs";

const config = {
  baseUrl: "https://session-share.test",
  entraResource: "api://30d5e016-cec6-4c9c-ac07-3d5b9b2deb5a",
  tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
};

test("session history client caches Azure CLI tokens and proxies structured requests", async () => {
  const commands = [];
  const requests = [];
  const runCommand = async (command, args) => {
    commands.push({ command, args });
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        accessToken: "test-access-token",
        expires_on: Math.floor(Date.now() / 1000) + 3600,
        tenant: config.tenantId,
      }),
    };
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({ items: [], total: 0, limit: 50, offset: 0 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const client = new SessionHistoryClient({
    config,
    fetchImpl,
    runCommand,
    platform: "win32",
  });

  await Promise.all([
    client.list({
      state: "active",
      query: "demo",
      limit: 50,
      offset: 0,
      startAt: 123456,
    }),
    client.list({ state: "trash", query: "", limit: 20, offset: 20 }),
  ]);

  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "az.cmd");
  assert.equal(commands[0].args.includes(config.entraResource), true);
  assert.equal(requests.length, 2);
  assert.match(String(requests[0].url), /state=active/);
  assert.match(String(requests[0].url), /start_at=123456/);
  await client.purge("active", "active-session");
  await client.purge("trash", "trash-session");
  assert.match(String(requests[2].url), /active\/active-session\/purge$/);
  assert.match(String(requests[3].url), /trash\/trash-session$/);
  assert.equal(requests[0].options.headers.authorization, "Bearer test-access-token");
});

test("session history client refreshes a rejected token once", async () => {
  let tokenCalls = 0;
  let requests = 0;
  const client = new SessionHistoryClient({
    config,
    runCommand: async () => {
      tokenCalls += 1;
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          accessToken: `token-${tokenCalls}`,
          expires_on: Math.floor(Date.now() / 1000) + 3600,
          tenant: config.tenantId,
        }),
      };
    },
    fetchImpl: async (_url, options) => {
      requests += 1;
      if (requests === 1) return new Response("unauthorized", { status: 401 });
      return new Response(
        JSON.stringify({ session: { session_name: "demo" } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const detail = await client.detail("active", "demo");
  assert.equal(detail.session.session_name, "demo");
  assert.equal(tokenCalls, 2);
  assert.equal(requests, 2);
  await assert.rejects(
    () => client.detail("active", "../escape"),
    /Session name is invalid/,
  );
});
