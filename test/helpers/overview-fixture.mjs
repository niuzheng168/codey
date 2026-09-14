export const overviewConfig = {
  requestTimeoutMs: 5000,
  refreshSeconds: 60,
  eventsPerNode: 2,
  maxRecentEvents: 5,
};

export const overviewNodes = ["healthy", "developing"].map((id) => ({
  id,
  name: id === "healthy" ? "Healthy" : "Developing",
  region: "Test",
  accent: "#60a5fa",
  endpoint: `https://${id}.example.test/usage`,
  networkMode: "devtunnel",
  proxyEndpoint: `/api/node-data/${id}/usage`,
  ticket: "synthetic-ticket",
  ticketExpiresAt: Date.now() + 60000,
}));

export function overviewPayload(pathname, tokens = 100) {
  const totals = { total_tokens: tokens, request_count: 1 };
  switch (pathname.replace(/^\/api\/node-data\/[^/]+/, "")) {
    case "/usage":
      return { login: "synthetic-user", copilot_plan: "test", quota_snapshots: {} };
    case "/token-usage":
      return { totals, byModel: [{ model: "test-model", ...totals }] };
    case "/token-usage/daily":
      return { days: [{ date: "2026-09-13", totals, byModel: [] }] };
    case "/token-usage/events":
      return { items: [{ id: "test-event", created_at_ms: tokens, model: "test-model", ...totals }] };
    default:
      throw new Error(`Unexpected test endpoint: ${pathname}`);
  }
}

export function controlledOverviewFetch() {
  const requests = [];
  const fetchImpl = (input, options) => {
    const deferred = Promise.withResolvers();
    const url = new URL(input, "https://portal.example.test");
    const { signal } = options;
    const aborted = () => deferred.reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    requests.push({
      url,
      signal,
      resolve: (value = overviewPayload(url.pathname)) => deferred.resolve(Response.json(value)),
      reject: deferred.reject,
    });
    return deferred.promise.finally(() => signal.removeEventListener("abort", aborted));
  };
  return { requests, fetchImpl };
}
