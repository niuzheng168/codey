import {
  createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual,
} from "node:crypto";
import { requestError } from "./signed-store.mjs";
import {
  validDevTunnelCoordinates, validateDevTunnelConnectToken, verifyDevTunnelAccess,
} from "./devtunnel-transport.mjs";

const ID = /^n-[a-f0-9]{24}$/;
const MAX_BODY = 16384;

/** A separate, node-scoped credential; never reuse the model, ticket, or SSO key. */
export function machineTunnelKey(master, id) {
  if (!ID.test(id)) throw new Error("Invalid machine identity");
  return createHmac("sha256", master).update(`codey-machine-tunnel-update-v1:${id}`).digest("base64url");
}

function encryptionKey(master, id) {
  return createHmac("sha256", master).update(`codey-machine-tunnel-storage-v1:${id}`).digest();
}

/** Encrypted at rest as well as covered by the registry's existing signature. */
export function sealMachineTunnelToken(master, id, token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(master, id), iv);
  cipher.setAAD(Buffer.from(id));
  const bytes = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(value => value.toString("base64url")).join(".");
}

/** Called only by the authenticated gateway transport; never returned by APIs. */
export function openMachineTunnelToken(master, id, sealed) {
  const parts = String(sealed).split(".").map(value => Buffer.from(value, "base64url"));
  if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16 || parts[2].length > 8192) {
    throw new Error("Invalid encrypted tunnel credential");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(master, id), parts[0]);
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(parts[1]);
  return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8");
}

/** Canonical request signing shared with the isolated installer/renewal tests. */
export function signMachineTunnelRequest(key, pathname, body, timestamp, nonce) {
  return createHmac("sha256", Buffer.from(key, "base64url"))
    .update(`POST\n${pathname}\n${timestamp}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`)
    .digest("base64url");
}

function reply(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

/**
 * A narrowly scoped node-agent endpoint. It cannot register/activate a node,
 * modify its certificate, access another node, or manage any Azure resource.
 */
export class MachineTunnelService {
  constructor({ nodePolicy, accounts, verifyAccess = verifyDevTunnelAccess, clock = Date.now, minIntervalMs = 15000 }) {
    Object.assign(this, { nodePolicy, accounts, verifyAccess, clock, minIntervalMs });
    this.inFlight = new Set();
    this.recentRequests = new Map();
    this.nextAttempt = new Map();
  }

  async handle(req, res) {
    const url = new URL(req.url, "https://portal.invalid");
    if (!url.pathname.startsWith("/api/machine-tunnels/")) return false;
    try {
      const match = /^\/api\/machine-tunnels\/(n-[a-f0-9]{24})\/token$/.exec(url.pathname);
      if (!match || url.search || req.method !== "POST" || req.headers.origin ||
          String(req.headers["content-type"] ?? "").split(";")[0] !== "application/json") {
        throw requestError("Invalid machine tunnel request", 400);
      }
      const id = match[1];
      const auth = /^CodeyTunnel (\d{13}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{43})$/
        .exec(String(req.headers.authorization ?? ""));
      const now = this.clock();
      if (!auth || Math.abs(Number(auth[1]) - now) > 120000) throw requestError("Machine authentication failed", 401);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw requestError("Machine request is too large", 413);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const expected = signMachineTunnelRequest(
        machineTunnelKey(this.nodePolicy.master, id), url.pathname, bytes, auth[1], auth[2],
      );
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(auth[3]))) throw requestError("Machine authentication failed", 401);
      const record = await this.nodePolicy.tunnelMachine(id, now);
      const owner = await this.accounts.byId(record.ownerId);
      if (!owner?.enabled) throw requestError("Machine authentication failed", 401);
      for (const [key, expiry] of this.recentRequests) if (expiry < now) this.recentRequests.delete(key);
      for (const [key, expiry] of this.nextAttempt) if (expiry < now) this.nextAttempt.delete(key);
      const replayKey = `${id}:${auth[2]}`;
      if (this.recentRequests.has(replayKey)) throw requestError("Replayed machine request", 409);
      if (this.inFlight.has(id) || this.inFlight.size >= 4 || this.recentRequests.size >= 4096) {
        throw requestError("Machine tunnel service is busy", 429);
      }
      let input;
      try { input = JSON.parse(bytes); } catch { throw requestError("Invalid machine request", 400); }
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some(key => !["tunnelId", "clusterId", "connectToken"].includes(key)) ||
          !validDevTunnelCoordinates(input)) throw requestError("Invalid tunnel binding", 400);
      try { validateDevTunnelConnectToken(input.connectToken, input, now); }
      catch { throw requestError("Invalid or expired connect-only token", 400); }
      // Fail before contacting Microsoft if this would change an already bound tunnel.
      if (record.tunnel && (record.tunnel.tunnelId !== input.tunnelId || record.tunnel.clusterId !== input.clusterId)) {
        throw requestError("This identity is bound to a different tunnel", 409);
      }
      const claims = JSON.parse(Buffer.from(input.connectToken.split(".")[1], "base64url"));
      if (record.tunnel && claims.exp * 1000 < record.tunnel.expiresAt) {
        throw requestError("Credential rollback is not allowed", 409);
      }
      if ((this.nextAttempt.get(id) ?? 0) > now) throw requestError("Please wait before renewing this node again", 429);
      this.nextAttempt.set(id, now + this.minIntervalMs);
      this.inFlight.add(id);
      this.recentRequests.set(replayKey, now + 240000);
      try {
        await this.verifyAccess(input, input.connectToken);
        const current = await this.accounts.byId(record.ownerId);
        if (!current?.enabled || current.authVersion !== owner.authVersion) {
          throw requestError("Machine authentication failed", 401);
        }
        const result = await this.nodePolicy.updateMachineTunnel(id, input, this.clock());
        reply(res, 200, result);
      } finally { this.inFlight.delete(id); }
    } catch (error) {
      // Never include CLI/SDK errors, authorization values, or token claims in responses/logs.
      reply(res, error.status ?? 502, { error: error.status ? error.message : "Authenticated tunnel validation failed" });
    }
    return true;
  }
}
