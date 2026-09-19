/** Dev Tunnels user authentication is not the CLI's tunnel-scoped --access-token. */
import { spawn } from "node:child_process";
import { authJson, readGhCredential } from "./github-auth.mjs";

const apiVersion = "2023-09-27-preview";
const idPattern = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
const clusterPattern = /^[a-z][a-z0-9]{1,15}$/;
const requireValue = (value, message) => { if (!value) throw new Error(message); };
const endpoint = cluster => `https://${cluster || "global"}.rel.tunnels.api.visualstudio.com`;

export function tunnelCoordinates(qualified) {
  const parts = typeof qualified === "string" ? qualified.split(".") : [];
  requireValue(parts.length === 2 && idPattern.test(parts[0]) && clusterPattern.test(parts[1]),
    "Invalid DevTunnel coordinates");
  return { tunnelId: parts[0], clusterId: parts[1] };
}

function coordinates(value) {
  return tunnelCoordinates(`${value?.tunnelId}.${value?.clusterId}`);
}

async function requestTunnel(credential, cluster, pathname, { method = "GET", body, scopes, create = false } = {}, request = authJson) {
  requireValue(!cluster || clusterPattern.test(cluster), "Invalid DevTunnel cluster");
  const query = new URLSearchParams({ "api-version": apiVersion });
  if (pathname === "/tunnels") query.set("global", "true");
  else { query.set("includePorts", "true"); query.set("includeAccessControl", "true"); }
  if (scopes) {
    requireValue(scopes.length > 0 && scopes.every(scope => ["host", "connect"].includes(scope)), "Unsupported tunnel credential scope");
    query.set("tokenScopes", scopes.join(","));
  }
  const response = await request(`${endpoint(cluster)}${pathname}?${query}`, { method,
    headers: { authorization: `github ${credential.token}`, "user-agent": "codey-gh-auth", accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}), ...(create ? { "if-none-match": "*" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  requireValue([200, 201].includes(response.status),
    `GitHub CLI DevTunnel access failed (HTTP ${response.status}); no account was changed`);
  return response.value;
}

export async function listGhTunnels(credential, { request = authJson } = {}) {
  const value = await requestTunnel(credential, undefined, "/tunnels", {}, request);
  requireValue(Array.isArray(value?.value) && !value.nextLink &&
    value.value.every(region => Array.isArray(region.value) && !region.error && !region.nextLink),
  "DevTunnel did not return a complete tunnel list");
  return value.value.flatMap(region => region.value);
}

function verifiedTunnel(value, expected) {
  requireValue(value?.tunnelId === expected.tunnelId && value.clusterId === expected.clusterId, "Unexpected DevTunnel identity");
  return value;
}

export async function getGhTunnel(credential, expected, { request = authJson } = {}) {
  const target = coordinates(expected);
  const value = verifiedTunnel(await requestTunnel(credential, target.clusterId, `/tunnels/${target.tunnelId}`, {}, request), target);
  // Only issue scopes in issueGhTunnelToken, and never log service token dictionaries.
  const { accessTokens: _tokens, ...tunnel } = value;
  return { ...tunnel, ...(Array.isArray(tunnel.ports) ? { ports: tunnel.ports.map(port => {
    const { accessTokens: _portTokens, ...safePort } = port;
    return safePort;
  }) } : {}) };
}

/** Create only this installation's new random ID; never adopt another owner's tunnel. */
export async function ensureGhTunnel(credential, tunnelId, { request = authJson } = {}) {
  requireValue(/^codey-n-[a-f0-9]{24}$/.test(tunnelId), "Invalid Codey tunnel identity");
  const found = (await listGhTunnels(credential, { request })).filter(item => item.tunnelId === tunnelId);
  requireValue(found.length <= 1, "Ambiguous Codey tunnel identity");
  let target;
  if (found.length) target = coordinates(found[0]);
  else {
    const created = await requestTunnel(credential, undefined, `/tunnels/${tunnelId}`, {
      method: "PUT", create: true, body: { tunnelId, description: `Codey ${tunnelId.slice(6)}`,
        ports: [3001, 8443].map(portNumber => ({ portNumber, protocol: "https" })), accessControl: { entries: [] } },
    }, request);
    target = coordinates(created);
    requireValue(target.tunnelId === tunnelId, "Created DevTunnel identity did not match");
  }
  const actual = await getGhTunnel(credential, target, { request });
  // Do not mutate a public tunnel or silently remove unrelated ports.
  for (const item of [actual, ...(actual.ports ?? [])]) {
    const entries = item.accessControl?.entries ?? item.accessControl ?? [];
    requireValue(Array.isArray(entries) && !entries.some(entry =>
      String(entry.type).toLowerCase() === "anonymous" && entry.isDeny !== true), "Anonymous tunnel access is forbidden");
  }
  requireValue(Array.isArray(actual.ports) && actual.ports.every(port => [3001, 8443].includes(port.portNumber)),
    "The existing tunnel has unrelated ports; no ports were removed");
  for (const portNumber of [3001, 8443]) {
    if (!actual.ports.some(port => port.portNumber === portNumber && port.protocol === "https")) {
      await requestTunnel(credential, target.clusterId, `/tunnels/${tunnelId}/ports/${portNumber}`, {
        method: "PUT", body: { portNumber, protocol: "https" },
      }, request);
    }
  }
  return getGhTunnel(credential, target, { request });
}

export function scopedTunnelToken(token, expected, scope, now = Date.now()) {
  requireValue(["host", "connect"].includes(scope) && typeof token === "string" &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), "Invalid scoped tunnel credential");
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url")); }
  catch { throw new Error("Invalid scoped tunnel credential"); }
  requireValue(claims.scp === scope && claims.tunnelId === expected.tunnelId && claims.clusterId === expected.clusterId &&
    Number.isSafeInteger(claims.exp) && claims.exp > now / 1000 + 3600 && claims.exp <= now / 1000 + 86400 + 300,
  "Wrong scope, identity or expiry on tunnel credential");
  const result = { expiresAt: claims.exp * 1000 };
  Object.defineProperty(result, "token", { value: token });
  return result;
}

export async function issueGhTunnelToken(config, expected, scope, {
  github = readGhCredential, request = authJson, now = Date.now,
} = {}) {
  const target = coordinates(expected);
  requireValue(config.tunnelAuth?.source === "gh", "GitHub CLI tunnel authentication is not configured");
  const credential = await github({ environment: config.baseEnvironment, binding: config.tunnelAuth });
  requireValue(credential, "The selected GitHub CLI account is unavailable");
  const response = verifiedTunnel(await requestTunnel(credential, target.clusterId, `/tunnels/${target.tunnelId}`,
    { scopes: [scope] }, request), target);
  return scopedTunnelToken(response.accessTokens?.[scope], target, scope, now());
}

/** Reuse the native service's restart policy to renew host credentials before expiry. */
export async function hostGhTunnel(config, {
  issue = issueGhTunnelToken, spawnProcess = spawn, signals = process,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  const target = tunnelCoordinates(config.qualifiedTunnel);
  const credential = await issue(config, target, "host");
  requireValue(credential.expiresAt > now() + 300000, "Host credential expires too soon");
  const environment = Object.fromEntries(Object.entries(config.baseEnvironment ?? {}).filter(([name]) =>
    !/(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(name) && !/^(?:CODEY_|COPILOT_API_)/i.test(name)));
  const child = spawnProcess(config.devtunnelExe, ["host", config.qualifiedTunnel,
    "--host-header", "unchanged", "--origin-header", "unchanged", "--access-token", "-"], {
    env: environment, shell: false, windowsHide: true, stdio: ["pipe", "ignore", "ignore"],
  });
  let renewal = false, stopping = false, killTimer;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    killTimer = schedule(() => child.kill("SIGKILL"), 10000);
  };
  const rotation = schedule(() => { renewal = true; stop(); }, credential.expiresAt - now() - 300000);
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", () => reject(new Error("DevTunnel host could not start")));
      child.once("close", code => resolve(renewal || stopping ? 0 : code ?? 1));
      child.stdin.on("error", () => {}); // EPIPE is reported by the child's exit status.
      child.stdin.end(credential.token + "\n");
    });
  } finally {
    cancel(rotation);
    if (killTimer) cancel(killTimer);
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
  }
}
