import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "./config.mjs";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BUILD_SCRIPT = String.raw`
import json
import os
from pathlib import Path
from codex_session_share.bundle import build_session_bundle

session_id = os.environ["PORTAL_SESSION_ID"]
output = Path(os.environ["PORTAL_OUTPUT"]).expanduser()
output.parent.mkdir(parents=True, exist_ok=True)
result = build_session_bundle(
    session_id,
    output,
    codex_home=Path(os.environ.get("PORTAL_CODEX_HOME") or (Path.home() / ".codex")),
    workspace=Path.home(),
    include_workspace=False,
    include_git_bundle=False,
)
manifest = result.manifest
print(
    json.dumps(
        {
            "archive_path": str(result.archive_path),
            "archive_sha256": result.archive_sha256,
            "archive_size_bytes": result.archive_size_bytes,
            "handoff_summary": result.handoff_summary,
            "manifest": {
                "schema_version": manifest.get("schema_version"),
                "source_session_id": session_id,
                "created_at": manifest.get("created_at"),
                "source": manifest.get("source") or {},
                "workspace": {
                    "included": False,
                    "file_count": 0,
                    "excluded_sensitive_file_count": 0,
                    "git_bundle": None,
                },
                "security": manifest.get("security") or {},
            },
        },
        separators=(",", ":"),
    )
)
`;
const MINIMAL_ARCHIVE_SCRIPT = String.raw`
import json
import tarfile
from pathlib import Path

detail = json.loads(Path(__import__("os").environ["PORTAL_DETAIL"]).read_text(encoding="utf-8"))
output = Path(__import__("os").environ["PORTAL_OUTPUT"])
root = output.parent / "minimal"
codex = root / "codex"
workspace = root / "workspace"
codex.mkdir(parents=True, exist_ok=True)
workspace.mkdir(parents=True, exist_ok=True)
session = detail["session"]
messages = (detail.get("transcript") or {}).get("messages") or []
session_id = str(session["session_name"])
records = [
    {
        "type": "session_meta",
        "payload": {
            "id": session_id,
            "timestamp": "2026-08-15T00:00:00Z",
            "cwd": session.get("cwd") or "",
        },
    }
]
for message in messages:
    records.append(
        {
            "timestamp": message.get("timestamp"),
            "type": "event_msg",
            "payload": {
                "type": (
                    "user_message"
                    if message.get("role") == "user"
                    else "agent_message"
                ),
                "message": message.get("text") or "",
            },
        }
    )
(codex / "rollout.jsonl").write_text(
    "".join(json.dumps(record) + "\n" for record in records),
    encoding="utf-8",
)
(codex / "thread.json").write_text(json.dumps(session), encoding="utf-8")
(codex / "goal.json").write_text("{}", encoding="utf-8")
(codex / "memories.json").write_text("[]", encoding="utf-8")
(codex / "session_index.json").write_text("{}", encoding="utf-8")
(workspace / "metadata.json").write_text(
    json.dumps(
        {
            "included": False,
            "source_path": session.get("cwd") or "",
            "files": [],
            "excluded_sensitive_files": [],
        }
    ),
    encoding="utf-8",
)
handoff = (
    session.get("title")
    or session.get("handoff_summary")
    or f"Imported node session {session_id}"
)
manifest = {
    "schema_version": 1,
    "session_id": session_id,
    "created_at": "2026-08-15T00:00:00Z",
    "source": {
        "codex_home": "",
        "user_home": "",
        "rollout_path": session.get("rollout_path"),
        "workspace": session.get("cwd") or "",
    },
    "codex_files": [],
    "workspace": {
        "included": False,
        "source_path": session.get("cwd") or "",
        "files": [],
    },
    "security": {
        "credentials_included": False,
        "history_is_unredacted": True,
    },
    "handoff_summary": handoff,
    "inventory": [],
}
(root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
with tarfile.open(output, "w:gz") as archive:
    for child in (codex, workspace, root / "manifest.json"):
        archive.add(child, arcname=child.name)
print(
    json.dumps(
        {
            "archive_path": str(output),
            "handoff_summary": handoff,
            "manifest": {
                "schema_version": 1,
                "source_session_id": session_id,
                "workspace": {"included": False},
            },
        },
        separators=(",", ":"),
    )
)
`;

function cleanMessage(value, maximumLength = 1600) {
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
        finish(new Error("Session upload output exceeded the safety limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", finish);
    child.once("close", (code) => {
      const value = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) finish(null, value);
      else {
        finish(
          new Error(
            cleanMessage(value.stderr || value.stdout) ||
              `Session upload command exited with code ${code}`,
          ),
        );
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Session bundle preparation timed out"));
    }, options.timeoutMs ?? 10 * 60 * 1000);
    timer.unref?.();
    child.stdin.end(options.input ?? "");
  });
}

function parseJsonOutput(value) {
  const line = String(value).trim().split(/\r?\n/).filter(Boolean).at(-1);
  try {
    return JSON.parse(line);
  } catch {
    throw new Error("Session bundle builder returned invalid JSON");
  }
}

export function sharedSessionName(sourceId, sessionId) {
  return `${sourceId.replaceAll("-", "_")}_${sessionId.replaceAll("-", "_")}`;
}

export class NodeSessionUploader {
  constructor(config, options = {}) {
    this.config = config;
    this.nodeHistory = options.nodeHistory;
    this.sharedClient = options.sharedClient;
    this.runCommand = options.runCommand ?? runCommand;
    this.platform = options.platform ?? process.platform;
    this.sourceRoot =
      options.sourceRoot ??
      path.join(PROJECT_ROOT, "codex-session-share-mcp", "src");
    this.activeUploads = new Set();
  }

  setConfig(config) {
    this.config = config;
  }

  async upload(sourceId, state, sessionId) {
    if (!SESSION_ID_PATTERN.test(String(sessionId ?? ""))) {
      throw this.#error("Session ID is invalid");
    }
    const node = this.#node(sourceId);
    const lockKey = `${sourceId}:${sessionId}`;
    if (this.activeUploads.has(lockKey)) {
      throw this.#error("This session upload is already running", 409);
    }
    this.activeUploads.add(lockKey);
    const temporary = await mkdtemp(path.join(os.tmpdir(), "session-upload-"));
    const archivePath = path.join(temporary, "bundle.tar.gz");
    try {
      const built =
        sourceId === "zhn-a100"
          ? await this.#buildMinimal(sourceId, state, sessionId, temporary)
          : await this.#buildNative(node, state, sessionId, archivePath);
      const archive = await stat(archivePath);
      const sha256 = createHash("sha256")
        .update(await readFile(archivePath))
        .digest("hex");
      const sharedName = sharedSessionName(sourceId, sessionId);
      const ticket = await this.sharedClient.reserveUpload({
        session_id: sessionId,
        name: sharedName,
        archive_sha256: sha256,
        archive_size_bytes: archive.size,
        handoff_summary: built.handoff_summary,
        manifest: built.manifest,
      });
      const stored = await this.sharedClient.uploadArchive(
        ticket.upload.url,
        archivePath,
        archive.size,
      );
      if (!stored.search_projection?.indexed) {
        throw new Error(
          `Session stored but search indexing failed: ${
            stored.search_projection?.error ?? "unknown error"
          }`,
        );
      }
      return {
        ok: true,
        sourceId,
        sessionId,
        sharedName,
        archiveSizeBytes: archive.size,
        sha256,
        stored,
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
      this.activeUploads.delete(lockKey);
    }
  }

  async #buildNative(node, state, sessionId, localArchive) {
    await access(path.join(this.sourceRoot, "codex_session_share", "bundle.py"));
    if (node.management.transport === "windows-ssh") {
      const detail = await this.nodeHistory.detail(node.id, state, sessionId);
      const detailPath = path.join(path.dirname(localArchive), "detail.json");
      await writeFile(detailPath, JSON.stringify(detail), "utf8");
      const result = await this.runCommand("python", ["-"], {
        input: MINIMAL_ARCHIVE_SCRIPT,
        timeoutMs: 120000,
        spawnOptions: {
          env: {
            ...process.env,
            PORTAL_DETAIL: detailPath,
            PORTAL_OUTPUT: localArchive,
          },
        },
      });
      return parseJsonOutput(result.stdout);
    }
    if (node.management.transport === "ssh") {
      const stage = `~/.cache/codex-session-share-portal/${sharedSessionName(
        node.id,
        sessionId,
      )}`;
      await this.runCommand(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          node.management.sshHost,
          "rm",
          "-rf",
          stage,
        ],
        { timeoutMs: 60000 },
      ).catch(() => {});
      await this.runCommand(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          node.management.sshHost,
          "mkdir",
          "-p",
          stage,
        ],
        { timeoutMs: 60000 },
      );
      await this.runCommand(
        "scp",
        [
          "-r",
          "-q",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          path.join(this.sourceRoot, "codex_session_share"),
          `${node.management.sshHost}:${stage}/`,
        ],
        { timeoutMs: 120000 },
      );
      const remoteArchive = `${stage}/bundle.tar.gz`;
      try {
        const result = await this.runCommand(
          "ssh",
          [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            node.management.sshHost,
            "env",
            `PYTHONPATH=${stage}`,
            `PORTAL_SESSION_ID=${sessionId}`,
            `PORTAL_OUTPUT=${remoteArchive}`,
            "python3",
            "-",
          ],
          { input: BUILD_SCRIPT, timeoutMs: 15 * 60 * 1000 },
        );
        await this.runCommand(
          "scp",
          [
            "-q",
            "-p",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            `${node.management.sshHost}:${remoteArchive}`,
            localArchive,
          ],
          { timeoutMs: 15 * 60 * 1000 },
        );
        return parseJsonOutput(result.stdout);
      } finally {
        await this.runCommand(
          "ssh",
          [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            node.management.sshHost,
            "rm",
            "-rf",
            stage,
          ],
          { timeoutMs: 60000 },
        ).catch(() => {});
      }
    }

    if (this.platform !== "win32") {
      throw new Error("Local session uploads currently require Windows");
    }
    const codexHome = path.dirname(path.resolve(node.management.sessionRoot));
    const result = await this.runCommand("python", ["-"], {
      input: BUILD_SCRIPT,
      timeoutMs: 15 * 60 * 1000,
      spawnOptions: {
        env: {
          ...process.env,
          PYTHONPATH: this.sourceRoot,
          PORTAL_CODEX_HOME: codexHome,
          PORTAL_SESSION_ID: sessionId,
          PORTAL_OUTPUT: localArchive,
        },
      },
    });
    return parseJsonOutput(result.stdout);
  }

  async #buildMinimal(sourceId, state, sessionId, temporary) {
    const detail = await this.nodeHistory.detail(sourceId, state, sessionId);
    const detailPath = path.join(temporary, "detail.json");
    const output = path.join(temporary, "bundle.tar.gz");
    await writeFile(detailPath, JSON.stringify(detail), "utf8");
    const result = await this.runCommand("python", ["-"], {
      input: MINIMAL_ARCHIVE_SCRIPT,
      timeoutMs: 120000,
      spawnOptions: {
        env: {
          ...process.env,
          PORTAL_DETAIL: detailPath,
          PORTAL_OUTPUT: output,
        },
      },
    });
    return parseJsonOutput(result.stdout);
  }

  #node(sourceId) {
    const node = this.config.nodes.find((item) => item.id === sourceId);
    if (!node || !["local", "ssh"].includes(node.management?.transport)) {
      throw this.#error("Unknown node session source", 404);
    }
    return node;
  }

  #error(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    error.expose = true;
    return error;
  }
}

export const nodeSessionUploaderInternals = Object.freeze({
  BUILD_SCRIPT,
  MINIMAL_ARCHIVE_SCRIPT,
});
