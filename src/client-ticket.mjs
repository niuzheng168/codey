import { createHmac, timingSafeEqual } from "node:crypto";

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9._:@-]{1,256}$/;
const ALLOWED_SCOPES = new Set(["usage", "history"]);

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function decode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signature(key, payload) {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function safeEqual(left, right) {
  const leftValue = Buffer.from(String(left));
  const rightValue = Buffer.from(String(right));
  return (
    leftValue.length === rightValue.length &&
    timingSafeEqual(leftValue, rightValue)
  );
}

function normalizeScopes(scopes) {
  const values = [...new Set(Array.isArray(scopes) ? scopes : [])];
  if (
    values.length === 0 ||
    values.some((scope) => !ALLOWED_SCOPES.has(scope))
  ) {
    throw new Error("Client ticket scopes are invalid");
  }
  return values.sort();
}

export function issueClientTicket({
  signingKey,
  nodeId,
  principalId,
  scopes = ["usage", "history"],
  ttlSeconds = 600,
  now = Date.now(),
}) {
  signingKey = String(signingKey ?? "");
  nodeId = String(nodeId ?? "");
  principalId = String(principalId ?? "");
  if (signingKey.length < 32) {
    throw new Error("Client relay signing key must contain at least 32 characters");
  }
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new Error("Client ticket node id is invalid");
  }
  if (!PRINCIPAL_PATTERN.test(principalId)) {
    throw new Error("Client ticket principal is invalid");
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3600) {
    throw new Error("Client ticket TTL must be between 30 and 3600 seconds");
  }
  const issuedAt = Math.floor(now / 1000);
  const payload = encode(
    JSON.stringify({
      v: 1,
      aud: nodeId,
      sub: principalId,
      scope: normalizeScopes(scopes),
      iat: issuedAt,
      exp: issuedAt + ttlSeconds,
    }),
  );
  return {
    token: `${payload}.${signature(signingKey, payload)}`,
    expiresAt: (issuedAt + ttlSeconds) * 1000,
  };
}

export function verifyClientTicket({
  signingKey,
  token,
  nodeId,
  requiredScope,
  now = Date.now(),
}) {
  signingKey = String(signingKey ?? "");
  token = String(token ?? "");
  nodeId = String(nodeId ?? "");
  if (signingKey.length < 32 || !NODE_ID_PATTERN.test(nodeId)) {
    throw new Error("Client relay authentication is not configured");
  }
  const separator = token.indexOf(".");
  if (separator <= 0 || separator !== token.lastIndexOf(".")) {
    throw new Error("Client ticket is malformed");
  }
  const payloadValue = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  if (!safeEqual(providedSignature, signature(signingKey, payloadValue))) {
    throw new Error("Client ticket signature is invalid");
  }
  let payload;
  try {
    payload = JSON.parse(decode(payloadValue));
  } catch {
    throw new Error("Client ticket payload is invalid");
  }
  const nowSeconds = Math.floor(now / 1000);
  if (
    payload?.v !== 1 ||
    payload.aud !== nodeId ||
    !PRINCIPAL_PATTERN.test(String(payload.sub ?? "")) ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    payload.iat > nowSeconds + 30 ||
    payload.exp <= nowSeconds ||
    payload.exp - payload.iat > 3600
  ) {
    throw new Error("Client ticket is expired or invalid");
  }
  const scopes = normalizeScopes(payload.scope);
  if (requiredScope && !scopes.includes(requiredScope)) {
    throw new Error("Client ticket scope is insufficient");
  }
  return {
    nodeId: payload.aud,
    principalId: payload.sub,
    scopes,
    issuedAt: payload.iat * 1000,
    expiresAt: payload.exp * 1000,
  };
}
