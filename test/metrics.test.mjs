import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateNodeUsage,
  deriveEndpointUrl,
  mergeDailyUsage,
  mergeModelBreakdowns,
  mergeTotals,
  normalizePeriod,
} from "../src/metrics.mjs";

test("mergeTotals sums token fields and groups costs by currency", () => {
  const result = mergeTotals([
    {
      total_tokens: 100,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 60,
      request_count: 2,
      costs: [{ currency: "USD", amount: 1.25, total_cost_nanos: 1_250_000_000 }],
    },
    {
      total_tokens: 50,
      input_tokens: 5,
      output_tokens: 5,
      cache_creation_input_tokens: 40,
      request_count: 1,
      costs: [
        { currency: "usd", amount: 0.75, total_cost_nanos: 750_000_000 },
        { currency: "EUR", amount: 0.5, total_cost_nanos: 500_000_000 },
      ],
    },
  ]);

  assert.equal(result.total_tokens, 150);
  assert.equal(result.request_count, 3);
  assert.deepEqual(result.costs, [
    { currency: "EUR", amount: 0.5, total_cost_nanos: 500_000_000 },
    { currency: "USD", amount: 2, total_cost_nanos: 2_000_000_000 },
  ]);
});

test("model and daily aggregation combine identical keys", () => {
  const models = mergeModelBreakdowns([
    [{ model: "gpt-a", total_tokens: 100, request_count: 1 }],
    [
      { model: "gpt-a", total_tokens: 50, request_count: 2 },
      { model: "gpt-b", total_tokens: 75, request_count: 1 },
    ],
  ]);
  assert.equal(models[0].model, "gpt-a");
  assert.equal(models[0].total_tokens, 150);
  assert.equal(models[0].request_count, 3);

  const days = mergeDailyUsage([
    { days: [{ date: "2026-08-13", totals: { total_tokens: 20 }, byModel: [] }] },
    { days: [{ date: "2026-08-13", totals: { total_tokens: 30 }, byModel: [] }] },
  ]);
  assert.equal(days.length, 1);
  assert.equal(days[0].totals.total_tokens, 50);
});

test("deriveEndpointUrl keeps a path prefix and removes usage query state", () => {
  const result = deriveEndpointUrl(
    "https://gateway.example/prefix/usage?old=1",
    "token-usage/events",
  );
  assert.equal(result.toString(), "https://gateway.example/prefix/token-usage/events");
});

test("period validation and recent-event ordering are deterministic", () => {
  assert.equal(normalizePeriod("week"), "week");
  assert.equal(normalizePeriod("year"), null);
  const aggregate = aggregateNodeUsage(
    [
      {
        tokenUsageAvailable: true,
        totals: { total_tokens: 10 },
        byModel: [],
        days: [],
        events: [{ id: "old", created_at_ms: 1 }],
      },
      {
        tokenUsageAvailable: true,
        totals: { total_tokens: 20 },
        byModel: [],
        days: [],
        events: [{ id: "new", created_at_ms: 2 }],
      },
    ],
    1,
  );
  assert.equal(aggregate.totals.total_tokens, 30);
  assert.equal(aggregate.recentEvents[0].id, "new");
});
