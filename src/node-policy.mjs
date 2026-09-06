import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { validateConfig } from "./config.mjs";
import { SignedStore, requestError } from "./signed-store.mjs";
import { workspaceNodeKey } from "./workspace-sso.mjs";

const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const allowedFields = new Set(["name", "region", "endpoint", "accent"]);

function nodeSettings(body, previous = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !allowedFields.has(key))) {
    throw requestError("只允许修改名称、区域、HTTPS 地址和颜色；节点 ID 与归属由服务端管理");
  }
  let endpoint;
  try { endpoint = new URL(body.endpoint ?? previous.endpoint); }
  catch { throw requestError("请输入有效的 HTTPS 节点地址"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.origin.length > 300 ||
      (!/^[a-z0-9.-]+$/i.test(endpoint.hostname) && !isIP(endpoint.hostname.replace(/^\[|\]$/g, ""))) ||
      !["/", "/usage"].includes(endpoint.pathname)) {
    throw requestError("节点地址必须为不含凭据或查询参数的 HTTPS origin 或 /usage 地址");
  }
  endpoint.pathname = "/usage";
  try {
    return validateConfig({
      nodes: [],
      clientNodes: [{
        ...previous, ...body, id: previous.id || "validation", endpoint: endpoint.href,
        accent: body.accent ?? previous.accent ?? "#60a5fa",
      }],
    }).clientNodes[0];
  } catch { throw requestError("节点名称、区域或颜色格式不正确"); }
}

function publicNode(record) {
  const { id, name, region, endpoint, accent } = record;
  return { id, name, region, endpoint, accent };
}

export class NodePolicy {
  constructor({ root, master, ticketMaster, seedPrincipalId, legacyConfigStore, defaults }) {
    if (String(ticketMaster ?? "").length < 32 || !/^[a-z0-9-]{1,80}$/.test(seedPrincipalId ?? "")) {
      throw new Error("Node ticket key and bootstrap owner are required");
    }
    this.store = new SignedStore(root, "node-registry.json", master);
    this.master = master;
    this.ticketMaster = ticketMaster;
    this.seedPrincipalId = seedPrincipalId;
    this.legacyConfigStore = legacyConfigStore;
    this.defaults = defaults;
  }

  async initialize() {
    const loaded = await this.legacyConfigStore.load(this.seedPrincipalId);
    const serverNodes = new Map(loaded.config.nodes.map((node) => [node.id, node]));
    const result = await this.store.initialize({
      seedPrincipalId: this.seedPrincipalId,
      nodes: loaded.config.clientNodes.map((node) => ({
        ...node, ownerId: this.seedPrincipalId, enabled: true, keyMode: "legacy",
        serverNode: serverNodes.get(node.id) ?? null, createdAt: new Date().toISOString(),
      })),
    });
    if (result.data.seedPrincipalId !== this.seedPrincipalId) throw new Error("Node owner bootstrap mismatch");
  }

  async records() {
    const record = await this.store.read();
    if (!Array.isArray(record.data.nodes) || record.data.nodes.length > 8192) throw new Error("Invalid node registry");
    const seen = new Set();
    for (const node of record.data.nodes) {
      if (!NODE_ID.test(node.id ?? "") || seen.has(node.id) ||
          !/^[a-z0-9-]{1,80}$/.test(node.ownerId ?? "") ||
          !["legacy", "isolated"].includes(node.keyMode) || typeof node.enabled !== "boolean" ||
          (node.keyMode === "legacy" && node.ownerId !== this.seedPrincipalId)) {
        throw new Error("Invalid node ownership record");
      }
      seen.add(node.id);
    }
    return record;
  }

  async owned(id, nodeId) {
    const record = (await this.records()).data.nodes.find(
      (node) => node.id === nodeId && node.ownerId === id && node.enabled,
    );
    if (!record) throw requestError("节点不存在或无权访问", 404);
    return record;
  }

  async canAccess(id, nodeId) {
    try { await this.owned(id, nodeId); return true; }
    catch (error) { if (error.status === 404) return false; throw error; }
  }

  async keyFor(id, nodeId) {
    const node = await this.owned(id, nodeId);
    return node.keyMode === "legacy" ? this.ticketMaster : this.isolatedKey(node.id);
  }

  isolatedKey(nodeId) {
    // The old shared browser key exists on legacy VMs. Do NOT derive any new
    // tenant's keys from it; only the ACA-only root may derive isolated keys.
    return createHmac("sha256", this.master).update(`codey-client-node-v1:${nodeId}`).digest("base64url");
  }

  async load(principalId) {
    const snapshot = await this.records();
    const owned = snapshot.data.nodes.filter((node) => node.ownerId === principalId && node.enabled);
    // Legacy per-user files are retained for rollback, but are not an ACL.
    // Every effective node list comes from the signed ownership registry.
    const config = validateConfig({
      ...this.defaults,
      clientNodes: owned.map(publicNode),
      nodes: owned.filter((node) => node.serverNode).map((node) => ({
        ...node.serverNode, name: node.name, region: node.region, accent: node.accent,
      })),
    });
    return {
      config,
      configPath: null,
      revision: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    };
  }

  async list(principalId) {
    return (await this.records()).data.nodes
      .filter((node) => node.ownerId === principalId && node.enabled)
      .map((node) => ({ ...publicNode(node), managedLegacy: node.keyMode === "legacy" }));
  }

  async create(principalId, body) {
    const settings = nodeSettings(body);
    return this.store.mutate((data) => {
      const owned = data.nodes.filter((node) => node.ownerId === principalId);
      if (owned.filter((node) => node.enabled).length >= 32 || owned.length >= 256 || data.nodes.length >= 8192) {
        throw requestError("节点数量已达上限", 409);
      }
      let id;
      do { id = `n-${randomBytes(12).toString("hex")}`; } while (data.nodes.some((node) => node.id === id));
      const node = {
        ...settings, id, ownerId: principalId, enabled: true, keyMode: "isolated",
        serverNode: null, createdAt: new Date().toISOString(),
      };
      data.nodes.push(node);
      return publicNode(node);
    });
  }

  async update(principalId, nodeId, body) {
    return this.store.mutate((data) => {
      const node = data.nodes.find((item) => item.id === nodeId && item.ownerId === principalId && item.enabled);
      if (!node) throw requestError("节点不存在或无权访问", 404);
      Object.assign(node, nodeSettings(body, publicNode(node)));
      return publicNode(node);
    });
  }

  async remove(principalId, nodeId) {
    return this.store.mutate((data) => {
      const node = data.nodes.find((item) => item.id === nodeId && item.ownerId === principalId && item.enabled);
      if (!node) throw requestError("节点不存在或无权访问", 404);
      // Never recycle an ID/key for another user, including after removal.
      node.enabled = false;
      node.removedAt = new Date().toISOString();
    });
  }

  async enrollment(principal, nodeId, origin) {
    const node = await this.owned(principal.id, nodeId);
    if (node.keyMode !== "isolated") throw requestError("既有节点的部署密钥不通过网页提供", 403);
    return {
      nodeId, portalOrigin: origin, principalId: principal.id, username: principal.name,
      clientSigningKey: this.isolatedKey(nodeId),
      workspaceSsoKey: workspaceNodeKey(this.master, nodeId),
      note: "只用于本节点。需在您自己的机器配置对应 node ID、密钥、HTTPS 证书；Workspace 还需部署 CloudCLI 并添加受信任的私网网关配置。",
    };
  }
}
