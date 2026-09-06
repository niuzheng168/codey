import { MAX_VOICE_BYTES, VOICE_LANGUAGES, VoiceError } from "./voice-service.mjs";

const ROUTE = /^\/cloudcli\/([a-z0-9][a-z0-9_-]{0,31})\/api\/voice\/codey\/(config|transcribe)$/;

function send(req, res, status, value, headers = {}) {
  if (res.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    vary: "Cookie",
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : bytes);
}

function readAudio(req, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => fail(new VoiceError(408, "VOICE_UPLOAD_TIMEOUT", "Audio upload timed out.")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("error", fail);
      req.off("aborted", abort);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error) => {
      cleanup();
      // An aborted IncomingMessage may emit ECONNRESET after its aborted event.
      req.once("error", () => {});
      req.pause();
      reject(error);
    };
    const abort = () => fail(signal.reason || new VoiceError(499, "VOICE_CANCELLED", "Audio upload cancelled."));
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_VOICE_BYTES) { fail(new VoiceError(413, "VOICE_AUDIO_TOO_LARGE", "Audio upload is too large.")); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on("data", data);
    req.on("end", end);
    req.on("error", fail);
    req.on("aborted", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function discardRejectedUpload(req) {
  if (req.complete || req.destroyed) return;
  await new Promise((resolve) => {
    let bytes = 0;
    const finish = () => {
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", finish);
      req.off("close", finish);
      req.off("error", finish);
      req.pause();
      resolve();
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_VOICE_BYTES + 65536) finish();
    };
    const timer = setTimeout(finish, 1500);
    req.on("data", data);
    req.once("end", finish);
    req.once("close", finish);
    req.once("error", finish);
    req.resume();
  });
}

/** Authenticated Codey-only STT endpoints intercepted before the per-VM Workspace proxy. */
export class VoiceGateway {
  constructor(service, { authenticator, nodePolicy, clock = Date.now, uploadTimeoutMs = 20000, leaseMs = 5000 } = {}) {
    Object.assign(this, { service, authenticator, nodePolicy, clock, uploadTimeoutMs, leaseMs });
    this.active = 0;
    this.users = new Map();
  }

  reserve(userId) {
    const now = this.clock();
    for (const [id, state] of this.users) {
      if (!state.active && now - state.since >= 60000) this.users.delete(id);
    }
    const state = this.users.get(userId) || { active: false, since: now, attempts: 0 };
    if (state.active || this.active >= 4 || state.attempts >= 8 || (!this.users.has(userId) && this.users.size >= 512)) {
      throw new VoiceError(429, "VOICE_BUSY", "Voice requests are busy. Please wait and retry.");
    }
    state.active = true;
    state.attempts++;
    this.users.set(userId, state);
    this.active++;
    return () => { state.active = false; this.active--; };
  }

  async handle(req, res, workspaceNodeIds) {
    const url = new URL(req.url, "http://portal.local");
    if (!/^\/cloudcli\/[^/]+\/api\/voice\/codey(?:\/|$)/.test(url.pathname)) return false;
    let release;
    let stopSessionLease;
    let lease;
    const controller = new AbortController();
    const close = () => {
      if (!res.writableFinished) controller.abort(new VoiceError(499, "VOICE_CANCELLED", "Transcription cancelled."));
    };
    res.once("close", close);
    try {
      const match = ROUTE.exec(url.pathname);
      const principal = req.codeyPrincipal;
      if (!principal?.id || !this.authenticator) throw new VoiceError(401, "VOICE_LOGIN_REQUIRED", "Sign in to Codey first.");
      const nodeId = match?.[1];
      if (!match || !workspaceNodeIds.includes(nodeId) || (this.nodePolicy && !await this.nodePolicy.canAccess(principal.id, nodeId))) {
        throw new VoiceError(404, "VOICE_NODE_DENIED", "Workspace not found or not assigned to you.");
      }
      if (match[2] === "config") {
        if (!["GET", "HEAD"].includes(req.method)) throw new VoiceError(405, "VOICE_METHOD_INVALID", "Method not allowed.");
        if (url.search) throw new VoiceError(400, "VOICE_QUERY_INVALID", "Invalid voice query.");
        send(req, res, 200, this.service.publicConfig(principal.id));
        return true;
      }
      if (req.method !== "POST") throw new VoiceError(405, "VOICE_METHOD_INVALID", "Method not allowed.");
      if (!this.authenticator.sameOrigin(req)) throw new VoiceError(403, "VOICE_ORIGIN_DENIED", "Cross-origin voice requests are not allowed.");
      if ([...url.searchParams.keys()].some((key) => !["provider", "language"].includes(key)) ||
          url.searchParams.getAll("provider").length !== 1 || url.searchParams.getAll("language").length > 1) {
        throw new VoiceError(400, "VOICE_QUERY_INVALID", "Invalid voice query.");
      }
      const provider = url.searchParams.get("provider");
      const language = url.searchParams.get("language") || "auto";
      if (!["azure-speech", "mai-transcribe"].includes(provider) || !VOICE_LANGUAGES.includes(language)) {
        throw new VoiceError(400, "VOICE_QUERY_INVALID", "Invalid voice service or language.");
      }
      if (!this.service.configured(provider)) throw new VoiceError(503, "VOICE_NOT_CONFIGURED", "This voice service is not configured.");
      if (!["audio/wav", "audio/x-wav"].includes(String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase())) {
        throw new VoiceError(415, "VOICE_AUDIO_INVALID", "Expected PCM WAV audio.");
      }
      if (Number(req.headers["content-length"] || 0) > MAX_VOICE_BYTES) throw new VoiceError(413, "VOICE_AUDIO_TOO_LARGE", "Audio upload is too large.");
      release = this.reserve(principal.id);
      stopSessionLease = this.authenticator.track(principal, () => {
        controller.abort(new VoiceError(401, "VOICE_LOGIN_REQUIRED", "Your Codey session has expired."));
      });
      let checking = false;
      if (this.nodePolicy) {
        lease = setInterval(async () => {
          if (checking || controller.signal.aborted) return;
          checking = true;
          try {
            if (!await this.nodePolicy.canAccess(principal.id, nodeId)) {
              controller.abort(new VoiceError(403, "VOICE_NODE_DENIED", "Workspace access was revoked."));
            }
          } catch { controller.abort(new VoiceError(503, "VOICE_ACCESS_UNAVAILABLE", "Unable to verify Workspace access.")); }
          finally { checking = false; }
        }, this.leaseMs);
        lease.unref?.();
      }
      const audio = await readAudio(req, controller.signal, this.uploadTimeoutMs);
      const result = await this.service.transcribe({ provider, language, audio, signal: controller.signal });
      controller.signal.throwIfAborted();
      const current = await this.authenticator.principal(req);
      if (!current || current.id !== principal.id) throw new VoiceError(401, "VOICE_LOGIN_REQUIRED", "Your Codey session has expired.");
      if (this.nodePolicy && !await this.nodePolicy.canAccess(principal.id, nodeId)) throw new VoiceError(403, "VOICE_NODE_DENIED", "Workspace access was revoked.");
      send(req, res, 200, result);
    } catch (error) {
      const known = error instanceof VoiceError;
      const status = known ? error.status : 503;
      // Drain a bounded rejected upload before replying so a normal oversized
      // request receives 413 instead of an upload-side TCP reset. Never buffer it.
      await discardRejectedUpload(req);
      if (!req.complete && !req.destroyed) {
        res.setHeader("connection", "close");
        req.once("error", () => {});
        res.once("finish", () => req.destroy());
      }
      send(req, res, status, {
        code: known ? error.code : "VOICE_UNAVAILABLE",
        error: known ? error.message : "Voice service is temporarily unavailable.",
      }, {
        ...(status === 429 ? { "retry-after": "10" } : {}),
        ...(status === 401 ? { "x-auth-error": "session-expired" } : {}),
      });
    } finally {
      clearInterval(lease);
      stopSessionLease?.();
      release?.();
      res.off("close", close);
    }
    return true;
  }
}
