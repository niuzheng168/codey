import { createHmac, randomBytes } from "node:crypto";

/** Derives isolated node keys from the ACA-only master secret (also used by deployment). */
export function workspaceNodeKey(master, nodeId) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(master ?? "")) throw new Error("Invalid Workspace SSO master key");
  return createHmac("sha256", Buffer.from(master, "base64url"))
    .update(`codey-workspace-v1:${nodeId}`).digest("base64url");
}

/** Creates a short-lived, request-bound assertion that is NEVER sent to the browser. */
export function issueWorkspaceAssertion({ master, nodeId, principal, method, target, now = Date.now() }) {
  if (!principal?.id || !principal?.sessionId || principal.expiresAt <= now) {
    throw new Error("An active portal session is required");
  }
  const payload = Buffer.from(JSON.stringify({
    iss: "codey-portal",
    aud: nodeId,
    sub: principal.id,
    username: principal.name,
    sid: principal.sessionId,
    method: method.toUpperCase(),
    path: `${target.pathname}${target.search}`,
    iat: Math.floor(now / 1000),
    exp: Math.min(Math.floor(now / 1000) + 20, Math.floor(principal.expiresAt / 1000)),
    nonce: randomBytes(16).toString("base64url"),
  })).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(workspaceNodeKey(master, nodeId), "base64url"))
    .update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
