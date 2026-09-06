import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
  CloudCliGateway,
  resolveCloudCliGatewayConfig,
} from "../src/cloudcli-gateway.mjs";

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
  });
}

test("CloudCLI config validates private upstream origins", () => {
  const config = resolveCloudCliGatewayConfig(
    { PORTAL_CLOUDCLI_CONFIG: "config.json" },
    () =>
      JSON.stringify({
        nodes: [
          {
            id: "zhn-a100",
            name: "ZHN A100",
            region: "Japan East",
            upstream: "http://10.0.0.7:3001",
          },
        ],
      }),
  );
  assert.equal(config.nodes[0].basePath, "/cloudcli/zhn-a100");
  assert.equal(config.nodes[0].upstream.href, "http://10.0.0.7:3001/");

  assert.throws(
    () =>
      resolveCloudCliGatewayConfig(
        { PORTAL_CLOUDCLI_CONFIG: "config.json" },
        () =>
          JSON.stringify({
            nodes: [
              {
                id: "bad/id",
                upstream: "http://user:secret@example.test/path",
              },
            ],
          }),
      ),
    /node id is invalid/,
  );
});

test("ACA CloudCLI example uses private HTTPS and filters each user's nodes without production configuration", () => {
  const config = resolveCloudCliGatewayConfig(
    {
      PORTAL_CLOUDCLI_CONFIG: fileURLToPath(
        new URL("../config/cloudcli-nodes.aca.example.json", import.meta.url),
      ),
    },
    (file, encoding) => file.endsWith(".pem")
      ? "test-only-public-ca"
      : readFileSync(file, encoding),
  );
  assert.deepEqual(
    Object.fromEntries(config.nodes.map((node) => [node.id, node.upstream.href])),
    {
      "example-node": "https://10.42.0.4:3001/",
    },
  );

  const gateway = new CloudCliGateway(config);
  assert.equal(config.ca, "test-only-public-ca");
  assert.equal(config.nodes[0].tlsServerName, "node.example.test");
  assert.deepEqual(gateway.publicNodes([]), []);
  const assignedNodes = gateway.publicNodes(["example-node", "local", "unassigned-node"]);
  assert.deepEqual(assignedNodes.map((node) => node.id), ["example-node"]);
  assert.equal(assignedNodes[0].path, "/cloudcli/example-node/");
  assert.equal("upstream" in assignedNodes[0], false);
  for (const node of config.nodes) {
    assert.equal(gateway.match(`/cloudcli/${node.id}/api/auth/status`).id, node.id);
    assert.equal(gateway.match(`/cloudcli/${node.id}-other/api/auth/status`), null);
  }
});

test("CloudCLI HTTP proxy strips the node prefix and does not forward portal cookies", async (t) => {
  let observed;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = {
      body: Buffer.concat(chunks).toString("utf8"),
      cookie: req.headers.cookie,
      forwardedPrefix: req.headers["x-forwarded-prefix"],
      url: req.url,
    };
    res.writeHead(201, {
      "content-type": "application/json",
      location: "/session/abc",
      "set-cookie": "cloudcli=test; Path=/; HttpOnly",
    });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());

  const gateway = new CloudCliGateway({
    nodes: [
      {
        basePath: "/cloudcli/zhn-a100",
        id: "zhn-a100",
        name: "ZHN A100",
        region: "Japan East",
        upstream: new URL(upstreamUrl),
      },
    ],
  });
  let allowedNodeIds = [];
  const portal = http.createServer((req, res) => {
    gateway.proxyHttp(req, res, allowedNodeIds);
  });
  const portalUrl = await listen(portal);
  t.after(() => portal.close());

  const denied = await fetch(`${portalUrl}/cloudcli/zhn-a100/api/auth/status`);
  assert.equal(denied.status, 403);
  assert.equal(observed, undefined);

  allowedNodeIds = ["zhn-a100"];
  const response = await fetch(
    `${portalUrl}/cloudcli/zhn-a100/api/auth/login?source=codey`,
    {
      body: "payload",
      headers: { cookie: "codey_portal_session=secret" },
      method: "POST",
      redirect: "manual",
    },
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("location"), "/cloudcli/zhn-a100/session/abc");
  assert.match(
    response.headers.get("set-cookie"),
    /Path=\/cloudcli\/zhn-a100\//,
  );
  assert.deepEqual(observed, {
    body: "payload",
    cookie: undefined,
    forwardedPrefix: "/cloudcli/zhn-a100",
    url: "/api/auth/login?source=codey",
  });
});

test("CloudCLI WebSocket proxy authorizes the node and tunnels the upgrade", async (t) => {
  let upstreamPeer;
  const upstream = http.createServer();
  upstream.on("upgrade", (req, socket) => {
    upstreamPeer = socket;
    assert.equal(req.url, "/ws?token=test");
    assert.equal(req.headers.cookie, undefined);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n\r\n" +
        "UPSTREAM_READY",
    );
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());

  const gateway = new CloudCliGateway({
    nodes: [
      {
        basePath: "/cloudcli/zhn-a100",
        id: "zhn-a100",
        name: "ZHN A100",
        region: "Japan East",
        upstream: new URL(upstreamUrl),
      },
    ],
  });
  const portal = http.createServer();
  gateway.attach(portal, async (_req, nodeId) => nodeId === "zhn-a100");
  await listen(portal);
  t.after(() => portal.close());
  const address = portal.address();

  const socket = net.connect(address.port, "127.0.0.1");
  t.after(() => socket.destroy());
  socket.write(
    "GET /cloudcli/zhn-a100/ws?token=test HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${address.port}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Cookie: codey_portal_session=secret\r\n\r\n",
  );

  let received = "";
  for await (const chunk of socket) {
    received += chunk.toString("utf8");
    if (received.includes("UPSTREAM_READY")) break;
  }
  assert.match(received, /101 Switching Protocols/);
  assert.match(received, /UPSTREAM_READY/);
  socket.destroy();
  upstreamPeer?.destroy();
});
