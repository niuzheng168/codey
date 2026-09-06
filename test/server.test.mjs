import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateConfig } from "../src/config.mjs";
import { verifyClientTicket } from "../src/client-ticket.mjs";
import { createPortalServer } from "../src/server.mjs";

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function totals(multiplier) {
  return {
    cache_creation_input_tokens: 5 * multiplier,
    cache_read_input_tokens: 60 * multiplier,
    costs: [{ amount: 0.25 * multiplier, currency: "USD" }],
    input_tokens: 10 * multiplier,
    output_tokens: 25 * multiplier,
    request_count: multiplier,
    total_tokens: 100 * multiplier,
  };
}

function createMockFetch() {
  return async (input) => {
    const url = new URL(input);
    const multiplier = url.hostname === "node-a.test" ? 1 : 2;
    if (url.pathname === "/usage") {
      return response({
        login: "shared-user",
        copilot_plan: "enterprise",
        quota_reset_date: "2026-09-01",
        quota_snapshots: {
          premium_interactions: {
            quota_id: "premium_interactions",
            percent_remaining: 90,
            remaining: 900,
            entitlement: 1000,
          },
        },
      });
    }
    if (url.pathname === "/token-usage") {
      return response({
        totals: totals(multiplier),
        byModel: [{ model: "gpt-test", ...totals(multiplier) }],
      });
    }
    if (url.pathname === "/token-usage/daily") {
      return response({
        days: [
          {
            date: "2026-08-13",
            start_ms: 1,
            end_ms: 2,
            totals: totals(multiplier),
            byModel: [{ model: "gpt-test", ...totals(multiplier) }],
          },
        ],
      });
    }
    if (url.pathname === "/token-usage/events") {
      return response({
        items: [
          {
            id: multiplier,
            created_at_ms: multiplier,
            model: "gpt-test",
            endpoint: "responses",
            total_tokens: 100 * multiplier,
          },
        ],
      });
    }
    return response({ error: "not found" }, 404);
  };
}

async function startServer(t, options = {}) {
  const config = validateConfig({
    cacheSeconds: 0,
    nodes: [
      { id: "a", name: "A", endpoint: "https://node-a.test/usage" },
      { id: "b", name: "B", endpoint: "https://node-b.test/usage" },
    ],
  });
  const server = createPortalServer({
    config,
    fetchImpl: createMockFetch(),
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("overview aggregates nodes, models, accounts, days, and events", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/api/overview?period=week`);
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.aggregate.totals.total_tokens, 300);
  assert.equal(payload.aggregate.totals.request_count, 3);
  assert.equal(payload.aggregate.byModel[0].total_tokens, 300);
  assert.equal(payload.aggregate.days[0].totals.total_tokens, 300);
  assert.equal(payload.aggregate.recentEvents[0].nodeId, "b");
  assert.deepEqual(payload.accounts[0].nodeIds, ["a", "b"]);
  assert.equal(payload.accounts[0].quotas[0].entitlement, 1000);
});

test("node filters and bad input are handled at the API boundary", async (t) => {
  const baseUrl = await startServer(t);
  const nodes = await fetch(`${baseUrl}/api/nodes`);
  assert.equal(nodes.status, 200);
  assert.deepEqual(
    (await nodes.json()).nodes.map((node) => node.id),
    ["a", "b"],
  );

  const filtered = await fetch(`${baseUrl}/api/overview?period=day&nodes=a`);
  assert.equal(filtered.status, 200);
  assert.equal((await filtered.json()).aggregate.totals.total_tokens, 100);

  const badPeriod = await fetch(`${baseUrl}/api/overview?period=year`);
  assert.equal(badPeriod.status, 400);
  const badNode = await fetch(`${baseUrl}/api/overview?period=week&nodes=missing`);
  assert.equal(badNode.status, 400);
});

test("static responses include security headers", async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(
    response.headers.get("content-security-policy"),
    /connect-src 'self';/,
  );
  assert.doesNotMatch(response.headers.get("content-security-policy"), /:4242/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(await response.text(), /<title>Codey<\/title>/);

  const bootstrap = await fetch(`${baseUrl}/windows-bootstrap.ps1`);
  assert.equal(bootstrap.status, 200);
  assert.match(
    bootstrap.headers.get("content-disposition"),
    /install-codex-workstation\.ps1/,
  );
  assert.match(await bootstrap.text(), /EnableOpenSsh/);
});

test("direct browser mode issues scoped node tickets and blocks server aggregation", async (t) => {
  const signingKey = "d".repeat(48);
  const config = validateConfig({
    cacheSeconds: 0,
    clientNodes: [
      {
        id: "local",
        name: "Local",
        endpoint: "http://127.0.0.1:4242/usage",
      },
      {
        id: "jpe2",
        name: "JPE2",
        endpoint: "https://jpe2.example.test/usage",
      },
    ],
    nodes: [{ id: "a", name: "A", endpoint: "https://node-a.test/usage" }],
  });
  const baseUrl = await startServer(t, {
    config,
    clientOnly: true,
    clientPrincipalId: "principal",
    clientRelaySigningKey: signingKey,
    clientTicketTtlSeconds: 300,
  });

  const clientNodes = await fetch(`${baseUrl}/api/client-nodes`);
  assert.equal(clientNodes.status, 200);
  const payload = await clientNodes.json();
  assert.equal(payload.directMode, true);
  assert.deepEqual(payload.nodes.map((node) => node.id), ["local", "jpe2"]);
  const verified = verifyClientTicket({
    signingKey,
    token: payload.nodes[1].ticket,
    nodeId: "jpe2",
    requiredScope: "usage",
  });
  assert.equal(verified.principalId, "principal");

  assert.equal((await fetch(`${baseUrl}/api/overview?period=day`)).status, 409);
  assert.equal((await fetch(`${baseUrl}/api/management/status`)).status, 409);
});

test("portal exposes only assigned CloudCLI node metadata without upstream URLs", async (t) => {
  const baseUrl = await startServer(t, {
    cloudCliGateway: {
      handles() {
        return false;
      },
      publicNodes(allowedNodeIds) {
        assert.deepEqual(allowedNodeIds, ["a", "b"]);
        return [
          {
            id: "a",
            name: "Node A CloudCLI",
            path: "/cloudcli/a/",
            region: "Test",
          },
        ];
      },
    },
  });
  const response = await fetch(`${baseUrl}/api/cloudcli/nodes`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    nodes: [
      {
        id: "a",
        name: "Node A CloudCLI",
        path: "/cloudcli/a/",
        region: "Test",
      },
    ],
  });
});

test("bootstrap downloads embed the validated package in each platform installer", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-bootstrap-"));
  const fileName = "copilot-api-2.3.10-2026-08-31-zhn.tgz";
  const artifactPath = path.join(root, fileName);
  const packageBody = Buffer.from("verified-package");
  const sha256 = "a".repeat(64);
  await writeFile(artifactPath, packageBody);
  t.after(() => rm(root, { force: true, recursive: true }));

  const artifact = {
    id: "copilot-api-2.3.10-2026-08-31-zhn",
    version: "2.3.10",
    buildDate: "2026-08-31",
    label: "zhn",
    fileName,
    sha256,
    sizeBytes: packageBody.length,
  };
  const artifactCatalog = {
    async scan() {
      return { artifacts: [artifact], errors: [] };
    },
    async resolve(id) {
      assert.equal(id, artifact.id);
      return { ...artifact, path: artifactPath };
    },
  };
  const baseUrl = await startServer(t, { artifactCatalog });

  const windows = await fetch(`${baseUrl}/bootstrap/windows`);
  assert.equal(windows.status, 200);
  assert.match(windows.headers.get("content-disposition"), /\.ps1/);
  const windowsBody = await windows.text();
  assert.match(windowsBody, new RegExp(fileName.replaceAll(".", "\\.")));
  assert.match(windowsBody, new RegExp(sha256));
  assert.match(windowsBody, new RegExp(packageBody.toString("base64")));
  assert.doesNotMatch(windowsBody, /__PORTAL_PACKAGE_/);

  const linux = await fetch(`${baseUrl}/bootstrap/linux`);
  assert.equal(linux.status, 200);
  assert.match(linux.headers.get("content-disposition"), /\.sh/);
  const linuxBody = await linux.text();
  assert.equal(linuxBody.includes("\r"), false);
  assert.match(linuxBody, new RegExp(fileName.replaceAll(".", "\\.")));
  assert.match(linuxBody, /gpt-6-astra/);
  assert.match(linuxBody, /model_context_window = 872000/);
  assert.match(linuxBody, new RegExp(packageBody.toString("base64")));
  assert.doesNotMatch(linuxBody, /__PORTAL_PACKAGE_/);

  const macos = await fetch(`${baseUrl}/bootstrap/macos`);
  assert.equal(macos.status, 200);
  assert.match(macos.headers.get("content-disposition"), /\.sh/);
  const macosBody = await macos.text();
  assert.equal(macosBody.includes("\r"), false);
  assert.match(macosBody, /launchctl bootstrap/);
  assert.match(macosBody, /gpt-6-astra/);
  assert.match(macosBody, /model_context_window = 872000/);
  assert.match(macosBody, /https:\/\/chatgpt\.com\/codex\/install\.sh/);
  assert.match(macosBody, /--registry=https:\/\/registry\.npmjs\.org\//);
  assert.match(macosBody, /CODEX_NON_INTERACTIVE=true/);
  assert.doesNotMatch(macosBody, /allow-remote/);
  assert.doesNotMatch(
    macosBody,
    /npm install --global "@openai\/codex@latest"/,
  );
  assert.match(macosBody, new RegExp(packageBody.toString("base64")));
  assert.doesNotMatch(macosBody, /__PORTAL_PACKAGE_/);
});

test("optional basic authentication protects the whole portal", async (t) => {
  const baseUrl = await startServer(t, {
    auth: { username: "zhn", password: "secret" },
  });
  const denied = await fetch(`${baseUrl}/api/health`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate"), /Basic/);

  const allowed = await fetch(`${baseUrl}/api/health`, {
    headers: { authorization: `Basic ${Buffer.from("zhn:secret").toString("base64")}` },
  });
  assert.equal(allowed.status, 200);
});

test("management status and update APIs use an explicit same-origin action marker", async (t) => {
  const updates = [];
  const starts = [];
  const fleetDeployments = [];
  const manager = {
    async status(nodeIds) {
      return { checkedAt: "2026-08-13T00:00:00.000Z", requested: nodeIds, nodes: [] };
    },
    async update(nodeId, component, options) {
      updates.push({ nodeId, component, options });
      return { ok: true, nodeId, component, artifactId: options.artifactId };
    },
    async startCopilotApi(nodeId) {
      starts.push(nodeId);
      return { ok: true, nodeId, component: "copilot-api" };
    },
    async deployCopilotArtifactToAll(artifactId) {
      fleetDeployments.push(artifactId);
      return {
        artifact: { id: artifactId },
        requested: 1,
        deployed: 1,
        skipped: 0,
        failed: 0,
        results: [],
      };
    },
  };
  const baseUrl = await startServer(t, { manager });

  const status = await fetch(`${baseUrl}/api/management/status?nodes=a`);
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).requested, ["a"]);

  const denied = await fetch(`${baseUrl}/api/nodes/a/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      component: "copilot-api",
      artifactId: "copilot-api-2.1.11-2026-08-15-zhn",
    }),
  });
  assert.equal(denied.status, 403);
  assert.equal(updates.length, 0);

  const allowed = await fetch(`${baseUrl}/api/nodes/a/update`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-portal-action": "update",
    },
    body: JSON.stringify({
      component: "copilot-api",
      artifactId: "copilot-api-2.1.11-2026-08-15-zhn",
    }),
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(updates, [
    {
      nodeId: "a",
      component: "copilot-api",
      options: {
        artifactId: "copilot-api-2.1.11-2026-08-15-zhn",
      },
    },
  ]);

  const deniedStart = await fetch(
    `${baseUrl}/api/nodes/a/copilot-api/start`,
    { method: "POST" },
  );
  assert.equal(deniedStart.status, 403);
  assert.deepEqual(starts, []);

  const allowedStart = await fetch(
    `${baseUrl}/api/nodes/a/copilot-api/start`,
    {
      method: "POST",
      headers: { "x-portal-action": "start-copilot-api" },
    },
  );
  assert.equal(allowedStart.status, 200);
  assert.deepEqual(starts, ["a"]);

  const deniedFleet = await fetch(`${baseUrl}/api/copilot-api/deploy-all`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifactId: "fleet-build" }),
  });
  assert.equal(deniedFleet.status, 403);
  assert.deepEqual(fleetDeployments, []);

  const allowedFleet = await fetch(`${baseUrl}/api/copilot-api/deploy-all`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-portal-action": "update",
    },
    body: JSON.stringify({ artifactId: "fleet-build" }),
  });
  assert.equal(allowedFleet.status, 200);
  assert.deepEqual(fleetDeployments, ["fleet-build"]);
});

test("one-click provisioning has a separate action marker and structured body", async (t) => {
  const provisions = [];
  const provisioner = {
    async provision(payload) {
      provisions.push(payload);
      return {
        ok: true,
        node: { id: payload.id, name: payload.name },
        verification: { codexCheck: "CODEX_PROVISION_OK" },
      };
    },
  };
  const baseUrl = await startServer(t, { provisioner });
  const payload = {
    id: "new-node",
    name: "New Node",
    sshHost: "new-node",
    templateNodeId: "a",
  };

  const denied = await fetch(`${baseUrl}/api/nodes/provision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-portal-action": "update",
    },
    body: JSON.stringify(payload),
  });

  assert.equal(denied.status, 403);
  assert.equal(provisions.length, 0);

  const allowed = await fetch(`${baseUrl}/api/nodes/provision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-portal-action": "provision",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(allowed.status, 201);
  assert.equal((await allowed.json()).verification.codexCheck, "CODEX_PROVISION_OK");
  assert.deepEqual(provisions, [payload]);
});

test("session history API stays server-authenticated and gates mutations", async (t) => {
  const calls = [];
  const sessionHistoryClient = {
    async status() {
      return { configured: true, baseUrl: "https://session-share.test" };
    },
    async list(options) {
      calls.push({ action: "list", options });
      return { items: [], total: 0, limit: options.limit, offset: options.offset };
    },
    async detail(state, name) {
      calls.push({ action: "detail", state, name });
      return { session: { session_name: name, state }, transcript: { messages: [] } };
    },
    async rename(name, newName) {
      calls.push({ action: "rename", name, newName });
      return { status: "renamed" };
    },
    async trash(name) {
      calls.push({ action: "trash", name });
      return { status: "trashed" };
    },
    async restore(name) {
      calls.push({ action: "restore", name });
      return { status: "restored" };
    },
    async purge(state, name) {
      calls.push({ action: "purge", state, name });
      return { status: "purged" };
    },
    async archive(state, name) {
      calls.push({ action: "archive", state, name });
      return new Response(Buffer.from("archive"), {
        status: 200,
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="${name}.tar.gz"`,
        },
      });
    },
  };
  const baseUrl = await startServer(t, { sessionHistoryClient });

  const list = await fetch(
    `${baseUrl}/api/session-history?source=shared&state=active&q=demo&range=week&limit=25&offset=0`,
  );
  assert.equal(list.status, 200);
  assert.equal(calls[0].options.startAt > 0, true);
  const invalidRange = await fetch(
    `${baseUrl}/api/session-history?source=shared&range=year`,
  );
  assert.equal(invalidRange.status, 400);
  const detail = await fetch(
    `${baseUrl}/api/session-history/shared/active/demo-session`,
  );
  assert.equal(detail.status, 200);
  const archive = await fetch(
    `${baseUrl}/api/session-history/shared/active/demo-session/archive`,
  );
  assert.equal(await archive.text(), "archive");

  const denied = await fetch(
    `${baseUrl}/api/session-history/shared/active/demo-session`,
    { method: "DELETE" },
  );
  assert.equal(denied.status, 403);

  const directlyPurged = await fetch(
    `${baseUrl}/api/session-history/shared/active/direct-session/purge`,
    {
      method: "DELETE",
      headers: { "x-portal-action": "session-history" },
    },
  );
  assert.equal(directlyPurged.status, 200);

  const batch = await fetch(`${baseUrl}/api/session-history/batch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-portal-action": "session-history",
    },
    body: JSON.stringify({
      action: "purge",
      items: [
        {
          sourceId: "shared",
          state: "active",
          sessionName: "batch-active",
        },
        {
          sourceId: "shared",
          state: "trash",
          sessionName: "batch-trash",
        },
      ],
    }),
  });
  assert.equal(batch.status, 200);
  assert.equal((await batch.json()).succeeded, 2);

  const renamed = await fetch(
    `${baseUrl}/api/session-history/shared/active/demo-session/rename`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-portal-action": "session-history",
      },
      body: JSON.stringify({ newName: "renamed-session" }),
    },
  );
  assert.equal(renamed.status, 200);
  const trashed = await fetch(
    `${baseUrl}/api/session-history/shared/active/renamed-session`,
    {
      method: "DELETE",
      headers: { "x-portal-action": "session-history" },
    },
  );
  assert.equal(trashed.status, 200);
  const restored = await fetch(
    `${baseUrl}/api/session-history/shared/trash/renamed-session/restore`,
    {
      method: "POST",
      headers: { "x-portal-action": "session-history" },
    },
  );
  assert.equal(restored.status, 200);
  const purged = await fetch(
    `${baseUrl}/api/session-history/shared/trash/renamed-session`,
    {
      method: "DELETE",
      headers: { "x-portal-action": "session-history" },
    },
  );
  assert.equal(purged.status, 200);

  assert.deepEqual(calls.slice(0, 3).map((call) => call.action), [
    "list",
    "detail",
    "archive",
  ]);
  assert.equal(calls.filter((call) => call.action === "purge").length, 4);
  assert.deepEqual(
    calls
      .filter((call) => call.action === "purge")
      .map((call) => [call.state, call.name]),
    [
      ["active", "direct-session"],
      ["active", "batch-active"],
      ["trash", "batch-trash"],
      ["trash", "renamed-session"],
    ],
  );
});

test("node session upload API requires the session-history action marker", async (t) => {
  const uploads = [];
  const sessionHistoryHub = {
    setConfig() {},
    async upload(source, state, sessionName) {
      uploads.push({ source, state, sessionName });
      return {
        ok: true,
        sharedName: `${source}_${sessionName}`,
      };
    },
  };
  const baseUrl = await startServer(t, { sessionHistoryHub });
  const path = `${baseUrl}/api/session-history/jpe2/archived/node-session/upload`;

  const denied = await fetch(path, { method: "POST" });
  assert.equal(denied.status, 403);
  assert.equal(uploads.length, 0);

  const allowed = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-portal-action": "session-history",
    },
    body: "{}",
  });
  assert.equal(allowed.status, 201);
  assert.deepEqual(uploads, [
    {
      source: "jpe2",
      state: "archived",
      sessionName: "node-session",
    },
  ]);
});

test("management config accepts only the supported transport and updater combinations", () => {
  const config = validateConfig({
    nodes: [
      {
        id: "remote",
        name: "Remote",
        endpoint: "https://remote.test/usage",
        management: {
          transport: "ssh",
          sshHost: "remote-alias",
          runtimeBin: "/home/user/.local/bin",
          copilotApi: "systemd-user",
          codexCli: "npm-global",
        },
      },
    ],
  });
  assert.equal(config.nodes[0].management.sshHost, "remote-alias");
  assert.throws(
    () => validateConfig({
      nodes: [
        {
          id: "bad",
          name: "Bad",
          endpoint: "https://bad.test/usage",
          management: {
            transport: "ssh",
            sshHost: "bad;command",
            runtimeBin: "/usr/bin",
            copilotApi: "systemd-user",
            codexCli: "npm-global",
          },
        },
      ],
    }),
    /invalid sshHost/,
  );
  // These key files live on the portal host, not on the remote Windows node.
  // Use the host OS's absolute path syntax so this fixture also runs on Linux.
  const keyRoot = path.join(tmpdir(), "codey-management-fixture");
  const windows = validateConfig({
    nodes: [
      {
        id: "windows",
        name: "Windows",
        endpoint: "https://windows.test/usage",
        apiKeyFile: path.join(keyRoot, "windows.api.key"),
        management: {
          transport: "windows-ssh",
          sshHost: "windows-alias",
          sessionApiKeyFile: path.join(keyRoot, "windows.session.key"),
          copilotApi: "windows-startup",
          codexCli: "desktop-managed",
        },
      },
    ],
  });
  assert.equal(windows.nodes[0].management.transport, "windows-ssh");
  assert.equal(windows.nodes[0].apiKeyFile, path.join(keyRoot, "windows.api.key"));
  assert.throws(
    () => validateConfig({ nodes: [{ ...windows.nodes[0], apiKeyFile: "relative.key" }] }),
    /apiKeyFile must be absolute/,
  );
});

test("client nodes are normalized and reject duplicate ids", () => {
  const config = validateConfig({
    clientNodes: [
      {
        id: "local",
        name: "Local",
        endpoint: "http://127.0.0.1:4242/usage",
      },
    ],
    nodes: [],
  });
  assert.equal(config.clientNodes[0].endpoint, "http://127.0.0.1:4242/usage");
  assert.throws(
    () =>
      validateConfig({
        clientNodes: [
          {
            id: "duplicate",
            name: "One",
            endpoint: "https://one.example.test/usage",
          },
          {
            id: "duplicate",
            name: "Two",
            endpoint: "https://two.example.test/usage",
          },
        ],
        nodes: [],
      }),
    /Duplicate client node id/,
  );
});
