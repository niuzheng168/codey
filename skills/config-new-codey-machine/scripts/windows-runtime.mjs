/** Native installer probes/token renewal, shared by Windows and macOS. */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativePlatform, registrationDocument as nativeRegistrationDocument, verifyRegistrationFile, writeRegistration } from "./registration.mjs";

const exec = promisify(execFile);
const read = async file => JSON.parse(await readFile(file, "utf8"));
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

export function parseTunnelJson(text) {
  try {
    const source = text.replace(/^\uFEFF/, "");
    const start = source.search(/^\s*\{/m);
    requireValue(start >= 0, "");
    const value = JSON.parse(source.slice(start));
    requireValue(value && typeof value === "object" && !Array.isArray(value), "");
    return value;
  } catch { throw new Error("DevTunnel did not return a valid JSON object"); }
}

export function validateTunnel(raw, expectedId) {
  const tunnel = raw?.tunnel ?? raw;
  let { tunnelId, clusterId } = tunnel ?? {};
  if (typeof tunnelId === "string" && tunnelId.includes(".")) {
    const parts = tunnelId.split(".");
    requireValue(parts.length === 2 && (!clusterId || clusterId === parts[1]), "Invalid tunnel coordinates");
    [tunnelId, clusterId] = parts;
  }
  requireValue(tunnelId === expectedId && /^[a-z][a-z0-9]{1,15}$/.test(clusterId ?? ""), "Unexpected tunnel identity");
  const ports = tunnel.ports;
  requireValue(Array.isArray(ports) && ports.length === 2 &&
    [3001, 8443].every(port => ports.some(item => item.portNumber === port && item.protocol === "https")),
  "Only private HTTPS ports 3001 and 8443 may be forwarded");
  for (const item of [tunnel, ...ports]) {
    const acl = item.accessControl;
    const entries = acl == null ? [] : Array.isArray(acl) ? acl : acl.entries;
    requireValue(Array.isArray(entries), "Invalid tunnel access policy");
    requireValue(!entries.some(entry => String(entry.type).toLowerCase() === "anonymous" && entry.isDeny !== true),
      "Anonymous tunnel access is forbidden");
  }
  return { tunnelId, clusterId };
}

export function validateConnectToken(value, coordinates, now = Date.now()) {
  const token = value?.token ?? value?.accessToken;
  requireValue(typeof token === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token),
    "Invalid connect credential");
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url")); }
  catch { throw new Error("Invalid connect credential"); }
  requireValue(claims.scp === "connect" && claims.tunnelId === coordinates.tunnelId &&
    claims.clusterId === coordinates.clusterId && Number.isInteger(claims.exp) &&
    claims.exp > now / 1000 + 3600 && claims.exp <= now / 1000 + 86400 + 300,
  "Wrong scope, tunnel or expiry on connect credential");
  return token;
}

export function clientTicket(identity, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1, aud: identity.nodeId, sub: identity.workspaceSubject,
    scope: ["history", "usage"], iat, exp: iat + 60,
  })).toString("base64url");
  return `${payload}.${createHmac("sha256", identity.clientSigningKey).update(payload).digest("base64url")}`;
}

export function workspaceAssertion(identity, target, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: "codey-portal", aud: identity.nodeId, sub: identity.workspaceSubject,
    username: identity.workspaceUsername, sid: randomBytes(32).toString("hex"),
    method: "GET", path: target, iat, exp: iat + 20, nonce: randomBytes(16).toString("base64url"),
  })).toString("base64url");
  return `${payload}.${createHmac("sha256", Buffer.from(identity.workspaceSsoKey, "base64url"))
    .update(payload).digest("base64url")}`;
}

export function request(options, body) {
  return new Promise((resolve, reject) => {
    const client = options.protocol === "http:" ? http : https;
    const req = client.request(options, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { response.destroy(new Error("Probe response too large")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode, body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.setTimeout(15000, () => req.destroy(new Error("Probe timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

export async function verifyGateway(config) {
  const result = await request({
    protocol: "http:", hostname: "127.0.0.1", port: 4141, path: "/models",
    headers: { authorization: `Bearer ${config.modelKey}` },
  });
  requireValue(result.status === 200 && Array.isArray(JSON.parse(result.body).data), "Authenticated model catalog failed");
  const anonymous = await request({ protocol: "http:", hostname: "127.0.0.1", port: 4141, path: "/models" });
  requireValue(anonymous.status === 401, "Model gateway must reject anonymous requests");
}

export async function verifyLocal(config) {
  await verifyGateway(config);
  const identity = await read(config.identityFile);
  const ca = await readFile(config.certificate, "utf8");
  const local = (port, target, headers = {}) => request({
    protocol: "https:", hostname: "127.0.0.1", servername: config.serverName,
    ca, rejectUnauthorized: true, port, path: target, headers,
  });
  const target = "/api/auth/status";
  requireValue((await local(3001, target)).status === 401, "Workspace anonymous access was not rejected");
  const workspace = await local(3001, target, { "x-codey-workspace-assertion": workspaceAssertion(identity, target) });
  requireValue(workspace.status === 200, "Authenticated Workspace SSO failed");
  JSON.parse(workspace.body);
  const dataPath = "/token-usage/events?limit=1";
  requireValue((await local(8443, dataPath)).status === 401, "Data gateway anonymous access was not rejected");
  const data = await local(8443, dataPath, { authorization: `Bearer ${clientTicket(identity)}` });
  requireValue(data.status === 200, "Authenticated data gateway failed");
  JSON.parse(data.body);
  return { tls: true, models: true, dataAuthentication: true, workspaceSso: true, anonymousDenied: true };
}

export function registrationDocument(setup, identity, coordinates, token, certificate, computer) {
  requireValue(setup.platform === "windows-x64", "Windows registration requires a Windows package");
  return nativeRegistrationDocument(setup, identity, coordinates, token, certificate, computer);
}

async function tokenFor(config, coordinates) {
  const result = await exec(config.devtunnelExe, [
    "token", `${coordinates.tunnelId}.${coordinates.clusterId}`, "--scope", "connect", "--json",
  ], { windowsHide: true, timeout: 60000, maxBuffer: 32768 });
  return validateConnectToken(parseTunnelJson(result.stdout), coordinates);
}

async function renew(config, identity, coordinates, token) {
  const origin = new URL(config.portalOrigin);
  requireValue(origin.protocol === "https:" && origin.origin === config.portalOrigin, "Invalid portal origin");
  const target = `/api/machine-tunnels/${identity.nodeId}/token`;
  const body = JSON.stringify({ ...coordinates, connectToken: token });
  const now = Date.now();
  const nonce = randomBytes(16).toString("base64url");
  const message = `POST\n${target}\n${now}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`;
  const signature = createHmac("sha256", Buffer.from(identity.tunnelUpdateKey, "base64url"))
    .update(message).digest("base64url");
  const result = await request({
    protocol: "https:", hostname: origin.hostname, port: origin.port || 443, method: "POST", path: target,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
      authorization: `CodeyTunnel ${now}:${nonce}:${signature}` },
  }, body);
  requireValue(result.status === 200, "Token renewal rejected; import registration in the Portal first");
}

async function sdkProbe(config) {
  // Exercise the SDK JS inlined into the single installed Codey package.
  const sdk = path.join(config.codeyDirectory, "lib/codex-sdk/index.js");
  const { Codex } = await import(pathToFileURL(sdk).href);
  const codex = new Codex({ codexPathOverride: config.codexExe, env: {
    ...process.env, CODEX_HOME: config.codexHome, CODEY_MODEL_API_KEY: config.modelKey,
  } });
  const thread = codex.startThread({
    workingDirectory: config.ownerHome, skipGitRepoCheck: true, sandboxMode: "danger-full-access",
    approvalPolicy: "never", model: "gpt-6-astra", modelReasoningEffort: "max",
  });
  const answer = await thread.run("Reply with only CODEY_CLOUDCLI_OK. Do not use tools.");
  requireValue(answer.finalResponse.trim() === "CODEY_CLOUDCLI_OK", "CloudCLI Codex response mismatch");
}

async function main() {
  const [command, file] = process.argv.slice(2);
  if (command === "check-tunnel") {
    console.log(JSON.stringify(validateTunnel(await read(file), process.argv[4])));
    return;
  }
  const config = await read(file);
  const target = nativePlatform();
  requireValue(config.kind === (target === "windows-x64" ? "codey-windows-oneclick" : "codey-macos-oneclick") &&
    (target === "windows-x64" || config.platform === target) && config.schema === 2 &&
    config.layout === "npm-codey-package", "Invalid runtime configuration");
  if (command === "gateway") { await verifyGateway(config); return; }
  if (command === "verify") { console.log(JSON.stringify(await verifyLocal(config))); return; }
  if (command === "sdk-probe") { await sdkProbe(config); console.log("CODEY_CLOUDCLI_OK"); return; }
  if (command === "check-registration") {
    const setup = await read(config.setupFile);
    await verifyRegistrationFile(process.argv[5], { ...setup, platform: target });
    return;
  }
  const identity = await read(config.identityFile);
  const coordinates = validateTunnel(await read(config.tunnelFile), `codey-${identity.nodeId}`);
  if (command === "tunnel") { console.log(JSON.stringify(coordinates)); return; }
  requireValue(command === "renew" || command === "registration", "Unsupported runtime operation");
  if (command === "registration") await verifyLocal(config);
  const token = await tokenFor(config, coordinates);
  if (command === "renew") { await renew(config, identity, coordinates, token); return; }
  const setup = await read(config.setupFile);
  requireValue(setup.platform === target, "Registration platform does not match this native host");
  const document = nativeRegistrationDocument(
    setup, identity, coordinates, token,
    await readFile(config.certificate, "utf8"), config.computer,
  );
  if (target.startsWith("macos-")) {
    await writeRegistration(path.join(config.ownerHome, "codey-machine-registration.json"), document);
    return;
  }
  // Output is initially inside the ACL-protected config root. PowerShell then
  // atomically exports it with an owner-only ACL; it is never printed.
  const temporary = config.registrationStaging + "." + randomBytes(12).toString("hex") + ".next";
  try {
    await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { flag: "wx" });
    await rename(temporary, config.registrationStaging);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Child CLI errors may contain credentials. Keep failures intentionally terse.
    console.error("Native runtime verification/registration/renewal failed; check authentication and the private installation state.");
    process.exitCode = 1;
  });
}
