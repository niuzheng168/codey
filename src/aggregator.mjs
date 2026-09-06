import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { EffortResolver } from "./effort-resolver.mjs";
import {
  aggregateNodeUsage,
  deriveEndpointUrl,
  normalizeTotals,
} from "./metrics.mjs";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function safeText(value, maximumLength = 160) {
  return String(value ?? "").trim().slice(0, maximumLength);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeReasoningEffort(value) {
  const effort = safeText(value, 64).toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(effort) ? effort : null;
}

function buildHeaders(node, env) {
  const headers = {
    accept: "application/json",
    "user-agent": "codex-usage-portal/1.0",
  };
  const apiKey = node.apiKeyEnv ? env[node.apiKeyEnv] : "";
  let resolvedApiKey = apiKey;
  if (!resolvedApiKey && node.apiKeyFile) {
    try {
      resolvedApiKey = readFileSync(node.apiKeyFile, "utf8").trim();
    } catch {
      resolvedApiKey = "";
    }
  }
  if (resolvedApiKey) headers["x-api-key"] = resolvedApiKey;
  return headers;
}

function errorMessage(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return "请求超时";
  }
  if (Number.isInteger(error?.status)) {
    if (error.status === 401 || error.status === 403) return `认证失败（HTTP ${error.status}）`;
    if (error.status === 404) return "当前代理版本不支持此接口（HTTP 404）";
    return `上游返回 HTTP ${error.status}`;
  }
  return "无法连接到上游节点";
}

async function fetchJson(fetchImpl, url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(url, {
      headers: options.headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      const error = new Error(`Upstream returned ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("Upstream response is too large");
    }

    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("Upstream response is too large");
    }
    return JSON.parse(body);
  } finally {
    clearTimeout(timeout);
  }
}

function endpointWithQuery(endpoint, searchParams) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

function normalizeQuotaSnapshots(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .map(([key, quota]) => ({
      id: safeText(quota?.quota_id || key, 80),
      unlimited: Boolean(quota?.unlimited),
      percentRemaining: Math.max(0, Math.min(100, finiteNumber(quota?.percent_remaining))),
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
    model: safeText(model?.model || "unknown", 160) || "unknown",
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
  return value.map((event) => ({
    id: `${node.id}:${safeText(event?.id, 80)}`,
    nodeId: node.id,
    nodeName: node.name,
    nodeAccent: node.accent,
    created_at_ms: finiteNumber(event?.created_at_ms),
    created_at_utc: safeText(event?.created_at_utc, 80),
    model: safeText(event?.model || "unknown", 160) || "unknown",
    endpoint: safeText(event?.endpoint, 80),
    source: safeText(event?.source, 80),
    _reasoningEffort: normalizeReasoningEffort(event?.reasoning_effort),
    _sessionId: safeText(event?.session_id, 80),
    input_tokens: finiteNumber(event?.input_tokens),
    output_tokens: finiteNumber(event?.output_tokens),
    cache_read_input_tokens: finiteNumber(event?.cache_read_input_tokens),
    cache_creation_input_tokens: finiteNumber(event?.cache_creation_input_tokens),
    total_tokens: finiteNumber(event?.total_tokens),
    cost: event?.cost
      ? {
          amount: finiteNumber(event.cost.amount),
          currency: safeText(event.cost.currency, 12).toUpperCase(),
        }
      : null,
  }));
}

function eventsWithoutSessionIds(events) {
  return events.map((event) => {
    const { _reasoningEffort, _sessionId, ...publicEvent } = event;
    return {
      ...publicEvent,
      reasoningEffort: _reasoningEffort,
      effortSource: _reasoningEffort ? "copilot-api" : null,
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
    if (!current.quotaResetAt && node.quotaResetAt) current.quotaResetAt = node.quotaResetAt;
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
      consistent: signatures.length <= 1 || signatures.every((value) => value === signatures[0]),
    };
  });
}

export async function collectNode(node, config, period, fetchImpl, env, effortResolver = null) {
  const headers = buildHeaders(node, env);
  const summaryUrl = endpointWithQuery(deriveEndpointUrl(node.endpoint, "token-usage"), {
    period,
  });
  const dailyUrl = endpointWithQuery(deriveEndpointUrl(node.endpoint, "token-usage/daily"), {
    period,
  });
  const eventsUrl = endpointWithQuery(deriveEndpointUrl(node.endpoint, "token-usage/events"), {
    period,
    page: 1,
    page_size: config.eventsPerNode,
  });
  const startedAt = performance.now();
  const requests = [
    ["quota", new URL(node.endpoint)],
    ["summary", summaryUrl],
    ["daily", dailyUrl],
    ["events", eventsUrl],
  ];
  const results = await Promise.allSettled(
    requests.map(([, url]) =>
      fetchJson(fetchImpl, url, { headers, timeoutMs: config.requestTimeoutMs }),
    ),
  );
  const elapsedMs = Math.round(performance.now() - startedAt);
  const errors = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ scope: requests[index][0], message: errorMessage(result.reason) }]
      : [],
  );

  const usage = resultValue(results[0]);
  const summary = resultValue(results[1]);
  const daily = resultValue(results[2]);
  const events = resultValue(results[3]);
  const successes = results.filter((result) => result.status === "fulfilled").length;
  const tokenUsageAvailable = Boolean(summary);
  const rawEvents = normalizeEvents(events?.items, node);
  let normalizedEvents = eventsWithoutSessionIds(rawEvents);
  if (effortResolver) {
    try {
      normalizedEvents = await effortResolver.resolveEvents(node, rawEvents);
    } catch {
      normalizedEvents = eventsWithoutSessionIds(rawEvents);
    }
  }

  return {
    id: node.id,
    name: node.name,
    region: node.region,
    accent: node.accent,
    endpoint: new URL(node.endpoint).origin,
    status: successes === 0 ? "offline" : errors.length === 0 ? "online" : "partial",
    latencyMs: elapsedMs,
    tokenUsageAvailable,
    login: safeText(usage?.login, 120),
    plan: safeText(usage?.copilot_plan, 80),
    quotaResetAt: safeText(usage?.quota_reset_date_utc || usage?.quota_reset_date, 80) || null,
    quotas: normalizeQuotaSnapshots(usage?.quota_snapshots),
    totals: normalizeTotals(summary?.totals),
    byModel: normalizeModels(summary?.byModel),
    days: normalizeDays(daily?.days),
    events: normalizedEvents,
    errors,
  };
}

export class UsageAggregator {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.env = options.env ?? process.env;
    this.effortResolver = options.effortResolver === false
      ? null
      : options.effortResolver ?? new EffortResolver(config);
    this.cache = new Map();
  }

  publicNodes() {
    return this.config.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      region: node.region,
      accent: node.accent,
      endpoint: new URL(node.endpoint).origin,
    }));
  }

  selectNodes(nodeIds) {
    if (!nodeIds || nodeIds.length === 0) return this.config.nodes;
    const requested = new Set(nodeIds);
    const unknown = [...requested].filter(
      (id) => !this.config.nodes.some((node) => node.id === id),
    );
    if (unknown.length > 0) {
      const error = new Error(`Unknown node ids: ${unknown.join(", ")}`);
      error.status = 400;
      throw error;
    }
    return this.config.nodes.filter((node) => requested.has(node.id));
  }

  async overview(period, nodeIds, forceRefresh = false) {
    const selected = this.selectNodes(nodeIds);
    const key = `${period}:${selected.map((node) => node.id).sort().join(",")}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > now) return cached.promise;

    const promise = this.#collectOverview(period, selected).catch((error) => {
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, {
      expiresAt: now + this.config.cacheSeconds * 1000,
      promise,
    });
    return promise;
  }

  async #collectOverview(period, selected) {
    const nodes = await Promise.all(
      selected.map((node) =>
        collectNode(
          node,
          this.config,
          period,
          this.fetchImpl,
          this.env,
          this.effortResolver,
        ),
      ),
    );
    const aggregate = aggregateNodeUsage(nodes, this.config.maxRecentEvents);
    const statusCounts = nodes.reduce(
      (counts, node) => ({ ...counts, [node.status]: counts[node.status] + 1 }),
      { online: 0, partial: 0, offline: 0 },
    );

    return {
      generatedAt: new Date().toISOString(),
      period,
      selectedNodeIds: selected.map((node) => node.id),
      status: statusCounts,
      aggregate,
      accounts: groupAccounts(nodes),
      nodes,
    };
  }
}
