import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { readWorkspaceHealth } from "../src/workspace-health.mjs";
import { CloudCliGateway } from "../src/cloudcli-gateway.mjs";
import { SettingsApi } from "../src/settings-api.mjs";
import { browserDataNode } from "../src/node-display.mjs";

const now = 1_800_000_000_000;
const node = { id: "local", name: "windows-devbox", upstream: new URL("https://localhost:3001"),
  healthMonitoring: true, tlsServerName: "localhost" };

function response(body, statusCode = 200, seen = []) {
  return (url, options, callback) => {
    seen.push({ url, options });
    const request = new EventEmitter();
    request.destroy = () => {};
    queueMicrotask(() => {
      const stream = Readable.from([Buffer.from(body)]);
      stream.statusCode = statusCode;
      callback(stream);
    });
    return request;
  };
}

test("health reads only pinned HTTPS /health and exports allowlisted metadata, not credentials or bodies", async () => {
  const seen = [];
  const checkServerIdentity = () => {};
  const result = await readWorkspaceHealth(node, { rejectUnauthorized: true, ca: "test-ca", checkServerIdentity }, {
    clock: () => now,
    requestImpl: response('{"status":"ok","version":"1.37.2","secret":"DO_NOT_EXPORT"}', 200, seen),
  });
  assert.deepEqual(result, { reachable: true, checkedAt: now, version: "1.37.2" });
  assert.equal(seen[0].url.href, "https://localhost:3001/health");
  assert.deepEqual(seen[0].options.headers, { accept: "application/json" });
  assert.equal(seen[0].options.checkServerIdentity, checkServerIdentity);
  assert.equal(seen[0].options.rejectUnauthorized, true);
  assert.ok(!JSON.stringify(result).includes("DO_NOT_EXPORT"));
});

test("bad statuses, redirects, HTML, oversized data and malformed versions cannot fabricate installed versions", async () => {
  for (const [body, status] of [
    ['{"status":"ok"}', 302], ['{"status":"ok"}', 401], ['{"status":"error"}', 200],
    ["<html>login</html>", 200], [" ".repeat(17 * 1024), 200],
  ]) {
    const result = await readWorkspaceHealth(node, { rejectUnauthorized: true }, {
      requestImpl: response(body, status), clock: () => now,
    });
    assert.equal(result.reachable, false);
    assert.equal(result.version, null);
  }
  const value = await readWorkspaceHealth(node, { rejectUnauthorized: true }, {
    requestImpl: response('{"status":"ok","version":"<script>bad</script>"}'), clock: () => now,
  });
  assert.equal(value.reachable, true);
  assert.equal(value.version, null, "Reachability is not permission to guess a component version");
});

test("timeout/transport failure is bounded; plain HTTP or relaxed TLS is never requested", async () => {
  let requests = 0;
  const requestImpl = () => {
    requests++;
    return Object.assign(new EventEmitter(), { destroy() {} });
  };
  assert.equal((await readWorkspaceHealth(node, { rejectUnauthorized: true },
    { requestImpl, timeoutMs: 5, clock: () => now })).reachable, false);
  assert.equal(requests, 1);
  await readWorkspaceHealth({ ...node, upstream: new URL("http://localhost:3001") },
    { rejectUnauthorized: true }, { requestImpl });
  await readWorkspaceHealth(node, { rejectUnauthorized: false }, { requestImpl });
  assert.equal(requests, 1);
  const failed = await readWorkspaceHealth(node, { rejectUnauthorized: true }, {
    requestImpl() { throw new Error("DO_NOT_EXPORT transport details"); }, clock: () => now,
  });
  assert.deepEqual(failed, { reachable: false, checkedAt: now, version: null });
});

test("gateway caches concurrent health checks, expires them and never probes unconfigured or ordinary nodes", async () => {
  let time = now;
  let calls = 0;
  let reachable = true;
  const ordinary = { ...node, id: "other", healthMonitoring: false };
  const gateway = new CloudCliGateway({ nodes: [node, ordinary], ca: "test-ca" }, {
    healthClock: () => time,
    healthProbe: async () => { calls++; return { reachable, checkedAt: time, version: "1.37.2" }; },
  });
  assert.equal(await gateway.healthMetadata("missing"), null);
  assert.equal(await gateway.healthMetadata("other"), null);
  const values = await Promise.all([gateway.healthMetadata("local"), gateway.healthMetadata("local")]);
  assert.equal(calls, 1);
  assert.equal(values[0].reachable, true);
  time += 29999;
  await gateway.healthMetadata("local");
  assert.equal(calls, 1);
  time += 1;
  reachable = false;
  assert.equal((await gateway.healthMetadata("local")).reachable, false);
  assert.equal(calls, 2, "Do not reuse a previous successful check forever");
  time -= 60000;
  await gateway.healthMetadata("local");
  assert.equal(calls, 3, "A backwards clock must not extend an old online result");
  await gateway.close();
});

test("admin differentiates live Workspace reachability from a missing updater heartbeat", async () => {
  const registered = [{ id: "local", name: "windows-devbox", region: "Windows", ownerId: "owner" }];
  const health = { reachable: true, checkedAt: now, version: "1.37.2" };
  let checks = 0;
  let enabled = true;
  const api = new SettingsApi({
    nodePolicy: { inventory: async () => registered },
    accounts: { list: async () => [{ id: "owner", username: "zhn", enabled }] },
    machineUpdates: { inventory: async () => ({
      generatedAt: now, heartbeatTimeoutMs: 90000,
      nodes: new Map([["local", { status: "not_enrolled", lastSeen: null, components: {} }]]),
    }) },
    cloudCliGateway: { healthMetadata: async () => { checks++; return health; } },
  });
  const result = await api.adminNodes();
  assert.deepEqual(result.summary, { total: 1, owners: 1, online: 1, stale: 0, unknown: 0 });
  const row = result.nodes[0];
  assert.equal(row.status, "workspace_online");
  assert.equal(row.updaterStatus, "not_enrolled");
  assert.equal(row.lastSeen, null, "Do not synthesize an updater heartbeat");
  assert.equal(row.components.cloudcli.source, "workspace_health");
  assert.equal(row.components.cloudcli.version, "1.37.2");
  assert.equal(row.components.cloudcli.commit, null);
  assert.equal(row.components.copilotApi, null, "Do not infer protected copilot-api metadata");
  health.reachable = false;
  const unavailable = await api.adminNodes();
  assert.equal(unavailable.summary.online, 0);
  assert.equal(unavailable.nodes[0].status, "workspace_unreachable");
  enabled = false;
  assert.equal((await api.adminNodes()).nodes[0].status, "owner_disabled");
  assert.equal(checks, 2, "A disabled owner's node is not probed");
});

test("browser-loopback data remains explicitly separate from the renamed remote Windows Workspace", () => {
  const windows = { id: "local", name: "windows-devbox", endpoint: "https://127.0.0.1:8443/usage", accent: "#ffffff" };
  const browser = browserDataNode(windows);
  assert.equal(browser.name, "浏览器本机");
  assert.match(browser.region, /不是远程 Windows/);
  assert.equal(browser.id, windows.id);
  assert.equal(browser.endpoint, windows.endpoint);
  assert.equal(windows.name, "windows-devbox", "Do not mutate the saved Workspace name or identity");
  const remote = { ...windows, id: "n-owned", endpoint: "https://10.0.0.4:8443/usage" };
  assert.equal(browserDataNode(remote), remote);
});
