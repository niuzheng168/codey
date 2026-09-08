import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { UsageAggregator } from "./aggregator.mjs";
import { ArtifactCatalog } from "./artifact-catalog.mjs";
import { loadConfig, PROJECT_ROOT, saveConfig, validateConfig } from "./config.mjs";
import { normalizePeriod } from "./metrics.mjs";
import { NodeManager } from "./node-manager.mjs";
import { NodeProvisioner } from "./provisioner.mjs";
import { SessionHistoryClient } from "./session-history-client.mjs";
import { SessionHistoryHub } from "./session-history-hub.mjs";
import { UserConfigStore } from "./user-config-store.mjs";
import { AadAuthenticator } from "./aad-auth.mjs";
import { PasswordAuthenticator } from "./password-auth.mjs";
import { issueClientTicket } from "./client-ticket.mjs";
import { NodeDataGateway, resolveNodeDataGatewayConfig } from "./node-data-gateway.mjs";
import { AccountStore } from "./account-store.mjs";
import { NodePolicy } from "./node-policy.mjs";
import { SettingsApi } from "./settings-api.mjs";
import { MachineSetup } from "./machine-setup.mjs";
import { MachineUpdates } from "./machine-updates.mjs";
import { VoiceService, resolveVoiceServiceConfig } from "./voice-service.mjs";
import { VoiceGateway } from "./voice-gateway.mjs";
import { VoiceRewriteService, resolveVoiceRewriteConfig } from "./voice-rewrite-service.mjs";
import { ComposerCompletionService, resolveComposerCompletionConfig } from "./composer-completion-service.mjs";
import { ComposerCompletionGateway } from "./composer-completion-gateway.mjs";
import { CloudCliUi } from "./cloudcli-ui.mjs";
import {
  createCloudCliGateway,
  resolveCloudCliGatewayConfig,
} from "./cloudcli-gateway.mjs";

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/client-aggregator.js", ["client-aggregator.js", "text/javascript; charset=utf-8"]],
  ["/client-history.js", ["client-history.js", "text/javascript; charset=utf-8"]],
  ["/node-transport.js", ["node-transport.js", "text/javascript; charset=utf-8"]],
  ["/portal-features.js", ["portal-features.js", "text/javascript; charset=utf-8"]],
  ["/settings", ["settings.html", "text/html; charset=utf-8"]],
  ["/settings.js", ["settings.js", "text/javascript; charset=utf-8"]],
  ["/admin-nodes.js", ["admin-nodes.js", "text/javascript; charset=utf-8"]],
  ["/machine-updates.js", ["machine-updates.js", "text/javascript; charset=utf-8"]],
  ["/settings.css", ["settings.css", "text/css; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/portal-session.js", ["portal-session.js", "text/javascript; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

const SKILL_DOWNLOADS = new Map([
  ["/downloads/codey-node-onboarding.zip", ["codey-node-onboarding.zip", "application/zip"]],
  ["/downloads/codey-node-onboarding.sha256", ["codey-node-onboarding.sha256", "text/plain; charset=utf-8"]],
]);

const SECURITY_HEADERS = Object.freeze({
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});
const MCP_PROXY_PATHS = [
  "/mcp",
  "/.well-known/",
  "/authorize",
  "/token",
  "/register",
  "/auth/",
  "/v1/",
  "/healthz",
  "/readyz",
];

function send(res, statusCode, body, contentType, extraHeaders = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    ...(res.codeyContentPolicy ? { "content-security-policy": res.codeyContentPolicy } : {}),
    "cache-control": "no-store",
    "content-type": contentType,
    "content-length": payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}

function sendJson(res, statusCode, value) {
  send(res, statusCode, JSON.stringify(value), "application/json; charset=utf-8");
}

async function latestArtifact(catalog) {
  const scan = await catalog.scan();
  const selected = scan.artifacts[0];
  if (!selected) {
    const error = new Error("没有可下载的有效 Copilot API 构建");
    error.status = 404;
    error.expose = true;
    throw error;
  }
  return catalog.resolve(selected.id);
}

function renderInstaller(source, artifact, packageBody) {
  const packageBase64 =
    packageBody
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\n") ?? "";
  return source
    .replaceAll("__PORTAL_PACKAGE_FILE__", artifact.fileName)
    .replaceAll("__PORTAL_PACKAGE_SHA256__", artifact.sha256)
    .replaceAll("__PORTAL_PACKAGE_BASE64__", packageBase64);
}

async function streamUpstreamFile(res, response) {
  const contentLength = response.headers.get("content-length");
  const contentDisposition = response.headers.get("content-disposition");
  res.writeHead(response.status, {
    ...SECURITY_HEADERS,
    "cache-control": "private, no-store",
    "content-type": response.headers.get("content-type") || "application/gzip",
    ...(contentLength ? { "content-length": contentLength } : {}),
    ...(contentDisposition ? { "content-disposition": contentDisposition } : {}),
  });
  if (!response.body) {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (!res.destroyed) res.destroy(error);
  }
}

function isMcpProxyPath(pathname) {
  return MCP_PROXY_PATHS.some((prefix) =>
    prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix,
  );
}

function proxyMcpRequest(req, res, baseUrl) {
  return new Promise((resolve) => {
    const incoming = new URL(req.url ?? "/", "http://portal.invalid");
    const target = new URL(baseUrl);
    // Never let absolute-form or scheme-relative request URLs change upstream.
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const headers = { ...req.headers };
    headers.host = target.host;
    headers["x-forwarded-host"] = req.headers.host ?? "";
    headers["x-forwarded-proto"] = "https";
    delete headers.connection;
    delete headers.cookie;
    for (const key of Object.keys(headers)) {
      if (key.startsWith("x-codey-") || key.startsWith("x-ms-client-principal")) delete headers[key];
    }
    const upstream = http.request(
      target,
      {
        method: req.method,
        headers,
      },
      (response) => {
        const responseHeaders = { ...response.headers };
        delete responseHeaders.connection;
        res.writeHead(response.statusCode ?? 502, responseHeaders);
        response.pipe(res);
        response.once("end", resolve);
      },
    );
    upstream.once("error", (error) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: `MCP upstream unavailable: ${error.message}` });
      } else {
        res.destroy(error);
      }
      resolve();
    });
    req.pipe(upstream);
  });
}

function safeEqual(left, right) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function authorized(req, auth, allowedPrincipalId, pathname) {
  if (allowedPrincipalId) {
    if (pathname === "/api/health") return true;
    const principalId = String(req.headers["x-ms-client-principal-id"] ?? "")
      .trim()
      .toLowerCase();
    return principalId && safeEqual(principalId, allowedPrincipalId.toLowerCase());
  }
  if (!auth?.password) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return (
    safeEqual(decoded.slice(0, separator), auth.username) &&
    safeEqual(decoded.slice(separator + 1), auth.password)
  );
}

function parseNodeIds(value) {
  if (!value) return [];
  return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
}

function actionRequestAllowed(req, action) {
  if (req.headers["x-portal-action"] !== action) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json");
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    throw error;
  }
}

export function createPortalServer(options) {
  let activeConfig = options.config;
  const ownsAggregator = !options.aggregator;
  let aggregator =
    options.aggregator ??
    new UsageAggregator(activeConfig, { fetchImpl: options.fetchImpl, env: options.env });
  const staticRoot = options.staticRoot ?? path.join(PROJECT_ROOT, "public");
  const auth = options.auth ?? null;
  const allowedPrincipalId = String(options.allowedPrincipalId ?? "").trim();
  const readOnly = Boolean(options.readOnly);
  const clientOnly = Boolean(options.clientOnly);
  const clientPrincipalId = String(options.clientPrincipalId ?? "local").trim();
  const clientRelaySigningKey = String(options.clientRelaySigningKey ?? "");
  const clientTicketTtlSeconds = Number(options.clientTicketTtlSeconds ?? 600);
  const portalName = String(options.portalName || "Codex Usage Portal").slice(0, 80);
  const mcpProxyUrl = String(options.mcpProxyUrl ?? "").trim();
  const cloudCliGateway = options.cloudCliGateway ?? null;
  const cloudCliUi = options.cloudCliUi ?? null;
  const nodeDataGateway = options.nodeDataGateway ?? null;
  const voiceGateway = options.voiceGateway ?? null;
  const composerCompletionGateway = options.composerCompletionGateway ?? null;
  const nodePolicy = options.nodePolicy ?? null;
  const artifactCatalog =
    options.artifactCatalog ??
    new ArtifactCatalog(
      options.artifactsRoot ??
        process.env.COPILOT_ARTIFACTS_DIR ??
        path.join(PROJECT_ROOT, "copilot-api-artifacts"),
    );
  const manager =
    options.manager ??
    new NodeManager(activeConfig, {
      artifactCatalog,
      fetchImpl: options.fetchImpl,
    });
  const sharedSessionHistoryClient =
    options.sessionHistoryClient ??
    new SessionHistoryClient({
      configPath: options.sessionHistoryConfigPath,
      fetchImpl: options.sessionHistoryFetchImpl,
    });
  const historyConfig = (config) =>
    clientOnly
      ? Object.freeze({ ...config, nodes: Object.freeze([]) })
      : config;
  const sessionHistoryHub =
    options.sessionHistoryHub ??
    new SessionHistoryHub(historyConfig(activeConfig), {
      sharedClient: sharedSessionHistoryClient,
      nodeHistory: options.nodeSessionHistory,
      canManageShared: options.canManageShared,
    });
  let provisioner;
  const applyConfig = async (nextConfig) => {
    activeConfig = nextConfig;
    if (ownsAggregator) {
      aggregator = new UsageAggregator(nextConfig, {
        fetchImpl: options.fetchImpl,
        env: options.env,
      });
    } else {
      aggregator.setConfig?.(nextConfig);
    }
    manager.setConfig?.(nextConfig);
    sessionHistoryHub.setConfig?.(historyConfig(nextConfig));
    provisioner?.setConfig?.(nextConfig);
  };
  provisioner = options.provisioner ?? new NodeProvisioner(activeConfig, {
    configPath: options.configPath,
    projectRoot: options.projectRoot,
    packagePath: options.packagePath,
    fetchImpl: options.fetchImpl,
    onConfigChange: applyConfig,
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://portal.local");
    if (mcpProxyUrl && isMcpProxyPath(url.pathname)) {
      await proxyMcpRequest(req, res, mcpProxyUrl);
      return;
    }
    if (!authorized(req, auth, allowedPrincipalId, url.pathname)) {
      send(
        res,
        401,
        JSON.stringify({ error: "需要登录" }),
        "application/json; charset=utf-8",
        { "www-authenticate": 'Basic realm="Codex Usage Portal", charset="UTF-8"' },
      );
      return;
    }

    try {
      const origins = [...new Set(activeConfig.clientNodes.map((node) => new URL(node.endpoint).origin))];
      res.codeyContentPolicy = SECURITY_HEADERS["content-security-policy"].replace(
        "connect-src 'self';", `connect-src ${["'self'", ...origins].join(" ")};`,
      );
      const cloudCliNodeIds = (nodePolicy ? activeConfig.clientNodes : activeConfig.nodes).map((node) => node.id);
      const dataNodeIds = activeConfig.clientNodes
        .filter((node) => cloudCliNodeIds.includes(node.id))
        .map((node) => node.id);
      if (nodePolicy) {
        const historySource = url.pathname === "/api/session-history"
          ? url.searchParams.get("source") || "all"
          : url.pathname.match(/^\/api\/session-history\/([^/]+)\/(?:active|archived|trash)\//)?.[1];
        if (historySource && !["all", "shared"].includes(historySource) && !cloudCliNodeIds.includes(historySource)) {
          sendJson(res, 404, { error: "节点不存在或无权访问" });
          return;
        }
      }
      if (cloudCliUi && await cloudCliUi.handleAssets(req, res)) return;
      if (nodeDataGateway && await nodeDataGateway.handle(req, res, dataNodeIds)) return;
      if (req.method === "GET" && url.pathname === "/api/cloudcli/nodes") {
        sendJson(res, 200, {
          nodes: (cloudCliGateway?.publicNodes(cloudCliNodeIds) ?? []).map((node) => {
            const preference = activeConfig.clientNodes.find((entry) => entry.id === node.id);
            return { ...node, name: preference?.name ?? node.name, region: preference?.region ?? node.region };
          }),
        });
        return;
      }
      if (
        composerCompletionGateway &&
        await composerCompletionGateway.handle(req, res, cloudCliGateway?.publicNodes(cloudCliNodeIds).map((node) => node.id) ?? [])
      ) return;
      if (
        voiceGateway &&
        await voiceGateway.handle(req, res, cloudCliGateway?.publicNodes(cloudCliNodeIds).map((node) => node.id) ?? [])
      ) return;
      if (
        cloudCliGateway?.handles(url.pathname) &&
        (await cloudCliGateway.proxyHttp(req, res, cloudCliNodeIds))
      ) {
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/session-history/status") {
        sendJson(res, 200, await sessionHistoryHub.status());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/session-history") {
        const source = url.searchParams.get("source") || "all";
        const state = url.searchParams.get("state") || (source === "all" ? "all" : "active");
        const range = url.searchParams.get("range") || "all";
        const query = (url.searchParams.get("q") || "").slice(0, 256);
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
        if (!Number.isInteger(limit) || !Number.isInteger(offset)) {
          sendJson(res, 400, { error: "limit and offset must be integers" });
          return;
        }
        sendJson(
          res,
          200,
          await sessionHistoryHub.list({
            source,
            state,
            query,
            limit,
            offset,
            range,
          }),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/session-history/batch") {
        if (!actionRequestAllowed(req, "session-history")) {
          sendJson(res, 403, { error: "会话管理请求缺少同源操作标记" });
          return;
        }
        const body = await readJsonBody(req);
        sendJson(
          res,
          200,
          await sessionHistoryHub.batch(body.action, body.items),
        );
        return;
      }

      const historyMatch = url.pathname.match(
        /^\/api\/session-history\/([a-z0-9][a-z0-9_-]{0,31})\/(active|archived|trash)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/(archive|rename|restore|upload|purge))?$/,
      );
      if (historyMatch) {
        const [, source, state, sessionName, action] = historyMatch;
        if (req.method === "GET" && action === "archive") {
          await streamUpstreamFile(
            res,
            await sessionHistoryHub.archive(source, state, sessionName),
          );
          return;
        }
        if (req.method === "GET" && !action) {
          sendJson(
            res,
            200,
            await sessionHistoryHub.detail(source, state, sessionName),
          );
          return;
        }
        if (!actionRequestAllowed(req, "session-history")) {
          sendJson(res, 403, { error: "会话管理请求缺少同源操作标记" });
          return;
        }
        if (req.method === "POST" && state === "active" && action === "rename") {
          const body = await readJsonBody(req);
          sendJson(
            res,
            200,
            await sessionHistoryHub.rename(source, sessionName, body.newName),
          );
          return;
        }
        if (req.method === "POST" && action === "upload") {
          sendJson(
            res,
            201,
            await sessionHistoryHub.upload(source, state, sessionName),
          );
          return;
        }
        if (req.method === "DELETE" && state === "active" && !action) {
          sendJson(res, 200, await sessionHistoryHub.trash(source, sessionName));
          return;
        }
        if (req.method === "POST" && state === "trash" && action === "restore") {
          sendJson(res, 200, await sessionHistoryHub.restore(source, sessionName));
          return;
        }
        if (
          req.method === "DELETE" &&
          (state === "active" || state === "trash") &&
          action === "purge"
        ) {
          sendJson(
            res,
            200,
            await sessionHistoryHub.purge(source, state, sessionName),
          );
          return;
        }
        if (req.method === "DELETE" && state === "trash" && !action) {
          sendJson(
            res,
            200,
            await sessionHistoryHub.purge(source, state, sessionName),
          );
          return;
        }
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const updateMatch = url.pathname.match(/^\/api\/nodes\/([a-z0-9][a-z0-9_-]{0,31})\/update$/);
      if (req.method === "POST" && updateMatch) {
        if (readOnly) {
          sendJson(res, 403, { error: "Codey hosted mode is read-only for node management" });
          return;
        }
        if (!actionRequestAllowed(req, "update")) {
          sendJson(res, 403, { error: "更新请求缺少同源操作标记" });
          return;
        }

        const body = await readJsonBody(req);
        const result = await manager.update(updateMatch[1], body.component, {
          artifactId: body.artifactId,
        });
        sendJson(res, 200, result);
        return;
      }

      const startCopilotMatch = url.pathname.match(
        /^\/api\/nodes\/([a-z0-9][a-z0-9_-]{0,31})\/copilot-api\/start$/,
      );
      if (req.method === "POST" && startCopilotMatch) {
        if (readOnly) {
          sendJson(res, 403, { error: "Codey hosted mode is read-only for node management" });
          return;
        }
        if (!actionRequestAllowed(req, "start-copilot-api")) {
          sendJson(res, 403, { error: "启动请求缺少同源操作标记" });
          return;
        }
        sendJson(
          res,
          200,
          await manager.startCopilotApi(startCopilotMatch[1]),
        );
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/api/copilot-api/deploy-all"
      ) {
        if (readOnly) {
          sendJson(res, 403, { error: "Codey hosted mode is read-only for node management" });
          return;
        }
        if (!actionRequestAllowed(req, "update")) {
          sendJson(res, 403, { error: "部署请求缺少同源操作标记" });
          return;
        }
        const body = await readJsonBody(req);
        sendJson(
          res,
          200,
          await manager.deployCopilotArtifactToAll(body.artifactId),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/nodes/provision") {
        if (readOnly) {
          if (!options.allowHostedNodeRegistration || !options.configPath) {
            sendJson(res, 403, { error: "Codey hosted mode does not provision machines" });
            return;
          }
          if (!actionRequestAllowed(req, "provision")) {
            sendJson(res, 403, { error: "节点注册请求缺少同源操作标记" });
            return;
          }
          const body = await readJsonBody(req);
          const host = String(body.sshHost ?? "").trim();
          const endpoint = String(body.endpoint ?? "").trim() ||
            (host ? `http://${host}:4141/usage` : "");
          const candidate = {
            id: String(body.id ?? "").trim().toLowerCase(),
            name: String(body.name ?? "").trim(),
            region: String(body.region ?? "").trim() || "User node",
            endpoint,
            accent: String(body.accent ?? "#60a5fa"),
          };
          const nextConfig = clientOnly
            ? validateConfig({
                ...activeConfig,
                clientNodes: [...activeConfig.clientNodes, candidate],
              })
            : validateConfig({
                ...activeConfig,
                nodes: [
                  ...activeConfig.nodes,
                  {
                    ...candidate,
                    apiKeyEnv: "",
                  },
                ],
              });
          const saved = await saveConfig(options.configPath, nextConfig);
          await applyConfig(saved);
          sendJson(res, 201, {
            ok: true,
            node: clientOnly
              ? saved.clientNodes.at(-1)
              : saved.nodes.at(-1),
            message: "节点已加入当前 AAD 用户的私有列表",
          });
          return;
        }
        if (!actionRequestAllowed(req, "provision")) {
          sendJson(res, 403, { error: "部署请求缺少同源操作标记" });
          return;
        }
        const body = await readJsonBody(req);
        const result = await provisioner.provision(body);
        sendJson(res, 201, result);
        return;
      }

      // This route stays behind the normal portal authentication boundary.
      // Only the reviewed static package is downloadable, never enrollment data.
      const skillDownload = SKILL_DOWNLOADS.get(url.pathname);
      if (skillDownload) {
        if (!["GET", "HEAD"].includes(req.method)) {
          send(res, 405, JSON.stringify({ error: "Method not allowed" }), "application/json", { allow: "GET, HEAD" });
          return;
        }
        const [fileName, contentType] = skillDownload;
        const body = await readFile(path.join(staticRoot, "downloads", fileName));
        send(res, 200, req.method === "HEAD" ? Buffer.alloc(0) : body, contentType, {
          "content-disposition": `attachment; filename="${fileName}"`,
          "content-length": body.length,
          "cache-control": "private, no-store",
          vary: "Cookie",
        });
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          configuredNodes: activeConfig.nodes.length,
          clientNodes: activeConfig.clientNodes.length,
          clientOnly,
          portalName,
          readOnly,
          now: new Date().toISOString(),
        });
        return;
      }

      if (url.pathname === "/api/client-nodes") {
        if (!clientRelaySigningKey || clientRelaySigningKey.length < 32) {
          sendJson(res, 503, { error: "Direct node access is not configured" });
          return;
        }
        const nodes = await Promise.all(activeConfig.clientNodes.map(async (node) => {
          const ticket = issueClientTicket({
            signingKey: nodePolicy ? await nodePolicy.keyFor(clientPrincipalId, node.id) : clientRelaySigningKey,
            nodeId: node.id,
            principalId: clientPrincipalId,
            ttlSeconds: clientTicketTtlSeconds,
          });
          return {
            ...node,
            proxyEndpoint: nodeDataGateway?.endpoint(node.id, dataNodeIds) ?? null,
            ticket: ticket.token,
            ticketExpiresAt: ticket.expiresAt,
          };
        }));
        sendJson(res, 200, {
          directMode: clientOnly,
          connectionModes: nodeDataGateway && (!nodePolicy || nodes.some((node) => node.proxyEndpoint))
            ? nodes.length && nodes.every((node) => node.vnetOnly) ? ["vnet"] : ["direct", "vnet"]
            : ["direct"],
          managedAccounts: Boolean(nodePolicy),
          userId: nodePolicy ? clientPrincipalId : undefined,
          nodes,
          requestTimeoutMs: activeConfig.requestTimeoutMs,
          refreshSeconds: activeConfig.refreshSeconds,
          eventsPerNode: activeConfig.eventsPerNode,
          maxRecentEvents: activeConfig.maxRecentEvents,
        });
        return;
      }

      if (url.pathname === "/api/nodes") {
        sendJson(res, 200, {
          nodes: clientOnly ? activeConfig.clientNodes : aggregator.publicNodes(),
          refreshSeconds: activeConfig.refreshSeconds,
        });
        return;
      }

      if (url.pathname === "/api/overview") {
        if (clientOnly) {
          sendJson(res, 409, {
            error: "Usage data is collected directly by the browser",
          });
          return;
        }
        const period = normalizePeriod(url.searchParams.get("period") || "week");
        if (!period) {
          sendJson(res, 400, { error: "period must be day, week, or month" });
          return;
        }
        const nodeIds = parseNodeIds(url.searchParams.get("nodes"));
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const overview = await aggregator.overview(period, nodeIds, forceRefresh);
        sendJson(res, 200, overview);
        return;
      }

      if (url.pathname === "/api/management/status") {
        if (clientOnly) {
          sendJson(res, 409, {
            error: "Node management is unavailable in direct browser mode",
          });
          return;
        }
        const nodeIds = parseNodeIds(url.searchParams.get("nodes"));
        sendJson(res, 200, await manager.status(nodeIds));
        return;
      }

      if (
        (req.method === "GET" || req.method === "HEAD") &&
        url.pathname === "/windows-bootstrap.ps1"
      ) {
        if (readOnly) {
          sendJson(res, 403, { error: "Codey hosted mode does not distribute installers" });
          return;
        }
        const script = await readFile(
          path.join(
            PROJECT_ROOT,
            "scripts",
            "windows",
            "install-codex-workstation.ps1",
          ),
        );
        send(
          res,
          200,
          req.method === "HEAD" ? Buffer.alloc(0) : script,
          "text/plain; charset=utf-8",
          {
            "content-disposition":
              'attachment; filename="install-codex-workstation.ps1"',
          },
        );
        return;
      }

      if (
        (req.method === "GET" || req.method === "HEAD") &&
        (url.pathname === "/bootstrap/windows" ||
          url.pathname === "/bootstrap/linux" ||
          url.pathname === "/bootstrap/macos")
      ) {
        if (readOnly) {
          sendJson(res, 403, { error: "Codey hosted mode does not distribute installers" });
          return;
        }
        const artifact = await latestArtifact(artifactCatalog);
        const windows = url.pathname.endsWith("/windows");
        const platform = windows
          ? "windows"
          : url.pathname.endsWith("/macos")
            ? "macos"
            : "linux";
        const fileName =
          platform === "windows"
            ? "install-codex-workstation.ps1"
            : "install-codex-workstation.sh";
        const script = await readFile(
          path.join(
            PROJECT_ROOT,
            "scripts",
            platform,
            fileName,
          ),
          "utf8",
        );
        const packageBody = await readFile(artifact.path);
        const normalizedScript = windows
          ? script.replace(/\r?\n/g, "\r\n")
          : script.replace(/\r\n/g, "\n");
        const body = Buffer.from(
          renderInstaller(normalizedScript, artifact, packageBody),
        );
        send(
          res,
          200,
          req.method === "HEAD" ? Buffer.alloc(0) : body,
          windows
            ? "text/plain; charset=utf-8"
            : "text/x-shellscript; charset=utf-8",
          {
            "content-disposition": `attachment; filename="${fileName}"`,
            "content-length": body.length,
          },
        );
        return;
      }

      const staticFile = STATIC_FILES.get(url.pathname);
      if (staticFile) {
        const [fileName, contentType] = staticFile;
        let body = await readFile(path.join(staticRoot, fileName));
        if (fileName === "index.html" && portalName !== "Codex Usage Portal") {
          body = Buffer.from(
            body.toString("utf8").replaceAll("Codex Usage Portal", portalName),
          );
        }
        if (req.method === "HEAD") {
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            "content-security-policy": res.codeyContentPolicy || SECURITY_HEADERS["content-security-policy"],
            "cache-control": nodePolicy ? "private, no-store" : "no-cache",
            ...(nodePolicy ? { vary: "Cookie" } : {}),
            "content-type": contentType,
            "content-length": body.length,
          });
          res.end();
        } else {
          send(res, 200, body, contentType, {
            "cache-control": nodePolicy ? "private, no-store" : "no-cache",
            ...(nodePolicy ? { vary: "Cookie" } : {}),
          });
        }
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) console.error("Portal request failed:", error);
      sendJson(res, status, {
        error: status < 500 || error?.expose ? error.message : "Portal 内部错误",
      });
    }
  });
}

export function createMultiUserPortalServer(options) {
  const contexts = new Map();
  const passwordAuthenticator = options.passwordAuthenticator;
  if (passwordAuthenticator?.multiUser && !options.nodePolicy) {
    throw new Error("Multi-user password login requires a signed node ownership policy");
  }
  const allowedPrincipalId = passwordAuthenticator?.multiUser ? "" : String(options.allowedPrincipalId ?? "").toLowerCase();
  const resolvePrincipal = async (req) => {
    const principal = passwordAuthenticator
      ? await passwordAuthenticator.principal(req)
      : options.aadAuthenticator
      ? await options.aadAuthenticator.principal(req)
      : {
          id: String(req.headers["x-ms-client-principal-id"] ?? "")
            .trim()
            .toLowerCase(),
        };
    const principalId = principal?.id ?? "";
    if (!principalId || (allowedPrincipalId && !safeEqual(principalId, allowedPrincipalId))) {
      return null;
    }
    return principal;
  };
  const server = http.createServer(async (req, res) => {
    try {
    const url = new URL(req.url ?? "/", "http://portal.local");
    // Updater credentials are independent of Portal cookies, model keys and SSO.
    // This handler authenticates and scopes every request itself.
    if (options.machineUpdates && await options.machineUpdates.handleAgent(req, res)) return;
    if (passwordAuthenticator && await passwordAuthenticator.handle(req, res)) return;
    if (passwordAuthenticator && ["/api/health", "/healthz", "/readyz"].includes(url.pathname) &&
        ["GET", "HEAD"].includes(req.method)) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (options.mcpProxyUrl && isMcpProxyPath(url.pathname)) {
      if (passwordAuthenticator && (url.pathname === "/mcp" || url.pathname.startsWith("/v1/")) &&
          !/^Bearer \S+$/i.test(String(req.headers.authorization ?? "")) && !req.headers["x-api-key"]) {
        send(res, 401, JSON.stringify({ error: "MCP authentication required" }), "application/json", {
          "www-authenticate": 'Bearer resource_metadata="/.well-known/oauth-protected-resource/mcp"',
        });
        return;
      }
      await proxyMcpRequest(req, res, options.mcpProxyUrl);
      return;
    }
    if (!passwordAuthenticator && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        portalName: options.portalName || "Codey",
        multiUser: true,
        now: new Date().toISOString(),
      });
      return;
    }
    if (!passwordAuthenticator && options.aadAuthenticator) {
      const redirectUri = `${options.publicBaseUrl}/portal-auth/callback`;
      if (url.pathname === "/portal-auth/start") {
        send(res, 200, options.aadAuthenticator.startPage(redirectUri), "text/html; charset=utf-8", {
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src https://login.microsoftonline.com; base-uri 'none'",
        });
        return;
      }
      if (url.pathname === "/portal-auth/callback") {
        send(res, 200, options.aadAuthenticator.callbackPage(redirectUri), "text/html; charset=utf-8", {
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src https://login.microsoftonline.com 'self'; base-uri 'none'",
        });
        return;
      }
      if (url.pathname === "/portal-auth/session" && req.method === "POST") {
        try {
          const result = await options.aadAuthenticator.createSession(
            (await readJsonBody(req)).idToken,
          );
          send(
            res,
            200,
            JSON.stringify({ ok: true, user: result.principal.name }),
            "application/json; charset=utf-8",
            { "set-cookie": result.cookie },
          );
        } catch (error) {
          sendJson(res, error.status || 401, { error: error.message });
        }
        return;
      }
    }
    const principal = await resolvePrincipal(req);
    const principalId = principal?.id ?? "";
    if (!principalId) {
      if (passwordAuthenticator) {
        passwordAuthenticator.reject(req, res);
        return;
      }
      res.writeHead(302, { location: "/portal-auth/start", "cache-control": "no-store" });
      res.end();
      return;
    }
    if (passwordAuthenticator && !["GET", "HEAD"].includes(req.method) &&
        !passwordAuthenticator.sameOrigin(req)) {
      sendJson(res, 403, { error: "Cross-origin operations are not allowed" });
      return;
    }
    req.codeyPrincipal = principal;
    await options.machineSetup?.refreshGateways();
    if (options.settingsApi && await options.settingsApi.handle(req, res)) return;
    const loaded = await (options.nodePolicy || options.userConfigStore).load(principalId);
    const contextRevision = `${principal.role || ""}:${loaded.revision || JSON.stringify(loaded.config)}`;
    let context = contexts.get(principalId);
    if (!context || context.revision !== contextRevision) {
      const server = createPortalServer({
        ...options,
        config: loaded.config,
        configPath: loaded.configPath,
        allowedPrincipalId: "",
        auth: passwordAuthenticator ? null : options.auth,
        clientPrincipalId: principalId,
        mcpProxyUrl: "",
        allowHostedNodeRegistration: !options.nodePolicy,
        ...(options.nodePolicy ? {
          clientOnly: true, readOnly: true,
          sessionHistoryHub: undefined, nodeSessionHistory: undefined,
        } : {}),
        canManageShared: principal.role !== "user",
      });
      context = { revision: contextRevision, handle: server.listeners("request")[0] };
      if (!contexts.has(principalId) && contexts.size >= 512) contexts.delete(contexts.keys().next().value);
      contexts.set(principalId, context);
    }
    await context.handle(req, res);
    } catch {
      if (!res.headersSent) sendJson(res, 503, { error: "Authentication or portal service unavailable" });
      else res.destroy();
    }
  });
  options.cloudCliGateway?.attach(server, async (req, nodeId) => {
    const principal = await resolvePrincipal(req);
    if (!principal) throw new Error("Unauthorized");
    if (passwordAuthenticator && !passwordAuthenticator.sameOrigin(req)) return false;
    req.codeyPrincipal = principal;
    if (options.nodePolicy) return options.nodePolicy.canAccess(principal.id, nodeId);
    const loaded = await options.userConfigStore.load(principal.id);
    return loaded.config.nodes.some((node) => node.id === nodeId);
  });
  return server;
}

async function main() {
  const { config, configPath } = await loadConfig();
  const host = process.env.PORTAL_HOST || "127.0.0.1";
  const port = Number(process.env.PORTAL_PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORTAL_PORT must be an integer between 1 and 65535");
  }

  const auth = process.env.PORTAL_PASSWORD
    ? {
        username: process.env.PORTAL_USERNAME || "portal",
        password: process.env.PORTAL_PASSWORD,
      }
    : null;
  const readOnly = /^(?:1|true|yes|on)$/i.test(
    String(process.env.PORTAL_READ_ONLY ?? ""),
  );
  const clientOnly = /^(?:1|true|yes|on)$/i.test(
    String(process.env.PORTAL_CLIENT_ONLY ?? ""),
  );
  const portalName = process.env.PORTAL_NAME || "Codex Usage Portal";
  const allowedPrincipalId = process.env.PORTAL_ALLOWED_PRINCIPAL_ID || "";
  const mcpProxyUrl = process.env.PORTAL_MCP_PROXY_URL || "";
  const userDataDir = String(process.env.PORTAL_USER_DATA_DIR ?? "").trim();
  const aadClientId = String(process.env.PORTAL_AAD_CLIENT_ID ?? "").trim();
  const aadTenantId = String(process.env.PORTAL_ENTRA_TENANT_ID ?? "").trim();
  const publicBaseUrl = String(process.env.PORTAL_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const passwordMode = process.env.PORTAL_AUTH_MODE === "password";
  if (passwordMode && (!userDataDir || !process.env.PORTAL_WORKSPACE_SSO_MASTER)) {
    throw new Error("Password mode requires persistent user/session storage and Workspace SSO");
  }
  const credential = passwordMode ? JSON.parse(process.env.PORTAL_PASSWORD_CREDENTIAL || "null") : null;
  const legacyConfigStore = userDataDir ? new UserConfigStore(userDataDir, {
    tenantId: process.env.PORTAL_ENTRA_TENANT_ID || "",
    seedPrincipalId: process.env.PORTAL_SEED_PRINCIPAL_ID || credential?.principalId || "",
    seedConfig: config,
  }) : null;
  const accountStore = passwordMode ? new AccountStore({
    credential, root: process.env.PORTAL_AUTH_STATE_DIR, master: process.env.PORTAL_WORKSPACE_SSO_MASTER,
  }) : null;
  if (accountStore) await accountStore.initialize();
  const nodePolicy = passwordMode ? new NodePolicy({
    root: process.env.PORTAL_AUTH_STATE_DIR, master: process.env.PORTAL_WORKSPACE_SSO_MASTER,
    ticketMaster: process.env.PORTAL_CLIENT_RELAY_SIGNING_KEY,
    seedPrincipalId: credential.principalId, legacyConfigStore, defaults: config,
  }) : null;
  if (nodePolicy) await nodePolicy.initialize();
  const passwordAuthenticator = passwordMode ? new PasswordAuthenticator({
    credential, accountStore,
    root: process.env.PORTAL_AUTH_STATE_DIR,
    publicBaseUrl,
    staticRoot: path.join(PROJECT_ROOT, "public"),
  }) : null;
  const cloudCliUiRoot = String(process.env.PORTAL_CLOUDCLI_UI_ROOT ?? "").trim();
  if (cloudCliUiRoot && (!passwordMode || !process.env.PORTAL_CLOUDCLI_CONFIG)) {
    throw new Error("Shared Workspace UI requires password login and a CloudCLI gateway");
  }
  const cloudCliUi = cloudCliUiRoot ? new CloudCliUi(cloudCliUiRoot) : null;
  const cloudCliGateway = createCloudCliGateway(
    resolveCloudCliGatewayConfig(process.env),
    { sessionAuthenticator: passwordAuthenticator, nodePolicy, ui: cloudCliUi },
  );
  const nodeDataConfig = resolveNodeDataGatewayConfig(process.env);
  const nodeDataGateway = nodeDataConfig ? new NodeDataGateway(nodeDataConfig, { nodePolicy }) : null;
  const voiceGateway = passwordAuthenticator ? new VoiceGateway(
    new VoiceService(resolveVoiceServiceConfig(process.env)),
    {
      authenticator: passwordAuthenticator, nodePolicy,
      rewriteService: new VoiceRewriteService(resolveVoiceRewriteConfig(process.env)),
    },
  ) : null;
  const composerCompletionGateway = passwordAuthenticator ? new ComposerCompletionGateway(
    new ComposerCompletionService(resolveComposerCompletionConfig(process.env)),
    { authenticator: passwordAuthenticator, nodePolicy },
  ) : null;
  const settingsApi = accountStore ? new SettingsApi({
    accounts: accountStore, nodePolicy, authenticator: passwordAuthenticator, cloudCliGateway, nodeDataGateway,
  }) : null;
  const machineUpdates = accountStore ? new MachineUpdates({
    root: process.env.PORTAL_AUTH_STATE_DIR, master: process.env.PORTAL_WORKSPACE_SSO_MASTER,
    catalogRoot: process.env.PORTAL_NODE_UPDATE_ROOT,
    publicKey: process.env.PORTAL_NODE_UPDATE_PUBLIC_KEY_FILE
      ? await readFile(process.env.PORTAL_NODE_UPDATE_PUBLIC_KEY_FILE, "utf8") : null,
    nodePolicy, accounts: accountStore, authenticator: passwordAuthenticator,
    sourceRoot: path.join(PROJECT_ROOT, "node-updater"),
  }) : null;
  if (machineUpdates) await machineUpdates.initialize();
  if (settingsApi) settingsApi.machineUpdates = machineUpdates;
  const machineSetup = accountStore ? new MachineSetup({
    nodePolicy, accounts: accountStore, authenticator: passwordAuthenticator, origin: publicBaseUrl,
    bundleRoot: process.env.PORTAL_MACHINE_BUNDLE_ROOT,
    network: process.env.PORTAL_MACHINE_NETWORK_CONFIG
      ? JSON.parse(await readFile(process.env.PORTAL_MACHINE_NETWORK_CONFIG, "utf8")) : null,
    cloudCliGateway, nodeDataGateway, cloudCliUi, machineUpdates,
  }) : null;
  if (settingsApi) settingsApi.machineSetup = machineSetup;
  const commonOptions = {
    config,
    configPath,
    auth,
    readOnly,
    clientOnly,
    clientRelaySigningKey:
      process.env.PORTAL_CLIENT_RELAY_SIGNING_KEY || "",
    clientTicketTtlSeconds: Math.min(
      Number(process.env.PORTAL_CLIENT_TICKET_TTL_SECONDS || 600),
      passwordMode ? 60 : 900,
    ),
    portalName,
    allowedPrincipalId,
    mcpProxyUrl,
    cloudCliGateway,
    cloudCliUi,
    nodeDataGateway,
    voiceGateway,
    composerCompletionGateway,
    passwordAuthenticator,
    nodePolicy,
    settingsApi,
    machineSetup,
    machineUpdates,
  };
  const server = userDataDir
    ? createMultiUserPortalServer({
        ...commonOptions,
        userConfigStore: nodePolicy || legacyConfigStore,
        aadAuthenticator:
          !passwordMode && aadClientId && aadTenantId
            ? new AadAuthenticator({
                tenantId: aadTenantId,
                clientId: aadClientId,
                allowedPrincipalIds: allowedPrincipalId ? [allowedPrincipalId] : [],
              })
            : null,
        publicBaseUrl,
      })
    : createPortalServer(commonOptions);
  if (!userDataDir) {
    cloudCliGateway?.attach(server, async (req, nodeId) => {
      const requestUrl = new URL(req.url ?? "/", "http://portal.local");
      return (
        authorized(req, auth, allowedPrincipalId, requestUrl.pathname) &&
        config.nodes.some((node) => node.id === nodeId)
      );
    });
  }
  server.listen(port, host, () => {
    console.log(`${portalName}: http://${host}:${port}`);
    console.log(`Loaded ${config.nodes.length} nodes from ${configPath}`);
    if (!auth && !passwordAuthenticator && !aadClientId && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      console.warn("Warning: the portal is listening beyond localhost without password protection.");
    }
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
