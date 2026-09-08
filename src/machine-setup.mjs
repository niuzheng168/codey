import { lstat, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { machineIdentity, MACHINE_ID, preparedGateways } from "./machine-identity.mjs";
import { verifyMachine } from "./machine-verification.mjs";
import { requestError } from "./signed-store.mjs";
import { zipStream } from "./zip-stream.mjs";
import { MACHINE_PLATFORMS, machinePlatform } from "./machine-platforms.mjs";
import { MachineTunnelService } from "./machine-tunnel.mjs";

export const MACHINE_SKILL = "config-new-codey-machine";
export const MACHINE_SKILL_FILES = Object.freeze([
  "SKILL.md", "agents/openai.yaml", "dependencies.json",
  "scripts/configure-machine.py", "scripts/azure-vnet.py", "references/verification.md",
]);
export const machineArtifacts = (platform) => [
  "cloudcli-source.tar.gz", "copilot-api-source.tar.gz",
  ...(machinePlatform(platform).tunnel ? ["portal-node-source.tar.gz"] : []),
];
const defaultSkillRoot = fileURLToPath(new URL(`../skills/${MACHINE_SKILL}/`, import.meta.url));
const json = (res, status, value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "content-length": bytes.length,
    "cache-control": "private, no-store", vary: "Cookie",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  });
  res.end(bytes);
};

async function input(req) {
  if (String(req.headers["content-type"] ?? "").split(";")[0] !== "application/json") throw requestError("Expected JSON", 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw requestError("Machine file is too large", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw requestError("机器文件不是有效的 JSON"); }
}

export function machineReleaseId(manifest) {
  const identity = [manifest.node, manifest.bunBuildTool, manifest.nodeDistribution.sha256,
    ...manifest.artifacts.map((file) => file.sha256)].join("\n");
  return `machine-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

export async function loadMachineBundle(root, platformId = "linux-x64") {
  const platform = machinePlatform(platformId);
  const ARTIFACTS = machineArtifacts(platformId);
  // Keep the existing Linux release layout/backlinks; each additional platform
  // has its own immutable active pointer and cannot fall back to Linux assets.
  if (platformId !== "linux-x64") {
    const expected = path.join(await realpath(root), "platforms", platformId);
    if (await realpath(expected) !== expected) throw new Error("Unsafe platform release directory");
    root = expected;
  }
  root = await realpath(root);
  let pointerText;
  try {
    pointerText = await readFile(path.join(root, "active.json"), "utf8");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (pointerText !== undefined) {
    if (pointerText.length > 1024) throw new Error("Oversized active machine release");
    const pointer = JSON.parse(pointerText);
    if (!/^machine-[a-f0-9]{16}$/.test(pointer.releaseId ?? "")) throw new Error("Invalid active machine release");
    const release = path.join(root, "releases", pointer.releaseId);
    if (await realpath(release) !== release) throw new Error("Unsafe active machine release");
    root = release;
  }
  if ((await lstat(path.join(root, "manifest.json"))).isSymbolicLink()) throw new Error("Unsafe machine manifest");
  const raw = await readFile(path.join(root, "manifest.json"), "utf8");
  if (raw.length > 16384) throw new Error("Oversized machine manifest");
  const manifest = JSON.parse(raw);
  if (manifest.schema !== 1 || manifest.platform !== platformId ||
      !/^machine-[a-f0-9]{16}$/.test(manifest.releaseId ?? "") ||
      !/^\d+\.\d+\.\d+$/.test(manifest.node ?? "") || !/^\d+\.\d+\.\d+$/.test(manifest.bunBuildTool ?? "") ||
      manifest.dependencyMode !== "install-on-target" ||
      manifest.nodeDistribution?.url !== `https://nodejs.org/dist/v${manifest.node}/node-v${manifest.node}-${platform.nodeSuffix}` ||
      manifest.nodeDistribution?.file !== `node-v${manifest.node}-${platform.nodeSuffix}` ||
      !/^[a-f0-9]{64}$/.test(manifest.nodeDistribution?.sha256 ?? "") ||
      !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== ARTIFACTS.length) {
    throw new Error("Invalid machine bundle manifest");
  }
  const files = [];
  for (const [index, expected] of ARTIFACTS.entries()) {
    const entry = manifest.artifacts[index];
    if (entry.file !== expected || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") ||
        !Number.isInteger(entry.crc32) || entry.crc32 < 0 || entry.crc32 > 0xffffffff ||
        !Number.isInteger(entry.size) || entry.size <= 0 || entry.size > 1536 * 1024 * 1024) {
      throw new Error("Invalid machine artifact metadata");
    }
    const file = path.join(root, expected);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file || info.size !== entry.size) {
      throw new Error("Unsafe or missing machine artifact");
    }
    files.push({ ...entry, path: file });
  }
  if (manifest.releaseId !== machineReleaseId(manifest)) throw new Error("Release digest mismatch");
  return { manifest, files };
}

export function machineNetworkConfig(raw) {
  const pattern = /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-z0-9_.()-]{1,90}\/providers\/Microsoft\.Network\/virtualNetworks\/[a-z0-9_.-]{1,80}\/subnets\/[a-z0-9_.-]{1,80}$/i;
  if (!raw || !pattern.test(raw.portalSubnetId ?? "") || !pattern.test(raw.privateEndpointSubnetId ?? "") ||
      raw.portalSubnetId.toLowerCase() === raw.privateEndpointSubnetId.toLowerCase() ||
      raw.portalSubnetId.split("/subnets/")[0].toLowerCase() !== raw.privateEndpointSubnetId.split("/subnets/")[0].toLowerCase()) {
    throw new Error("Machine setup requires distinct ACA infrastructure and private endpoint subnets in the same VNet");
  }
  return { portalSubnetId: raw.portalSubnetId, privateEndpointSubnetId: raw.privateEndpointSubnetId };
}

export class MachineSetup {
  constructor({ nodePolicy, accounts, authenticator, origin, bundleRoot, network, cloudCliGateway, nodeDataGateway, cloudCliUi,
    machineUpdates, skillRoot = defaultSkillRoot, verify = verifyMachine }) {
    Object.assign(this, { nodePolicy, accounts, authenticator, origin, bundleRoot, cloudCliGateway, nodeDataGateway, cloudCliUi, skillRoot, verify });
    this.machineUpdates = machineUpdates;
    this.tunnels = new MachineTunnelService({ nodePolicy, accounts });
    this.network = network ? machineNetworkConfig(network) : null;
    this.verifying = 0;
    this.downloading = 0;
    this.refreshing = null;
    if (cloudCliGateway) cloudCliGateway.refreshMachines = () => this.refreshGateways();
  }

  async availability(platformId) {
    if (platformId === undefined) {
      const platforms = await Promise.all(MACHINE_PLATFORMS.map(async (definition) =>
        definition.implemented ? { ...await this.availability(definition.id) }
          : { enabled: false, platform: definition.id, name: definition.name, planned: true, reason: definition.description }));
      const selected = platforms.find((entry) => entry.platform === "linux-x64" && entry.enabled)
        ?? platforms.find((entry) => entry.enabled) ?? platforms.find((entry) => entry.platform === "linux-x64");
      return { ...selected, platforms };
    }
    const definition = machinePlatform(platformId);
    const identity = { platform: platformId, name: definition.name, entrypoint: definition.entrypoint,
      updaterSupported: definition.updater, description: definition.description };
    if (!this.bundleRoot || (!definition.tunnel && !this.network) || !this.cloudCliGateway || !this.nodeDataGateway || !this.cloudCliUi) {
      return { ...identity, enabled: false, reason: "运维尚未发布完整机器配置包或启用共享 Workspace UI / 私网配置" };
    }
    if (definition.updater && this.machineUpdates && !this.machineUpdates.catalog.configured) {
      return { ...identity, enabled: false, reason: "请先配置节点升级器签名公钥，确保新机器可持续更新" };
    }
    try {
      const { manifest, files } = await loadMachineBundle(this.bundleRoot, platformId);
      await this.cloudCliUi.active?.();
      return {
        ...identity, enabled: true, platform: manifest.platform, releaseId: manifest.releaseId,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
        node: manifest.node, cloudcli: manifest.cloudcli.version, copilotApi: manifest.copilotApi.version,
      };
    } catch { return { ...identity, enabled: false, reason: `${definition.name} 完整配置包尚未发布或不可用；不会退回其他平台或仅说明的 ZIP` }; }
  }

  async refreshGateways() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const snapshot = await this.nodePolicy.records();
      if (this.gatewayRevision === snapshot.revision) return;
      const nodes = snapshot.data.nodes.filter((node) => node.enabled && node.machine).map(node => preparedGateways(node, {
        getTunnelToken: () => this.nodePolicy.machineTunnelToken(node.id),
      }));
      this.nodeDataGateway?.setMachineNodes(nodes.map((node) => node.data));
      this.cloudCliGateway?.setMachineNodes(nodes.map((node) => node.workspace));
      this.gatewayRevision = snapshot.revision;
    })();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }

  async download(req, res, reserved, requestedPlatform) {
    for await (const chunk of req) {
      if (chunk.length) throw requestError("下载配置包不接受 owner、节点 ID 或密钥参数");
    }
    const platformId = reserved?.setup.platform ?? requestedPlatform ?? "linux-x64";
    if (reserved && requestedPlatform && requestedPlatform !== (reserved.setup.platform ?? "linux-x64")) {
      throw requestError("待配置身份已绑定原平台，请下载同一平台的包", 409);
    }
    const definition = machinePlatform(platformId);
    const available = await this.availability(platformId);
    if (!available.enabled) throw requestError(available.reason, 503);
    const { manifest, files } = await loadMachineBundle(this.bundleRoot, platformId);
    const skillRoot = await realpath(this.skillRoot);
    const entries = [];
    for (const name of [...MACHINE_SKILL_FILES, ...definition.files]) {
      const file = path.join(skillRoot, name);
      const info = await lstat(file);
      const actual = await realpath(file);
      if (!info.isFile() || info.isSymbolicLink() || actual !== file || info.size > 128 * 1024) {
        throw new Error("Unsafe machine skill input");
      }
      entries.push({ name: `${MACHINE_SKILL}/${name}`, data: await readFile(file) });
    }
    const node = reserved ?? await this.nodePolicy.reserveMachine(req.codeyPrincipal.id, Date.now(), platformId);
    const enrollment = {
      schema: 1, ...this.nodePolicy.enrollmentValues(req.codeyPrincipal, node.id, this.origin),
      expiresAt: node.setup.expiresAt, releaseId: manifest.releaseId, platform: platformId,
      ...(definition.tunnel ? { network: { mode: "devtunnel" }, tunnelUpdateKey: this.nodePolicy.tunnelUpdateKey(node.id) }
        : { network: this.network }),
      ...(definition.tunnel ? { note: "仅用于此 Mac 的私有 DevTunnel 节点；不需要 Azure VM 或节点后台的 Azure 部署权限。" } : {}),
    };
    if (definition.updater && this.machineUpdates) {
      entries.push(...(await this.machineUpdates.newMachineEntries(req.codeyPrincipal.id, node.id))
        .map((entry) => ({ ...entry, name: `${MACHINE_SKILL}/assets/${entry.name}` })));
    }
    entries.push(
      { name: `${MACHINE_SKILL}/assets/enrollment.json`, data: JSON.stringify(enrollment, null, 2) + "\n" },
      { name: `${MACHINE_SKILL}/assets/manifest.json`, data: JSON.stringify(manifest, null, 2) + "\n" },
      ...files.map((file) => ({ ...file, name: `${MACHINE_SKILL}/assets/${file.file}` })),
    );
    const zip = zipStream(entries);
    res.writeHead(200, {
      "content-type": "application/zip", "content-length": zip.length,
      "content-disposition": `attachment; filename="${MACHINE_SKILL}${platformId === "linux-x64" ? "" :
        platformId === "windows-x64" ? "-windows" : `-${platformId}`}-${node.id}.zip"`,
      "cache-control": "private, no-store", vary: "Cookie", "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    await pipeline(Readable.from(zip), res);
  }

  async limitedDownload(req, res, reserved, requestedPlatform) {
    if (this.downloading >= 4) throw requestError("配置包下载繁忙，请稍后重试", 429);
    this.downloading++;
    try { await this.download(req, res, reserved, requestedPlatform); } finally { this.downloading--; }
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://portal.local");
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/settings/machines")) return false;
    try {
      if (!req.codeyPrincipal) throw requestError("需要登录", 401);
      if (pathname === "/api/settings/machines/skill") {
        if (req.method !== "POST") throw requestError("Method not allowed", 405);
        if ([...url.searchParams.keys()].some((key) => key !== "platform") || url.searchParams.getAll("platform").length > 1) {
          throw requestError("只接受一个目标平台参数");
        }
        const platform = url.searchParams.get("platform") ?? undefined;
        machinePlatform(platform);
        await this.limitedDownload(req, res, undefined, platform);
        return true;
      }
      const match = pathname.match(/^\/api\/settings\/machines\/(n-[a-f0-9]{24})(\/activate|\/skill)?$/);
      if (!match || !MACHINE_ID.test(match[1])) throw requestError("Not found", 404);
      const [, nodeId, activate] = match;
      if (!activate && req.method === "DELETE") {
        await this.nodePolicy.cancelMachine(req.codeyPrincipal.id, nodeId);
        json(res, 200, { ok: true });
        return true;
      }
      const reserved = await this.nodePolicy.reservedMachine(req.codeyPrincipal.id, nodeId);
      if (activate === "/skill") {
        if (req.method !== "POST") throw requestError("Method not allowed", 405);
        const platform = url.searchParams.get("platform") ?? undefined;
        if ([...url.searchParams.keys()].some((key) => key !== "platform") || url.searchParams.getAll("platform").length > 1) {
          throw requestError("只接受一个目标平台参数");
        }
        if (platform) machinePlatform(platform);
        await this.limitedDownload(req, res, reserved, platform);
        return true;
      }
      if (!activate || req.method !== "POST") throw requestError("Method not allowed", 405);
      const available = await this.availability(reserved.setup.platform ?? "linux-x64");
      if (!available.enabled) throw requestError(available.reason, 503);
      const machine = machineIdentity(await input(req), nodeId);
      if (machine.platform !== (reserved.setup.platform ?? "linux-x64")) {
        throw requestError("机器文件的平台与下载时预留的平台不一致");
      }
      if (machine.networkMode === "devtunnel" && (!reserved.tunnel ||
          reserved.tunnel.tunnelId !== machine.devTunnel.tunnelId || reserved.tunnel.clusterId !== machine.devTunnel.clusterId)) {
        throw requestError("请先由此 Mac 的安装脚本提交并验证本节点隧道", 409);
      }
      if (this.verifying >= 4) throw requestError("正在验收其他机器，请稍后重试", 429);
      this.verifying++;
      try {
        const account = await this.accounts.byId(req.codeyPrincipal.id);
        const verification = await this.verify(machine, {
          principal: req.codeyPrincipal, master: this.nodePolicy.master,
          clientKey: this.nodePolicy.isolatedKey(nodeId),
          getTunnelToken: () => this.nodePolicy.machineTunnelToken(nodeId),
        });
        if (res.destroyed || (this.authenticator && !(await this.authenticator.principal(req, { touch: false })))) {
          throw requestError("登录已失效或验收已取消，机器尚未添加", 401);
        }
        const current = await this.accounts.byId(req.codeyPrincipal.id);
        if (!account?.enabled || !current?.enabled || account.authVersion !== current.authVersion) {
          throw requestError("账号状态已变化，请重新登录", 401);
        }
        const node = await this.nodePolicy.activateMachine(req.codeyPrincipal.id, machine);
        await this.refreshGateways();
        json(res, 201, { node, verification });
      } finally { this.verifying--; }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else json(res, error.status ?? 503, { error: error.status ? error.message : "机器配置服务暂不可用" });
    }
    return true;
  }
}
