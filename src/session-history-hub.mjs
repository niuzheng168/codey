import { NodeSessionHistory } from "./node-session-history.mjs";
import {
  NodeSessionUploader,
  sharedSessionName,
} from "./node-session-uploader.mjs";

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHARED_NAME_CACHE_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 50;
const RANGE_MS = Object.freeze({
  all: 0,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
});

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function normalizeSharedItem(item) {
  return {
    ...item,
    source_id: "shared",
    source_name: "Shared",
    source_type: "shared",
    uploaded: true,
    shared_name: item.session_name,
    timestamp_ms: Number(item.deleted_at || item.uploaded_at || 0) * 1000,
  };
}

function compareHistoryItems(left, right) {
  return (
    Number(left.state === "trash") - Number(right.state === "trash") ||
    Number(right.search_score ?? 0) - Number(left.search_score ?? 0) ||
    Number(right.timestamp_ms ?? 0) - Number(left.timestamp_ms ?? 0) ||
    String(right.session_name).localeCompare(String(left.session_name))
  );
}

export class SessionHistoryHub {
  constructor(config, options = {}) {
    this.config = config;
    this.sharedClient = options.sharedClient;
    this.canManageShared = options.canManageShared !== false;
    this.nodeHistory =
      options.nodeHistory ??
      new NodeSessionHistory(config, options.nodeHistoryOptions);
    this.nodeUploader =
      options.nodeUploader ??
      new NodeSessionUploader(config, {
        nodeHistory: this.nodeHistory,
        sharedClient: this.sharedClient,
        ...options.nodeUploaderOptions,
      });
    this.sharedNameCache = null;
  }

  setConfig(config) {
    this.config = config;
    this.nodeHistory.setConfig(config);
    this.nodeUploader.setConfig(config);
    this.sharedNameCache = null;
  }

  sources() {
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
      ...this.nodeHistory.sources(),
    ];
  }

  async status() {
    return {
      shared: await this.sharedClient.status(),
      sources: this.sources(),
    };
  }

  async list(options = {}) {
    const source = this.#source(options.source ?? "shared");
    const limit = Math.min(200, Math.max(1, Number(options.limit ?? 50)));
    const offset = Math.max(0, Number(options.offset ?? 0));
    if (!Number.isInteger(limit) || !Number.isInteger(offset)) {
      throw requestError("limit and offset must be integers");
    }
    const state = options.state ?? (source.id === "all" ? "all" : "active");
    const range = options.range ?? "all";
    if (!Object.hasOwn(RANGE_MS, range)) {
      throw requestError("range must be all, day, week, or month");
    }
    const startMs = RANGE_MS[range] ? Date.now() - RANGE_MS[range] : 0;
    if (!source.states.includes(state)) {
      throw requestError(
        `state ${state} is not supported for source ${source.id}`,
      );
    }
    const fetchLimit =
      source.id === "all" ? 1000 : Math.min(1000, offset + limit);
    const selectedSources =
      source.id === "all"
        ? this.sources().filter(
            (item) =>
              item.id !== "all" && (state !== "trash" || item.type === "shared"),
          )
        : [source];
    const sourceErrors = [];
    let canManage = false;
    const searchModes = new Set();
    const results = await Promise.all(
      selectedSources.map(async (item) => {
        try {
          if (item.type === "shared") {
            const result = await this.sharedClient.list({
              state: source.id === "all" && state !== "trash" ? "all" : state,
              query: options.query,
              limit: fetchLimit,
              offset: 0,
              startAt: startMs ? Math.floor(startMs / 1000) : 0,
            });
            canManage = canManage || Boolean(result.permissions?.can_manage);
            if (result.search_mode) searchModes.add(result.search_mode);
            const items = (result.items ?? [])
              .map(normalizeSharedItem)
              .filter(
                (value) =>
                  !startMs || Number(value.timestamp_ms ?? 0) >= startMs,
              );
            return {
              items,
              total: startMs ? items.length : Number(result.total ?? 0),
            };
          }
          const result = await this.nodeHistory.list(item.id, {
            state: source.id === "all" ? "all" : state,
            query: options.query,
            limit: fetchLimit,
            offset: 0,
            startAtMs: startMs,
          });
          const items = (result.items ?? []).filter(
            (value) =>
              !startMs || Number(value.timestamp_ms ?? 0) >= startMs,
          );
          return {
            ...result,
            items,
            total: startMs ? items.length : Number(result.total ?? 0),
          };
        } catch (error) {
          sourceErrors.push({
            source_id: item.id,
            source_name: item.name,
            message: String(error?.message ?? "source unavailable").slice(0, 300),
          });
          return { items: [], total: 0 };
        }
      }),
    );
    let items = results
      .flatMap((result) => result.items ?? [])
      .sort(compareHistoryItems);
    const hasNodeItems = items.some((item) => item.source_type === "node");
    const needsSharedCatalog =
      hasNodeItems || (source.id === "all" && !options.query);
    const sharedCatalog = needsSharedCatalog
      ? await this.#sharedCatalog()
      : {
          names: new Set(),
          itemsByName: new Map(),
          itemsBySourceSessionId: new Map(),
        };
    const sharedNames = sharedCatalog.names;
    for (const item of items) {
      if (item.source_type !== "node") continue;
      const expectedSharedName = sharedSessionName(
        item.source_id,
        item.session_name,
      );
      const sharedItem =
        sharedCatalog.itemsByName.get(expectedSharedName) ??
        sharedCatalog.itemsBySourceSessionId.get(
          item.source_session_id || item.session_name,
        );
      item.shared_name = sharedItem?.session_name ?? expectedSharedName;
      item.uploaded = Boolean(sharedItem) || sharedNames.has(item.shared_name);
    }

    if (source.id === "all") {
      if (!options.query) {
        for (const sharedItem of sharedCatalog.itemsByName.values()) {
          const normalized = normalizeSharedItem(sharedItem);
          if (state === "trash" && normalized.state !== "trash") continue;
          if (startMs && normalized.timestamp_ms < startMs) continue;
          items.push(normalized);
        }
      }
      const deduplicated = new Map();
      for (const item of items) {
        let candidate = item;
        let key = `${item.source_id}:${item.state}:${item.session_name}`;
        if (item.source_type === "shared") {
          key = `session:${item.source_session_id || item.session_name}`;
        } else if (item.uploaded && item.shared_name) {
          const sharedItem =
            sharedCatalog.itemsByName.get(item.shared_name) ??
            sharedCatalog.itemsBySourceSessionId.get(
              item.source_session_id || item.session_name,
            );
          key = `session:${
            sharedItem?.source_session_id ||
            item.source_session_id ||
            item.shared_name
          }`;
          if (sharedItem) {
            const normalized = normalizeSharedItem(sharedItem);
            if (!startMs || normalized.timestamp_ms >= startMs) {
              candidate = {
                ...normalized,
                search_score: Math.max(
                  Number(normalized.search_score ?? 0),
                  Number(item.search_score ?? 0),
                ),
                matches: normalized.matches ?? item.matches,
              };
            }
          }
        }
        const existing = deduplicated.get(key);
        if (
          !existing ||
          (candidate.source_type === "shared" &&
            existing.source_type !== "shared") ||
          Number(candidate.search_score ?? 0) >
            Number(existing.search_score ?? 0)
        ) {
          deduplicated.set(key, candidate);
        }
      }
      items = [...deduplicated.values()].sort(compareHistoryItems);
    }

    const rawTotal = results.reduce(
      (sum, result) => sum + Number(result.total ?? 0),
      0,
    );
    const total = source.id === "all" ? items.length : rawTotal;
    const sourceCounts = Object.fromEntries(
      selectedSources.map((item, index) => [
        item.id,
        Number(results[index]?.total ?? 0),
      ]),
    );
    if (source.id === "all") sourceCounts.all = total;
    return {
      items: items.slice(offset, offset + limit),
      total,
      limit,
      offset,
      has_more: offset + limit < total,
      permissions: { can_manage: canManage && this.canManageShared },
      sources: this.sources(),
      source_counts: sourceCounts,
      source_errors: sourceErrors,
      search_mode:
        options.query && searchModes.has("azure_ai_search_hybrid_vector")
          ? source.id === "shared"
            ? "azure_ai_search_hybrid_vector"
            : "hybrid_sources"
          : options.query
            ? "substring"
            : "browse",
      range,
      start_at_ms: startMs,
    };
  }

  async detail(sourceId, state, sessionName) {
    const source = this.#source(sourceId);
    if (source.type === "shared") {
      const result = await this.sharedClient.detail(state, sessionName);
      return {
        ...result,
        permissions: { ...result.permissions, can_manage: Boolean(result.permissions?.can_manage) && this.canManageShared },
        session: normalizeSharedItem(result.session),
      };
    }
    if (source.type !== "node") {
      throw requestError("Select one source before opening a session");
    }
    const result = await this.nodeHistory.detail(source.id, state, sessionName);
    const sharedName = sharedSessionName(source.id, sessionName);
    const sharedNames = await this.#sharedNames();
    return {
      ...result,
      session: {
        ...result.session,
        shared_name: sharedName,
        uploaded: sharedNames.has(sharedName),
      },
    };
  }

  async archive(sourceId, state, sessionName) {
    this.#sharedSource(sourceId);
    return this.sharedClient.archive(state, sessionName);
  }

  async rename(sourceId, sessionName, newName) {
    if (!this.canManageShared) throw requestError("Shared 历史为只读", 403);
    this.#sharedSource(sourceId);
    const result = await this.sharedClient.rename(sessionName, newName);
    this.#updateSharedNameCache((cache) => {
      cache.names.delete(sessionName);
      cache.names.add(newName);
      cache.itemsByName.delete(sessionName);
      if (result.session) {
        cache.itemsByName.set(newName, result.session);
        if (result.session.source_session_id) {
          cache.itemsBySourceSessionId.set(
            result.session.source_session_id,
            result.session,
          );
        }
      }
    });
    return result;
  }

  async trash(sourceId, sessionName) {
    if (!this.canManageShared) throw requestError("Shared 历史为只读", 403);
    this.#sharedSource(sourceId);
    const result = await this.sharedClient.trash(sessionName);
    this.#rememberSharedSession(result.session);
    return result;
  }

  async restore(sourceId, sessionName) {
    if (!this.canManageShared) throw requestError("Shared 历史为只读", 403);
    this.#sharedSource(sourceId);
    const result = await this.sharedClient.restore(sessionName);
    this.#rememberSharedSession(result.session);
    return result;
  }

  async purge(sourceId, state, sessionName) {
    if (!this.canManageShared) throw requestError("Shared 历史为只读", 403);
    this.#sharedSource(sourceId);
    if (state !== "active" && state !== "trash") {
      throw requestError("Only active or trash Shared sessions can be deleted");
    }
    const result = await this.sharedClient.purge(state, sessionName);
    this.#updateSharedNameCache((cache) => {
      cache.names.delete(sessionName);
      const deleted = cache.itemsByName.get(sessionName);
      cache.itemsByName.delete(sessionName);
      if (deleted?.source_session_id) {
        cache.itemsBySourceSessionId.delete(deleted.source_session_id);
      }
    });
    return result;
  }

  async batch(action, items) {
    if (!this.canManageShared) throw requestError("Shared 历史为只读", 403);
    if (!["trash", "restore", "purge"].includes(action)) {
      throw requestError("Batch action must be trash, restore, or purge");
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > BATCH_LIMIT) {
      throw requestError(`Batch items must contain between 1 and ${BATCH_LIMIT} sessions`);
    }
    const unique = new Map();
    for (const item of items) {
      const sourceId = String(item?.sourceId ?? "");
      const state = String(item?.state ?? "");
      const sessionName = String(item?.sessionName ?? "");
      this.#sharedSource(sourceId);
      if (!SESSION_NAME_PATTERN.test(sessionName)) {
        throw requestError("Batch session name is invalid");
      }
      if (
        (action === "trash" && state !== "active") ||
        (action === "restore" && state !== "trash") ||
        (action === "purge" && state !== "active" && state !== "trash")
      ) {
        throw requestError(`Batch action ${action} is not valid for state ${state}`);
      }
      unique.set(`${state}:${sessionName}`, { sourceId, state, sessionName });
    }
    const pending = [...unique.values()];
    const results = new Array(pending.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(4, pending.length) },
      async () => {
        while (cursor < pending.length) {
          const index = cursor;
          cursor += 1;
          const item = pending[index];
          try {
            const result =
              action === "trash"
                ? await this.trash(item.sourceId, item.sessionName)
                : action === "restore"
                  ? await this.restore(item.sourceId, item.sessionName)
                  : await this.purge(
                      item.sourceId,
                      item.state,
                      item.sessionName,
                    );
            results[index] = { ...item, ok: true, result };
          } catch (error) {
            results[index] = {
              ...item,
              ok: false,
              error: String(error?.message ?? "session operation failed").slice(
                0,
                500,
              ),
            };
          }
        }
      },
    );
    await Promise.all(workers);
    const succeeded = results.filter((item) => item.ok).length;
    return {
      action,
      requested: pending.length,
      succeeded,
      failed: pending.length - succeeded,
      results,
    };
  }

  async upload(sourceId, state, sessionName) {
    const source = this.#source(sourceId);
    if (source.type !== "node") {
      throw requestError("Only node-native sessions can be uploaded", 409);
    }
    const sharedName = sharedSessionName(sourceId, sessionName);
    const sharedNames = await this.#sharedNames();
    if (sharedNames.has(sharedName)) {
      throw requestError("This node session is already uploaded", 409);
    }
    const result = await this.nodeUploader.upload(sourceId, state, sessionName);
    this.#updateSharedNameCache((cache) => {
      cache.names.add(result.sharedName ?? sharedName);
      const stored = result.stored ?? result.session;
      if (stored) {
        cache.itemsByName.set(result.sharedName ?? sharedName, stored);
        cache.itemsBySourceSessionId.set(
          stored.source_session_id ?? result.sessionId,
          stored,
        );
      }
    });
    return result;
  }

  async #sharedNames() {
    return (await this.#sharedCatalog()).names;
  }

  async #sharedCatalog() {
    if (this.sharedNameCache?.expiresAt > Date.now()) {
      return this.sharedNameCache;
    }
    if (this.sharedNameCache?.promise) {
      return this.sharedNameCache.names
        ? this.sharedNameCache
        : this.sharedNameCache.promise;
    }

    const staleNames = this.sharedNameCache?.names ?? null;
    const staleItems = this.sharedNameCache?.itemsByName ?? null;
    const promise = (async () => {
      const names = new Set();
      const itemsByName = new Map();
      const itemsBySourceSessionId = new Map();
      let offset = 0;
      while (true) {
        const result = await this.sharedClient.list({
          state: "all",
          query: "",
          limit: 200,
          offset,
        });
        for (const item of result.items ?? []) {
          if (item.session_name) {
            const name = String(item.session_name);
            names.add(name);
            itemsByName.set(name, item);
            if (item.source_session_id) {
              itemsBySourceSessionId.set(String(item.source_session_id), item);
            }
          }
        }
        if (!result.has_more) break;
        offset += Number(result.limit ?? 200);
      }
      this.sharedNameCache = {
        names,
        itemsByName,
        itemsBySourceSessionId,
        expiresAt: Date.now() + SHARED_NAME_CACHE_MS,
        promise: null,
      };
      return this.sharedNameCache;
    })();
    this.sharedNameCache = {
      names: staleNames,
      itemsByName: staleItems ?? new Map(),
      itemsBySourceSessionId:
        this.sharedNameCache?.itemsBySourceSessionId ?? new Map(),
      expiresAt: 0,
      promise,
    };
    if (staleNames) {
      promise.catch((error) => {
        console.warn(
          `Unable to refresh Shared session-name cache: ${String(error?.message ?? error).slice(0, 300)}`,
        );
        if (this.sharedNameCache?.promise === promise) {
          this.sharedNameCache = {
            names: staleNames,
            itemsByName: staleItems ?? new Map(),
            itemsBySourceSessionId:
              this.sharedNameCache?.itemsBySourceSessionId ?? new Map(),
            expiresAt: Date.now() + 30000,
            promise: null,
          };
        }
      });
      return this.sharedNameCache;
    }
    try {
      return await promise;
    } catch (error) {
      if (this.sharedNameCache?.promise === promise) {
        this.sharedNameCache = null;
      }
      throw error;
    }
  }

  #updateSharedNameCache(update) {
    if (!this.sharedNameCache?.names) return;
    this.sharedNameCache.itemsByName ??= new Map();
    this.sharedNameCache.itemsBySourceSessionId ??= new Map();
    update(this.sharedNameCache);
    this.sharedNameCache.expiresAt = Date.now() + SHARED_NAME_CACHE_MS;
  }

  #rememberSharedSession(session) {
    const name = String(session?.session_name ?? session?.session_id ?? "");
    if (!name) return;
    this.#updateSharedNameCache((cache) => {
      cache.names.add(name);
      cache.itemsByName.set(name, session);
      if (session.source_session_id) {
        cache.itemsBySourceSessionId.set(session.source_session_id, session);
      }
    });
  }

  #sharedSource(sourceId) {
    if (sourceId !== "shared") {
      throw requestError("Node-native session histories are read-only", 409);
    }
  }

  #source(sourceId) {
    const id = String(sourceId ?? "").trim();
    if (!SOURCE_PATTERN.test(id)) {
      throw requestError("Session history source is invalid");
    }
    const source = this.sources().find((item) => item.id === id);
    if (!source) throw requestError("Unknown session history source", 404);
    return source;
  }
}

export const sessionHistoryHubInternals = Object.freeze({
  RANGE_MS,
  normalizeSharedItem,
});
