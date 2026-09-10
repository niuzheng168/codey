import { createHash, randomBytes } from "node:crypto";
import https from "node:https";
import { issueClientTicket } from "./client-ticket.mjs";
import { issueWorkspaceAssertion } from "./workspace-sso.mjs";
import { requestError } from "./signed-store.mjs";
import { nodeTlsOptions } from "./machine-identity.mjs";
import { DevTunnelTransport } from "./devtunnel-transport.mjs";

function probe(machine, port, pathname, headers, { requestImpl, timeoutMs, websocket = false, agents }) {
  return new Promise((resolve, reject) => {
    let request, peer, finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      peer?.destroy();
      request?.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Private machine probe timed out")), timeoutMs);
    timer.unref?.();
    try {
      const host = machine.networkMode === "devtunnel" ? "127.0.0.1" : machine.privateIp;
      if (machine.networkMode === "devtunnel" && !agents?.get(port)?.agent) {
        throw new Error("A DevTunnel probe must not fall back to local TCP");
      }
      request = requestImpl(new URL(`https://${host}:${port}${pathname}`), {
        method: "GET", ...nodeTlsOptions(machine), agent: agents?.get(port)?.agent ?? false, headers,
      }, (response) => {
        if (websocket) { response.resume(); finish(new Error("Workspace WebSocket was not accepted")); return; }
        const chunks = [];
        let size = 0;
        response.on("error", finish);
        response.on("aborted", () => finish(new Error("Incomplete probe")));
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) finish(new Error("Oversized machine probe"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (finished) return;
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { finish(new Error("Machine probe did not return JSON")); return; }
          finish(null, { status: response.statusCode, body });
        });
      });
      request.on("error", finish);
      if (websocket) request.on("upgrade", (response, socket) => {
        peer = socket;
        const expected = createHash("sha1").update(headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        if (response.statusCode !== 101 || response.headers["sec-websocket-accept"] !== expected) {
          finish(new Error("Invalid WebSocket handshake"));
        } else finish(null, { status: 101 });
      });
      request.end();
    } catch (error) { finish(error); }
  });
}

export async function verifyMachine(machine, { principal, master, clientKey, requestImpl = https.request, timeoutMs = 15000,
  getTunnelToken, tunnelTransportFactory = (config, tlsOptions, options) => new DevTunnelTransport(config, tlsOptions, options) }) {
  const agents = new Map();
  if (machine.networkMode === "devtunnel") {
    if (typeof getTunnelToken !== "function") throw requestError("请先提交本节点的 DevTunnel 连接凭据", 409);
    for (const port of [3001, 8443]) {
      agents.set(port, tunnelTransportFactory({ ...machine.devTunnel, port }, nodeTlsOptions(machine), { getToken: getTunnelToken }));
    }
  }
  const options = { requestImpl, timeoutMs, agents };
  const ticket = issueClientTicket({ signingKey: clientKey, nodeId: machine.id, principalId: principal.id, ttlSeconds: 60 });
  const dataHeaders = { accept: "application/json", authorization: `Bearer ${ticket.token}` };
  const workspaceHeaders = (pathname) => ({
    accept: "application/json",
    "x-codey-workspace-assertion": issueWorkspaceAssertion({
      master, nodeId: machine.id, principal, method: "GET",
      target: new URL(`https://${machine.networkMode === "devtunnel" ? "127.0.0.1" : machine.privateIp}:3001${pathname}`),
    }),
  });
  try {
    const [health, usage, history, anonymousData, workspace, anonymousWorkspace] = await Promise.all([
      probe(machine, 8443, "/healthz", {}, options),
      probe(machine, 8443, "/usage", dataHeaders, options),
      probe(machine, 8443, "/session-history?state=all&limit=1", dataHeaders, options),
      probe(machine, 8443, "/usage", {}, options),
      probe(machine, 3001, "/api/auth/status", workspaceHeaders("/api/auth/status"), options),
      probe(machine, 3001, "/api/auth/status", {}, options),
    ]);
    const usageAvailable = usage.status === 200 && (machine.networkMode !== "devtunnel" ||
      (usage.body !== null && typeof usage.body === "object" &&
        !Array.isArray(usage.body) && !Object.hasOwn(usage.body, "error")));
    const quotaUnavailable = (usage.status === 200 && usage.body === null) ||
      [404, 429].includes(usage.status) || (usage.status >= 500 && usage.status <= 599);
    if (health.status !== 200 || (!usageAvailable && !quotaUnavailable) || history.status !== 200 ||
        anonymousData.status !== 401 || anonymousWorkspace.status !== 401 ||
        workspace.status !== 200 || workspace.body.managedAuthentication !== true ||
        workspace.body.needsSetup !== false || workspace.body.user?.username !== principal.name) {
      throw new Error("Private service authentication verification failed");
    }
    if (!usageAvailable) {
      // The optional Copilot quota API may fail while the node remains usable.
      // Do not turn that into a successful quota result or waive authentication.
      const ownerBoundData = health.body?.relay === "codey-node-relay" ||
        (machine.platform === "linux-x64" && health.body?.service === "copilot-api-codey-https");
      if (machine.networkMode !== "devtunnel" || !ownerBoundData ||
          health.body.nodeId !== machine.id) {
        throw new Error("An unavailable quota API requires a verified owner-bound relay");
      }
      const [tokens, anonymousTokens] = await Promise.all([
        probe(machine, 8443, "/token-usage", dataHeaders, options),
        probe(machine, 8443, "/token-usage", {}, options),
      ]);
      if (tokens.status !== 200 || !tokens.body || typeof tokens.body !== "object" ||
          Array.isArray(tokens.body) || Object.hasOwn(tokens.body, "error") || anonymousTokens.status !== 401) {
        throw new Error("Independent authenticated token usage verification failed");
      }
    }
    await probe(machine, 3001, "/ws", {
      ...workspaceHeaders("/ws"), connection: "Upgrade", upgrade: "websocket",
      "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"),
    }, { ...options, websocket: true });
    return { https: true, usage: usageAvailable, history: true, workspaceSso: true, websocket: true, anonymousDenied: true,
      ...(!usageAvailable ? { tokenUsage: true, usageHttpStatus: usage.status,
        warnings: ["copilot_quota_unavailable_model_inference_not_tested"] } : {}) };
  } catch {
    throw requestError(machine.networkMode === "devtunnel"
      ? "DevTunnel 验收未通过：请确认隧道在线、令牌有效、8443/3001 服务、数据认证及本节点证书正确；机器尚未添加"
      : "私网验收未通过：请确认 Skill 已完成 VNet、8443/3001 服务和本节点证书配置；机器尚未添加", 502);
  } finally { await Promise.allSettled([...agents.values()].map(transport => transport.dispose())); }
}
