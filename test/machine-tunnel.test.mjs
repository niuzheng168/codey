import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateConfig } from "../src/config.mjs";
import { NodePolicy } from "../src/node-policy.mjs";
import {
  MachineTunnelService, machineTunnelKey, openMachineTunnelToken, sealMachineTunnelToken, signMachineTunnelRequest,
} from "../src/machine-tunnel.mjs";
import { verifyDevTunnelAccess } from "../src/devtunnel-transport.mjs";
import { preparedGateways } from "../src/machine-identity.mjs";
import { NodeDataGateway } from "../src/node-data-gateway.mjs";
import { CloudCliGateway } from "../src/cloudcli-gateway.mjs";

const coordinates = { tunnelId: "codey-test-mac", clusterId: "jpe1" };
function token(input = {}, now = Date.now()) {
  return ["e30", Buffer.from(JSON.stringify({
    ...coordinates, scp: "connect", exp: Math.floor(now / 1000) + 72000, ...input,
  })).toString("base64url"), "c2ln"].join(".");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-tunnel-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const master = randomBytes(32).toString("base64url");
  const defaults = validateConfig({ nodes: [], clientNodes: [] });
  const policy = new NodePolicy({
    root, master, ticketMaster: randomBytes(32).toString("base64url"),
    seedPrincipalId: "owner-a", defaults,
    legacyConfigStore: { load: async () => ({ config: defaults }) },
  });
  await policy.initialize();
  const owner = { enabled: true, authVersion: 1 };
  const node = await policy.reserveMachine("owner-a", Date.now(), "macos-arm64");
  const other = await policy.reserveMachine("owner-b", Date.now(), "macos-x64");
  let calls = 0;
  const service = new MachineTunnelService({
    nodePolicy: policy, accounts: { byId: async () => owner },
    verifyAccess: async () => { calls++; },
    minIntervalMs: 0,
  });
  const server = http.createServer(async (req, res) => {
    if (!await service.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const signed = (id, input, options = {}) => {
    const pathname = `/api/machine-tunnels/${id}/token`;
    const body = JSON.stringify(input);
    const now = options.timestamp ?? Date.now();
    const nonce = options.nonce ?? randomBytes(16).toString("base64url");
    const key = options.key ?? machineTunnelKey(master, id);
    const signature = signMachineTunnelRequest(key, pathname, body, now, nonce);
    return { pathname, body, method: "POST", headers: {
      "content-type": "application/json", authorization: `CodeyTunnel ${now}:${nonce}:${signature}`,
      ...options.headers,
    } };
  };
  const send = (request) => fetch(base + request.pathname, request);
  return { policy, node, other, master, owner, service, signed, send, calls: () => calls };
}

test("Mac token enrollment is node-authenticated, encrypted, purpose-separated, and absent from public metadata", async t => {
  const f = await fixture(t);
  const value = token();
  const response = await f.send(f.signed(f.node.id, { ...coordinates, connectToken: value }));
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(await response.json()).sort(), ["expiresAt", "nodeId", "ok"]);
  assert.equal(f.calls(), 1);
  assert.equal(await f.policy.machineTunnelToken(f.node.id), value);
  assert.ok(!JSON.stringify(await f.policy.records()).includes(value));
  assert.ok(!JSON.stringify(await f.policy.pendingMachines("owner-a")).includes(value));
  assert.notEqual(f.policy.tunnelUpdateKey(f.node.id), f.policy.isolatedKey(f.node.id));
  assert.notEqual(f.policy.tunnelUpdateKey(f.node.id), f.policy.enrollmentValues({ id: "owner-a", name: "owner" }, f.node.id, "https://codey.test").workspaceSsoKey);
});

test("Mac token requests reject other-node keys, cookies, tampering, browser origins, old timestamps, and replay", async t => {
  const f = await fixture(t);
  const input = { ...coordinates, connectToken: token() };
  for (const options of [
    { key: f.policy.tunnelUpdateKey(f.other.id) },
    { headers: { authorization: "Bearer model-key", cookie: "portal_session=not-a-node-credential" } },
    { headers: { origin: "https://codey.test" } },
    { timestamp: Date.now() - 180000 },
  ]) {
    assert.ok([400, 401].includes((await f.send(f.signed(f.node.id, input, options))).status));
  }
  const changed = f.signed(f.node.id, input);
  changed.body = JSON.stringify({ ...input, clusterId: "euw1" });
  assert.equal((await f.send(changed)).status, 401);
  assert.equal(f.calls(), 0);
  const request = f.signed(f.node.id, input);
  assert.equal((await f.send(request)).status, 200);
  assert.equal((await f.send(request)).status, 409);
  assert.equal(f.calls(), 1);
});

test("Mac renewal cannot change tunnel identity, roll credentials back, claim a bound tunnel, or renew cancelled/disabled nodes", async t => {
  const f = await fixture(t);
  const input = { ...coordinates, connectToken: token() };
  assert.equal((await f.send(f.signed(f.node.id, input))).status, 200);
  assert.equal((await f.send(f.signed(f.node.id, {
    ...input, tunnelId: "different-mac", connectToken: token({ tunnelId: "different-mac" }),
  }))).status, 409);
  assert.equal((await f.send(f.signed(f.node.id, {
    ...input, connectToken: token({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  }))).status, 409);
  assert.equal((await f.send(f.signed(f.other.id, input))).status, 409);
  f.owner.enabled = false;
  assert.equal((await f.send(f.signed(f.node.id, input))).status, 401);
  f.owner.enabled = true;
  await f.policy.cancelMachine("owner-a", f.node.id);
  assert.equal((await f.send(f.signed(f.node.id, input))).status, 401);
  await assert.rejects(f.policy.machineTunnelToken(f.node.id));
});

test("Malformed, expired, wrong-scope, and overbroad Mac token payloads never contact Microsoft", async t => {
  const f = await fixture(t);
  for (const input of [
    { ...coordinates, connectToken: "not-a-jwt" },
    { ...coordinates, connectToken: token({ scp: "host" }) },
    { ...coordinates, connectToken: token({ tunnelId: "someone-else" }) },
    { ...coordinates, connectToken: token({ exp: 1 }) },
    { ...coordinates, connectToken: token(), upstream: "https://169.254.169.254/" },
  ]) {
    assert.equal((await f.send(f.signed(f.node.id, input))).status, 400);
  }
  assert.equal(f.calls(), 0);
});

test("a valid machine key cannot continuously consume the shared Microsoft verification pool", async t => {
  const f = await fixture(t);
  f.service.minIntervalMs = 15000;
  const input = { ...coordinates, connectToken: token() };
  assert.equal((await f.send(f.signed(f.node.id, input))).status, 200);
  assert.equal((await f.send(f.signed(f.node.id, input))).status, 429);
  assert.equal(f.calls(), 1);
});

test("The same scoped renewal key works after activation but is revoked on removal", async t => {
  const f = await fixture(t);
  await f.policy.updateMachineTunnel(f.node.id, { ...coordinates, connectToken: token() });
  const machine = {
    id: f.node.id, name: "Mac", region: "DevTunnel", platform: "macos-arm64",
    networkMode: "devtunnel", devTunnel: coordinates,
    tlsServerName: `${f.node.id}.nodes.codey.internal`, fingerprint: "test", ca: "test",
  };
  await f.policy.activateMachine("owner-a", machine);
  assert.equal((await f.send(f.signed(f.node.id, { ...coordinates, connectToken: token() }))).status, 200);
  assert.equal((await f.policy.list("owner-a"))[0].networkMode, "devtunnel");
  assert.ok(!JSON.stringify(await f.policy.list("owner-a")).includes("sealedToken"));
  await f.policy.remove("owner-a", f.node.id);
  assert.equal((await f.send(f.signed(f.node.id, { ...coordinates, connectToken: token() }))).status, 401);
});

test("Storage encryption is authenticated and bound to the node ID", () => {
  const master = randomBytes(32).toString("base64url");
  const a = `n-${"a".repeat(24)}`, b = `n-${"b".repeat(24)}`;
  const encrypted = sealMachineTunnelToken(master, a, "private-credential");
  assert.equal(openMachineTunnelToken(master, a, encrypted), "private-credential");
  assert.throws(() => openMachineTunnelToken(master, b, encrypted));
  const parts = encrypted.split(".");
  parts[1] = Buffer.alloc(16).toString("base64url");
  assert.throws(() => openMachineTunnelToken(master, a, parts.join(".")));
});

test("Mac data and Workspace gateways use dedicated tunnel agents, not ACA loopback or shared env tokens", async t => {
  let tokenValue = "first", creations = 0;
  const factory = node => {
    creations++;
    assert.equal(typeof node.getTunnelToken, "function");
    return { agent: { tunnel: node.id, port: node.devTunnel.port }, dispose: async () => {} };
  };
  const gateways = preparedGateways({
    id: "n-" + "a".repeat(24), name: "Mac", region: "Test",
    machine: { platform: "macos-arm64", networkMode: "devtunnel", devTunnel: coordinates,
      ca: "fixture", tlsServerName: "mac.test", fingerprint: "fixture" },
  }, { getTunnelToken: async () => tokenValue });
  const data = new NodeDataGateway({ nodes: [], ca: "unused" }, { tunnelTransportFactory: factory });
  const workspace = new CloudCliGateway({ nodes: [], ca: "unused" }, { tunnelTransportFactory: factory });
  t.after(async () => { await data.close(); await workspace.close(); });
  data.setMachineNodes([gateways.data]);
  workspace.setMachineNodes([gateways.workspace]);
  assert.equal(data.upstreamOptions(gateways.data).agent.port, 8443);
  assert.equal(workspace.upstreamOptions(gateways.workspace).agent.port, 3001);
  assert.equal(creations, 2);
  tokenValue = "renewed";
  assert.equal(await gateways.workspace.getTunnelToken(), "renewed");
  assert.equal(data.upstreamOptions(gateways.data).rejectUnauthorized, true);
  assert.throws(() => data.upstreamOptions({ ...gateways.data, getTunnelToken: undefined }));
});

test("Microsoft validation requires the right tunnel, both HTTPS ports, and no anonymous access", async () => {
  let metadata;
  const sdkFactory = async () => ({
    TunnelManagementHttpClient: class { async getTunnel() { return metadata; } async dispose() {} },
    ManagementApiVersions: { Version20230927preview: "fixture" },
    CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
  });
  const valid = { ...coordinates, ports: [3001, 8443].map(portNumber => ({ portNumber, protocol: "https" })) };
  metadata = valid;
  await verifyDevTunnelAccess(coordinates, token(), { sdkFactory });
  for (const invalid of [
    { ...valid, tunnelId: "another-tunnel" },
    { ...valid, ports: valid.ports.slice(0, 1) },
    { ...valid, ports: [...valid.ports, { portNumber: 4141, protocol: "http" }] },
    { ...valid, accessControl: { entries: [{ type: "anonymous", scopes: ["connect"] }] } },
    { ...valid, ports: [{ ...valid.ports[0], protocol: "http" }, valid.ports[1]] },
  ]) {
    metadata = invalid;
    await assert.rejects(verifyDevTunnelAccess(coordinates, token(), { sdkFactory }), /unavailable/);
  }
});
