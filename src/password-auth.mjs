import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, unlink, utimes, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const HASH_OPTIONS = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 });
const COOKIE_NAME = "__Host-codey_session";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS = 5;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const AUTH_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
});

const digest = (value) => createHash("sha256").update(value).digest("hex");

async function touchSessionFile(file, now) {
  try {
    await utimes(file, new Date(now), new Date(now));
  } catch (error) {
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
    // Azure Files may report uid 0 and deny SETATTR to the non-root app while
    // allowing writes. Rewriting the existing opening brace updates mtime
    // without altering the signed JSON or requiring broader mount permissions.
    // r+ MUST NOT create a deleted/logout session, even in a concurrent request.
    const handle = await open(file, "r+");
    try { await handle.write("{", 0, "utf8"); }
    finally { await handle.close(); }
  }
}

/** Used by the deployment helper; plaintext passwords are never persisted. */
export async function hashPassword(password) {
  const salt = randomBytes(32);
  const result = await derive(password, salt, 64, HASH_OPTIONS);
  return `scrypt-v1$${salt.toString("base64url")}$${result.toString("base64url")}`;
}

function parsePasswordHash(value) {
  const match = /^scrypt-v1\$([A-Za-z0-9_-]{43})\$([A-Za-z0-9_-]{86})$/.exec(value ?? "");
  if (!match) throw new Error("Invalid configured password hash");
  return { salt: Buffer.from(match[1], "base64url"), hash: Buffer.from(match[2], "base64url") };
}

function tokenFromCookie(req) {
  const matches = String(req.headers.cookie ?? "").split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${COOKIE_NAME}=`));
  // Duplicate security cookies are ambiguous; never select an attacker's one.
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE_NAME.length + 1);
  return SESSION_PATTERN.test(token) ? token : null;
}

function respond(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(
    typeof body === "string" ? body : JSON.stringify(body),
  );
  res.writeHead(status, { ...AUTH_HEADERS, "content-type": type, "content-length": bytes.length, ...headers });
  res.end(bytes);
}

async function loginBody(req) {
  if (String(req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") {
    throw Object.assign(new Error("Expected JSON"), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

/** Password-mode authentication, shared by HTTP routes and Workspace upgrades. */
export class PasswordAuthenticator {
  constructor({ credential, accountStore, root, publicBaseUrl, staticRoot, clock = Date.now, sessionTtlMs = 8 * 60 * 60 * 1000, idleTtlMs = 30 * 60 * 1000, leaseIntervalMs = 5000 }) {
    if (!credential || !/^[a-z][a-z0-9_-]{0,31}$/.test(credential.username ?? "") ||
        !/^[a-z0-9-]{1,80}$/.test(credential.principalId ?? "")) {
      throw new Error("A single valid password account is required");
    }
    this.password = parsePasswordHash(credential.passwordHash);
    this.version = digest(JSON.stringify(credential));
    this.user = Object.freeze({ id: credential.principalId, name: credential.username, role: "admin" });
    this.accountStore = accountStore;
    this.multiUser = Boolean(accountStore);
    this.origin = new URL(publicBaseUrl).origin;
    if (!this.origin.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(this.origin)) {
      throw new Error("Password login requires an HTTPS public origin");
    }
    if (!root) throw new Error("A persistent password session directory is required");
    this.root = path.resolve(root);
    this.staticRoot = staticRoot;
    this.clock = clock;
    this.sessionTtlMs = sessionTtlMs;
    this.idleTtlMs = idleTtlMs;
    this.leaseIntervalMs = leaseIntervalMs;
    this.connections = new Map();
    this.verifying = false;
  }

  /** Strict Origin checking is required for unsafe HTTP methods and every WS handshake. */
  sameOrigin(req) {
    if (req.headers.origin !== this.origin) return false;
    const site = req.headers["sec-fetch-site"];
    return !site || site === "same-origin";
  }

  reject(req, res) {
    const url = new URL(req.url, this.origin);
    const navigation = req.method === "GET" &&
      (req.headers["sec-fetch-mode"] === "navigate" || String(req.headers.accept ?? "").includes("text/html") || url.pathname === "/");
    if (navigation) {
      respond(res, 302, "", "text/plain", { location: "/portal-auth/login" });
    } else {
      respond(res, 401, { error: "请先登录 Codey", code: "AUTH_TOKEN_EXPIRED" }, undefined, { "x-auth-error": "session-expired" });
    }
  }

  async #reserveLoginAttempt(username) {
    // Exclusive file creation is atomic across ACA replicas sharing Azure Files.
    // Slots count ALL attempts and survive restart; forged client IPs cannot
    // bypass this small single-account deployment's global guessing limit.
    const bucket = Math.floor(this.clock() / LOGIN_WINDOW_MS);
    const directory = path.join(this.root, "login-limits");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const reserve = async (prefix, maximum) => {
      for (let slot = 0; slot < maximum; slot++) {
        try {
          await writeFile(path.join(directory, `${prefix}-${slot}`), "", { flag: "wx", mode: 0o600 });
          return;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      throw Object.assign(new Error("登录尝试过多，请稍后再试"), {
        status: 429,
        retryAfter: Math.ceil(((bucket + 1) * LOGIN_WINDOW_MS - this.clock()) / 1000),
      });
    };
    if (this.multiUser) {
      // A busy user's normal logins do not consume another user's five slots.
      // The additional global cap bounds CPU/storage attacks using made-up names.
      await reserve(`${bucket}-global`, 100);
      await reserve(`${bucket}-user-${digest(username).slice(0, 32)}`, LOGIN_ATTEMPTS);
    } else {
      await reserve(String(bucket), LOGIN_ATTEMPTS);
    }
  }

  async #account({ username, id }) {
    if (!this.accountStore) {
      if ((username !== undefined && username !== this.user.name) ||
          (id !== undefined && id !== this.user.id)) return null;
      return { user: this.user, password: this.password, version: this.version };
    }
    const account = id !== undefined
      ? await this.accountStore.byId(id)
      : await this.accountStore.byUsername(username);
    if (!account?.enabled) return null;
    return {
      user: { id: account.principalId, name: account.username, role: account.role },
      password: parsePasswordHash(account.passwordHash),
      version: account.authVersion,
    };
  }

  async #verifyPassword(username, password) {
    username = typeof username === "string" ? username.trim().toLowerCase().slice(0, 64) : "";
    if (this.verifying) throw Object.assign(new Error("请稍后重试"), { status: 429, retryAfter: 2 });
    this.verifying = true;
    try {
      await this.#reserveLoginAttempt(username);
      const account = await this.#account({ username });
      const safePassword = typeof password === "string" && password.length <= 1024 ? password : "";
      const verifier = account?.password ?? this.password;
      const candidate = await derive(safePassword, verifier.salt, 64, HASH_OPTIONS);
      if (!timingSafeEqual(candidate, verifier.hash) || !account || !safePassword) {
        throw Object.assign(new Error("用户名或密码错误"), { status: 401 });
      }
      return account;
    } finally { this.verifying = false; }
  }

  async verifyCurrentPassword(principal, password) {
    const account = await this.#verifyPassword(principal.name, password);
    if (account.user.id !== principal.id) throw Object.assign(new Error("身份不匹配"), { status: 403 });
    return account.version;
  }

  async login(username, password) {
    const account = await this.#verifyPassword(username, password);
    const token = randomBytes(32).toString("base64url");
    const sessionId = digest(token);
    const expiresAt = this.clock() + this.sessionTtlMs;
    await mkdir(path.join(this.root, "sessions"), { recursive: true, mode: 0o700 });
    const file = path.join(this.root, "sessions", `${sessionId}.json`);
    const record = { version: account.version, expiresAt, userId: account.user.id };
    record.mac = this.#sessionMac(sessionId, record, account);
    await writeFile(file, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    await touchSessionFile(file, this.clock());
    return {
      principal: { ...account.user, sessionId, expiresAt },
      cookie: `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(this.sessionTtlMs / 1000)}`,
    };
  }

  #sessionMac(id, record, account) {
    return createHmac("sha256", account.password.hash)
      .update(`codey-session-v1:${id}:${record.version}:${record.userId}:${record.expiresAt}`)
      .digest("base64url");
  }

  async #readSession(sessionId, touch = false) {
    if (!/^[a-f0-9]{64}$/.test(sessionId)) return null;
    const file = path.join(this.root, "sessions", `${sessionId}.json`);
    try {
      const [raw, metadata] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      const value = JSON.parse(raw);
      if (typeof value.userId !== "string") return null;
      const account = await this.#account({ id: value.userId });
      if (!account) return null;
      const expectedMac = this.#sessionMac(sessionId, value, account);
      if (typeof value.mac !== "string" || value.mac.length !== expectedMac.length ||
          !timingSafeEqual(Buffer.from(value.mac), Buffer.from(expectedMac))) return null;
      if (value.version !== account.version || value.userId !== account.user.id ||
          !Number.isFinite(value.expiresAt) || value.expiresAt <= this.clock() ||
          metadata.mtimeMs + this.idleTtlMs <= this.clock()) return null;
      if (touch) await touchSessionFile(file, this.clock());
      return { ...account.user, sessionId, expiresAt: value.expiresAt };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      // Storage outages/corrupt records must fail closed, never fall back to AAD.
      throw new Error("Password session storage unavailable", { cause: error });
    }
  }

  async principal(req, { touch = true } = {}) {
    const token = tokenFromCookie(req);
    return token ? this.#readSession(digest(token), touch) : null;
  }

  async revoke(req) {
    const token = tokenFromCookie(req);
    if (!token) return;
    const id = digest(token);
    await unlink(path.join(this.root, "sessions", `${id}.json`)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    for (const close of [...(this.connections.get(id) ?? [])]) close();
  }

  /** Bound all proxied HTTP streams and sockets to the revocable portal session. */
  track(principal, close) {
    if (!principal?.sessionId) throw new Error("Workspace requires a portal session");
    const id = principal.sessionId;
    const callbacks = this.connections.get(id) ?? new Set();
    this.connections.set(id, callbacks);
    let finished = false;
    const disconnect = () => {
      if (finished) return;
      cleanup();
      close();
    };
    const timer = setInterval(() => {
      // Polling does not extend idle time. Only real authenticated HTTP
      // activity/explicit frontend heartbeat can keep a session alive.
      this.#readSession(id).then((value) => { if (!value) disconnect(); }).catch(disconnect);
    }, this.leaseIntervalMs);
    timer.unref?.();
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      callbacks.delete(disconnect);
      if (!callbacks.size) this.connections.delete(id);
    };
    callbacks.add(disconnect);
    return cleanup;
  }

  async handle(req, res) {
    const url = new URL(req.url, this.origin);
    const pathname = url.pathname;
    if (!pathname.startsWith("/portal-auth/")) return false;
    try {
      const files = {
        "/portal-auth/login": ["login.html", "text/html; charset=utf-8"],
        "/portal-auth/login.js": ["login.js", "text/javascript; charset=utf-8"],
        "/portal-auth/login.css": ["login.css", "text/css; charset=utf-8"],
      };
      if (req.method === "GET" && files[pathname]) {
        const [name, type] = files[pathname];
        respond(res, 200, await readFile(path.join(this.staticRoot, name)), type);
        return true;
      }
      if (req.method === "GET" && pathname === "/portal-auth/session") {
        const principal = await this.principal(req);
        if (!principal) this.reject(req, res);
        else respond(res, 200, {
          authenticated: true, username: principal.name, userId: principal.id,
          role: principal.role, multiUser: this.multiUser, expiresAt: principal.expiresAt,
        });
        return true;
      }
      if (req.method === "POST" && ["/portal-auth/login", "/portal-auth/logout"].includes(pathname)) {
        if (!this.sameOrigin(req)) {
          respond(res, 403, { error: "不允许跨站登录或操作" });
          return true;
        }
        if (pathname.endsWith("/logout")) {
          await this.revoke(req);
          respond(res, 200, { ok: true }, undefined, {
            "set-cookie": [
              `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
              "codey_aad=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
            ],
            "clear-site-data": '"cache", "storage"',
          });
        } else {
          const body = await loginBody(req);
          const result = await this.login(body?.username, body?.password);
          // Re-login rotates the session instead of leaving its old cookie valid.
          await this.revoke(req);
          respond(res, 200, { ok: true, username: result.principal.name, userId: result.principal.id }, undefined, { "set-cookie": result.cookie });
        }
        return true;
      }
      // This also disables the previous AAD start/callback/session-mint routes.
      respond(res, 404, { error: "Not found" });
    } catch (error) {
      respond(res, error.status ?? 503, { error: error.status ? error.message : "登录服务暂不可用" }, undefined,
        error.retryAfter ? { "retry-after": String(error.retryAfter) } : {});
    }
    return true;
  }
}
