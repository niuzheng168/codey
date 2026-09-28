// Shared by the installed Codey CLI and the repository setup entrypoint.
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);
const BEGIN = "# BEGIN Codey Agency MCP - read-only";
const END = "# END Codey Agency MCP - read-only";

// Reviewed against Agency's Teams/Mail catalogs. Never infer permission from a
// name prefix or automatically enable newly advertised tools.
export const AGENCY_SERVERS = Object.freeze({
  teams: Object.freeze({
    name: "agency_teams",
    tools: Object.freeze([
      "ListTeams", "ListChannels", "GetTeam", "GetChannel", "ListTeamMembers",
      "ListChatMembers", "ListChannelMembers", "ListChats", "GetChat",
      "ListChatMessages", "ListChannelMessages", "GetChatMessage",
      "ListChannelMessageReplies", "SearchTeamsMessages", "SearchTeamMessagesQueryParameters",
    ]),
  }),
  mail: Object.freeze({
    name: "agency_mail",
    tools: Object.freeze([
      "GetMessage", "SearchMessages", "SearchMessagesQueryParameters",
      "GetAttachments", "DownloadAttachment",
    ]),
  }),
});

export function agencyMcpEnvironment({ platform = process.platform, env = process.env } = {}) {
  const environment = { AGENCY_AEC_ENABLED: "0" };
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    // Agency otherwise selects Azure CLI on headless Linux, whose application
    // may lack the Teams/Mail scopes. Use the pre-authenticated AzureAuth cache
    // without launching a browser from a background MCP process. Interactive
    // sign-in remains a separate, organization-approved browser operation.
    environment.BROWSER = "/bin/false";
  }
  return environment;
}

export function executableCandidates(name, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (!["win32", "darwin", "linux"].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  const paths = platform === "win32" ? path.win32 : path.posix;
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const binary = name + (platform === "win32" ? ".exe" : "");
  const directories = [];
  if (name === "agency" && platform === "win32") {
    directories.push(paths.join(env.APPDATA || paths.join(home, "AppData", "Roaming"), "agency", "CurrentVersion"));
  }
  directories.push(...pathValue.split(platform === "win32" ? ";" : ":"));
  if (platform !== "win32") {
    directories.push(paths.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin");
  }
  return [...new Set(directories.map(value => value.replace(/^"(.*)"$/, "$1"))
    .filter(value => value && paths.isAbsolute(value)).map(value => paths.join(value, binary)))];
}

function versionParts(value) {
  const match = value.match(/\bagency\s+(\d+(?:\.\d+){1,4})\b/);
  return match ? match[1].split(".").map(Number) : null;
}

export function newestAgency(installations) {
  return [...installations].filter(item => versionParts(item.version)).sort((left, right) => {
    const a = versionParts(left.version), b = versionParts(right.version);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
    }
    return 0;
  })[0];
}

export async function resolveExecutable(name, { explicit, env = process.env, ...options } = {}) {
  const candidates = explicit ? [path.resolve(explicit)] : executableCandidates(name, { env, ...options });
  const found = [];
  for (const command of candidates) {
    try {
      await access(command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      const { stdout } = await execute(command, ["--version"], {
        env, windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024,
      });
      const version = stdout.trim();
      if (name === "agency" && !versionParts(version)) throw new Error("Unexpected Agency version output.");
      found.push({ command, version });
      if (name !== "agency") break;
    } catch (error) {
      if (explicit) throw new Error(`Cannot run ${name} at ${command}: ${error.code || "invalid version output"}`);
    }
  }
  if (!found.length) throw new Error(`${name} is not installed or executable. Install its native build, then pass --${name} /absolute/path/to/${name}.`);
  return name === "agency" ? newestAgency(found) : found[0];
}

export function redactDiagnostic(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED JWT]")
    .replace(/((?:access_token|refresh_token|client_secret|password)\s*["']?\s*[:=]\s*["']?)[^"'\s&,}]+/gi, "$1[REDACTED]")
    .slice(0, 2000);
}

export class StdioMcpClient {
  constructor(command, args, { env = process.env, timeoutMs = 120000, maxBytes = 16 * 1024 * 1024 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = "";
    this.closed = false;
    this.child = spawn(command, args, { env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise(resolve => this.child.once("close", resolve));
    // Agency owns authentication. Never print/copy its stderr or credential cache.
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", data => this.receive(data));
    this.child.stdin.on("error", error => this.fail(new Error(`MCP input failed: ${error.code}`)));
    this.child.once("error", error => this.fail(new Error(`MCP process failed: ${error.code}`)));
    this.child.once("close", code => this.fail(new Error(`MCP process exited (${code}). Check Agency sign-in using its supported workflow.`)));
  }

  fail(error) {
    this.failure ??= error;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    if (this.closed || this.failure) throw this.failure || new Error("MCP client is closed.");
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  receive(data) {
    if (this.closed || this.failure) return;
    this.buffer += data;
    if (Buffer.byteLength(this.buffer) > this.maxBytes) {
      this.fail(new Error("MCP response exceeds the configured size limit."));
      this.child.kill();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        this.fail(new Error("MCP server wrote non-JSON output to stdout."));
        this.child.kill();
        return;
      }
      if (message.jsonrpc !== "2.0") {
        this.fail(new Error("Invalid MCP JSON-RPC response."));
        this.child.kill();
        return;
      }
      if (message.method && message.id !== undefined) {
        // Discovery/verification never grants sampling, roots, or elicitation.
        this.send({ id: message.id, error: { code: -32601, message: "Unsupported server-initiated request." } });
      } else if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(redactDiagnostic(message.error.message || "MCP request failed.")));
        else pending.resolve(message.result);
      }
    }
  }

  request(method, params = {}) {
    if (this.failure || this.closed) return Promise.reject(this.failure || new Error("MCP client is closed."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out. Complete Agency sign-in and retry; no configuration was changed.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "codey-agency-readonly-setup", version: "1.0.0" },
    });
    if (!result?.capabilities?.tools) throw new Error("Agency did not advertise MCP tools.");
    this.send({ method: "notifications/initialized" });
    return result;
  }

  async listTools() {
    const tools = [], cursors = new Set(), names = new Set();
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw new Error("Invalid MCP tool catalog.");
      for (const tool of result.tools) {
        if (!tool || typeof tool.name !== "string" || names.has(tool.name)) throw new Error("Invalid or duplicate MCP tool name.");
        names.add(tool.name);
        tools.push(tool);
      }
      if (!result.nextCursor) return tools;
      if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) throw new Error("Invalid MCP pagination cursor.");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("MCP tool catalog exceeded 100 pages.");
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("MCP client closed."));
    this.child.stdin.end();
    this.child.kill();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}

export function validateReadOnlyCatalog(service, tools) {
  const spec = AGENCY_SERVERS[service];
  if (!spec) throw new Error(`Unsupported Agency service: ${service}`);
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  for (const name of spec.tools) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`${service} is missing reviewed read-only tool ${name}; refusing to change configuration.`);
    if (tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true) {
      throw new Error(`${service}/${name} is annotated as writable/destructive; refusing to enable it.`);
    }
  }
  return { service, enabledTools: [...spec.tools], excludedTools: tools.filter(tool => !spec.tools.includes(tool.name)).map(tool => tool.name) };
}

export async function callReadOnlyTool(client, service, name, args) {
  if (!AGENCY_SERVERS[service]?.tools.includes(name)) throw new Error(`Tool is not in the read-only allowlist: ${service}/${name}`);
  let result;
  try { result = await client.request("tools/call", { name, arguments: args }); } catch {
    // A service error can echo a message ID or other private request data.
    throw new Error(`${service}/${name} RPC failed. Check Agency sign-in; private error details are not printed.`);
  }
  if (!result || result.isError) throw new Error(`${service}/${name} returned a tool error. No message content is printed.`);
  return result;
}

export function parseToolData(result) {
  if (result.isError) throw new Error("The read probe returned a tool error.");
  let data = result.structuredContent;
  if (!data) {
    for (const item of result.content ?? []) {
      if (item.type !== "text") continue;
      try { data = JSON.parse(item.text); break; } catch { /* Do not log private response text. */ }
    }
  }
  for (let depth = 0; depth < 5; depth++) {
    if (!data || typeof data !== "object") throw new Error("The read probe did not return structured data; refusing to report success.");
    if (data.error || Number(data.statusCode) >= 400) throw new Error("The service returned an error inside the MCP result; no private response is printed.");
    if (typeof data.rawResponse !== "string") return data;
    try { data = JSON.parse(data.rawResponse); } catch {
      throw new Error("Agency returned an unrecognized response wrapper; refusing to report success.");
    }
  }
  throw new Error("Agency response nesting exceeded the supported limit.");
}

export async function verifyAgencyReadAccess(client, service, { now = new Date() } = {}) {
  if (service === "mail") {
    const data = parseToolData(await callReadOnlyTool(client, service, "SearchMessagesQueryParameters", {
      queryParameters: "?$top=1&$select=id,receivedDateTime,isRead",
    }));
    if (!Array.isArray(data.value)) throw new Error("Mail search did not return a message collection.");
    const first = data.value[0];
    if (!first) return { querySucceeded: true, returnedItems: 0, messageRead: false };
    if (typeof first.id !== "string" || !first.id) throw new Error("Mail search returned no usable message ID.");
    const response = parseToolData(await callReadOnlyTool(client, service, "GetMessage", {
      id: first.id, bodyPreviewOnly: true,
    }));
    const message = response.data ?? response;
    if (message.id !== first.id || typeof message.bodyPreview !== "string") throw new Error("Mail read probe did not return the requested message preview.");
    if (typeof first.isRead === "boolean" && message.isRead !== first.isRead) {
      throw new Error("Mail read-state changed during verification; no write tool was called.");
    }
    return { querySucceeded: true, returnedItems: data.value.length, messageRead: true };
  }
  if (service === "teams") {
    const since = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const data = parseToolData(await callReadOnlyTool(client, service, "SearchTeamMessagesQueryParameters", {
      queryString: `sent>=${since}`, from: 0, size: 1,
    }));
    if (!Array.isArray(data.value) || !data.value.every(item => Array.isArray(item.hitsContainers))) {
      throw new Error("Teams search did not return a search result collection.");
    }
    const hits = data.value.flatMap(item => item.hitsContainers.flatMap(container => {
      if (!Array.isArray(container.hits)) throw new Error("Teams search did not return a hit collection.");
      return container.hits;
    }));
    const resource = hits[0]?.resource;
    let messageRead = false;
    if (resource?.chatId?.endsWith("@thread.v2") && resource.id) {
      const response = parseToolData(await callReadOnlyTool(client, service, "GetChatMessage", {
        chatId: resource.chatId, messageId: resource.id,
      }));
      const message = response.data ?? response;
      if (message.id !== resource.id || !message.body) throw new Error("Teams read probe did not return the requested message.");
      messageRead = true;
    }
    return { querySucceeded: true, returnedItems: hits.length, messageRead };
  }
  throw new Error(`Unsupported Agency service: ${service}`);
}

export function renderAgencyConfig(command, newline = "\n", options = {}) {
  const environment = Object.entries(agencyMcpEnvironment(options))
    .map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join(", ");
  const lines = [BEGIN, "# Explicit allowlists: new tools remain disabled. Agency manages Entra authentication."];
  for (const [service, spec] of Object.entries(AGENCY_SERVERS)) {
    lines.push(`[mcp_servers.${spec.name}]`, `command = ${JSON.stringify(command)}`,
      `args = ["mcp", "${service}"]`, "enabled = true", "required = false",
      "startup_timeout_sec = 120", "tool_timeout_sec = 120",
      `enabled_tools = ${JSON.stringify(spec.tools)}`, `env = { ${environment} }`, "");
  }
  lines.push(END);
  return lines.join(newline);
}

export function mergeAgencyConfig(original, command, options = {}) {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const block = renderAgencyConfig(command, newline, options);
  const starts = [...original.matchAll(/^# BEGIN Codey Agency MCP - read-only\r?$/gm)];
  const ends = [...original.matchAll(/^# END Codey Agency MCP - read-only\r?$/gm)];
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
      throw new Error("Malformed Agency managed block; refusing to rewrite the existing configuration.");
    }
    const start = starts[0].index, end = ends[0].index + END.length;
    const oldBlock = original.slice(start, end);
    const headers = [...oldBlock.matchAll(/^\s*\[([^\]]+)\]/gm)].map(match => match[1]);
    if (headers.length !== 2 || !headers.includes("mcp_servers.agency_teams") || !headers.includes("mcp_servers.agency_mail")) {
      throw new Error("Unexpected configuration inside the Agency managed block.");
    }
    return original.slice(0, start) + block + original.slice(end);
  }
  // Native Codex validation also catches inline/dotted/quoted TOML duplicates.
  if (/^\s*\[\s*mcp_servers\s*\.\s*["']?agency_(teams|mail)\b/m.test(original)) {
    throw new Error("Existing unmanaged Agency MCP configuration found. Review it instead of silently overwriting it.");
  }
  return original + (original && !original.endsWith("\n") ? newline : "") + newline + block + newline;
}

export async function validateCodexConfig(codex, contents, command, {
  executeImpl = execute, environment = agencyMcpEnvironment(),
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agency-mcp-validate-"));
  try {
    await writeFile(path.join(root, "config.toml"), contents, { mode: 0o600 });
    for (const [service, spec] of Object.entries(AGENCY_SERVERS)) {
      const { stdout } = await executeImpl(codex, ["mcp", "get", spec.name, "--json"], {
        env: { ...process.env, CODEX_HOME: root }, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
      });
      const config = JSON.parse(stdout);
      if (config.transport?.command !== command || JSON.stringify(config.transport?.args) !== JSON.stringify(["mcp", service])
        || config.enabled !== true || JSON.stringify(config.enabled_tools) !== JSON.stringify(spec.tools)
        || Object.entries(environment).some(([name, value]) => config.transport?.env?.[name] !== value)) {
        throw new Error(`Codex did not preserve the read-only configuration for ${spec.name}.`);
      }
    }
  } catch {
    // Config can contain secrets. Do not print native parser output or the file.
    throw new Error("Native Codex rejected the candidate MCP configuration; the existing config was not changed.");
  } finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("agency-mcp-validate-")) {
      throw new Error("Refusing to remove an unexpected validation directory.");
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

export async function installAgencyConfig(configPath, original, updated) {
  const absolute = path.resolve(configPath);
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  let info;
  try { info = await lstat(absolute); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Refusing to replace a non-regular Codex configuration file.");
  const current = await readFile(absolute, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (current !== original) throw new Error("Codex configuration changed during setup; rerun instead of overwriting it.");
  if (current === updated) return { changed: false, configPath: absolute };
  const suffix = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const backupPath = info ? `${absolute}.agency-backup-${suffix}` : undefined;
  const temporary = `${absolute}.agency-${randomUUID()}.tmp`;
  if (backupPath) await writeFile(backupPath, original, { mode: 0o600, flag: "wx" });
  try {
    await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
    const latest = await readFile(absolute, "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (latest !== original) throw new Error("Codex configuration changed during setup; the original was preserved.");
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true });
  }
  return { changed: true, configPath: absolute, backupPath };
}
