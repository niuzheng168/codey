import test from "node:test";
import assert from "node:assert/strict";
import { SessionHistoryHub } from "../src/session-history-hub.mjs";

test("history hub merges Shared and node categories with source identity", async () => {
  const sharedClient = {
    async status() {
      return { configured: true };
    },
    async list() {
      return {
        items: [
          {
            session_name: "shared-session",
            state: "active",
            uploaded_at: 100,
          },
        ],
        total: 1,
        permissions: { can_manage: true },
      };
    },
    async detail() {
      return {
        session: { session_name: "shared-session", state: "active" },
        transcript: { messages: [] },
      };
    },
  };
  const nodeHistory = {
    setConfig() {},
    sources() {
      return [
        {
          id: "jpe2",
          name: "Japan East 2",
          type: "node",
          states: ["active", "archived", "all"],
        },
      ];
    },
    async list() {
      return {
        items: [
          {
            session_name: "node-session",
            source_id: "jpe2",
            source_name: "Japan East 2",
            source_type: "node",
            state: "archived",
            timestamp_ms: 200000,
          },
        ],
        total: 1,
      };
    },
    async detail() {
      return {
        session: {
          session_name: "node-session",
          source_id: "jpe2",
          source_type: "node",
          state: "archived",
        },
        transcript: { messages: [] },
      };
    },
  };
  const nodeUploader = {
    setConfig() {},
    async upload(sourceId, state, sessionId) {
      return {
        ok: true,
        sourceId,
        sessionId,
        state,
        sharedName: "jpe2_node_session",
      };
    },
  };
  const hub = new SessionHistoryHub(
    { nodes: [] },
    { sharedClient, nodeHistory, nodeUploader },
  );
  const result = await hub.list({
    source: "all",
    state: "all",
    limit: 10,
    offset: 0,
  });

  assert.equal(result.total, 2);
  assert.deepEqual(
    result.items.map((item) => [item.source_id, item.session_name]),
    [
      ["jpe2", "node-session"],
      ["shared", "shared-session"],
    ],
  );
  assert.equal(result.permissions.can_manage, true);
  assert.equal(result.items[0].uploaded, false);
  assert.equal(result.items[0].shared_name, "jpe2_node_session");
  assert.deepEqual(result.source_counts, {
    all: 2,
    shared: 1,
    jpe2: 1,
  });
  assert.deepEqual(
    result.sources.map((source) => source.id),
    ["all", "shared", "jpe2"],
  );
  await assert.rejects(
    () => hub.trash("jpe2", "node-session"),
    /read-only/,
  );
  const upload = await hub.upload("jpe2", "archived", "node-session");
  assert.equal(upload.sharedName, "jpe2_node_session");
});

test("history hub filters every source before counting and pagination", async () => {
  const now = Date.now;
  Date.now = () => 2_000_000_000_000;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sharedCalls = [];
  const nodeCalls = [];
  const sharedClient = {
    async list(options) {
      sharedCalls.push(options);
      return {
        items: [
          {
            session_name: "shared-new",
            state: "active",
            uploaded_at: Math.floor((cutoff + 1_000) / 1000),
          },
          {
            session_name: "shared-old",
            state: "active",
            uploaded_at: Math.floor((cutoff - 1_000) / 1000),
          },
        ],
        total: 2,
      };
    },
  };
  const nodeHistory = {
    setConfig() {},
    sources() {
      return [
        {
          id: "jpe2",
          name: "Japan East 2",
          type: "node",
          states: ["active", "archived", "all"],
        },
      ];
    },
    async list(_sourceId, options) {
      nodeCalls.push(options);
      return {
        items: [
          {
            session_name: "archived-new",
            source_id: "jpe2",
            source_type: "node",
            state: "archived",
            timestamp_ms: cutoff + 1,
          },
          {
            session_name: "active-old",
            source_id: "jpe2",
            source_type: "node",
            state: "active",
            timestamp_ms: cutoff - 1,
          },
        ],
        total: 2,
      };
    },
  };
  const hub = new SessionHistoryHub(
    { nodes: [] },
    {
      sharedClient,
      nodeHistory,
      nodeUploader: { setConfig() {} },
    },
  );

  try {
    const result = await hub.list({
      source: "all",
      state: "all",
      range: "week",
      limit: 1,
      offset: 1,
    });
    assert.deepEqual(result.source_counts, { all: 2, shared: 1, jpe2: 1 });
    assert.equal(result.total, 2);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].session_name, "archived-new");
    assert.equal(result.range, "week");
    assert.equal(result.start_at_ms, cutoff);
    assert.equal(sharedCalls[0].startAt, Math.floor(cutoff / 1000));
    assert.equal(nodeCalls[0].startAtMs, cutoff);
    assert.equal(nodeCalls[0].limit, 1000);
  } finally {
    Date.now = now;
  }
});

test("history hub prefers Shared copies and keeps Recycle Bin items last", async () => {
  let nodeCalls = 0;
  const sharedItems = [
    {
      session_name: "renamed-shared",
      source_session_id: "node-session",
      state: "active",
      uploaded_at: 300,
    },
    {
      session_name: "trash-session",
      source_session_id: "trash-source",
      state: "trash",
      uploaded_at: 100,
      deleted_at: 400,
    },
  ];
  const sharedClient = {
    async list(options) {
      const items =
        options.state === "trash"
          ? sharedItems.filter((item) => item.state === "trash")
          : sharedItems;
      return {
        items,
        total: items.length,
        limit: options.limit,
        offset: options.offset,
        has_more: false,
      };
    },
  };
  const nodeHistory = {
    setConfig() {},
    sources() {
      return [
        {
          id: "jpe2",
          name: "Japan East 2",
          type: "node",
          states: ["active", "archived", "all"],
        },
      ];
    },
    async list() {
      nodeCalls += 1;
      return {
        items: [
          {
            session_name: "node-session",
            source_id: "jpe2",
            source_type: "node",
            state: "active",
            timestamp_ms: 500000,
          },
          {
            session_name: "node-only",
            source_id: "jpe2",
            source_type: "node",
            state: "active",
            timestamp_ms: 200000,
          },
        ],
        total: 2,
      };
    },
  };
  const hub = new SessionHistoryHub(
    { nodes: [] },
    {
      sharedClient,
      nodeHistory,
      nodeUploader: { setConfig() {} },
    },
  );

  const all = await hub.list({
    source: "all",
    state: "all",
    limit: 20,
    offset: 0,
  });
  assert.equal(all.total, 3);
  assert.equal(
    all.items.filter(
      (item) =>
        item.session_name === "node-session" ||
        item.session_name === "renamed-shared",
    ).length,
    1,
  );
  assert.equal(all.items[0].session_name, "renamed-shared");
  assert.equal(all.items.at(-1).state, "trash");

  const trash = await hub.list({
    source: "all",
    state: "trash",
    limit: 20,
    offset: 0,
  });
  assert.deepEqual(
    trash.items.map((item) => item.session_name),
    ["trash-session"],
  );
  assert.equal(nodeCalls, 1);
});

test("history hub validates and executes state-aware batch actions", async () => {
  const calls = [];
  const sharedClient = {
    async trash(name) {
      calls.push(["trash", name]);
      return { status: "trashed" };
    },
    async restore(name) {
      calls.push(["restore", name]);
      return { status: "restored" };
    },
    async purge(state, name) {
      calls.push(["purge", state, name]);
      return { status: "purged" };
    },
  };
  const hub = new SessionHistoryHub(
    { nodes: [] },
    {
      sharedClient,
      nodeHistory: {
        setConfig() {},
        sources() {
          return [];
        },
      },
      nodeUploader: { setConfig() {} },
    },
  );

  const result = await hub.batch("purge", [
    { sourceId: "shared", state: "active", sessionName: "active-one" },
    { sourceId: "shared", state: "trash", sessionName: "trash-one" },
  ]);
  assert.equal(result.succeeded, 2);
  assert.deepEqual(calls, [
    ["purge", "active", "active-one"],
    ["purge", "trash", "trash-one"],
  ]);
  await assert.rejects(
    () =>
      hub.batch("restore", [
        { sourceId: "shared", state: "active", sessionName: "active-one" },
      ]),
    /not valid/,
  );
});
