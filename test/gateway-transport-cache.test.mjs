import assert from "node:assert/strict";
import test from "node:test";
import { NodeDataGateway } from "../src/node-data-gateway.mjs";
import { CloudCliGateway } from "../src/cloudcli-gateway.mjs";

function route(kind, id = "n-" + "a".repeat(24), changes = {}) {
  const port = kind === "data" ? 8443 : 3001;
  return {
    id, name: "Fixture", region: "Test", basePath: `/cloudcli/${id}`,
    upstream: new URL(`https://127.0.0.1:${port}`),
    ca: "original-certificate", tlsServerName: `${id}.nodes.codey.internal`, fingerprint: "original-pin",
    devTunnel: { tunnelId: "fixture-tunnel", clusterId: "jpe1", port },
    getTunnelToken: async () => "original-token", ...changes,
  };
}

function fixture(t, kind, { staticNodes = [], dispose, healthProbe } = {}) {
  const transports = [];
  const Gateway = kind === "data" ? NodeDataGateway : CloudCliGateway;
  const gateway = new Gateway({ nodes: staticNodes, ca: "fallback-ca", ssoMaster: "fixture" }, {
    sessionAuthenticator: {}, healthProbe,
    tunnelTransportFactory(node) {
      const transport = {
        agent: { fingerprint: node.fingerprint, ca: node.ca, getToken: node.getTunnelToken },
        disposed: false,
        dispose() { this.disposed = true; return dispose?.(this); },
      };
      transports.push(transport);
      return transport;
    },
  });
  t.after(() => gateway.close());
  return { gateway, transports };
}

for (const kind of ["data", "workspace"]) {
  test(`${kind} drops obsolete TLS transports even if it never observes the removed snapshot`, async t => {
    const { gateway, transports } = fixture(t, kind);
    const original = route(kind);
    gateway.setMachineNodes([original]);
    const oldAgent = gateway.upstreamOptions(original).agent;
    const renewed = { ...original, ca: "renewed-certificate", fingerprint: "renewed-pin" };
    gateway.setMachineNodes([renewed]);
    assert.equal(transports[0].disposed, true);
    const nextAgent = gateway.upstreamOptions(renewed).agent;
    assert.notEqual(nextAgent, oldAgent);
    assert.equal(nextAgent.fingerprint, renewed.fingerprint);
    assert.equal(nextAgent.ca, renewed.ca);
    assert.throws(() => gateway.upstreamOptions(original), "An in-flight old snapshot cannot restore an obsolete pin");
    assert.equal(gateway.upstreamOptions(renewed).agent, nextAgent);
  });

  test(`${kind} removes cached transports before an identical node ID is added again`, async t => {
    const { gateway, transports } = fixture(t, kind);
    const node = route(kind);
    gateway.setMachineNodes([node]);
    const oldAgent = gateway.upstreamOptions(node).agent;
    gateway.setMachineNodes([]);
    assert.equal(transports[0].disposed, true);
    assert.throws(() => gateway.upstreamOptions(node));
    gateway.setMachineNodes([node]);
    assert.notEqual(gateway.upstreamOptions(node).agent, oldAgent);
    assert.equal(transports.length, 2);
  });

  test(`${kind} keeps live transports for metadata-only refreshes and uses the current token provider`, async t => {
    const { gateway, transports } = fixture(t, kind);
    const node = route(kind);
    gateway.setMachineNodes([node]);
    const agent = gateway.upstreamOptions(node).agent;
    assert.equal(await agent.getToken(), "original-token");
    const renamed = { ...node, name: "Renamed", region: "New region", upstream: new URL(node.upstream),
      devTunnel: { port: node.devTunnel.port, clusterId: "jpe1", tunnelId: "fixture-tunnel" },
      getTunnelToken: async () => "renewed-token" };
    gateway.setMachineNodes([renamed]);
    assert.equal(gateway.upstreamOptions(renamed).agent, agent);
    assert.equal(await agent.getToken(), "renewed-token");
    assert.equal(transports[0].disposed, false, "Routine refreshes must not disconnect Workspace sockets");
    assert.equal(transports.length, 1);
  });

  test(`${kind} invalidates binding changes without disturbing static or other nodes`, async t => {
    const fixed = route(kind, "static");
    const { gateway, transports } = fixture(t, kind, { staticNodes: [fixed] });
    let node = route(kind);
    const other = route(kind, "other");
    gateway.setMachineNodes([node, other]);
    const fixedAgent = gateway.upstreamOptions(fixed).agent;
    const otherAgent = gateway.upstreamOptions(other).agent;
    gateway.upstreamOptions(node);
    for (const patch of [
      { ca: "another-ca" }, { fingerprint: "another-pin" }, { tlsServerName: "another.nodes.codey.internal" },
      { upstream: new URL("https://localhost:9443") },
      { devTunnel: { ...node.devTunnel, tunnelId: "another-tunnel" } },
      { devTunnel: { ...node.devTunnel, clusterId: "euw1" } },
      { devTunnel: { ...node.devTunnel, port: 9443 } },
      { devTunnel: { ...node.devTunnel, connectTokenEnv: "CODEY_OTHER_TOKEN" } },
    ]) {
      const previous = transports.at(-1);
      node = { ...node, ...patch };
      gateway.setMachineNodes([node, { ...other, name: "Other renamed" }]);
      assert.equal(previous.disposed, true);
      gateway.upstreamOptions(node);
      assert.equal(gateway.upstreamOptions(fixed).agent, fixedAgent);
      assert.equal(gateway.upstreamOptions(other).agent, otherAgent);
    }
    const current = transports.at(-1);
    assert.throws(() => gateway.setMachineNodes([{ ...node, id: fixed.id }]), /conflicts/);
    assert.equal(current.disposed, false, "An invalid snapshot must not evict usable transports");
    gateway.setMachineNodes([{ ...node, devTunnel: undefined }]);
    assert.equal(current.disposed, true);
    assert.equal(gateway.upstreamOptions({ ...node, devTunnel: undefined }).agent, undefined);
    assert.equal(gateway.upstreamOptions(fixed).agent, fixedAgent);
  });

  test(`${kind} retires transports immediately but awaits asynchronous disposal on shutdown`, async t => {
    const finish = [];
    const { gateway, transports } = fixture(t, kind, { dispose: () => new Promise(resolve => finish.push(resolve)) });
    const node = route(kind);
    gateway.setMachineNodes([node]);
    gateway.upstreamOptions(node);
    gateway.setMachineNodes([]);
    assert.equal(transports[0].disposed, true);
    let closed = false;
    const closing = gateway.close().then(() => { closed = true; });
    await new Promise(setImmediate);
    assert.equal(closed, false, "Shutdown must also await previously evicted transports");
    finish[0]();
    await closing;
    assert.equal(closed, true);
    assert.throws(() => gateway.upstreamOptions(node));
  });

  test(`${kind} tolerates cleanup failures without reusing stale connections`, async t => {
    for (const dispose of [() => { throw new Error("private SDK detail"); }, async () => { throw new Error("private SDK detail"); }]) {
      const { gateway } = fixture(t, kind, { dispose });
      const node = route(kind);
      gateway.setMachineNodes([node]);
      const previous = gateway.upstreamOptions(node).agent;
      gateway.setMachineNodes([]);
      gateway.setMachineNodes([node]);
      assert.notEqual(gateway.upstreamOptions(node).agent, previous);
      await gateway.close();
    }
  });
}

test("Workspace health cache follows the connection identity and ignores late results from a removed node", async t => {
  let completeOld;
  let calls = 0;
  const { gateway } = fixture(t, "workspace", { healthProbe: async (_node, options) => {
    calls++;
    if (calls === 1) return new Promise(resolve => { completeOld = resolve; });
    return { reachable: true, checkedAt: Date.now(), version: options.agent.fingerprint };
  } });
  const original = route("workspace");
  gateway.setMachineNodes([original]);
  const pending = gateway.healthMetadata(original.id);
  await new Promise(setImmediate);
  gateway.setMachineNodes([]);
  assert.equal(gateway.healthCache.has(original.id), false);
  const renewed = { ...original, ca: "renewed-certificate", fingerprint: "renewed-pin" };
  gateway.setMachineNodes([renewed]);
  assert.equal((await gateway.healthMetadata(renewed.id)).version, "renewed-pin");
  completeOld({ reachable: true, checkedAt: Date.now(), version: "obsolete" });
  await pending;
  gateway.setMachineNodes([{ ...renewed, name: "Renamed again" }]);
  assert.equal((await gateway.healthMetadata(renewed.id)).version, "renewed-pin");
  assert.equal(calls, 2);
});
