// Read-only loopback probes. Never create a session, send a prompt or run Codex.
import { createHmac, randomBytes, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const requireValue = (value, message) => { if (!value) throw new Error(message); };

export function assertion(identity, pathname) {
  const now = Math.floor(Date.now() / 1000);
  const key = Buffer.from(identity.workspaceSsoKey, "base64url");
  requireValue(key.length === 32, "Invalid existing Workspace SSO key.");
  const payload = Buffer.from(JSON.stringify({
    iss: "codey-portal", aud: identity.nodeId, sub: identity.workspaceSubject,
    username: identity.workspaceUsername, sid: randomBytes(32).toString("hex"),
    method: "GET", path: pathname, iat: now, exp: now + 20, nonce: randomBytes(16).toString("base64url"),
  })).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

export function dataTicket(identity) {
  const now = Math.floor(Date.now() / 1000);
  requireValue(typeof identity.clientSigningKey === "string" && identity.clientSigningKey.length >= 32,
    "Invalid existing data gateway key.");
  const payload = Buffer.from(JSON.stringify({
    v: 1, aud: identity.nodeId, sub: identity.workspaceSubject,
    scope: ["history", "usage"], iat: now, exp: now + 60,
  })).toString("base64url");
  return `${payload}.${createHmac("sha256", identity.clientSigningKey).update(payload).digest("base64url")}`;
}

export function request(options) {
  return new Promise((resolve, reject) => {
    const client = options.protocol === "http:" ? http : https;
    const req = client.get({ ...options, agent: false }, response => {
      const chunks = [];
      let size = 0;
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Local health response was interrupted.")));
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) response.destroy(new Error("Oversized local health response."));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode, body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Local health check timed out.")));
  });
}

export async function probeNative(config, { version, idle = false, get = request } = {}) {
  const identity = JSON.parse(await readFile(config.identityFile, "utf8"));
  requireValue(identity.nodeId === config.nodeId, "Local node identity changed.");
  const certificate = await readFile(config.certificate);
  const leaf = new X509Certificate(certificate);
  const servername = config.serverName;
  const local = (port, pathname, headers = {}) => get({
    protocol: "https:", hostname: "127.0.0.1", port, path: pathname, servername,
    ca: certificate, allowPartialTrustChain: true, rejectUnauthorized: true,
    checkServerIdentity(host, peer) {
      return tls.checkServerIdentity(host, peer) ||
        (peer.fingerprint256 === leaf.fingerprint256 ? undefined : new Error("Local TLS certificate changed."));
    },
    headers,
  });
  const workspace = (pathname, signed = true) => local(3001, pathname, signed ? {
      "x-codey-workspace-assertion": assertion(identity, pathname), Origin: config.portalOrigin,
    } : {});
  const sessions = await workspace("/api/providers/sessions/running");
  requireValue(sessions.status === 200, "Authenticated Workspace readiness failed.");
  const running = JSON.parse(sessions.body).data?.sessions;
  requireValue(Array.isArray(running), "Unknown Workspace activity state.");
  if (idle) {
    requireValue(running.length === 0, "Codey is busy; finish active tasks before updating.");
    return { idle: true, runningSessions: 0, modelRequests: false };
  }
  const model = key => get({
    protocol: "http:", hostname: "127.0.0.1", port: 4141, path: "/models",
    headers: key ? { authorization: "Bearer " + key } : {},
  });
  requireValue(typeof config.modelKey === "string" && config.modelKey.length >= 32, "Missing existing gateway model key.");
  const models = await model(config.modelKey);
  requireValue(models.status === 200 && Array.isArray(JSON.parse(models.body).data), "Authenticated gateway readiness failed.");
  requireValue((await model()).status === 401 && (await model("invalid-codey-local-update-key")).status === 401,
    "Gateway authentication changed.");
  requireValue((await workspace("/api/auth/status", false)).status === 401, "Workspace authentication changed.");
  const dataPath = "/token-usage/events?limit=1";
  requireValue((await local(8443, dataPath)).status === 401, "Data gateway authentication changed.");
  const data = await local(8443, dataPath, { authorization: "Bearer " + dataTicket(identity) });
  requireValue(data.status === 200, "Authenticated TLS data gateway readiness failed.");
  JSON.parse(data.body);
  if (version) {
    const health = await workspace("/health");
    requireValue(health.status === 200 && JSON.parse(health.body).version === version, "Running Codey version differs from the staged package.");
  }
  return { healthy: true, runningSessions: running.length, modelRequests: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [file, mode, version] = process.argv.slice(2);
    if (!file || !["idle", "health"].includes(mode)) throw new Error("Invalid probe command.");
    const config = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    console.log(JSON.stringify(await probeNative(config, { idle: mode === "idle", version })));
  } catch {
    // Never print a response body, model key, SSO assertion or private descriptor.
    console.error("Codey local readiness/activity check failed; finish active tasks and check the existing services.");
    process.exitCode = 1;
  }
}
