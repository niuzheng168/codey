import assert from "node:assert/strict";
import test from "./helpers/optional-history.mjs";
import { fetchClientHistoryList } from "../public/client-history.js";

test("direct copilot-api history receives node source metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/session-history/);
    return Response.json({
      items: [
        {
          session_name: "019ffffd-8cf4-7101-8c8f-a2726b8dc7b1",
          source_session_id: "019ffffd-8cf4-7101-8c8f-a2726b8dc7b1",
          state: "archived",
          title: "A100 session",
          timestamp_ms: 1,
        },
      ],
      total: 1,
    });
  };
  try {
    const result = await fetchClientHistoryList({
      nodes: [
        {
          id: "zhn-a100",
          name: "ZHN A100",
          endpoint: "https://zhn-a100.example.test:8443/usage",
          ticket: "ticket",
        },
      ],
      source: "all",
      state: "all",
      query: "",
      limit: 20,
      offset: 0,
      range: "all",
      serverFetch: async () => ({
        items: [],
        total: 0,
        limit: 200,
        has_more: false,
        permissions: {},
      }),
    });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].source_id, "zhn-a100");
    assert.equal(result.items[0].source_type, "node");
    assert.equal(result.items[0].source_name, "ZHN A100 (zhn-a100)");
    assert.equal(
      result.items[0].shared_name,
      "zhn_a100_019ffffd_8cf4_7101_8c8f_a2726b8dc7b1",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
