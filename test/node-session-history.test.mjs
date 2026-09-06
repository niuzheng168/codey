import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateConfig } from "../src/config.mjs";
import { NodeSessionHistory } from "../src/node-session-history.mjs";
import { sharedSessionName } from "../src/node-session-uploader.mjs";

test("local node session reader lists and opens active and archived histories", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "node-session-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, ".codex");
  const sessions = path.join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true });
  const activeRollout = path.join(sessions, "active.jsonl");
  const archivedRollout = path.join(codexHome, "archived_sessions", "archived.jsonl");
  await mkdir(path.dirname(archivedRollout), { recursive: true });
  await Promise.all([
    writeFile(
      activeRollout,
      [
        {
          timestamp: "2026-08-15T00:00:00Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Active question" },
        },
        {
          timestamp: "2026-08-15T00:00:01Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Active answer" },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    ),
    writeFile(archivedRollout, ""),
  ]);
  const setup = spawnSync(
    "python",
    [
      "-c",
      [
        "import sqlite3,sys",
        "db=sqlite3.connect(sys.argv[1])",
        "db.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, archived INTEGER, rollout_path TEXT, updated_at INTEGER)')",
        "db.execute('INSERT INTO threads VALUES (?,?,?,?,?,?)', ('active-session','Active title','Q:/work',0,sys.argv[2],200))",
        "db.execute('INSERT INTO threads VALUES (?,?,?,?,?,?)', ('archived-session','Archived title','Q:/old',1,sys.argv[3],100))",
        "db.commit()",
      ].join(";"),
      path.join(codexHome, "state_5.sqlite"),
      activeRollout,
      archivedRollout,
    ],
    { encoding: "utf8" },
  );
  assert.equal(setup.status, 0, setup.stderr);

  const config = validateConfig({
    nodes: [
      {
        id: "local",
        name: "Local",
        endpoint: "http://localhost:4141/usage",
        management: {
          transport: "local",
          sessionRoot: sessions,
          copilotApi: "none",
          codexCli: "desktop-managed",
        },
      },
    ],
  });

  test("remote node session reader prefers the authenticated Copilot API", async () => {
    const requests = [];
    const config = validateConfig({
      requestTimeoutMs: 5000,
      nodes: [
        {
          id: "jpe2",
          name: "Japan East 2",
          endpoint: "http://jpe2.example.test:4141/usage",
          management: {
            transport: "ssh",
            sshHost: "jpe2",
            runtimeBin: "/home/zhn/.local/bin",
            copilotApi: "systemd-user",
            codexCli: "npm-global",
          },
        },
      ],
    });
    const reader = new NodeSessionHistory(config, {
      sessionApiKey: "session-secret",
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        if (String(url).includes("/session-history/active/demo-session")) {
          return Response.json({
            session: { session_name: "demo-session", state: "active" },
            transcript: { messages: [] },
          });
        }
        return Response.json({
          items: [
            {
              session_name: "demo-session",
              state: "active",
              timestamp_ms: 123456,
            },
          ],
          total: 1,
          limit: 10,
          offset: 0,
        });
      },
      runCommand: async () => {
        throw new Error("SSH must not be used when the API succeeds");
      },
    });

    const list = await reader.list("jpe2", {
      state: "all",
      limit: 10,
      startAtMs: 120000,
    });
    assert.equal(list.items[0].source_id, "jpe2");
    assert.match(requests[0].url, /\/session-history\?/);
    assert.match(requests[0].url, /start_at_ms=120000/);
    assert.equal(requests[0].options.headers["x-api-key"], "session-secret");

    const detail = await reader.detail("jpe2", "active", "demo-session");
    assert.equal(detail.session.source_id, "jpe2");
    assert.match(requests[1].url, /\/session-history\/active\/demo-session$/);
  });

  test("remote node session reader falls back to SSH during mixed-version rollout", async () => {
    const config = validateConfig({
      nodes: [
        {
          id: "legacy",
          name: "Legacy",
          endpoint: "http://legacy.example.test:4141/usage",
          management: {
            transport: "ssh",
            sshHost: "legacy",
            runtimeBin: "/home/zhn/.local/bin",
            copilotApi: "systemd-user",
            codexCli: "npm-global",
          },
        },
      ],
    });
    let sshCalls = 0;
    const reader = new NodeSessionHistory(config, {
      sessionApiKey: "session-secret",
      fetchImpl: async () => new Response("missing", { status: 404 }),
      runCommand: async () => {
        sshCalls += 1;
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            items: [],
            total: 0,
            limit: 10,
            offset: 0,
          }),
        };
      },
    });

    const result = await reader.list("legacy", { limit: 10 });
    assert.equal(result.transport, "ssh_fallback");
    assert.equal(sshCalls, 1);
  });

  test("Windows SSH session history uses its node-specific API key", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "windows-session-key-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sessionKeyFile = path.join(root, "session.key");
    await writeFile(sessionKeyFile, "windows-session-secret\n");
    const config = validateConfig({
      nodes: [
        {
          id: "windows",
          name: "Windows",
          endpoint: "http://windows.example.test:4141/usage",
          apiKeyFile: path.join(root, "api.key"),
          management: {
            transport: "windows-ssh",
            sshHost: "windows",
            sessionApiKeyFile: sessionKeyFile,
            copilotApi: "windows-startup",
            codexCli: "desktop-managed",
          },
        },
      ],
    });
    const requests = [];
    const reader = new NodeSessionHistory(config, {
      sessionApiKey: "global-key-must-not-be-used",
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        return Response.json({
          items: [],
          total: 0,
          limit: 10,
          offset: 0,
        });
      },
      runCommand: async () => {
        throw new Error("Windows history must not fall back to SSH Python");
      },
    });

    await reader.list("windows", { limit: 10 });

    assert.equal(
      requests[0].options.headers["x-api-key"],
      "windows-session-secret",
    );
  });

  test("node-qualified shared names are stable and path-safe", () => {
    assert.equal(
      sharedSessionName("zhn-a100", "019f-1234"),
      "zhn_a100_019f_1234",
    );
  });
  const reader = new NodeSessionHistory(config);
  const all = await reader.list("local", { state: "all", limit: 10, offset: 0 });
  assert.equal(all.total, 2);
  assert.deepEqual(
    all.items.map((item) => [item.session_name, item.state]),
    [
      ["active-session", "active"],
      ["archived-session", "archived"],
    ],
  );
  const archived = await reader.list("local", {
    state: "archived",
    limit: 10,
    offset: 0,
  });
  assert.equal(archived.total, 1);

  const detail = await reader.detail("local", "active", "active-session");
  assert.equal(detail.session.source_id, "local");
  assert.deepEqual(
    detail.transcript.messages.map((message) => message.text),
    ["Active question", "Active answer"],
  );
});
