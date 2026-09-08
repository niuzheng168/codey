import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { validateConfig } from "./config.mjs";
import { SignedStore, requestError } from "./signed-store.mjs";
import { workspaceNodeKey } from "./workspace-sso.mjs";
import { machineServerName } from "./machine-identity.mjs";
import { machinePlatform } from "./machine-platforms.mjs";
import { machineTunnelKey, sealMachineTunnelToken, openMachineTunnelToken } from "./machine-tunnel.mjs";
import { validateDevTunnelConnectToken } from "./devtunnel-transport.mjs";

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
  return { id, name, region, endpoint, accent, ...(record.machine
    ? { vnetOnly: true, platform: record.machine.platform ?? "linux-x64", networkMode: record.machine.networkMode } : {}) };
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

  async inventory() {
    // Metadata for the administrator's read-only directory, never an access
    // list. Do not reuse publicNode: it includes an owner's service endpoint.
    return (await this.records()).data.nodes
      .filter((node) => node.enabled)
      .map(({ id, name, region, ownerId }) => ({ id, name, region, ownerId }));
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

  async reserveMachine(principalId, now = Date.now(), platform = "linux-x64") {
    machinePlatform(platform);
    return this.store.mutate((data) => {
      const own = data.nodes.filter((node) => node.ownerId === principalId);
      const pending = own.filter((node) => node.setup?.status === "reserved" && node.setup.expiresAt > now);
      if (pending.length >= 4 || own.filter((node) => node.enabled).length + pending.length >= 32 ||
          own.length >= 256 || data.nodes.length >= 8192 || data.nodes.filter((node) => node.setup).length >= 2048) {
        throw requestError("待配置机器或节点数量已达上限，请先取消不用的配置包", 409);
      }
      let id;
      do { id = `n-${randomBytes(12).toString("hex")}`; } while (data.nodes.some((node) => node.id === id));
      const node = {
        id, ownerId: principalId, name: "待配置机器", region: "",
        endpoint: `https://${machineServerName(id)}:8443/usage`, accent: "#60a5fa",
        enabled: false, keyMode: "isolated", serverNode: null,
        createdAt: new Date(now).toISOString(),
        setup: { status: "reserved", platform, expiresAt: now + 7 * 86400000 },
      };
      data.nodes.push(node);
      return node;
    });
  }

  async reservedMachine(principalId, nodeId, now = Date.now()) {
    const node = (await this.records()).data.nodes.find(
      (item) => item.id === nodeId && item.ownerId === principalId &&
        !item.enabled && item.setup?.status === "reserved",
    );
    if (!node) throw requestError("待配置机器不存在或无权添加", 404);
    if (node.setup.expiresAt <= now) throw requestError("配置包已过期，请重新下载；不要复用旧机器身份", 410);
    return node;
  }

  async pendingMachines(principalId, now = Date.now()) {
    return (await this.records()).data.nodes
      .filter((node) => node.ownerId === principalId && node.setup?.status === "reserved")
      .map((node) => ({ id: node.id, platform: node.setup.platform ?? "linux-x64",
        createdAt: node.createdAt, expiresAt: node.setup.expiresAt, expired: node.setup.expiresAt <= now }));
  }

  async cancelMachine(principalId, nodeId) {
    return this.store.mutate((data) => {
      const node = data.nodes.find((item) => item.id === nodeId && item.ownerId === principalId && item.setup?.status === "reserved");
      if (!node) throw requestError("待配置机器不存在或无权访问", 404);
      node.setup.status = "cancelled";
    });
  }

  async activateMachine(principalId, machine, now = Date.now()) {
    return this.store.mutate((data) => {
      const node = data.nodes.find((item) => item.id === machine.id && item.ownerId === principalId &&
        !item.enabled && item.setup?.status === "reserved");
      if (!node) throw requestError("机器配置已添加、取消或无权访问", 409);
      if (node.setup.expiresAt <= now) throw requestError("配置包已过期", 410);
      if ((machine.platform ?? "linux-x64") !== (node.setup.platform ?? "linux-x64")) {
        throw requestError("机器平台与预留身份不一致", 409);
      }
      if (data.nodes.filter((item) => item.ownerId === principalId && item.enabled).length >= 32) {
        throw requestError("节点数量已达上限", 409);
      }
      // The TLS-verified endpoint is authoritative. vmResourceId is descriptive
      // client metadata: using it as a global claim would let one user squat
      // another user's Azure resource ID without controlling that VM.
      if (machine.networkMode === "devtunnel") {
        if (!node.tunnel || node.tunnel.tunnelId !== machine.devTunnel.tunnelId ||
            node.tunnel.clusterId !== machine.devTunnel.clusterId || node.tunnel.expiresAt <= now + 5000) {
          throw requestError("请先由本机脚本建立并验证自己的 DevTunnel", 409);
        }
      } else if (data.nodes.some((item) => item.enabled && item.machine?.privateIp === machine.privateIp)) {
        throw requestError("此私网服务入口已添加为节点，不能再次认领", 409);
      }
      Object.assign(node, {
        name: machine.name, region: machine.region, machine, enabled: true,
        setup: { ...node.setup, status: "activated", verifiedAt: new Date(now).toISOString() },
      });
      return publicNode(node);
    });
  }

  async update(principalId, nodeId, body) {
    return this.store.mutate((data) => {
      const node = data.nodes.find((item) => item.id === nodeId && item.ownerId === principalId && item.enabled);
      if (!node) throw requestError("节点不存在或无权访问", 404);
      Object.assign(node, nodeSettings(body, publicNode(node)));
      if (node.machine) node.endpoint = `https://${machineServerName(node.id)}:8443/usage`;
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
      ...this.enrollmentValues(principal, nodeId, origin),
      ...(node.machine?.networkMode === "devtunnel" ? {
        tunnelUpdateKey: this.tunnelUpdateKey(nodeId),
        note: "仅用于此 Mac。隧道更新 key 只能续期本节点 connect 令牌，不具有门户登录或 Azure 部署权限。",
      } : {}),
    };
  }

  enrollmentValues(principal, nodeId, origin) {
    return {
      nodeId, portalOrigin: origin, principalId: principal.id, username: principal.name,
      clientSigningKey: this.isolatedKey(nodeId),
      workspaceSsoKey: workspaceNodeKey(this.master, nodeId),
      note: "只用于本节点。需在您自己的机器配置对应 node ID、密钥、HTTPS 证书；Workspace 还需部署 CloudCLI 并添加受信任的私网网关配置。",
    };
  }

  /** Only reserved, unexpired or enabled Mac identities may renew a tunnel. */
  async tunnelMachine(nodeId, now = Date.now()) {
    const node = (await this.records()).data.nodes.find(item => item.id === nodeId);
    if (!node || !String(node.setup?.platform).startsWith("macos-") ||
        !(node.enabled || (node.setup.status === "reserved" && node.setup.expiresAt > now))) {
      throw requestError("Machine authentication failed", 401);
    }
    return node;
  }

  tunnelUpdateKey(nodeId) { return machineTunnelKey(this.master, nodeId); }

  async updateMachineTunnel(nodeId, input, now = Date.now()) {
    validateDevTunnelConnectToken(input.connectToken, input, now);
    const claims = JSON.parse(Buffer.from(input.connectToken.split(".")[1], "base64url"));
    const expiresAt = claims.exp * 1000;
    const sealedToken = sealMachineTunnelToken(this.master, nodeId, input.connectToken);
    return this.store.mutate(data => {
      const node = data.nodes.find(item => item.id === nodeId);
      if (!node || !String(node.setup?.platform).startsWith("macos-") ||
          !(node.enabled || (node.setup.status === "reserved" && node.setup.expiresAt > now))) {
        throw requestError("Machine authentication failed", 401);
      }
      if (node.tunnel && (node.tunnel.tunnelId !== input.tunnelId ||
          node.tunnel.clusterId !== input.clusterId || expiresAt < node.tunnel.expiresAt)) {
        throw requestError("Tunnel rebinding or credential rollback is not allowed", 409);
      }
      if (data.nodes.some(item => item.id !== nodeId &&
          (item.enabled || (item.setup?.status === "reserved" && item.setup.expiresAt > now)) &&
          item.tunnel?.tunnelId === input.tunnelId && item.tunnel?.clusterId === input.clusterId)) {
        throw requestError("Tunnel is already bound to another machine", 409);
      }
      node.tunnel = { tunnelId: input.tunnelId, clusterId: input.clusterId, sealedToken, expiresAt, updatedAt: now };
      return { ok: true, nodeId, expiresAt };
    });
  }

  async machineTunnelToken(nodeId) {
    const node = await this.tunnelMachine(nodeId);
    if (!node.tunnel) throw new Error("Machine tunnel is not configured");
    const token = openMachineTunnelToken(this.master, nodeId, node.tunnel.sealedToken);
    return validateDevTunnelConnectToken(token, node.tunnel);
  }
}
