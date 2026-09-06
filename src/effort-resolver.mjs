import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORT_PATTERN = /^[a-z0-9_-]{1,32}$/i;
const CACHE_TTL_MS = 2 * 60 * 1000;
const MISSING_CACHE_TTL_MS = 15 * 1000;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

const REMOTE_SESSION_READER = String.raw`
import json
import pathlib
import sys

session_ids = set(sys.argv[1:])
root = pathlib.Path.home() / ".codex" / "sessions"
files = {}

if root.is_dir():
    for path in root.rglob("*.jsonl"):
        name = path.name
        for session_id in tuple(session_ids - files.keys()):
            if session_id in name:
                files[session_id] = path

result = {}
for session_id in session_ids:
    contexts = []
    path = files.get(session_id)
    if path:
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if '"turn_context"' not in line:
                        continue
                    try:
                        item = json.loads(line)
                    except Exception:
                        continue
                    if item.get("type") != "turn_context":
                        continue
                    payload = item.get("payload") or {}
                    effort = payload.get("effort")
                    if not isinstance(effort, str):
                        continue
                    contexts.append({
                        "timestamp": item.get("timestamp"),
                        "effort": effort,
                        "model": payload.get("model"),
                    })
        except OSError:
            contexts = []
    result[session_id] = contexts[-2000:]

print(json.dumps(result, separators=(",", ":")))
`;

function safeEffort(value) {
  const effort = String(value ?? "").trim().toLowerCase();
  return EFFORT_PATTERN.test(effort) ? effort : null;
}

function safeModel(value) {
  return String(value ?? "").trim().slice(0, 160) || null;
}

function normalizeContexts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      timestampMs: Date.parse(item?.timestamp),
      effort: safeEffort(item?.effort),
      model: safeModel(item?.model),
    }))
    .filter((item) => Number.isFinite(item.timestampMs) && item.effort)
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .slice(-2000);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...options.spawnOptions,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("远程会话元数据响应过大"));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        finish(new Error(errorOutput || `SSH exited with code ${code}`));
        return;
      }
      finish(null, output);
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("读取 Codex 会话元数据超时"));
    }, options.timeoutMs ?? 12000);
    timer.unref?.();
    child.stdin.end(options.input ?? "");
  });
}

async function findLocalSessionFiles(root, sessionIds) {
  const pending = new Set(sessionIds);
  const found = new Map();
  const directories = [root];
  let visited = 0;

  while (directories.length > 0 && pending.size > 0 && visited < 100_000) {
    const directory = directories.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      for (const sessionId of pending) {
        if (!entry.name.includes(sessionId)) continue;
        found.set(sessionId, fullPath);
        pending.delete(sessionId);
        break;
      }
    }
  }
  return found;
}

async function readContexts(filePath) {
  if (!filePath) return [];
  const contexts = [];
  let input;
  try {
    input = createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"turn_context"')) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (item?.type !== "turn_context") continue;
      contexts.push({
        timestamp: item.timestamp,
        effort: item.payload?.effort,
        model: item.payload?.model,
      });
      if (contexts.length > 4000) contexts.splice(0, contexts.length - 2000);
    }
  } catch {
    input?.destroy();
    return [];
  }
  return normalizeContexts(contexts);
}

function matchingContext(contexts, event) {
  if (!contexts.length) return null;
  const eventTime = Number(event.created_at_ms);
  if (!Number.isFinite(eventTime)) return contexts.at(-1);

  let match = null;
  for (const context of contexts) {
    if (context.timestampMs > eventTime + 1000) break;
    match = context;
  }
  return match;
}

export class EffortResolver {
  constructor(config, options = {}) {
    this.config = config;
    this.runProcess = options.runProcess ?? runProcess;
    this.now = options.now ?? Date.now;
    this.cache = new Map();
  }

  async resolveEvents(node, events) {
    const sessionIds = [
      ...new Set(
        events
          .filter((event) => !safeEffort(event._reasoningEffort))
          .map((event) => event._sessionId)
          .filter((sessionId) => SESSION_ID_PATTERN.test(sessionId ?? "")),
      ),
    ];
    const contexts = await this.#contextsFor(node, sessionIds);

    return events.map((event) => {
      const sessionContexts = contexts.get(event._sessionId) ?? [];
      const context = matchingContext(sessionContexts, event);
      const directEffort = safeEffort(event._reasoningEffort);
      const { _reasoningEffort, _sessionId, ...publicEvent } = event;
      return {
        ...publicEvent,
        reasoningEffort: directEffort ?? context?.effort ?? null,
        effortSource:
          directEffort ? "copilot-api"
          : context ? "codex-session"
          : null,
      };
    });
  }

  async #contextsFor(node, sessionIds) {
    const result = new Map();
    if (!node.management || sessionIds.length === 0) return result;

    const missing = [];
    const now = this.now();
    for (const sessionId of sessionIds) {
      const key = `${node.id}:${sessionId}`;
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > now) {
        result.set(sessionId, cached.contexts);
      } else {
        missing.push(sessionId);
      }
    }
    if (missing.length === 0) return result;

    let loaded = new Map();
    try {
      loaded = node.management.transport === "ssh"
        ? await this.#readRemote(node, missing)
        : await this.#readLocal(node, missing);
    } catch {
      loaded = new Map();
    }

    for (const sessionId of missing) {
      const sessionContexts = loaded.get(sessionId) ?? [];
      const key = `${node.id}:${sessionId}`;
      this.cache.set(key, {
        contexts: sessionContexts,
        expiresAt: now + (sessionContexts.length ? CACHE_TTL_MS : MISSING_CACHE_TTL_MS),
      });
      result.set(sessionId, sessionContexts);
    }
    return result;
  }

  async #readLocal(node, sessionIds) {
    const files = await findLocalSessionFiles(node.management.sessionRoot, sessionIds);
    const pairs = await Promise.all(
      sessionIds.map(async (sessionId) => [sessionId, await readContexts(files.get(sessionId))]),
    );
    return new Map(pairs);
  }

  async #readRemote(node, sessionIds) {
    const output = await this.runProcess(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        node.management.sshHost,
        "python3",
        "-",
        ...sessionIds,
      ],
      { input: REMOTE_SESSION_READER, timeoutMs: 15000 },
    );
    const parsed = JSON.parse(output);
    return new Map(
      sessionIds.map((sessionId) => [sessionId, normalizeContexts(parsed?.[sessionId])]),
    );
  }
}

export const effortInternals = Object.freeze({
  matchingContext,
  normalizeContexts,
  SESSION_ID_PATTERN,
});
