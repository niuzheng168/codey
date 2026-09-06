const PREFERENCE_KEY = "codey.nodeConnectionMode";
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export function readConnectionMode(storage) {
  try {
    return storage?.getItem(PREFERENCE_KEY) === "vnet" ? "vnet" : "direct";
  } catch {
    return "direct";
  }
}

export function saveConnectionMode(storage, mode) {
  try { storage?.setItem(PREFERENCE_KEY, mode === "vnet" ? "vnet" : "direct"); } catch { /* Storage is optional. */ }
}

export function nodesForConnection(nodes, mode) {
  return mode === "vnet" ? nodes.filter((node) => node.proxyEndpoint) : nodes;
}

export function isLoopback(url) {
  const hostname = new URL(url).hostname;
  return hostname === "localhost" || hostname === "::1" ||
    hostname === "[::1]" || hostname.startsWith("127.");
}

// This is a user-selected route, not an automatic fallback. VNet requests stay
// same-origin and use the portal Cookie; browser tickets never go to this API.
export async function fetchNodeJson(node, url, {
  connectionMode = "direct", timeoutMs = 15000, fetchImpl = fetch,
} = {}) {
  const vnet = connectionMode === "vnet";
  const directUrl = new URL(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = directUrl;
    const options = {
      cache: "no-store",
      credentials: vnet ? "same-origin" : "omit",
      headers: { accept: "application/json" },
      mode: vnet ? "same-origin" : "cors",
      redirect: "error",
      signal: controller.signal,
    };
    if (vnet) {
      if (node.proxyEndpoint !== `/api/node-data/${node.id}/usage` || isLoopback(directUrl)) {
        throw new Error("此节点未配置 VNet 连接，请切换浏览器直连");
      }
      target = `/api/node-data/${node.id}${directUrl.pathname}${directUrl.search}`;
    } else {
      options.headers.authorization = `Bearer ${node.ticket}`;
      if (isLoopback(directUrl)) options.targetAddressSpace = "loopback";
    }
    const response = await fetchImpl(target, options);
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      throw new Error("Node response is too large");
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("Node response is too large");
    const body = JSON.parse(text || "{}");
    if (!response.ok) {
      if (vnet && response.status === 401 && typeof window !== "undefined") {
        window.location.assign("/portal-auth/login");
      }
      const error = new Error(
        (typeof body.error === "string" ? body.error : body.error?.message) ||
        `HTTP ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}
