import { fetchNodeJson, isLoopback, nodesForConnection } from "./node-transport.js";

const TOTAL_FIELDS = Object.freeze([
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "input_tokens",
  "output_tokens",
  "request_count",
  "total_tokens",
]);

function safeText(value, maximumLength = 160) {
  return String(value ?? "").trim().slice(0, maximumLength);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function emptyTotals() {
  return {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    costs: [],
    input_tokens: 0,
    output_tokens: 0,
    request_count: 0,
    total_nano_aiu: null,
    total_tokens: 0,
  };
}

function normalizeCosts(costs) {
  if (!Array.isArray(costs)) return [];
  const byCurrency = new Map();
  for (const cost of costs) {
    const currency = safeText(cost?.currency, 12).toUpperCase();
    if (!currency) continue;
    const current = byCurrency.get(currency) ?? {
      currency,
      amount: 0,
      total_cost_nanos: 0,
    };
    current.amount += finiteNumber(cost?.amount);
    current.total_cost_nanos += finiteNumber(cost?.total_cost_nanos);
    byCurrency.set(currency, current);
  }
  return [...byCurrency.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}

function normalizeTotals(value) {
  const result = emptyTotals();
  for (const field of TOTAL_FIELDS) result[field] = finiteNumber(value?.[field]);
  const nanoAiu = Number(value?.total_nano_aiu);
  result.total_nano_aiu = Number.isFinite(nanoAiu) ? nanoAiu : null;
  result.costs = normalizeCosts(value?.costs);
  return result;
}

function mergeTotals(values) {
  const result = emptyTotals();
  const costs = [];
  let totalNanoAiu = 0;
  let hasNanoAiu = false;
  for (const value of values) {
    const normalized = normalizeTotals(value);
    for (const field of TOTAL_FIELDS) result[field] += normalized[field];
    costs.push(...normalized.costs);
    if (normalized.total_nano_aiu !== null) {
      totalNanoAiu += normalized.total_nano_aiu;
      hasNanoAiu = true;
    }
  }
  result.costs = normalizeCosts(costs);
  result.total_nano_aiu = hasNanoAiu ? totalNanoAiu : null;
  return result;
}

function mergeModelBreakdowns(groups) {
  const models = new Map();
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const model = safeText(item?.model || "unknown") || "unknown";
      const current = models.get(model) ?? [];
      current.push(item);
      models.set(model, current);
    }
  }
  return [...models.entries()]
    .map(([model, values]) => ({ model, ...mergeTotals(values) }))
    .sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model));
}

function mergeDailyUsage(nodes) {
  const days = new Map();
  for (const node of nodes) {
    for (const day of node.days ?? []) {
      const date = safeText(day?.date, 20);
      if (!date) continue;
      const current = days.get(date) ?? {
        date,
        start_ms: finiteNumber(day.start_ms),
        end_ms: finiteNumber(day.end_ms),
        totals: [],
        byModel: [],
      };
      current.start_ms =
        Math.min(current.start_ms || Infinity, finiteNumber(day.start_ms)) || 0;
      current.end_ms = Math.max(current.end_ms, finiteNumber(day.end_ms));
      current.totals.push(day.totals);
      current.byModel.push(day.byModel);
      days.set(date, current);
    }
  }
  return [...days.values()]
    .map((day) => ({
      date: day.date,
      start_ms: Number.isFinite(day.start_ms) ? day.start_ms : 0,
      end_ms: day.end_ms,
      totals: mergeTotals(day.totals),
      byModel: mergeModelBreakdowns(day.byModel),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function deriveEndpointUrl(usageEndpoint, siblingPath) {
  const url = new URL(usageEndpoint);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.at(-1) === "usage") segments.pop();
  url.pathname = `/${[
    ...segments,
    ...siblingPath.split("/").filter(Boolean),
  ].join("/")}`;
  url.search = "";
  url.hash = "";
  return url;
}

function endpointWithQuery(endpoint, searchParams) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

function errorMessage(error, connectionMode = "direct") {
  const portal = connectionMode === "vnet" || connectionMode === "devtunnel";
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return "请求超时";
  }
  if (Number.isInteger(error?.status)) {
    if (error.status === 401 || error.status === 403) {
      return portal ? "门户登录已失效" : `直连票据无效（HTTP ${error.status}）`;
    }
    if (error.status === 404) return "节点不支持此接口（HTTP 404）";
    return `${portal ? "门户" : "节点"}返回 HTTP ${error.status}`;
  }
  if (connectionMode === "devtunnel") return "无法通过私有 DevTunnel 连接节点";
  return connectionMode === "vnet" ? "无法通过 ACA 连接节点" : "浏览器无法直连节点";
}

function normalizeQuotaSnapshots(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .map(([key, quota]) => ({
      id: safeText(quota?.quota_id || key, 80),
      unlimited: Boolean(quota?.unlimited),
      percentRemaining: Math.max(
        0,
        Math.min(100, finiteNumber(quota?.percent_remaining)),
      ),
      remaining: finiteNumber(quota?.remaining ?? quota?.quota_remaining),
      entitlement: finiteNumber(quota?.entitlement),
      creditsUsed: finiteNumber(quota?.credits_used),
      tokenBasedBilling: Boolean(quota?.token_based_billing),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeModels(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).map((model) => ({
    model: safeText(model?.model || "unknown") || "unknown",
    ...normalizeTotals(model),
  }));
}

function normalizeDays(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 62).map((day) => ({
    date: safeText(day?.date, 20),
    start_ms: finiteNumber(day?.start_ms),
    end_ms: finiteNumber(day?.end_ms),
    totals: normalizeTotals(day?.totals),
    byModel: normalizeModels(day?.byModel),
  }));
}

function normalizeEvents(value, node) {
  if (!Array.isArray(value)) return [];
  return value.map((event) => {
    const reasoningEffort = safeText(event?.reasoning_effort, 64).toLowerCase();
    return {
      id: `${node.id}:${safeText(event?.id, 80)}`,
      nodeId: node.id,
      nodeName: node.name,
      nodeAccent: node.accent,
      created_at_ms: finiteNumber(event?.created_at_ms),
      created_at_utc: safeText(event?.created_at_utc, 80),
      model: safeText(event?.model || "unknown") || "unknown",
      endpoint: safeText(event?.endpoint, 80),
      source: safeText(event?.source, 80),
      reasoningEffort: /^[a-z0-9_-]{1,64}$/.test(reasoningEffort)
        ? reasoningEffort
        : null,
      effortSource: /^[a-z0-9_-]{1,64}$/.test(reasoningEffort)
        ? "copilot-api"
        : null,
      input_tokens: finiteNumber(event?.input_tokens),
      output_tokens: finiteNumber(event?.output_tokens),
      cache_read_input_tokens: finiteNumber(event?.cache_read_input_tokens),
      cache_creation_input_tokens: finiteNumber(
        event?.cache_creation_input_tokens,
      ),
      total_tokens: finiteNumber(event?.total_tokens),
      cost: event?.cost
        ? {
            amount: finiteNumber(event.cost.amount),
            currency: safeText(event.cost.currency, 12).toUpperCase(),
          }
        : null,
    };
  });
}

function resultValue(result) {
  return result.status === "fulfilled" ? result.value : null;
}

function groupAccounts(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    if (!node.login && node.quotas.length === 0) continue;
    const key = node.login || `unknown:${node.id}`;
    const current = groups.get(key) ?? {
      login: node.login || "未知账号",
      plan: node.plan,
      quotaResetAt: node.quotaResetAt,
      nodes: [],
      snapshots: [],
    };
    current.nodes.push(node.id);
    if (node.quotas.length > 0) current.snapshots.push(node.quotas);
    if (!current.plan && node.plan) current.plan = node.plan;
    if (!current.quotaResetAt && node.quotaResetAt) {
      current.quotaResetAt = node.quotaResetAt;
    }
    groups.set(key, current);
  }
  return [...groups.values()].map((group) => {
    const signatures = group.snapshots.map((snapshot) =>
      JSON.stringify(
        snapshot.map((quota) => ({
          id: quota.id,
          unlimited: quota.unlimited,
          percentRemaining: quota.percentRemaining,
          remaining: quota.remaining,
          entitlement: quota.entitlement,
        })),
      ),
    );
    return {
      login: group.login,
      plan: group.plan || "unknown",
      quotaResetAt: group.quotaResetAt || null,
      nodeIds: group.nodes,
      quotas: group.snapshots[0] ?? [],
      consistent:
        signatures.length <= 1 ||
        signatures.every((value) => value === signatures[0]),
    };
  });
}

async function collectNode(node, config, period, fetchImpl, options) {
  const timeoutMs =
    options.interactiveLocal && isLoopback(node.endpoint)
      ? 30000
      : config.requestTimeoutMs;
  const requests = [
    ["quota", new URL(node.endpoint)],
    [
      "summary",
      endpointWithQuery(deriveEndpointUrl(node.endpoint, "token-usage"), {
        period,
      }),
    ],
    [
      "daily",
      endpointWithQuery(deriveEndpointUrl(node.endpoint, "token-usage/daily"), {
        period,
      }),
    ],
    [
      "events",
      endpointWithQuery(deriveEndpointUrl(node.endpoint, "token-usage/events"), {
        period,
        page: 1,
        page_size: config.eventsPerNode,
      }),
    ],
  ];
  const startedAt = performance.now();
  const results = await Promise.allSettled(
    requests.map(([, url]) => fetchNodeJson(node, url, {
      fetchImpl, timeoutMs, connectionMode: options.connectionMode,
    })),
  );
  const errors = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ scope: requests[index][0], message: errorMessage(result.reason, options.connectionMode) }]
      : [],
  );
  const usage = resultValue(results[0]);
  const summary = resultValue(results[1]);
  const daily = resultValue(results[2]);
  const events = resultValue(results[3]);
  const successes = results.filter((result) => result.status === "fulfilled").length;
  return {
    id: node.id,
    name: node.name,
    region: node.region,
    accent: node.accent,
    endpoint: new URL(node.endpoint).origin,
    status: successes === 0 ? "offline" : errors.length === 0 ? "online" : "partial",
    latencyMs: Math.round(performance.now() - startedAt),
    tokenUsageAvailable: Boolean(summary),
    login: safeText(usage?.login, 120),
    plan: safeText(usage?.copilot_plan, 80),
    quotaResetAt:
      safeText(usage?.quota_reset_date_utc || usage?.quota_reset_date, 80) ||
      null,
    quotas: normalizeQuotaSnapshots(usage?.quota_snapshots),
    totals: normalizeTotals(summary?.totals),
    byModel: normalizeModels(summary?.byModel),
    days: normalizeDays(daily?.days),
    events: normalizeEvents(events?.items, node),
    errors,
  };
}

export async function collectClientOverview(
  nodes,
  config,
  period,
  options = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const selectedIds = new Set(options.nodeIds ?? []);
  const available = nodesForConnection(nodes, options.connectionMode);
  const selected = selectedIds.size
    ? available.filter((node) => selectedIds.has(node.id))
    : available;
  const collected = await Promise.all(
    selected.map((node) =>
      collectNode(node, config, period, fetchImpl, options),
    ),
  );
  const usableNodes = collected.filter((node) => node.tokenUsageAvailable);
  const aggregate = {
    totals: mergeTotals(usableNodes.map((node) => node.totals)),
    byModel: mergeModelBreakdowns(usableNodes.map((node) => node.byModel)),
    days: mergeDailyUsage(usableNodes),
    recentEvents: collected
      .flatMap((node) => node.events ?? [])
      .sort((a, b) => b.created_at_ms - a.created_at_ms)
      .slice(0, config.maxRecentEvents),
  };
  const status = collected.reduce(
    (counts, node) => ({ ...counts, [node.status]: counts[node.status] + 1 }),
    { online: 0, partial: 0, offline: 0 },
  );
  return {
    generatedAt: new Date().toISOString(),
    connectionMode: options.connectionMode ?? "direct",
    period,
    selectedNodeIds: selected.map((node) => node.id),
    status,
    aggregate,
    accounts: groupAccounts(collected),
    nodes: collected,
  };
}
