import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEndpointUrl } from "./metrics.mjs";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_SESSION_API_KEY_FILE = path.join(
  os.homedir(),
  ".config",
  "codex-usage-portal",
  "session-history.key",
);

const LIST_SCRIPT = String.raw`
import base64
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

def decode(name):
    value = os.environ.get(name, "")
    return base64.b64decode(value).decode("utf-8") if value else ""

def timestamp_ms(value, fallback=0):
    if value is None:
        return fallback
    if isinstance(value, (int, float)):
        number = float(value)
        return int(number if number > 10**12 else number * 1000)
    text = str(value).strip()
    if not text:
        return fallback
    try:
        number = float(text)
        return int(number if number > 10**12 else number * 1000)
    except ValueError:
        pass
    try:
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return fallback

root = Path(os.environ.get("PORTAL_CODEX_HOME") or (Path.home() / ".codex")).expanduser().resolve()
db_path = root / "state_5.sqlite"
source_id = os.environ["PORTAL_SOURCE_ID"]
source_name = decode("PORTAL_SOURCE_NAME_B64")
state = os.environ.get("PORTAL_STATE", "all")
query = decode("PORTAL_QUERY_B64").casefold()
limit = max(1, min(int(os.environ.get("PORTAL_LIMIT", "50")), 1000))
offset = max(0, int(os.environ.get("PORTAL_OFFSET", "0")))
start_at_ms = max(0, int(os.environ.get("PORTAL_START_AT_MS", "0")))

if state not in {"active", "archived", "all"}:
    raise SystemExit("invalid session state")
if not db_path.is_file():
    print(json.dumps({"items": [], "total": 0, "limit": limit, "offset": offset}))
    raise SystemExit(0)

connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
connection.row_factory = sqlite3.Row
try:
    columns = {
        str(row["name"])
        for row in connection.execute("PRAGMA table_info(threads)").fetchall()
    }
    if "id" not in columns:
        raise RuntimeError("Codex threads table does not contain id")
    selected = [
        name
        for name in (
            "id", "title", "cwd", "archived", "rollout_path", "created_at",
            "updated_at", "created_at_ms", "updated_at_ms", "recency_at",
            "recency_at_ms", "cli_version", "model_provider", "git_branch", "git_sha",
        )
        if name in columns
    ]
    order_column = next(
        (
            name
            for name in (
                "recency_at_ms", "updated_at_ms", "recency_at", "updated_at",
                "created_at_ms", "created_at",
            )
            if name in columns
        ),
        "id",
    )
    conditions = []
    parameters = []
    if "archived" in columns and state != "all":
        conditions.append("COALESCE(archived, 0) = ?")
        parameters.append(1 if state == "archived" else 0)
    if query:
        searchable = [name for name in ("id", "title", "cwd") if name in columns]
        conditions.append(
            "(" + " OR ".join(f"LOWER(CAST({name} AS TEXT)) LIKE ?" for name in searchable) + ")"
        )
        parameters.extend([f"%{query}%"] * len(searchable))
    if start_at_ms and order_column != "id":
        timestamp_value = (
            f"(CASE WHEN typeof({order_column}) IN ('integer','real') "
            f"THEN CASE WHEN ABS({order_column}) > 1000000000000 "
            f"THEN CAST({order_column} AS INTEGER) "
            f"ELSE CAST({order_column} * 1000 AS INTEGER) END "
            f"ELSE CAST((julianday({order_column}) - 2440587.5) * 86400000 AS INTEGER) END)"
        )
        conditions.append(f"{timestamp_value} >= ?")
        parameters.append(start_at_ms)
    where = " WHERE " + " AND ".join(conditions) if conditions else ""
    total = int(
        connection.execute(
            "SELECT COUNT(*) FROM threads" + where,
            tuple(parameters),
        ).fetchone()[0]
    )
    rows = connection.execute(
        f"SELECT {', '.join(selected)} FROM threads{where} "
        f"ORDER BY {order_column} DESC, id DESC LIMIT ? OFFSET ?",
        (*parameters, limit, offset),
    ).fetchall()
finally:
    connection.close()

items = []
for row in rows:
    value = dict(row)
    raw_rollout = str(value.get("rollout_path") or "")
    rollout = None
    rollout_size = 0
    if raw_rollout:
        try:
            candidate = Path(raw_rollout).expanduser().resolve()
            candidate.relative_to(root)
            if candidate.is_file():
                rollout = candidate
                rollout_size = candidate.stat().st_size
        except (OSError, ValueError):
            pass
    fallback = int(rollout.stat().st_mtime * 1000) if rollout else 0
    updated = next(
        (
            value.get(name)
            for name in (
                "recency_at_ms", "updated_at_ms", "recency_at", "updated_at",
                "created_at_ms", "created_at",
            )
            if value.get(name) is not None
        ),
        None,
    )
    archived = bool(value.get("archived", 0))
    title = str(value.get("title") or "").strip()
    cwd = str(value.get("cwd") or "").strip()
    summary = title or (f"Workspace: {cwd}" if cwd else f"Codex session on {source_name}")
    items.append(
        {
            "session_name": str(value["id"]),
            "source_session_id": str(value["id"]),
            "source_id": source_id,
            "source_name": source_name,
            "source_type": "node",
            "state": "archived" if archived else "active",
            "title": title,
            "cwd": cwd,
            "timestamp_ms": timestamp_ms(updated, fallback),
            "archive_size_bytes": rollout_size,
            "handoff_summary": summary,
            "uploaded_by_email": source_name,
        }
    )

print(
    json.dumps(
        {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + limit < total,
            "permissions": {"can_manage": False},
        },
        separators=(",", ":"),
    )
)
`;

const DETAIL_SCRIPT = String.raw`
import json
import os
import sqlite3
import base64
from collections import deque
from datetime import datetime
from pathlib import Path

def timestamp_ms(value, fallback=0):
    if value is None:
        return fallback
    if isinstance(value, (int, float)):
        number = float(value)
        return int(number if number > 10**12 else number * 1000)
    text = str(value).strip()
    if not text:
        return fallback
    try:
        number = float(text)
        return int(number if number > 10**12 else number * 1000)
    except ValueError:
        pass
    try:
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return fallback

root = Path(os.environ.get("PORTAL_CODEX_HOME") or (Path.home() / ".codex")).expanduser().resolve()
db_path = root / "state_5.sqlite"
source_id = os.environ["PORTAL_SOURCE_ID"]
source_name = base64.b64decode(
    os.environ["PORTAL_SOURCE_NAME_B64"]
).decode("utf-8")
session_id = os.environ["PORTAL_SESSION_ID"]
expected_state = os.environ["PORTAL_STATE"]

connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
connection.row_factory = sqlite3.Row
try:
    row = connection.execute("SELECT * FROM threads WHERE id = ? LIMIT 1", (session_id,)).fetchone()
finally:
    connection.close()
if row is None:
    print(json.dumps({"error": "not_found"}))
    raise SystemExit(0)

metadata = dict(row)
archived = bool(metadata.get("archived", 0))
actual_state = "archived" if archived else "active"
if actual_state != expected_state:
    print(json.dumps({"error": "not_found"}))
    raise SystemExit(0)

raw_rollout = str(metadata.get("rollout_path") or "")
try:
    rollout = Path(raw_rollout).expanduser().resolve()
    rollout.relative_to(root)
except (OSError, ValueError):
    rollout = Path()
if not rollout.is_file():
    print(json.dumps({"error": "rollout_not_found"}))
    raise SystemExit(0)

messages = deque()
total_chars = 0
truncated = False
with rollout.open(encoding="utf-8", errors="replace") as handle:
    for line in handle:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict) or value.get("type") != "event_msg":
            continue
        payload = value.get("payload")
        if not isinstance(payload, dict):
            continue
        event_type = payload.get("type")
        role = "user" if event_type == "user_message" else "assistant" if event_type == "agent_message" else None
        message = payload.get("message")
        if role is None or not isinstance(message, str) or not message.strip():
            continue
        text = message.strip()[:65536]
        messages.append({"role": role, "text": text, "timestamp": value.get("timestamp")})
        total_chars += len(text)
        while len(messages) > 300 or total_chars > 2 * 1024 * 1024:
            removed = messages.popleft()
            total_chars -= len(removed["text"])
            truncated = True

fallback = int(rollout.stat().st_mtime * 1000)
updated = next(
    (
        metadata.get(name)
        for name in (
            "recency_at_ms", "updated_at_ms", "recency_at", "updated_at",
            "created_at_ms", "created_at",
        )
        if metadata.get(name) is not None
    ),
    None,
)
safe_metadata = {}
for key, value in metadata.items():
    if value is None or isinstance(value, (str, int, float, bool)):
        safe_metadata[key] = value
    else:
        safe_metadata[key] = str(value)
safe_metadata.update(
    {
        "session_name": session_id,
        "source_session_id": session_id,
        "source_id": source_id,
        "source_name": source_name,
        "source_type": "node",
        "state": actual_state,
        "timestamp_ms": timestamp_ms(updated, fallback),
        "archive_size_bytes": rollout.stat().st_size,
        "handoff_summary": str(metadata.get("title") or "").strip()
            or f"Workspace: {metadata.get('cwd') or ''}".strip(),
    }
)
print(
    json.dumps(
        {
            "session": safe_metadata,
            "transcript": {
                "messages": list(messages),
                "message_count": len(messages),
                "truncated": truncated,
            },
            "transcript_error": None,
            "permissions": {"can_manage": False},
        },
        separators=(",", ":"),
    )
)
`;

function cleanMessage(value, maximumLength = 1200) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(-maximumLength);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...options.spawnOptions,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("Session history output exceeded the safety limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", finish);
    child.once("close", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) finish(null, result);
      else {
        finish(
          new Error(
            cleanMessage(result.stderr || result.stdout) ||
              `Session history command exited with code ${code}`,
          ),
        );
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Session history operation timed out"));
    }, options.timeoutMs ?? 60000);
    timer.unref?.();
    child.stdin.end(options.input ?? "");
  });
}

function parseResult(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Node session reader returned invalid JSON");
  }
}

function b64(value) {
  return Buffer.from(String(value ?? ""), "utf8").toString("base64");
}

function sessionApiKey(options = {}) {
  if (Object.hasOwn(options, "sessionApiKey")) {
    return String(options.sessionApiKey ?? "").trim();
  }
  const fromEnvironment = String(
    process.env.PORTAL_SESSION_HISTORY_API_KEY ?? "",
  ).trim();
  if (fromEnvironment) return fromEnvironment;
  const keyFile =
    process.env.PORTAL_SESSION_HISTORY_API_KEY_FILE ||
    DEFAULT_SESSION_API_KEY_FILE;
  try {
    return readFileSync(path.resolve(keyFile), "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export class NodeSessionHistory {
  constructor(config, options = {}) {
    this.config = config;
    this.runCommand = options.runCommand ?? runCommand;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.platform = options.platform ?? process.platform;
    this.sessionApiKey = sessionApiKey(options);
    this.httpOnly =
      options.httpOnly ??
      /^(?:1|true|yes|on)$/i.test(
        String(process.env.PORTAL_SESSION_HISTORY_HTTP_ONLY ?? ""),
      );
    this.httpSources = new Set();
  }

  setConfig(config) {
    this.config = config;
  }

  sources() {
    return this.config.nodes
      .filter((node) =>
        ["local", "ssh", "windows-ssh"].includes(node.management?.transport) ||
        (this.httpOnly && this.sessionApiKey),
      )
      .map((node) => ({
        id: node.id,
        name: `${node.name} (${node.id})`,
        type: "node",
        states: ["active", "archived", "all"],
      }));
  }

  async list(sourceId, options = {}) {
    const node = this.#node(sourceId);
    const state = options.state ?? "all";
    if (!["active", "archived", "all"].includes(state)) {
      throw this.#error("Node session state must be active, archived, or all");
    }
    const limit = Math.min(1000, Math.max(1, Number(options.limit ?? 50)));
    const offset = Math.max(0, Number(options.offset ?? 0));
    if (!Number.isInteger(limit) || !Number.isInteger(offset)) {
      throw this.#error("limit and offset must be integers");
    }
    const env = {
      PORTAL_SOURCE_ID: node.id,
      PORTAL_SOURCE_NAME_B64: b64(`${node.name} (${node.id})`),
      PORTAL_STATE: state,
      PORTAL_QUERY_B64: b64(String(options.query ?? "").slice(0, 256)),
      PORTAL_LIMIT: String(limit),
      PORTAL_OFFSET: String(offset),
      PORTAL_START_AT_MS: String(
        Math.max(0, Number(options.startAtMs ?? 0)),
      ),
    };
    const apiKey = this.#sessionApiKey(node);
    if (this.httpOnly) {
      if (!apiKey) throw this.#error("Node session-history API key is not configured", 503);
      const result = await this.#requestApi(node, apiKey, "session-history", {
        state,
        q: String(options.query ?? "").slice(0, 256),
        limit,
        offset,
        start_at_ms: env.PORTAL_START_AT_MS,
      });
      this.httpSources.add(node.id);
      return this.#decorateList(node, result);
    }
    if (
      ["ssh", "windows-ssh"].includes(node.management?.transport) &&
      apiKey
    ) {
      try {
        const result = await this.#requestApi(node, apiKey, "session-history", {
          state,
          q: String(options.query ?? "").slice(0, 256),
          limit,
          offset,
          start_at_ms: env.PORTAL_START_AT_MS,
        });
        this.httpSources.add(node.id);
        return this.#decorateList(node, result);
      } catch (error) {
        if (
          node.management.transport === "windows-ssh" ||
          (Number.isInteger(error?.status) && error.status !== 404)
        ) {
          throw error;
        }
        const fallback = parseResult(
          await this.#run(node, LIST_SCRIPT, env, 60000),
        );
        return {
          ...fallback,
          transport: "ssh_fallback",
          transport_error: cleanMessage(error?.message, 300),
        };
      }
    }
    return parseResult(await this.#run(node, LIST_SCRIPT, env, 60000));
  }

  async detail(sourceId, state, sessionId) {
    const node = this.#node(sourceId);
    if (!["active", "archived"].includes(state)) {
      throw this.#error("Node session state must be active or archived");
    }
    if (!SESSION_ID_PATTERN.test(String(sessionId ?? ""))) {
      throw this.#error("Session ID is invalid");
    }
    const apiKey = this.#sessionApiKey(node);
    if (this.httpOnly) {
      if (!apiKey) throw this.#error("Node session-history API key is not configured", 503);
      const result = await this.#requestApi(
        node,
        apiKey,
        `session-history/${state}/${encodeURIComponent(sessionId)}`,
      );
      this.httpSources.add(node.id);
      return this.#decorateDetail(node, result);
    }
    if (
      ["ssh", "windows-ssh"].includes(node.management?.transport) &&
      apiKey
    ) {
      try {
        const result = await this.#requestApi(
          node,
          apiKey,
          `session-history/${state}/${encodeURIComponent(sessionId)}`,
        );
        this.httpSources.add(node.id);
        return this.#decorateDetail(node, result);
      } catch (error) {
        if (
          node.management.transport === "windows-ssh" ||
          (Number.isInteger(error?.status) && error.status !== 404) ||
          this.httpSources.has(node.id)
        ) {
          throw error;
        }
      }
    }
    const value = parseResult(
      await this.#run(
        node,
        DETAIL_SCRIPT,
        {
          PORTAL_SOURCE_ID: node.id,
          PORTAL_SOURCE_NAME_B64: b64(`${node.name} (${node.id})`),
          PORTAL_STATE: state,
          PORTAL_SESSION_ID: sessionId,
        },
        120000,
      ),
    );
    if (value.error) {
      const error = this.#error(
        value.error === "not_found"
          ? "Node session was not found"
          : "Node rollout file was not found",
        404,
      );
      throw error;
    }
    return value;
  }

  #decorateList(node, value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.items)) {
      throw this.#error("Node session API returned an invalid list response", 502);
    }
    return {
      ...value,
      items: value.items.slice(0, 1000).map((item) => ({
        ...item,
        source_id: node.id,
        source_name: `${node.name} (${node.id})`,
        source_type: "node",
      })),
    };
  }

  #decorateDetail(node, value) {
    if (
      !value ||
      typeof value !== "object" ||
      !value.session ||
      typeof value.session !== "object" ||
      !value.transcript ||
      typeof value.transcript !== "object"
    ) {
      throw this.#error("Node session API returned an invalid detail response", 502);
    }
    return {
      ...value,
      session: {
        ...value.session,
        source_id: node.id,
        source_name: `${node.name} (${node.id})`,
        source_type: "node",
      },
    };
  }

  #sessionApiKey(node) {
    if (node.management?.sessionApiKeyFile) {
      try {
        return readFileSync(
          path.resolve(node.management.sessionApiKeyFile),
          "utf8",
        ).trim();
      } catch {
        return "";
      }
    }
    return this.sessionApiKey;
  }

  async #requestApi(node, apiKey, siblingPath, searchParams = {}) {
    const url = deriveEndpointUrl(node.endpoint, siblingPath);
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1000, Number(this.config.requestTimeoutMs ?? 8000)),
    );
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          accept: "application/json",
          "user-agent": "codex-usage-portal/1.0",
          "x-api-key": apiKey,
        },
        redirect: "error",
        signal: controller.signal,
      });
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_OUTPUT_BYTES
      ) {
        throw this.#error("Node session API response is too large", 502);
      }
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MAX_OUTPUT_BYTES) {
        throw this.#error("Node session API response is too large", 502);
      }
      if (!response.ok) {
        throw this.#error(
          `Node session API returned HTTP ${response.status}`,
          response.status,
        );
      }
      try {
        return JSON.parse(body);
      } catch {
        throw this.#error("Node session API returned invalid JSON", 502);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  #node(sourceId) {
    const node = this.config.nodes.find((item) => item.id === sourceId);
    if (
      !node ||
      (!["local", "ssh", "windows-ssh"].includes(node.management?.transport) &&
        !(this.httpOnly && this.sessionApiKey))
    ) {
      throw this.#error("Unknown node session source", 404);
    }
    return node;
  }

  async #run(node, script, environment, timeoutMs) {
    if (node.management.transport === "ssh") {
      return this.runCommand(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          node.management.sshHost,
          "env",
          `PATH=${node.management.runtimeBin}:/usr/local/bin:/usr/bin:/bin:/snap/bin`,
          ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
          "python3",
          "-",
        ],
        { input: script, timeoutMs },
      );
    }
    const sessionRoot = path.resolve(node.management.sessionRoot);
    const codexHome = path.dirname(sessionRoot);
    return this.runCommand(this.platform === "win32" ? "python" : "python3", ["-"], {
      input: script,
      timeoutMs,
      spawnOptions: {
        env: {
          ...process.env,
          ...environment,
          PORTAL_CODEX_HOME: codexHome,
        },
      },
    });
  }

  #error(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    error.expose = true;
    return error;
  }
}

export const nodeSessionHistoryInternals = Object.freeze({
  DETAIL_SCRIPT,
  LIST_SCRIPT,
  SESSION_ID_PATTERN,
});
