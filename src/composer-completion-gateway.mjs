import { COMPLETION_LIMITS, CompletionError, validateCompletionRequest } from "./composer-completion-service.mjs";

const ROUTE = /^\/cloudcli\/([a-z0-9][a-z0-9_-]{0,31})\/api\/composer\/codey\/(config|complete)$/;

function send(req, res, status, value, headers = {}) {
  if (res.destroyed) return;
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "content-length": body.length,
    "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", vary: "Cookie", ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function readBody(req, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", data); req.off("end", end); req.off("error", fail); req.off("aborted", abort);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true; cleanup(); req.once("error", () => {}); req.pause(); reject(error);
    };
    const abort = () => fail(signal.reason || new CompletionError(499, "COMPLETION_CANCELLED", "Request cancelled."));
    const data = (chunk) => {
      size += chunk.length;
      if (size > COMPLETION_LIMITS.requestBytes) {
        fail(new CompletionError(413, "COMPLETION_INPUT_INVALID", "Request is too large."));
      } else chunks.push(chunk);
    };
    const end = () => {
      if (settled) return;
      settled = true; cleanup(); resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => fail(new CompletionError(408, "COMPLETION_INPUT_TIMEOUT", "Request timed out.")), timeoutMs);
    req.on("data", data); req.on("end", end); req.on("error", fail); req.on("aborted", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function discardBody(req) {
  if (req.complete || req.destroyed) return;
  await new Promise((resolve) => {
    let size = 0;
    const finish = () => {
      clearTimeout(timer);
      req.off("data", data); req.off("end", finish); req.off("close", finish); req.off("error", finish);
      req.pause(); resolve();
    };
    const data = (chunk) => { size += chunk.length; if (size > COMPLETION_LIMITS.requestBytes * 2) finish(); };
    const timer = setTimeout(finish, 500);
    req.on("data", data); req.once("end", finish); req.once("close", finish); req.once("error", finish);
    req.resume();
  });
}

/** Portal-only, authenticated completion endpoints. Never forward draft text or keys to a workspace VM. */
export class ComposerCompletionGateway {
  constructor(service, { authenticator, nodePolicy, clock = Date.now, leaseMs = 1000,
    uploadTimeoutMs = 2000, ratePerMinute = 30, burst = 3, maxActive = 16, dailyLimit } = {}) {
    Object.assign(this, { service, authenticator, nodePolicy, clock, leaseMs, uploadTimeoutMs, ratePerMinute, burst, maxActive });
    this.dailyLimit = dailyLimit ?? service.config?.dailyLimit ?? 1000;
    this.users = new Map();
    this.active = 0;
  }

  reserve(userId) {
    const now = this.clock();
    const day = Math.floor(now / 86400000);
    for (const [id, value] of this.users) {
      if (!value.active && value.day < day) this.users.delete(id);
    }
    const state = this.users.get(userId) ?? { tokens: this.burst, updated: now, active: false, day, attempts: 0 };
    if (state.day !== day) { state.day = day; state.attempts = 0; }
    state.tokens = Math.min(this.burst, state.tokens + Math.max(0, now - state.updated) * this.ratePerMinute / 60000);
    state.updated = now;
    const retryAfter = state.attempts >= this.dailyLimit
      ? Math.ceil(((day + 1) * 86400000 - now) / 1000) : Math.max(2, Math.ceil((1 - state.tokens) * 60 / this.ratePerMinute));
    if (state.active || this.active >= this.maxActive || state.tokens < 1 || state.attempts >= this.dailyLimit ||
        (!this.users.has(userId) && this.users.size >= 512)) {
      throw new CompletionError(429, "COMPLETION_RATE_LIMITED", "Completion quota reached. Please wait.", retryAfter);
    }
    state.tokens--; state.attempts++; state.active = true;
    this.users.set(userId, state); this.active++;
    let released = false;
    return () => { if (!released) { released = true; state.active = false; this.active--; } };
  }

  async handle(req, res, workspaceNodeIds) {
    const url = new URL(req.url, "http://portal.local");
    if (!/^\/cloudcli\/[^/]+\/api\/composer\/codey(?:\/|$)/.test(url.pathname)) return false;
    let release, stopSessionLease, lease;
    const controller = new AbortController();
    const close = () => {
      if (!res.writableFinished) controller.abort(new CompletionError(499, "COMPLETION_CANCELLED", "Request cancelled."));
    };
    res.once("close", close);
    try {
      const match = ROUTE.exec(url.pathname);
      const principal = req.codeyPrincipal;
      if (!principal?.id || !this.authenticator) throw new CompletionError(401, "COMPLETION_LOGIN_REQUIRED", "Sign in first.");
      const nodeId = match?.[1];
      if (!match || !workspaceNodeIds.includes(nodeId) ||
          (this.nodePolicy && !await this.nodePolicy.canAccess(principal.id, nodeId))) {
        throw new CompletionError(404, "COMPLETION_NODE_DENIED", "Workspace not found or not assigned to you.");
      }
      if (url.search) throw new CompletionError(400, "COMPLETION_INPUT_INVALID", "Query parameters are not accepted.");
      if (match[2] === "config") {
        if (!["GET", "HEAD"].includes(req.method)) throw new CompletionError(405, "COMPLETION_METHOD_INVALID", "Method not allowed.");
        send(req, res, 200, { ...this.service.publicConfig(), userId: principal.id });
        return true;
      }
      if (req.method !== "POST") throw new CompletionError(405, "COMPLETION_METHOD_INVALID", "Method not allowed.");
      if (!this.authenticator.sameOrigin(req)) throw new CompletionError(403, "COMPLETION_ORIGIN_DENIED", "Cross-origin request denied.");
      if (!this.service.publicConfig().configured) throw new CompletionError(503, "COMPLETION_DISABLED", "Completion is not available.");
      if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") {
        throw new CompletionError(415, "COMPLETION_INPUT_INVALID", "Expected JSON.");
      }
      if (Number(req.headers["content-length"] || 0) > COMPLETION_LIMITS.requestBytes) {
        throw new CompletionError(413, "COMPLETION_INPUT_INVALID", "Request is too large.");
      }
      release = this.reserve(principal.id);
      stopSessionLease = this.authenticator.track(principal, () =>
        controller.abort(new CompletionError(401, "COMPLETION_LOGIN_REQUIRED", "Your session has expired.")));
      let checking = false;
      if (this.nodePolicy) {
        lease = setInterval(async () => {
          if (checking || controller.signal.aborted) return;
          checking = true;
          try {
            if (!await this.nodePolicy.canAccess(principal.id, nodeId)) {
              controller.abort(new CompletionError(403, "COMPLETION_NODE_DENIED", "Workspace access was revoked."));
            }
          } catch { controller.abort(new CompletionError(503, "COMPLETION_UNAVAILABLE", "Unable to verify access.")); }
          finally { checking = false; }
        }, this.leaseMs);
        lease.unref?.();
      }
      const bytes = await readBody(req, controller.signal, this.uploadTimeoutMs);
      let input;
      try { input = JSON.parse(bytes.toString("utf8")); }
      catch { throw new CompletionError(400, "COMPLETION_INPUT_INVALID", "Invalid JSON."); }
      input = validateCompletionRequest(input);
      const result = await this.service.complete(input, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if ((await this.authenticator.principal(req))?.id !== principal.id) {
        throw new CompletionError(401, "COMPLETION_LOGIN_REQUIRED", "Your session has expired.");
      }
      if (this.nodePolicy && !await this.nodePolicy.canAccess(principal.id, nodeId)) {
        throw new CompletionError(403, "COMPLETION_NODE_DENIED", "Workspace access was revoked.");
      }
      send(req, res, 200, result);
    } catch (error) {
      const known = error instanceof CompletionError;
      const status = known ? error.status : 503;
      await discardBody(req);
      if (!req.complete && !req.destroyed) {
        res.setHeader("connection", "close"); req.once("error", () => {});
        res.once("finish", () => req.destroy());
      }
      send(req, res, status, {
        code: known ? error.code : "COMPLETION_UNAVAILABLE",
        error: known ? error.message : "Completion is temporarily unavailable.",
      }, {
        ...(status === 429 ? { "retry-after": String(error.retryAfter || 10) } : {}),
        ...(status === 401 ? { "x-auth-error": "session-expired" } : {}),
      });
    } finally {
      clearInterval(lease); stopSessionLease?.(); release?.(); res.off("close", close);
    }
    return true;
  }
}
