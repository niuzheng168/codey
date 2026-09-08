import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { verifyClientTicket } from "../src/client-ticket.mjs";
import { validateConfig } from "../src/config.mjs";
import { NodeSessionHistory } from "../src/node-session-history.mjs";

const USAGE_PATHS = new Set([
  "/usage",
  "/token-usage",
  "/token-usage/daily",
  "/token-usage/events",
]);
const HISTORY_DETAIL_PATTERN =
  /^\/session-history\/(active|archived)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

function required(value, label) {
  value = String(value ?? "").trim();
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function readSecret(filePath, label) {
  const value = readFileSync(path.resolve(required(filePath, `${label} file`)), "utf8").trim();
  if (value.length < 32) throw new Error(`${label} must contain at least 32 characters`);
  return value;
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

function applyCors(req, res, allowedOrigin) {
  const origin = String(req.headers.origin ?? "").trim();
  if (!origin) return true;
  if (origin !== allowedOrigin) return false;
  res.setHeader("access-control-allow-origin", allowedOrigin);
  res.setHeader("vary", "Origin");
  return true;
}

function bearerToken(req) {
  const header = String(req.headers.authorization ?? "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function integerParam(url, name, fallback, minimum, maximum) {
  const value = Number(url.searchParams.get(name) ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    const error = new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    error.status = 400;
    throw error;
  }
  return value;
}

function historyConfig({ nodeId, nodeName, nodeRegion, nodeAccent, upstream, sessionRoot }) {
  return validateConfig({
    nodes: [
      {
        id: nodeId,
        name: nodeName,
        region: nodeRegion,
        accent: nodeAccent,
        endpoint: new URL("/usage", upstream).toString(),
        management: {
          transport: "local",
          sessionRoot,
          copilotApi: "none",
          codexCli: "desktop-managed",
        },
      },
    ],
  });
}

async function proxyUsage(req, res, url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  timeout.unref?.();
  try {
    const target = new URL(`${url.pathname}${url.search}`, options.upstream);
    const response = await options.fetchImpl(target, {
      headers: { accept: "application/json", ...(options.upstreamKeyFile
        ? { authorization: `Bearer ${readSecret(options.upstreamKeyFile, "Local usage API key")}` } : {}) },
      redirect: "error",
      signal: controller.signal,
    });
    const headers = {
      ...SECURITY_HEADERS,
      "content-type": response.headers.get("content-type") || "application/json",
    };
    const contentLength = response.headers.get("content-length");
    if (contentLength) headers["content-length"] = contentLength;
    res.writeHead(response.status, headers);
    if (req.method === "HEAD" || !response.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(response.body), res);
  } finally {
    clearTimeout(timeout);
  }
}

export function createRelayServer(options = {}) {
  const nodeId = required(
    options.nodeId ?? process.env.CODEY_RELAY_NODE_ID,
    "CODEY_RELAY_NODE_ID",
  );
  const nodeName = required(
    options.nodeName ?? process.env.CODEY_RELAY_NODE_NAME ?? nodeId,
    "CODEY_RELAY_NODE_NAME",
  );
  const nodeRegion = String(
    options.nodeRegion ?? process.env.CODEY_RELAY_NODE_REGION ?? "",
  ).trim();
  const nodeAccent = String(
    options.nodeAccent ?? process.env.CODEY_RELAY_NODE_ACCENT ?? "#8b5cf6",
  ).trim();
  const allowedOrigin = required(
    options.allowedOrigin ?? process.env.CODEY_RELAY_ALLOWED_ORIGIN,
    "CODEY_RELAY_ALLOWED_ORIGIN",
  );
  const upstream = new URL(
    options.upstream ?? process.env.CODEY_RELAY_UPSTREAM ?? "http://127.0.0.1:4141",
  );
  const upstreamKeyFile = options.upstreamKeyFile ?? process.env.CODEY_RELAY_UPSTREAM_KEY_FILE;
  if (upstreamKeyFile && (!["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname) ||
      !["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password ||
      upstream.search || upstream.hash || upstream.pathname !== "/")) {
    throw new Error("A local provider credential can only be forwarded to an explicit loopback usage service");
  }
  const certificate = options.tlsCertificate ?? process.env.CODEY_RELAY_TLS_CERT;
  const privateKey = options.tlsPrivateKey ?? process.env.CODEY_RELAY_TLS_KEY;
  if (Boolean(certificate) !== Boolean(privateKey)) throw new Error("Node TLS requires both certificate and private key");
  const sessionRoot = path.resolve(
    required(
      options.sessionRoot ?? process.env.CODEY_RELAY_SESSION_ROOT,
      "CODEY_RELAY_SESSION_ROOT",
    ),
  );
  const signingKey =
    options.signingKey ??
    readSecret(
      options.signingKeyFile ?? process.env.CODEY_RELAY_SIGNING_KEY_FILE,
      "Client relay signing key",
    );
  const requestTimeoutMs = Number(
    options.requestTimeoutMs ?? process.env.CODEY_RELAY_REQUEST_TIMEOUT_MS ?? 15000,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const history =
    options.history ??
    new NodeSessionHistory(
      historyConfig({
        nodeId,
        nodeName,
        nodeRegion,
        nodeAccent,
        upstream,
        sessionRoot,
      }),
      { sessionApiKey: "", httpOnly: false },
    );

  const handler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    if (!applyCors(req, res, allowedOrigin)) {
      sendJson(res, 403, { error: "Origin is not allowed" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
      res.setHeader("access-control-allow-headers", "authorization");
      res.setHeader("access-control-max-age", "600");
      if (req.headers["access-control-request-private-network"] === "true") {
        res.setHeader("access-control-allow-private-network", "true");
      }
      res.writeHead(204, { ...SECURITY_HEADERS, "content-length": "0" });
      res.end();
      return;
    }
    if (url.pathname === "/healthz" && ["GET", "HEAD"].includes(req.method)) {
      sendJson(res, 200, {
        ok: true,
        nodeId,
        relay: "codey-node-relay",
        now: new Date().toISOString(),
      });
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const detailMatch = HISTORY_DETAIL_PATTERN.exec(url.pathname);
    const scope =
      USAGE_PATHS.has(url.pathname)
        ? "usage"
        : url.pathname === "/session-history" || detailMatch
          ? "history"
          : "";
    if (!scope) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    try {
      verifyClientTicket({
        signingKey,
        token: bearerToken(req),
        nodeId,
        requiredScope: scope,
      });
    } catch {
      sendJson(res, 401, { error: "Client ticket is invalid or expired" });
      return;
    }

    try {
      if (scope === "usage") {
        await proxyUsage(req, res, url, {
          fetchImpl,
          requestTimeoutMs,
          upstream,
          upstreamKeyFile,
        });
        return;
      }
      if (url.pathname === "/session-history") {
        const result = await history.list(nodeId, {
          state: url.searchParams.get("state") || "all",
          query: (url.searchParams.get("q") || "").slice(0, 256),
          limit: integerParam(url, "limit", 50, 1, 1000),
          offset: integerParam(url, "offset", 0, 0, 1_000_000),
          startAtMs: integerParam(
            url,
            "start_at_ms",
            0,
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        });
        sendJson(res, 200, result);
        return;
      }
      const result = await history.detail(
        nodeId,
        detailMatch[1],
        detailMatch[2],
      );
      sendJson(res, 200, result);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) console.error("Codey node relay request failed");
      sendJson(res, status, {
        error: status < 500 ? error.message : "Node relay request failed",
      });
    }
  };
  return certificate
    ? https.createServer({ cert: readFileSync(certificate), key: readFileSync(privateKey), minVersion: "TLSv1.2" }, handler)
    : http.createServer(handler);
}

async function main() {
  const host = process.env.CODEY_RELAY_HOST || "127.0.0.1";
  const port = Number(process.env.CODEY_RELAY_PORT || 4242);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CODEY_RELAY_PORT must be an integer between 1 and 65535");
  }
  const server = createRelayServer();
  server.listen(port, host, () => {
    console.log(`Codey node relay: ${process.env.CODEY_RELAY_TLS_CERT ? "https" : "http"}://${host}:${port}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
