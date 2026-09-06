export const PERIODS = Object.freeze(new Set(["day", "week", "month"]));

const TOTAL_FIELDS = Object.freeze([
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "input_tokens",
  "output_tokens",
  "request_count",
  "total_tokens",
]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function emptyTotals() {
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

export function normalizeCosts(costs) {
  if (!Array.isArray(costs)) return [];
  const byCurrency = new Map();
  for (const cost of costs) {
    const currency = String(cost?.currency ?? "").trim().toUpperCase();
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
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function normalizeTotals(value) {
  const result = emptyTotals();
  for (const field of TOTAL_FIELDS) result[field] = finiteNumber(value?.[field]);
  const nanoAiu = Number(value?.total_nano_aiu);
  result.total_nano_aiu = Number.isFinite(nanoAiu) ? nanoAiu : null;
  result.costs = normalizeCosts(value?.costs);
  return result;
}

export function mergeTotals(values) {
  const result = emptyTotals();
  const allCosts = [];
  let totalNanoAiu = 0;
  let hasNanoAiu = false;

  for (const value of values) {
    const normalized = normalizeTotals(value);
    for (const field of TOTAL_FIELDS) result[field] += normalized[field];
    allCosts.push(...normalized.costs);
    if (normalized.total_nano_aiu !== null) {
      totalNanoAiu += normalized.total_nano_aiu;
      hasNanoAiu = true;
    }
  }

  result.costs = normalizeCosts(allCosts);
  result.total_nano_aiu = hasNanoAiu ? totalNanoAiu : null;
  return result;
}

export function mergeModelBreakdowns(groups) {
  const models = new Map();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const model = String(item?.model ?? "unknown").trim() || "unknown";
      const current = models.get(model) ?? [];
      current.push(item);
      models.set(model, current);
    }
  }

  return [...models.entries()]
    .map(([model, values]) => ({ model, ...mergeTotals(values) }))
    .sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model));
}

export function mergeDailyUsage(nodes) {
  const days = new Map();
  for (const node of nodes) {
    for (const day of node.days ?? []) {
      const date = String(day?.date ?? "");
      if (!date) continue;
      const current = days.get(date) ?? {
        date,
        start_ms: finiteNumber(day.start_ms),
        end_ms: finiteNumber(day.end_ms),
        totals: [],
        byModel: [],
      };
      current.start_ms = Math.min(current.start_ms || Infinity, finiteNumber(day.start_ms)) || 0;
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

export function deriveEndpointUrl(usageEndpoint, siblingPath) {
  const url = new URL(usageEndpoint);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.at(-1) === "usage") segments.pop();
  url.pathname = `/${[...segments, ...siblingPath.split("/").filter(Boolean)].join("/")}`;
  url.search = "";
  url.hash = "";
  return url;
}

export function normalizePeriod(value) {
  return PERIODS.has(value) ? value : null;
}

export function aggregateNodeUsage(nodes, maxRecentEvents = 60) {
  const usableNodes = nodes.filter((node) => node.tokenUsageAvailable);
  const recentEvents = nodes
    .flatMap((node) => node.events ?? [])
    .sort((a, b) => b.created_at_ms - a.created_at_ms)
    .slice(0, maxRecentEvents);

  return {
    totals: mergeTotals(usableNodes.map((node) => node.totals)),
    byModel: mergeModelBreakdowns(usableNodes.map((node) => node.byModel)),
    days: mergeDailyUsage(usableNodes),
    recentEvents,
  };
}
