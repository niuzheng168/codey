import { fetchNodeJson, nodesForConnection } from "./node-transport.js";

const RANGE_MS = Object.freeze({
  all: 0,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
});

function relayUrl(node, pathname, searchParams = null) {
  const url = new URL(pathname, node.endpoint);
  for (const [key, value] of searchParams ?? []) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

function relayJson(node, pathname, searchParams = null, transport = {}) {
  return fetchNodeJson(node, relayUrl(node, pathname, searchParams), transport);
}

function historySources(nodes) {
  return [
    {
      id: "all",
      name: "All sources",
      type: "aggregate",
      states: ["all", "trash"],
    },
    {
      id: "shared",
      name: "Shared",
      type: "shared",
      states: ["active", "trash", "all"],
    },
    ...nodes.map((node) => ({
      id: node.id,
      name: `${node.name} (${node.id})`,
      type: "node",
      states: ["active", "archived", "all"],
    })),
  ];
}

function sharedSessionName(sourceId, sessionId) {
  return `${String(sourceId).replaceAll("-", "_")}_${String(sessionId).replaceAll("-", "_")}`;
}

function compareItems(left, right) {
  return (
    Number(left.state === "trash") - Number(right.state === "trash") ||
    Number(right.search_score ?? 0) - Number(left.search_score ?? 0) ||
    Number(right.timestamp_ms ?? 0) - Number(left.timestamp_ms ?? 0) ||
    String(right.session_name).localeCompare(String(left.session_name))
  );
}

async function fetchSharedPages(serverFetch, options) {
  const items = [];
  let total = 0;
  let offset = 0;
  let permissions = {};
  let searchMode = "browse";
  do {
    const query = new URLSearchParams({
      source: "shared",
      state: options.state,
      q: options.query,
      limit: "200",
      offset: String(offset),
      range: options.range,
    });
    const result = await serverFetch(`/api/session-history?${query}`);
    items.push(...(result.items ?? []));
    total = Number(result.total ?? items.length);
    permissions = result.permissions ?? permissions;
    searchMode = result.search_mode ?? searchMode;
    offset += Number(result.limit ?? 200);
    if (options.query || !result.has_more) break;
  } while (offset < total && offset < 5000);
  return { items, total, permissions, searchMode };
}

function sharedCatalog(sharedItems) {
  const byName = new Map();
  const bySession = new Map();
  for (const item of sharedItems) {
    if (item.session_name) byName.set(item.session_name, item);
    if (item.source_session_id) bySession.set(item.source_session_id, item);
  }
  return { byName, bySession };
}

function decorateNodeItems(items, catalog, node) {
  return items.map((item) => {
    const sourceId = String(item.source_id || node.id);
    const sessionName = String(item.session_name || item.source_session_id);
    const expected = sharedSessionName(sourceId, sessionName);
    const shared =
      catalog.byName.get(expected) ??
      catalog.bySession.get(item.source_session_id || sessionName);
    return {
      ...item,
      session_name: sessionName,
      shared_name: shared?.session_name ?? expected,
      source_id: sourceId,
      source_name: item.source_name || `${node.name} (${node.id})`,
      source_type: "node",
      uploaded: Boolean(shared),
    };
  });
}

function deduplicateAll(items, catalog) {
  const values = new Map();
  for (const item of items) {
    let candidate = item;
    let key = `${item.source_id}:${item.state}:${item.session_name}`;
    if (item.source_type === "shared") {
      key = `session:${item.source_session_id || item.session_name}`;
    } else if (item.uploaded) {
      const shared =
        catalog.byName.get(item.shared_name) ??
        catalog.bySession.get(item.source_session_id || item.session_name);
      key = `session:${
        shared?.source_session_id ||
        item.source_session_id ||
        item.shared_name
      }`;
      if (shared) {
        candidate = {
          ...shared,
          search_score: Math.max(
            Number(shared.search_score ?? 0),
            Number(item.search_score ?? 0),
          ),
          matches: shared.matches ?? item.matches,
        };
      }
    }
    const existing = values.get(key);
    if (
      !existing ||
      (candidate.source_type === "shared" &&
        existing.source_type !== "shared") ||
      Number(candidate.search_score ?? 0) >
        Number(existing.search_score ?? 0)
    ) {
      values.set(key, candidate);
    }
  }
  return [...values.values()].sort(compareItems);
}

export async function fetchClientHistoryList({
  nodes,
  source,
  state,
  query,
  limit,
  offset,
  range,
  serverFetch,
  connectionMode = "direct",
  fetchImpl = fetch,
}) {
  if (!Object.hasOwn(RANGE_MS, range)) throw new Error("Invalid history range");
  nodes = nodesForConnection(nodes, connectionMode);
  const transport = { connectionMode, fetchImpl };
  const sources = historySources(nodes);
  const selected = sources.find((item) => item.id === source);
  if (!selected) throw new Error("Unknown session history source");
  const startAtMs = RANGE_MS[range] ? Date.now() - RANGE_MS[range] : 0;

  if (source === "shared") {
    const result = await fetchSharedPages(serverFetch, {
      state,
      query,
      range,
    });
    return {
      items: result.items.slice(offset, offset + limit),
      total: result.total,
      limit,
      offset,
      has_more: offset + limit < result.total,
      permissions: result.permissions,
      sources,
      source_counts: { shared: result.total },
      source_errors: [],
      search_mode: result.searchMode,
      range,
      start_at_ms: startAtMs,
    };
  }

  const sharedPromise = fetchSharedPages(serverFetch, {
    state: source === "all" && state === "trash" ? "trash" : "all",
    query: source === "all" ? query : "",
    range,
  });
  if (source !== "all") {
    const node = nodes.find((item) => item.id === source);
    const [shared, result] = await Promise.all([
      sharedPromise,
      relayJson(
        node,
        "/session-history",
        new URLSearchParams({
          state,
          q: query,
          limit: String(Math.min(1000, offset + limit)),
          offset: "0",
          start_at_ms: String(startAtMs),
        }),
        transport,
      ),
    ]);
    const items = decorateNodeItems(
      result.items ?? [],
      sharedCatalog(shared.items),
      node,
    );
    const total = startAtMs ? items.length : Number(result.total ?? items.length);
    return {
      ...result,
      items: items.slice(offset, offset + limit),
      total,
      limit,
      offset,
      has_more: offset + limit < total,
      permissions: shared.permissions,
      sources,
      source_counts: { [source]: total },
      source_errors: [],
      search_mode: query ? "substring" : "browse",
      range,
      start_at_ms: startAtMs,
    };
  }

  const sourceErrors = [];
  const selectedNodes = state === "trash" ? [] : nodes;
  const [shared, ...nodeResults] = await Promise.all([
    sharedPromise,
    ...selectedNodes.map(async (node) => {
      try {
        return await relayJson(
          node,
          "/session-history",
          new URLSearchParams({
            state: "all",
            q: query,
            limit: "1000",
            offset: "0",
            start_at_ms: String(startAtMs),
          }),
          transport,
        );
      } catch (error) {
        sourceErrors.push({
          source_id: node.id,
          source_name: `${node.name} (${node.id})`,
          message: String(error?.message ?? "source unavailable").slice(0, 300),
        });
        return { items: [], total: 0 };
      }
    }),
  ]);
  const catalog = sharedCatalog(shared.items);
  const decoratedNodes = nodeResults.flatMap((result, index) =>
    decorateNodeItems(result.items ?? [], catalog, selectedNodes[index]),
  );
  const items = deduplicateAll([...shared.items, ...decoratedNodes], catalog);
  const total = items.length;
  const sourceCounts = { shared: shared.total, all: total };
  selectedNodes.forEach((node, index) => {
    sourceCounts[node.id] = Number(nodeResults[index]?.total ?? 0);
  });
  return {
    items: items.slice(offset, offset + limit),
    total,
    limit,
    offset,
    has_more: offset + limit < total,
    permissions: shared.permissions,
    sources,
    source_counts: sourceCounts,
    source_errors: sourceErrors,
    search_mode:
      query && shared.searchMode === "azure_ai_search_hybrid_vector"
        ? "hybrid_sources"
        : query
          ? "substring"
          : "browse",
    range,
    start_at_ms: startAtMs,
  };
}

export async function fetchClientHistoryDetail({
  nodes,
  sourceId,
  state,
  sessionName,
  serverFetch,
  connectionMode = "direct",
  fetchImpl = fetch,
}) {
  if (sourceId === "shared") {
    return serverFetch(
      `/api/session-history/shared/${encodeURIComponent(state)}/${encodeURIComponent(sessionName)}`,
    );
  }
  const node = nodes.find((item) => item.id === sourceId);
  if (!node) throw new Error("Unknown session history source");
  return relayJson(
    node,
    `/session-history/${encodeURIComponent(state)}/${encodeURIComponent(sessionName)}`,
    null,
    { connectionMode, fetchImpl },
  );
}
