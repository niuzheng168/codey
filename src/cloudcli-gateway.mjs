import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { issueWorkspaceAssertion } from "./workspace-sso.mjs";
import { nodeTlsOptions } from "./machine-identity.mjs";
import { DevTunnelTransport, normalizeDevTunnel } from "./devtunnel-transport.mjs";

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function sendProxyError(res, statusCode, message) {
  if (res.destroyed) return;
  const body = Buffer.from(JSON.stringify({ error: message }));
  if (!res.headersSent) {
    res.writeHead(statusCode, {
      "cache-control": "no-store",
      "content-length": body.length,
      "content-type": "application/json; charset=utf-8",
    });
  }
  res.end(body);
}

function closeUpgradeSocket(socket, statusCode, label) {
  if (socket.destroyed) return;
  const body = Buffer.from(label);
  socket.end(
    `HTTP/1.1 ${statusCode} ${label}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n\r\n` +
      body,
  );
}

function requestTransport(url) {
  return url.protocol === "https:" ? https : http;
}

function forwardedRequestHeaders(req, node, { websocket = false, ssoMaster, target } = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      normalized === "host" ||
      normalized === "cookie" ||
      normalized.startsWith("x-codey-") ||
      normalized.startsWith("x-ms-client-principal") ||
      normalized.startsWith("x-forwarded-") ||
      normalized === "forwarded" ||
      (ssoMaster && normalized === "authorization") ||
      (!websocket && HOP_BY_HOP_HEADERS.has(normalized))
    ) {
      continue;
    }
    headers[name] = value;
  }
  headers.host = node.upstream.host;
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-forwarded-prefix"] = node.basePath;
  headers["x-forwarded-proto"] =
    "https";
  if (ssoMaster) {
    headers["x-codey-workspace-assertion"] = issueWorkspaceAssertion({
      master: ssoMaster,
      nodeId: node.id,
      principal: req.codeyPrincipal,
      method: req.method,
      target,
    });
  }
  return headers;
}

function forwardedResponseHeaders(headers, node, ssoEnabled = false) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase()) ||
        (ssoEnabled && ["set-cookie", "x-refreshed-token"].includes(name.toLowerCase()))) {
      continue;
    }
    if (name.toLowerCase() === "location") {
      result[name] = rewriteLocation(value, node);
      continue;
    }
    if (name.toLowerCase() === "set-cookie") {
      const values = Array.isArray(value) ? value : [value];
      result[name] = values.map((entry) =>
        String(entry).replace(
          /;\s*Path=\/(?=;|$)/i,
          `; Path=${node.basePath}/`,
        ),
      );
      continue;
    }
    result[name] = value;
  }
  if (ssoEnabled) {
    result["cache-control"] = "private, no-store";
    result["referrer-policy"] = "no-referrer";
    result["x-content-type-options"] = "nosniff";
    result["x-frame-options"] = "SAMEORIGIN";
  }
  return result;
}

function rewriteLocation(value, node) {
  const location = String(value ?? "");
  if (location.startsWith("/")) {
    return `${node.basePath}${location}`;
  }
  try {
    const parsed = new URL(location);
    if (parsed.origin !== node.upstream.origin) return location;
    return `${node.basePath}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return location;
  }
}

function normalizeNode(raw, seen) {
  const id = String(raw?.id ?? "").trim();
  if (!NODE_ID_PATTERN.test(id)) {
    throw new Error(`CloudCLI node id is invalid: ${id || "<empty>"}`);
  }
  if (seen.has(id)) throw new Error(`CloudCLI node id is duplicated: ${id}`);
  seen.add(id);

  let upstream;
  try {
    upstream = new URL(String(raw?.upstream ?? "").trim());
  } catch {
    throw new Error(`CloudCLI upstream is invalid for node ${id}`);
  }
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    !["", "/"].includes(upstream.pathname)
  ) {
    throw new Error(
      `CloudCLI upstream for node ${id} must be an http(s) origin without credentials or a path`,
    );
  }
  upstream.pathname = "/";
  const tlsServerName = String(raw?.tlsServerName ?? "").trim();
  if (tlsServerName && !/^(?=.{1,253}$)[a-z0-9.-]+$/i.test(tlsServerName)) {
    throw new Error(`Invalid TLS server name for node ${id}`);
  }
  const fingerprint = String(raw?.fingerprint ?? "").trim().toUpperCase();
  if (fingerprint && !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(fingerprint)) {
    throw new Error(`Invalid TLS certificate fingerprint for node ${id}`);
  }
  const devTunnel = normalizeDevTunnel(raw?.devTunnel, { upstream, tlsServerName, fingerprint });

  return Object.freeze({
    basePath: `/cloudcli/${id}`,
    id,
    name: String(raw?.name ?? id).trim().slice(0, 80) || id,
    region: String(raw?.region ?? "Private VNet").trim().slice(0, 80),
    upstream,
    tlsServerName,
    fingerprint,
    devTunnel,
  });
}

export function resolveCloudCliGatewayConfig(
  environment = process.env,
  readFileImpl = readFileSync,
) {
  const configPath = String(environment.PORTAL_CLOUDCLI_CONFIG ?? "").trim();
  if (!configPath) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileImpl(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load PORTAL_CLOUDCLI_CONFIG: ${error.message}`);
  }
  if (!Array.isArray(parsed?.nodes)) {
    throw new Error("PORTAL_CLOUDCLI_CONFIG must contain a nodes array");
  }
  const seen = new Set();
  const nodes = parsed.nodes.map((node) => normalizeNode(node, seen));
  const ssoMaster = environment.PORTAL_WORKSPACE_SSO_MASTER || "";
  if (ssoMaster && nodes.some((node) => node.upstream.protocol !== "https:")) {
    throw new Error("Password-authenticated Workspaces require HTTPS upstreams");
  }
  if (!ssoMaster && nodes.some(node => node.devTunnel)) {
    throw new Error("Dev Tunnel Workspaces require node-bound portal SSO");
  }
  const ca = nodes.some((node) => node.tlsServerName)
    ? readFileImpl(environment.PORTAL_CLOUDCLI_CA_FILE || path.join(path.dirname(configPath), "codey-node-ca.pem"), "utf8")
    : undefined;
  return Object.freeze({
    ssoMaster, ca,
    nodes: Object.freeze(nodes),
  });
}

export class CloudCliGateway {
  constructor(config, { sessionAuthenticator, nodePolicy, accessLeaseMs = 5000, ui,
    tunnelTransportFactory = (node, ca) => new DevTunnelTransport(node.devTunnel, nodeTlsOptions(node, ca)),
  } = {}) {
    this.config = config;
    this.sessionAuthenticator = sessionAuthenticator;
    this.nodePolicy = nodePolicy;
    this.accessLeaseMs = accessLeaseMs;
    this.ui = ui;
    this.machineNodes = [];
    this.tunnelTransports = new Map();
    this.tunnelTransportFactory = tunnelTransportFactory;
    if (config.ssoMaster && !sessionAuthenticator) {
      throw new Error("Workspace SSO requires revocable portal authentication");
    }
  }

  setMachineNodes(nodes) {
    const staticIds = new Set(this.config.nodes.map((node) => node.id));
    if (nodes.some((node) => staticIds.has(node.id))) throw new Error("Prepared machine conflicts with a static Workspace");
    this.machineNodes = nodes;
  }

  allNodes() {
    return [...this.config.nodes, ...this.machineNodes];
  }

  upstreamOptions(node) {
    const options = nodeTlsOptions(node, this.config.ca);
    if (node.devTunnel) {
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

  publicNodes(allowedNodeIds) {
    const allowed = new Set(allowedNodeIds);
    return this.allNodes()
      .filter((node) => allowed.has(node.id))
      .map((node) => ({
        id: node.id,
        name: node.name,
        path: `${node.basePath}/`,
        region: node.region,
      }));
  }

  match(pathname) {
    return (
      this.allNodes().find(
        (node) =>
          pathname === node.basePath || pathname.startsWith(`${node.basePath}/`),
      ) ?? null
    );
  }

  handles(pathname) {
    return Boolean(this.match(pathname));
  }

  trackAccess(principal, nodeId, close) {
    const sessionCleanup = this.sessionAuthenticator?.track(principal, close) ?? (() => {});
    if (!this.nodePolicy) return sessionCleanup;
    let finished = false;
    const timer = setInterval(() => {
      this.nodePolicy.canAccess(principal.id, nodeId)
        .then((allowed) => { if (!allowed && !finished) { cleanup(); close(); } })
        .catch(() => { if (!finished) { cleanup(); close(); } });
    }, this.accessLeaseMs);
    timer.unref?.();
    const cleanup = () => {
      finished = true;
      clearInterval(timer);
      sessionCleanup();
    };
    return cleanup;
  }

  async proxyHttp(req, res, allowedNodeIds) {
    await this.refreshMachines?.();
    const requestUrl = new URL(req.url ?? "/", "http://codey.local");
    const node = this.match(requestUrl.pathname);
    if (!node) return false;
    if (!new Set(allowedNodeIds).has(node.id)) {
      sendProxyError(res, 403, "This CloudCLI node is not assigned to the current user");
      return true;
    }
    if (this.nodePolicy && !(await this.nodePolicy.canAccess(req.codeyPrincipal.id, node.id))) {
      sendProxyError(res, 403, "This CloudCLI node is not assigned to the current user");
      return true;
    }
    if (requestUrl.pathname === node.basePath) {
      res.writeHead(308, {
        "cache-control": "no-store",
        location: `${node.basePath}/${requestUrl.search}`,
      });
      res.end();
      return true;
    }
    // Share static UI only after the same ownership checks as an upstream request.
    // All API/SSE/plugin routes and legacy /assets requests continue to the VM.
    if (this.ui && await this.ui.handleWorkspace(req, res, node)) return true;

    const target = new URL(node.upstream);
    target.pathname = requestUrl.pathname.slice(node.basePath.length) || "/";
    target.search = requestUrl.search;
    if (this.config.ssoMaster) target.searchParams.delete("token");

    await new Promise((resolve) => {
      const upstreamRequest = requestTransport(target).request(
        target,
        {
          headers: forwardedRequestHeaders(req, node, { ssoMaster: this.config.ssoMaster, target }),
          method: req.method,
          ...this.upstreamOptions(node),
        },
        (upstreamResponse) => {
          res.writeHead(
            upstreamResponse.statusCode ?? 502,
            forwardedResponseHeaders(upstreamResponse.headers, node, Boolean(this.config.ssoMaster)),
          );
          upstreamResponse.pipe(res);
          upstreamResponse.once("end", () => { cleanup(); resolve(); });
        },
      );
      const cleanup = this.trackAccess(req.codeyPrincipal, node.id, () => {
        upstreamRequest.destroy();
        res.destroy();
        resolve();
      });
      res.once("close", () => {
        cleanup();
        upstreamRequest.destroy();
        resolve();
      });
      upstreamRequest.once("error", (error) => {
        cleanup();
        sendProxyError(res, 502, node.devTunnel
          ? `CloudCLI node ${node.id} is unavailable; check the tunnel host and connect-token expiry`
          : `CloudCLI node ${node.id} is unavailable: ${error.message}`);
        resolve();
      });
      req.pipe(upstreamRequest);
    });
    return true;
  }

  attach(server, authorizeNode) {
    server.once("close", () => { void this.close(); });
    server.on("upgrade", async (req, socket, head) => {
      if (this.sessionAuthenticator) {
        try {
          const principal = await this.sessionAuthenticator.principal(req);
          if (!principal) { closeUpgradeSocket(socket, 401, "Unauthorized"); return; }
          if (!this.sessionAuthenticator.sameOrigin(req)) { closeUpgradeSocket(socket, 403, "Forbidden"); return; }
          req.codeyPrincipal = principal;
        } catch { closeUpgradeSocket(socket, 401, "Unauthorized"); return; }
      }
      let requestUrl;
      try {
        await this.refreshMachines?.();
        requestUrl = new URL(req.url ?? "/", "http://codey.local");
      } catch {
        closeUpgradeSocket(socket, 400, "Bad Request");
        return;
      }
      const node = this.match(requestUrl.pathname);
      if (!node) {
        closeUpgradeSocket(socket, 404, "Not Found");
        return;
      }
      try {
        if (!(await authorizeNode(req, node.id))) {
          closeUpgradeSocket(socket, 403, "Forbidden");
          return;
        }
      } catch {
        closeUpgradeSocket(socket, 401, "Unauthorized");
        return;
      }

      const target = new URL(node.upstream);
      target.pathname = requestUrl.pathname.slice(node.basePath.length) || "/";
      target.search = requestUrl.search;
      if (this.config.ssoMaster) target.searchParams.delete("token");
      const upstreamRequest = requestTransport(target).request(target, {
        headers: forwardedRequestHeaders(req, node, { websocket: true, ssoMaster: this.config.ssoMaster, target }),
        method: req.method,
        ...this.upstreamOptions(node),
      });

      let peer;
      const cleanup = this.trackAccess(req.codeyPrincipal, node.id, () => {
        peer?.destroy();
        upstreamRequest.destroy();
        socket.destroy();
      });
      socket.once("close", () => { cleanup(); peer?.destroy(); upstreamRequest.destroy(); });
      upstreamRequest.once("upgrade", (response, upstreamSocket, upstreamHead) => {
        peer = upstreamSocket;
        upstreamSocket.once("close", () => { cleanup(); socket.destroy(); });
        upstreamSocket.on("error", () => socket.destroy());
        socket.on("error", () => upstreamSocket.destroy());
        const responseHeaders = response.rawHeaders
          .reduce((lines, value, index, values) => {
            if (index % 2 === 0) lines.push(`${value}: ${values[index + 1]}`);
            return lines;
          }, [])
          .join("\r\n");
        socket.write(
          `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n${responseHeaders}\r\n\r\n`,
        );
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        socket.pipe(upstreamSocket).pipe(socket);
      });
      upstreamRequest.once("response", (response) => {
        cleanup();
        response.resume();
        closeUpgradeSocket(
          socket,
          response.statusCode ?? 502,
          response.statusMessage || "WebSocket upgrade failed",
        );
      });
      upstreamRequest.once("error", () => {
        cleanup();
        closeUpgradeSocket(socket, 502, "CloudCLI WebSocket unavailable");
      });
      upstreamRequest.end();
    });
  }
}

export function createCloudCliGateway(config, options) {
  return config ? new CloudCliGateway(config, options) : null;
}
