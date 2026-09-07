function resourceEndpoint(value, project = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        (url.port && url.port !== "443") ||
        !/^[a-z0-9-]+\.(?:openai\.azure\.com|services\.ai\.azure\.com)$/i.test(url.hostname) ||
        !(project
          ? /^\/(?:api\/projects\/[a-z0-9_.-]+\/?)?$/i.test(url.pathname)
          : /^\/(?:openai\/v1(?:\/responses)?\/?)?$/.test(url.pathname))) return null;
    url.pathname = "/openai/v1/responses";
    return url.href;
  } catch { return null; }
}

/** Voice rewrite and composer completion share resource validation, not prompts or quotas. */
export function resolveFoundryResponsesBinding(environment, { endpoint: override, apiKey } = {}) {
  const foundry = resourceEndpoint(environment.FOUNDRY_ENDPOINT, true);
  const endpoint = override ? resourceEndpoint(override) : foundry;
  const sameResource = endpoint && foundry &&
    new URL(endpoint).hostname.split(".")[0] === new URL(foundry).hostname.split(".")[0];
  return {
    endpoint,
    key: apiKey || (sameResource ? environment.FOUNDRY_API_KEY || environment.FOUNDRY_KEY || "" : ""),
  };
}

/** Both text services bound bytes even when an upstream omits Content-Length; abort releases the reader. */
export async function readFoundryResponseJson(response, signal, maxBytes) {
  if (Number(response.headers.get("content-length")) > maxBytes || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Invalid response size");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("Invalid response size");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
