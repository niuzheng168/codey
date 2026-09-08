import { readFileSync } from "node:fs";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { issueClientTicket } from "./client-ticket.mjs";
import { nodeTlsOptions } from "./machine-identity.mjs";
import { DevTunnelTransport } from "./devtunnel-transport.mjs";

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const USAGE_PATHS = new Set([
  "/usage",
  "/token-usage",
  "/token-usage/daily",
  "/token-usage/events",
]);
const HISTORY_DETAIL = /^\/session-history\/(active|archived)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function privateIpv4(hostname) {
  if (isIP(hostname) !== 4) return false;
  const [a, b] = hostname.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function normalizeNode(raw, seen) {
  const id = String(raw?.id ?? "");
  if (!NODE_ID_PATTERN.test(id) || id === "local" || seen.has(id)) {
    throw new Error("Node data gateway requires unique, non-local node IDs");
  }
  seen.add(id);
  const upstream = new URL(String(raw.upstream ?? ""));
  if (
    upstream.protocol !== "https:" || !privateIpv4(upstream.hostname) ||
    upstream.username || upstream.password || upstream.search || upstream.hash ||
    upstream.pathname !== "/"
  ) {
    throw new Error(`Node data upstream for ${id} must be a private HTTPS origin`);
  }
  const tlsServerName = String(raw.tlsServerName ?? "");
  if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(tlsServerName) || isIP(tlsServerName)) {
    throw new Error(`Node data TLS hostname is required for ${id}`);
  }
  return Object.freeze({ id, upstream, tlsServerName });
}

export function resolveNodeDataGatewayConfig(environment = process.env, readFileImpl = readFileSync) {
  const configPath = String(environment.PORTAL_NODE_DATA_CONFIG ?? "").trim();
  if (!configPath) return null;
  const raw = JSON.parse(readFileImpl(configPath, "utf8"));
  if (!Array.isArray(raw?.nodes) || raw.nodes.length > 32) {
    throw new Error("PORTAL_NODE_DATA_CONFIG requires a nodes array of at most 32 entries");
  }
  const signingKey = String(environment.PORTAL_CLIENT_RELAY_SIGNING_KEY ?? "");
  if (signingKey.length < 32) throw new Error("Node data gateway signing key is not configured");
  const seen = new Set();
  return Object.freeze({
    nodes: Object.freeze(raw.nodes.map((node) => normalizeNode(node, seen))),
    signingKey,
    ca: readFileImpl(
      environment.PORTAL_NODE_DATA_CA_FILE || path.join(path.dirname(configPath), "codey-node-ca.pem"),
      "utf8",
    ),
  });
}

function requestScope(pathname) {
  if (USAGE_PATHS.has(pathname)) return "usage";
  if (pathname === "/session-history" || HISTORY_DETAIL.test(pathname)) return "history";
  return null;
}

function validQuery(pathname, params) {
  const allowed = new Set(
    pathname === "/session-history"
      ? ["state", "q", "limit", "offset", "start_at_ms"]
      : pathname === "/token-usage/events"
        ? ["period", "page", "page_size"]
        : ["/token-usage", "/token-usage/daily"].includes(pathname)
          ? ["period"]
          : [],
  );
  if (params.toString().length > 4096) return false;
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) return false;
  }
  return true;
}

function send(res, status, value, head = false) {
  if (res.destroyed) return;
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  res.end(head ? undefined : body);
}

// Only server-deployed private targets are accepted. A user's editable browser
// node URL, query string, Cookie, and Authorization never select an upstream.
export class NodeDataGateway {
  constructor(config, { requestImpl = https.request, timeoutMs = 15000, maxResponseBytes = MAX_RESPONSE_BYTES, nodePolicy,
    tunnelTransportFactory = (node, ca) => new DevTunnelTransport(node.devTunnel, nodeTlsOptions(node, ca),
      { getToken: node.getTunnelToken }) } = {}) {
    this.config = config;
    this.nodes = new Map(config.nodes.map((node) => [node.id, node]));
    this.requestImpl = requestImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.activeRequests = 0;
    this.nodePolicy = nodePolicy;
    this.tunnelTransportFactory = tunnelTransportFactory;
    this.tunnelTransports = new Map();
  }

  setMachineNodes(nodes) {
    const result = new Map(this.config.nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      if (result.has(node.id)) throw new Error("Prepared machine conflicts with a static gateway");
      result.set(node.id, node);
    }
    this.nodes = result;
  }

  upstreamOptions(node) {
    const options = nodeTlsOptions(node, this.config.ca);
    if (node.devTunnel) {
      if (typeof node.getTunnelToken !== "function") throw new Error("Missing node-scoped tunnel credential provider");
      if (!this.tunnelTransports.has(node.id)) {
        this.tunnelTransports.set(node.id, this.tunnelTransportFactory(node, this.config.ca));
      }
      options.agent = this.tunnelTransports.get(node.id).agent;
    }
    return options;
  }

  async close() {
    await Promise.allSettled([...this.tunnelTransports.values()].map(transport => transport.dispose()));
    this.tunnelTransports.clear();
  }

  endpoint(nodeId, allowedIds) {
    return this.nodes.has(nodeId) && allowedIds.includes(nodeId)
      ? `/api/node-data/${nodeId}/usage`
      : null;
  }

  async handle(req, res, allowedIds) {
    const url = new URL(req.url, "http://portal.local");
    if (!url.pathname.startsWith("/api/node-data/")) return false;
    const head = req.method === "HEAD";
    if (!req.codeyPrincipal?.id) {
      send(res, 401, { error: "需要登录" }, head);
      return true;
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      send(res, 405, { error: "Node data access is read-only" });
      return true;
    }
    const match = url.pathname.match(/^\/api\/node-data\/([a-z0-9][a-z0-9_-]{0,31})(\/.*)$/);
    const node = match && allowedIds.includes(match[1]) && this.nodes.get(match[1]);
    const scope = match && requestScope(match[2]);
    if (!node || !scope) {
      send(res, 404, { error: "Node data route is not available" }, head);
      return true;
    }
    if (!validQuery(match[2], url.searchParams)) {
      send(res, 400, { error: "Invalid node data query" }, head);
      return true;
    }
    if (this.activeRequests >= 64) {
      send(res, 429, { error: "Too many node data requests" }, head);
      return true;
    }
    const ticket = issueClientTicket({
      signingKey: this.nodePolicy
        ? await this.nodePolicy.keyFor(req.codeyPrincipal.id, node.id)
        : this.config.signingKey,
      nodeId: node.id,
      principalId: req.codeyPrincipal.id,
      scopes: [scope],
      ttlSeconds: 60,
    });
    const target = new URL(node.upstream);
    target.pathname = match[2];
    target.search = url.search;
    this.activeRequests++;
    try {
      const body = await this.read(target, node, ticket.token, res);
      send(res, 200, body, head);
    } catch (error) {
      const status = error.code === "ETIMEDOUT" ? 504 : error.code === "NOT_FOUND" ? 404 : 502;
      const message = status === 504
        ? "ACA 连接节点超时"
        : status === 404 ? "节点数据不存在" : "ACA 无法读取节点数据";
      send(res, status, { error: message }, head);
    } finally {
      this.activeRequests--;
    }
    return true;
  }

  read(target, node, ticket, downstream) {
    return new Promise((resolve, reject) => {
      let request;
      let finished = false;
      const finish = (error, body) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        downstream.off("close", disconnected);
        if (error) {
          request?.destroy();
          reject(error);
        } else {
          resolve(body);
        }
      };
      const disconnected = () => finish(new Error("Client disconnected"));
      const timer = setTimeout(
        () => finish(Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" })),
        this.timeoutMs,
      );
      timer.unref?.();
      downstream.once("close", disconnected);
      try {
        request = this.requestImpl(target, {
          method: "GET",
          ...this.upstreamOptions(node),
          headers: { accept: "application/json", authorization: `Bearer ${ticket}` },
        }, (response) => {
          response.on("error", finish);
          if (response.statusCode !== 200 ||
              !/^application\/json(?:;|$)/i.test(String(response.headers["content-type"] ?? ""))) {
            response.resume();
            finish(Object.assign(new Error("Invalid upstream response"), {
              code: response.statusCode === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR",
            }));
            return;
          }
          if (Number(response.headers["content-length"]) > this.maxResponseBytes) {
            finish(new Error("Upstream response too large"));
            return;
          }
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > this.maxResponseBytes) finish(new Error("Upstream response too large"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            if (finished) return;
            try {
              const body = Buffer.concat(chunks);
              JSON.parse(body.toString("utf8"));
              finish(null, body);
            } catch (error) { finish(error); }
          });
        });
        request.on("error", finish);
        request.end();
      } catch (error) { finish(error); }
    });
  }
}
