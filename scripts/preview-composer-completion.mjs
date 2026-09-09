// Local-only rehearsal: no Azure management calls, VM proxy, agent runtime, production data, git commit or publish.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { cp, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { ComposerCompletionService, resolveComposerCompletionConfig } from "../src/composer-completion-service.mjs";
import { ComposerCompletionGateway } from "../src/composer-completion-gateway.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  port: { type: "string", default: "4311" },
  "data-dir": { type: "string" },
  "env-file": { type: "string", default: path.join(ROOT, ".env") },
  "real-model": { type: "boolean", default: false },
  "skip-build": { type: "boolean", default: false },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3001, 4141, 8443, 4310].includes(port)) {
  throw new Error("Use a separate unprivileged preview port (default 4311).");
}
const directory = path.resolve(values["data-dir"] || path.join(ROOT, "artifacts", `composer-preview-${Date.now()}`));
if (!directory.startsWith(path.join(ROOT, "artifacts") + path.sep)) throw new Error("Preview data must stay under this repository's ignored artifacts/ directory.");
await mkdir(directory, { recursive: true, mode: 0o700 });
const publicRoot = path.join(directory, "public");
const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const snapshot = path.join(directory, "source");
const markerFile = path.join(directory, "preview-marker.json");
try {
  const marker = JSON.parse(await readFile(markerFile, "utf8"));
  if (marker.kind !== "codey-composer-local-preview") throw new Error("Not an owned preview directory.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(markerFile, JSON.stringify({ kind: "codey-composer-local-preview", createdAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
}

if (!values["skip-build"]) {
  await mkdir(snapshot, { recursive: false, mode: 0o700 });
  const inputs = ["src", "shared", "public", "package.json", "package-lock.json", "vite.config.js",
    "tsconfig.json", "tailwind.config.js", "postcss.config.js"];
  for (const input of inputs) await cp(path.join(ROOT, "cloudcli", input), path.join(snapshot, input), { recursive: true });
  await symlink(path.join(ROOT, "cloudcli/node_modules"), path.join(snapshot, "node_modules"), "dir");
  const resources = {};
  for (const language of ["en", "zh-CN"]) {
    resources[language] = {};
    for (const namespace of ["chat", "common"]) {
      resources[language][namespace] = JSON.parse(await readFile(
        path.join(ROOT, "cloudcli/src/modules/i18n/locales", language, `${namespace}.json`), "utf8"));
    }
  }
  const resourcesJson = JSON.stringify(resources).replace(/</g, "\\u003c");
  await writeFile(path.join(snapshot, "index.html"), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codey · Local completion preview</title>
<script>window.__CLOUDCLI_BASE_PATH__="/cloudcli/local-preview/";window.__ROUTER_BASENAME__="/cloudcli/local-preview";</script>
<script id="preview-messages" type="application/json">${resourcesJson}</script>
<script id="preview-runtime" type="application/json">${JSON.stringify({ realModel: values["real-model"] })}</script>
</head><body><div id="root"></div>
<script type="module" src="/src/modules/chat/tests/fixtures/ComposerCompletionPreview.tsx"></script></body></html>`);
  const buildHome = path.join(directory, "build-home");
  await mkdir(buildHome, { mode: 0o700 });
  // No .env or model credential can enter the frontend build environment.
  await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "build:client", "--", "--outDir", publicRoot], {
      cwd: snapshot, stdio: ["ignore", "inherit", "inherit"],
      env: { PATH: process.env.PATH, HOME: buildHome, NODE_ENV: "production",
        VITE_IS_PLATFORM: "false", VITE_CODEY_MANAGED: "true", VITE_CODEY_PORTAL_SSO: "true", VITE_BASE_PATH: "/" },
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Preview frontend build failed (${code})`)));
  });
} else {
  await stat(path.join(publicRoot, "index.html"));
  const html = await readFile(path.join(publicRoot, "index.html"), "utf8");
  if (!html.includes(JSON.stringify({ realModel: values["real-model"] }))) throw new Error("The existing preview build uses a different mock/real mode.");
}

// Read only the bindings required for this preview, after its client has been built.
const variables = values["real-model"] ? parseEnv(await readFile(path.resolve(values["env-file"]), "utf8")) : {
  FOUNDRY_ENDPOINT: "https://local-preview.openai.azure.com", FOUNDRY_API_KEY: "mock-only-not-a-real-api-key",
};
const selected = {};
for (const key of ["FOUNDRY_ENDPOINT", "FOUNDRY_API_KEY", "FOUNDRY_KEY", "COMPOSER_COMPLETION_ENDPOINT", "COMPOSER_COMPLETION_API_KEY"]) {
  if (variables[key]) selected[key] = variables[key];
}
const config = resolveComposerCompletionConfig({
  ...selected, COMPOSER_COMPLETION_ENABLED: "true", COMPOSER_COMPLETION_SINGLE_INSTANCE: "true",
  COMPOSER_COMPLETION_DEPLOYMENT: "gpt-5.6-luna", COMPOSER_COMPLETION_REASONING_EFFORT: "none",
  COMPOSER_COMPLETION_TIMEOUT_MS: "2000", COMPOSER_COMPLETION_DAILY_LIMIT: "1000",
});
if (!config.configured) throw new Error("A valid local Foundry binding is required; no model call has been made.");

const password = randomBytes(15).toString("base64url");
const passwordHash = createHash("sha256").update(password).digest();
const sessions = new Map();
const listeners = new Map();
const loginAttempts = [];
const metrics = { requests: 0, modelNetworkCalls: 0, upstreamStatuses: [], startedAt: new Date().toISOString() };
const COOKIE = "codey_completion_preview";
const auth = {
  sameOrigin(req) {
    return origins.has(req.headers.origin) && (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin");
  },
  async principal(req) {
    const token = String(req.headers.cookie || "").split(/;\s*/).find((part) => part.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const sessionId = createHash("sha256").update(token).digest("hex");
    const session = sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) return null;
    return { id: "local-preview-user", sessionId, expiresAt: session.expiresAt };
  },
  track(principal, stop) {
    const timer = setTimeout(stop, Math.max(0, principal.expiresAt - Date.now()));
    timer.unref();
    const set = listeners.get(principal.sessionId) ?? new Set();
    set.add(stop); listeners.set(principal.sessionId, set);
    return () => { clearTimeout(timer); set.delete(stop); if (!set.size) listeners.delete(principal.sessionId); };
  },
};
const broker = new ComposerCompletionService(config, {
  fetchImpl: async (...args) => {
    metrics.requests++;
    if (values["real-model"]) {
      metrics.modelNetworkCalls++;
      const result = await fetch(...args);
      metrics.upstreamStatuses = [...metrics.upstreamStatuses, result.status].slice(-20);
      return result;
    }
    return new Response(JSON.stringify({
      status: "completed", output: [{ type: "message", role: "assistant", content: [
        { type: "output_text", text: JSON.stringify({ suffix: "（本地模拟建议）" }) },
      ] }],
    }));
  },
});
const gateway = new ComposerCompletionGateway(broker, {
  authenticator: auth, nodePolicy: { canAccess: async (id, node) => id === "local-preview-user" && node === "local-preview" },
});
const state = { preferences: { composerPreferences: { completionEnabled: false, useHistory: true }, uiPreferences: { voiceEnabled: false } }, drafts: new Map() };
const commonHeaders = {
  "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
function send(res, status, value, contentType = "application/json; charset=utf-8", extra = {}) {
  const body = typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value);
  res.writeHead(status, { ...commonHeaders, "content-type": contentType, ...extra });
  res.end(body);
}
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error("Preview request too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const loginHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codey local preview login</title><body style="font-family:system-ui;max-width:440px;margin:12vh auto;padding:20px">
<h1>Codey · 本地试用</h1><p>独立测试环境，不是生产登录。密码见试用目录的 access.txt。</p>
<form><label>试用密码 <input name="password" type="password" autocomplete="current-password" required style="padding:10px"></label>
<button style="padding:12px;margin:12px 0" type="submit">进入试用</button><p role="status"></p></form>
<script>document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/preview/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:new FormData(e.target).get('password')})});if(r.ok)location.replace('/');else document.querySelector('[role=status]').textContent='密码不正确或请求过于频繁。';});</script></body></html>`;
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" };
const server = http.createServer(async (req, res) => {
  try {
    if (!hosts.has(req.headers.host)) { send(res, 403, { error: "Loopback preview host required." }); return; }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/preview/login") {
      if (req.method === "GET") { send(res, 200, loginHtml, "text/html; charset=utf-8"); return; }
      if (req.method !== "POST" || !auth.sameOrigin(req)) { send(res, 403, { error: "Origin denied." }); return; }
      while (loginAttempts[0] < Date.now() - 60000) loginAttempts.shift();
      if (loginAttempts.length >= 10) { send(res, 429, { error: "Please wait." }); return; }
      loginAttempts.push(Date.now());
      const body = await readJson(req);
      const actual = createHash("sha256").update(String(body.password || "")).digest();
      if (!timingSafeEqual(actual, passwordHash)) { send(res, 401, { error: "Invalid preview password." }); return; }
      for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(id);
      if (sessions.size >= 20) { send(res, 429, { error: "Too many preview sessions." }); return; }
      const token = randomBytes(32).toString("base64url");
      sessions.set(createHash("sha256").update(token).digest("hex"), { expiresAt: Date.now() + 8 * 3600000 });
      send(res, 200, { ok: true }, undefined, { "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800` });
      return;
    }
    const principal = await auth.principal(req);
    if (!principal) {
      send(res, req.method === "GET" && (url.pathname === "/" || req.headers.accept?.includes("text/html")) ? 302 : 401,
        { error: "Local preview login required." }, undefined, { location: "/preview/login" }); return;
    }
    req.codeyPrincipal = principal;
    if (url.pathname === "/preview/logout" && req.method === "POST" && auth.sameOrigin(req)) {
      for (const stop of listeners.get(principal.sessionId) ?? []) stop();
      sessions.delete(principal.sessionId);
      send(res, 200, { ok: true }, undefined, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
      return;
    }
    if (await gateway.handle(req, res, ["local-preview"])) return;
    if (!["GET", "HEAD"].includes(req.method) && !auth.sameOrigin(req)) { send(res, 403, { error: "Origin denied." }); return; }
    if (url.pathname === "/preview/status") {
      send(res, 200, { localOnly: true, realModel: values["real-model"], model: "gpt-5.6-luna", pid: process.pid,
        productionNodeConnections: 0, ...metrics }); return;
    }
    const apiPath = url.pathname.replace(/^\/cloudcli\/local-preview/, "");
    if (apiPath === "/api/user/preferences") {
      if (req.method === "PATCH") {
        const updates = await readJson(req);
        if (!updates || typeof updates !== "object" || Array.isArray(updates)) throw new Error("Invalid preferences.");
        state.preferences = { ...state.preferences, ...updates };
      } else if (req.method !== "GET") { send(res, 405, { error: "Method denied." }); return; }
      send(res, 200, { success: true, preferences: state.preferences }); return;
    }
    if (apiPath === "/api/user/drafts") {
      if (["PUT", "DELETE"].includes(req.method)) {
        const body = await readJson(req);
        if (!["preview-a", "preview-b"].includes(body.scope)) throw new Error("Not a preview draft.");
        if (req.method === "DELETE") state.drafts.delete(body.scope);
        else state.drafts.set(body.scope, {
          scope: body.scope, text: String(body.text || ""),
          queuedMessage: body.preserveQueuedMessage === true
            ? state.drafts.get(body.scope)?.queuedMessage ?? null : body.queuedMessage ?? null,
        });
      } else if (req.method !== "GET") { send(res, 405, { error: "Method denied." }); return; }
      send(res, 200, { success: true, drafts: [...state.drafts.values()] }); return;
    }
    if (apiPath === "/api/user/drafts/steer" && req.method === "POST") {
      const body = await readJson(req);
      const draft = state.drafts.get(body.scope);
      const accepted = Boolean(draft?.queuedMessage?.id && draft.queuedMessage.id === body.queuedMessage?.id);
      if (accepted) state.drafts.set(body.scope, { ...draft, queuedMessage: null });
      send(res, 200, {
        kind: "chat_steer_result", sessionId: body.scope, requestId: body.requestId,
        accepted, ...(!accepted ? { error: "Preview queue changed." } : {}),
      }); return;
    }
    if (apiPath === "/api/commands/list") { await readJson(req); send(res, 200, { builtIn: [], custom: [] }); return; }
    if (/^\/api\/providers\/[^/]+\/skills$/.test(apiPath)) { send(res, 200, { data: { skills: [] } }); return; }
    if (/^\/api\/file-tree\/projects\/[^/]+\/files$/.test(apiPath)) { send(res, 200, []); return; }
    if (apiPath === "/api/voice/health") { send(res, 200, { available: false, status: "disabled" }); return; }
    if (apiPath.startsWith("/api/") || url.pathname.startsWith("/cloudcli/") || !["GET", "HEAD"].includes(req.method)) {
      send(res, 404, { error: "No real backend, file operations or agents in this preview." }); return;
    }
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    if (relative.split("/").some((part) => part.startsWith("."))) { send(res, 404, { error: "Not found." }); return; }
    const file = await realpath(path.join(publicRoot, relative));
    if (!file.startsWith(publicRoot + path.sep) || !(await stat(file)).isFile()) { send(res, 404, { error: "Not found." }); return; }
    send(res, 200, req.method === "HEAD" ? "" : await readFile(file), mime[path.extname(file)] || "application/octet-stream");
  } catch {
    if (!res.headersSent && !res.destroyed) send(res, 400, { error: "Preview request failed." });
    else res.destroy();
  }
});
server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.on("upgrade", (_req, socket) => socket.destroy());
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
await writeFile(path.join(directory, "access.txt"), `URL: http://127.0.0.1:${port}\nPreview password: ${password}\nOnly local synthetic conversations; no production access.\n`, { mode: 0o600 });
await writeFile(path.join(directory, "runtime.json"), JSON.stringify({
  pid: process.pid, port, url: `http://127.0.0.1:${port}`, directory, realModel: values["real-model"],
  startedAt: metrics.startedAt, productionChanges: 0,
}, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, realModel: values["real-model"], accessFile: path.join(directory, "access.txt") }));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  for (const set of listeners.values()) for (const stop of set) stop();
  server.closeAllConnections(); server.close(() => process.exit(0));
});
