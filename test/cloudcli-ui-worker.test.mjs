import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../cloudcli/public/sw.js", import.meta.url), "utf8");

function worker({ cacheNames = [], clients = [], response = new Response("OK") } = {}) {
  const handlers = {};
  const removed = [], cached = [], opened = [];
  const context = {
    URL, Response, encodeURIComponent,
    self: {
      location: { origin: "https://codey.example" },
      registration: { scope: "https://codey.example/cloudcli/node-a/", showNotification: async () => {} },
      skipWaiting: () => {},
      addEventListener: (name, handler) => { handlers[name] = handler; },
      clients: {
        claim: async () => {},
        matchAll: async () => clients,
        openWindow: async (url) => { opened.push(url); },
      },
    },
    caches: {
      keys: async () => cacheNames,
      delete: async (name) => { removed.push(name); },
      match: async () => assert.fail("Must not read another node's or ambiguous legacy cache"),
      open: async () => ({ match: async () => null, addAll: async () => {}, put: async (...args) => { cached.push(args); } }),
    },
    fetch: async () => response,
  };
  vm.runInNewContext(source, context);
  return { handlers, removed, cached, opened };
}

test("worker activation only cleans the current node's old caches", async () => {
  const instance = worker({ cacheNames: [
    "claude-ui-scope-%2Fcloudcli%2Fnode-a%2F-v2", "claude-ui-scope-%2Fcloudcli%2Fnode-a%2F-v3",
    "claude-ui-scope-%2Fcloudcli%2Fnode_a%2F-v2", "claude-ui-scope-%2Fcloudcli%2Fnode-b%2F-v3",
    "claude-ui-v2-cloudcli-node-a-", "portal-cache",
  ] });
  let done;
  instance.handlers.activate({ waitUntil: (promise) => { done = promise; } });
  await done;
  assert.deepEqual(instance.removed, ["claude-ui-scope-%2Fcloudcli%2Fnode-a%2F-v2"]);
});

test("push navigation selects the matching node and cannot turn a session ID into another node's path", async () => {
  const focused = [], messages = [];
  const client = (id) => ({
    url: `https://codey.example/cloudcli/${id}/`,
    focus: async () => { focused.push(id); },
    postMessage: (message) => { messages.push(message); },
  });
  const instance = worker({ clients: [client("node-b"), client("node-a")] });
  let done;
  instance.handlers.notificationclick({
    notification: { data: { sessionId: "../node-b/session" }, close: () => {} },
    waitUntil: (promise) => { done = promise; },
  });
  await done;
  assert.deepEqual(focused, ["node-a"]);
  assert.ok(messages[0].urlPath.startsWith("https://codey.example/cloudcli/node-a/session/"));
  assert.ok(messages[0].urlPath.includes("%2F"));
  assert.deepEqual(instance.opened, []);
});

test("worker never caches an authentication failure or intercepts node/portal API requests", async () => {
  const instance = worker({ response: new Response("Sign in", { status: 401 }) });
  let done;
  instance.handlers.fetch({
    request: { method: "GET", url: "https://codey.example/cloudcli-ui/ui-one/assets/app.js" },
    respondWith: (promise) => { done = promise; },
  });
  assert.equal((await done).status, 401);
  assert.deepEqual(instance.cached, []);
  for (const url of [
    "https://codey.example/cloudcli/node-a/api/projects",
    "https://codey.example/portal-auth/session",
    "https://other.example/assets/app.js",
  ]) {
    instance.handlers.fetch({
      request: { method: "GET", url },
      respondWith: () => assert.fail("Private/API request was intercepted"),
    });
  }
});
