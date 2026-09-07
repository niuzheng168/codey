import { createHash, randomBytes } from "node:crypto";
import https from "node:https";
import { issueClientTicket } from "./client-ticket.mjs";
import { issueWorkspaceAssertion } from "./workspace-sso.mjs";
import { requestError } from "./signed-store.mjs";
import { nodeTlsOptions } from "./machine-identity.mjs";

function probe(machine, port, pathname, headers, { requestImpl, timeoutMs, websocket = false }) {
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
      request = requestImpl(new URL(`https://${machine.privateIp}:${port}${pathname}`), {
        method: "GET", ...nodeTlsOptions(machine), agent: false, headers,
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

export async function verifyMachine(machine, { principal, master, clientKey, requestImpl = https.request, timeoutMs = 10000 }) {
  const options = { requestImpl, timeoutMs };
  const ticket = issueClientTicket({ signingKey: clientKey, nodeId: machine.id, principalId: principal.id, ttlSeconds: 60 });
  const dataHeaders = { accept: "application/json", authorization: `Bearer ${ticket.token}` };
  const workspaceHeaders = (pathname) => ({
    accept: "application/json",
    "x-codey-workspace-assertion": issueWorkspaceAssertion({
      master, nodeId: machine.id, principal, method: "GET",
      target: new URL(`https://${machine.privateIp}:3001${pathname}`),
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
    if (health.status !== 200 || usage.status !== 200 || history.status !== 200 ||
        anonymousData.status !== 401 || anonymousWorkspace.status !== 401 ||
        workspace.status !== 200 || workspace.body.managedAuthentication !== true ||
        workspace.body.needsSetup !== false || workspace.body.user?.username !== principal.name) {
      throw new Error("Private service authentication verification failed");
    }
    await probe(machine, 3001, "/ws", {
      ...workspaceHeaders("/ws"), connection: "Upgrade", upgrade: "websocket",
      "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"),
    }, { ...options, websocket: true });
    return { https: true, usage: true, history: true, workspaceSso: true, websocket: true, anonymousDenied: true };
  } catch {
    throw requestError("私网验收未通过：请确认 Skill 已完成 VNet、8443/3001 服务和本节点证书配置；机器尚未添加", 502);
  }
}
