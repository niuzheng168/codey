import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");
export const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config", "nodes.json");

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const SSH_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,252}[a-z0-9])?$/i;
const POSIX_PATH_PATTERN = /^\/[a-zA-Z0-9._/+:-]+$/;

function integerInRange(value, fallback, minimum, maximum, label) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function validateManagement(value, nodeId) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Node ${nodeId} management must be an object`);
  }

  const transport = String(value.transport ?? "");
  if (!["local", "ssh", "windows-ssh"].includes(transport)) {
    throw new Error(
      `Node ${nodeId} management transport must be local, ssh, or windows-ssh`,
    );
  }

  const copilotApi = String(value.copilotApi ?? "none");
  const codexCli = String(value.codexCli ?? "none");
  const allowedCopilot =
    transport === "local"
      ? new Set(["local-npx", "none"])
      : transport === "windows-ssh"
        ? new Set(["windows-startup", "none"])
        : new Set(["systemd-user", "none"]);
  const allowedCodex =
    transport === "local" || transport === "windows-ssh"
      ? new Set(["desktop-managed", "none"])
      : new Set(["npm-global", "none"]);
  if (!allowedCopilot.has(copilotApi)) {
    throw new Error(`Node ${nodeId} has an invalid copilotApi management mode`);
  }
  if (!allowedCodex.has(codexCli)) {
    throw new Error(`Node ${nodeId} has an invalid codexCli management mode`);
  }

  if (transport === "local") {
    const sessionRoot = String(value.sessionRoot ?? "").trim();
    if (!sessionRoot || sessionRoot.length > 1024 || !path.isAbsolute(sessionRoot)) {
      throw new Error(`Node ${nodeId} local management requires an absolute sessionRoot`);
    }
    return Object.freeze({ transport, sessionRoot, copilotApi, codexCli });
  }

  const sshHost = String(value.sshHost ?? "").trim();
  if (!SSH_HOST_PATTERN.test(sshHost)) {
    throw new Error(`Node ${nodeId} has an invalid sshHost`);
  }
  if (transport === "windows-ssh") {
    const sessionApiKeyFile = String(value.sessionApiKeyFile ?? "").trim();
    if (!sessionApiKeyFile || !path.isAbsolute(sessionApiKeyFile)) {
      throw new Error(
        `Node ${nodeId} Windows management requires an absolute sessionApiKeyFile`,
      );
    }
    return Object.freeze({
      transport,
      sshHost,
      sessionApiKeyFile,
      copilotApi,
      codexCli,
    });
  }
  const runtimeBin = String(value.runtimeBin ?? "").trim();
  if (runtimeBin.length > 512 || !POSIX_PATH_PATTERN.test(runtimeBin)) {
    throw new Error(`Node ${nodeId} has an invalid runtimeBin`);
  }
  return Object.freeze({ transport, sshHost, runtimeBin, copilotApi, codexCli });
}

function validateClientNode(node, seenIds = new Set()) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new Error("Each client node must be an object");
  }
  const id = String(node.id ?? "").trim();
  if (!NODE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid client node id: ${id || "<empty>"}`);
  }
  if (seenIds.has(id)) {
    throw new Error(`Duplicate client node id: ${id}`);
  }
  seenIds.add(id);

  const name = String(node.name ?? "").trim();
  if (!name || name.length > 80) {
    throw new Error(`Client node ${id} must have a name of at most 80 characters`);
  }
  const region = String(node.region ?? "").trim();
  if (region.length > 120) {
    throw new Error(`Client node ${id} region is too long`);
  }
  let endpoint;
  try {
    endpoint = new URL(String(node.endpoint ?? ""));
  } catch {
    throw new Error(`Client node ${id} has an invalid endpoint URL`);
  }
  if (!new Set(["http:", "https:"]).has(endpoint.protocol)) {
    throw new Error(`Client node ${id} endpoint must use http or https`);
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error(
      `Client node ${id} endpoint cannot contain credentials or a fragment`,
    );
  }
  endpoint.search = "";
  const accent = String(node.accent ?? "#8b5cf6");
  if (!HEX_COLOR_PATTERN.test(accent)) {
    throw new Error(`Client node ${id} accent must be a six-digit hex color`);
  }
  return Object.freeze({
    id,
    name,
    region,
    endpoint: endpoint.toString(),
    accent: accent.toLowerCase(),
  });
}

export function validateNode(node, seenIds = new Set()) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new Error("Each node must be an object");
  }

  const id = String(node.id ?? "").trim();
  if (!NODE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid node id: ${id || "<empty>"}`);
  }
  if (seenIds.has(id)) {
    throw new Error(`Duplicate node id: ${id}`);
  }
  seenIds.add(id);

  const name = String(node.name ?? "").trim();
  if (!name || name.length > 80) {
    throw new Error(`Node ${id} must have a name of at most 80 characters`);
  }

  const region = String(node.region ?? "").trim();
  if (region.length > 120) {
    throw new Error(`Node ${id} region is too long`);
  }

  let endpoint;
  try {
    endpoint = new URL(String(node.endpoint ?? ""));
  } catch {
    throw new Error(`Node ${id} has an invalid endpoint URL`);
  }
  if (!new Set(["http:", "https:"]).has(endpoint.protocol)) {
    throw new Error(`Node ${id} endpoint must use http or https`);
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error(`Node ${id} endpoint cannot contain credentials or a fragment`);
  }
  endpoint.search = "";

  const apiKeyEnv = String(node.apiKeyEnv ?? "").trim();
  if (apiKeyEnv && !ENV_NAME_PATTERN.test(apiKeyEnv)) {
    throw new Error(`Node ${id} has an invalid apiKeyEnv name`);
  }
  const apiKeyFile = String(node.apiKeyFile ?? "").trim();
  if (apiKeyFile && !path.isAbsolute(apiKeyFile)) {
    throw new Error(`Node ${id} apiKeyFile must be absolute`);
  }

  const accent = String(node.accent ?? "#8b5cf6");
  if (!HEX_COLOR_PATTERN.test(accent)) {
    throw new Error(`Node ${id} accent must be a six-digit hex color`);
  }

  return Object.freeze({
    id,
    name,
    region,
    endpoint: endpoint.toString(),
    apiKeyEnv,
    apiKeyFile,
    accent: accent.toLowerCase(),
    management: validateManagement(node.management, id),
  });
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Portal config must be a JSON object");
  }
  if (!Array.isArray(raw.nodes)) {
    throw new Error("Portal config nodes must be an array");
  }
  if (raw.nodes.length > 32) {
    throw new Error("Portal supports at most 32 configured nodes");
  }
  if (raw.clientNodes != null && !Array.isArray(raw.clientNodes)) {
    throw new Error("Portal config clientNodes must be an array");
  }
  if ((raw.clientNodes?.length ?? 0) > 32) {
    throw new Error("Portal supports at most 32 client nodes");
  }

  const seenIds = new Set();
  const seenClientIds = new Set();
  return Object.freeze({
    clientNodes: Object.freeze(
      (raw.clientNodes ?? []).map((node) =>
        validateClientNode(node, seenClientIds),
      ),
    ),
    requestTimeoutMs: integerInRange(
      raw.requestTimeoutMs,
      8000,
      500,
      60000,
      "requestTimeoutMs",
    ),
    cacheSeconds: integerInRange(raw.cacheSeconds, 10, 0, 300, "cacheSeconds"),
    refreshSeconds: integerInRange(
      raw.refreshSeconds,
      60,
      10,
      3600,
      "refreshSeconds",
    ),
    eventsPerNode: integerInRange(
      raw.eventsPerNode,
      12,
      1,
      100,
      "eventsPerNode",
    ),
    maxRecentEvents: integerInRange(
      raw.maxRecentEvents,
      60,
      1,
      500,
      "maxRecentEvents",
    ),
    updateTimeoutMs: integerInRange(
      raw.updateTimeoutMs,
      180000,
      10000,
      600000,
      "updateTimeoutMs",
    ),
    nodes: Object.freeze(raw.nodes.map((node) => validateNode(node, seenIds))),
  });
}

export async function loadConfig(configPath = process.env.PORTAL_CONFIG || DEFAULT_CONFIG_PATH) {
  const absolutePath = path.resolve(configPath);
  const contents = await readFile(absolutePath, "utf8");
  let raw;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not parse ${absolutePath}: ${error.message}`);
  }
  return { config: validateConfig(raw), configPath: absolutePath };
}

function plainConfig(config) {
  return {
    clientNodes: config.clientNodes.map((node) => ({ ...node })),
    requestTimeoutMs: config.requestTimeoutMs,
    cacheSeconds: config.cacheSeconds,
    refreshSeconds: config.refreshSeconds,
    eventsPerNode: config.eventsPerNode,
    maxRecentEvents: config.maxRecentEvents,
    updateTimeoutMs: config.updateTimeoutMs,
    nodes: config.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      region: node.region,
      endpoint: node.endpoint,
      apiKeyEnv: node.apiKeyEnv,
      apiKeyFile: node.apiKeyFile,
      accent: node.accent,
      management: node.management ? { ...node.management } : null,
    })),
  };
}

export async function saveConfig(configPath, value) {
  const normalized = validateConfig(value);
  const absolutePath = path.resolve(configPath);
  await writeFile(absolutePath, `${JSON.stringify(plainConfig(normalized), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return normalized;
}
