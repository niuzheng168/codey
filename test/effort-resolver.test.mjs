import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EffortResolver } from "../src/effort-resolver.mjs";

test("effort resolver matches usage events to the latest preceding turn context", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-effort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "019ffac7-265c-7881-8bc0-93b88b3649cd";
  const directory = path.join(root, "2026", "08", "13");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-test-${sessionId}.jsonl`);
  const contexts = [
    {
      timestamp: "2026-08-13T10:00:00.000Z",
      type: "turn_context",
      payload: { effort: "low", model: "gpt-test" },
    },
    {
      timestamp: "2026-08-13T10:01:00.000Z",
      type: "turn_context",
      payload: { effort: "max", model: "gpt-test" },
    },
  ];
  await writeFile(file, `${contexts.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

  const resolver = new EffortResolver({ nodes: [] });
  const node = {
    id: "local",
    management: { transport: "local", sessionRoot: root },
  };
  const events = await resolver.resolveEvents(node, [
    { id: "first", _sessionId: sessionId, created_at_ms: Date.parse("2026-08-13T10:00:30.000Z") },
    { id: "second", _sessionId: sessionId, created_at_ms: Date.parse("2026-08-13T10:01:30.000Z") },
    { id: "direct", _reasoningEffort: "high", _sessionId: sessionId, created_at_ms: Date.parse("2026-08-13T10:00:30.000Z") },
    { id: "unknown", _sessionId: "", created_at_ms: Date.now() },
  ]);

  assert.equal(events[0].reasoningEffort, "low");
  assert.equal(events[1].reasoningEffort, "max");
  assert.equal(events[2].reasoningEffort, "high");
  assert.equal(events[2].effortSource, "copilot-api");
  assert.equal(events[3].reasoningEffort, null);
  assert.equal("_sessionId" in events[0], false);
  assert.equal("_reasoningEffort" in events[2], false);
});
