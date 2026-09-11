import { createReadStream } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { machineIdentity, MACHINE_ID, preparedGateways } from "./machine-identity.mjs";
import { verifyMachine } from "./machine-verification.mjs";
import { requestError } from "./signed-store.mjs";
import { MACHINE_PLATFORMS, machinePlatform, machineRegistrationPlatform } from "./machine-platforms.mjs";
import { MachineTunnelService } from "./machine-tunnel.mjs";
import { machineRegistration } from "./machine-registration.mjs";
import { verifyDevTunnelAccess } from "./devtunnel-transport.mjs";

export const MACHINE_SKILL = "config-new-codey-machine";
const MACHINE_STORE = "packages-v2";
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
    if (size > 32768) throw requestError("Machine file is too large", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw requestError("机器文件不是有效的 JSON"); }
}

export function machineReleaseId(manifest) {
  return `machine-${manifest.package.sha256.slice(0, 16)}`;
}

async function releasedFile(release, item, expectedName, magic, maximum) {
  if (item?.file !== expectedName || !Number.isSafeInteger(item?.size) ||
      item.size <= 0 || item.size > maximum || !/^[a-f0-9]{64}$/.test(item?.sha256 ?? "")) {
    throw new Error("Invalid direct npm download metadata");
  }
  const file = path.join(release, expectedName);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file || info.size !== item.size) {
    throw new Error("Unsafe or missing direct npm download");
  }
  const hash = createHash("sha256");
  let prefix = Buffer.alloc(0);
  for await (const bytes of createReadStream(file)) {
    hash.update(bytes);
    if (prefix.length < magic.length) prefix = Buffer.concat([prefix, bytes.subarray(0, magic.length - prefix.length)]);
  }
  if (!prefix.equals(magic) || hash.digest("hex") !== item.sha256) throw new Error("Direct npm download checksum mismatch");
  return { ...item, path: file };
}

export async function loadMachineBundle(root, platformId = "linux-x64") {
  machinePlatform(platformId);
  root = path.join(await realpath(root), MACHINE_STORE);
  if (await realpath(root) !== root) throw new Error("Unsafe machine package store");
  const pointerText = await readFile(path.join(root, "active.json"), "utf8");
  if (pointerText.length > 1024) throw new Error("Oversized active machine release");
  const pointer = JSON.parse(pointerText);
  if (pointer.schema !== 1 || !/^machine-[a-f0-9]{16}$/.test(pointer.releaseId ?? "") ||
      !/^[a-f0-9]{64}$/.test(pointer.manifestSha256 ?? "")) {
    throw new Error("Invalid active machine release");
  }
  const release = path.join(root, "releases", pointer.releaseId);
  if (await realpath(release) !== release) throw new Error("Unsafe active machine release");
  const manifestFile = path.join(release, "manifest.json");
  if ((await lstat(manifestFile)).isSymbolicLink()) throw new Error("Unsafe machine manifest");
  const raw = await readFile(manifestFile, "utf8");
  if (raw.length > 16384 ||
      createHash("sha256").update(raw).digest("hex") !== pointer.manifestSha256) {
    throw new Error("Invalid active machine manifest");
  }
  const manifest = JSON.parse(raw);
  const packageInfo = manifest.package;
  if (manifest.schema !== 2 || manifest.kind !== "codey-machine-skill" ||
      manifest.registrationSchema !== 2 || manifest.platform !== platformId ||
      !/^machine-[a-f0-9]{16}$/.test(manifest.releaseId ?? "") ||
      !/^machine-[a-f0-9]{16}$/.test(manifest.installerReleaseId ?? "") ||
      JSON.stringify(manifest.bundledRuntimes) !== JSON.stringify(["cloudcli", "copilot-api", "updater"]) ||
      JSON.stringify(manifest.downloadedOfficialRuntimes) !== JSON.stringify(["node", "codex", "devtunnel"]) ||
      !/^\d+\.\d+\.\d+$/.test(manifest.node ?? "") ||
      typeof manifest.cloudcli?.version !== "string" || typeof manifest.copilotApi?.version !== "string" ||
      packageInfo?.file !== `${MACHINE_SKILL}.zip` ||
      !Number.isInteger(packageInfo?.size) || packageInfo.size <= 0 || packageInfo.size > 1536 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(packageInfo?.sha256 ?? "")) {
    throw new Error("Invalid machine bundle manifest");
  }
  if (manifest.releaseId !== machineReleaseId(manifest)) throw new Error("Release digest mismatch");
  const packageFile = path.join(release, packageInfo.file);
  const info = await lstat(packageFile);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(packageFile) !== packageFile ||
      info.size !== packageInfo.size) {
    throw new Error("Unsafe or missing machine package");
  }
  const descriptor = await open(packageFile, "r");
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await descriptor.read(signature, 0, signature.length, 0);
    if (bytesRead !== 4 || !signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new Error("Invalid machine package");
    }
  } finally {
    await descriptor.close();
  }
  let npmPackage;
  let installer;
  if (manifest.npmSetup !== undefined) {
    if (manifest.npmSetup !== 1 || manifest.runtimePackage?.name !== "codey" ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.codey?.version ?? "")) {
      throw new Error("Invalid npm setup release");
    }
    npmPackage = await releasedFile(release, manifest.runtimePackage, `codey-${manifest.codey.version}.tgz`,
      Buffer.from([0x1f, 0x8b]), 512 * 1024 * 1024);
    installer = await releasedFile(release, manifest.installer, "install-codey-linux.sh",
      Buffer.from("#!/usr/bin/env bash\n"), 1024 * 1024);
  }
  return { manifest, package: { ...packageInfo, path: packageFile }, npmPackage, installer };
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
    machineUpdates, verify = verifyMachine, verifyTunnel = verifyDevTunnelAccess }) {
    Object.assign(this, { nodePolicy, accounts, authenticator, origin, bundleRoot, cloudCliGateway, nodeDataGateway, cloudCliUi, verify });
    this.machineUpdates = machineUpdates;
    this.verifyTunnel = verifyTunnel;
    this.tunnels = new MachineTunnelService({ nodePolicy, accounts });
    this.network = network ? machineNetworkConfig(network) : null;
    this.verifying = 0;
    this.downloading = 0;
    this.refreshing = null;
    if (cloudCliGateway) cloudCliGateway.refreshMachines = () => this.refreshGateways();
  }

  async selectedBundle(platformId) {
    return loadMachineBundle(this.bundleRoot, platformId);
  }

  async availability(platformId, principalId) {
    if (platformId === undefined) {
      const platforms = await Promise.all(MACHINE_PLATFORMS.map(async (definition) =>
        definition.implemented ? { ...await this.availability(definition.id, principalId) }
          : { enabled: false, platform: definition.id, name: definition.name, planned: true, reason: definition.description }));
      const selected = platforms.find((entry) => entry.platform === "linux-x64" && entry.enabled)
        ?? platforms.find((entry) => entry.enabled) ?? platforms.find((entry) => entry.platform === "linux-x64");
      return { ...selected, platforms };
    }
    const definition = machinePlatform(platformId);
    const identity = { platform: platformId, name: definition.name, entrypoint: definition.entrypoint,
      updaterSupported: definition.updater, description: definition.description };
    if (!this.bundleRoot || (!definition.tunnel && !this.network) || !this.cloudCliGateway || !this.nodeDataGateway) {
      return { ...identity, enabled: false, reason: "运维尚未发布完整机器配置包或启用节点网关" };
    }
    if (definition.updater && (!this.machineUpdates || !this.machineUpdates.catalog.configured)) {
      return { ...identity, enabled: false, reason: "请先配置节点升级器签名公钥，确保新机器可持续更新" };
    }
    try {
      const { manifest, package: packageInfo, npmPackage, installer } = await this.selectedBundle(platformId);
      return {
        ...identity, enabled: true, platform: manifest.platform, releaseId: manifest.releaseId,
        bytes: npmPackage?.size ?? packageInfo.size,
        npmAvailable: Boolean(npmPackage && installer),
        ...(npmPackage ? { npmFile: npmPackage.file, entrypoint: "codey setup" } : {}),
        node: manifest.node, cloudcli: manifest.cloudcli.version, copilotApi: manifest.copilotApi.version,
        ...(manifest.codey ? { codey: manifest.codey.version } : {}),
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
        getWorkspaceBinding: (principal) => this.nodePolicy.workspaceBindingFor(principal.id, node.id),
      }));
      this.nodeDataGateway?.setMachineNodes(nodes.map((node) => node.data));
      this.cloudCliGateway?.setMachineNodes(nodes.map((node) => node.workspace));
      this.gatewayRevision = snapshot.revision;
    })();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }

  registrationAvailability(platformId) {
    const definition = machineRegistrationPlatform(platformId);
    if (!this.cloudCliGateway || !this.nodeDataGateway) {
      return { enabled: false, reason: "运维尚未启用机器注册所需的 Workspace 和数据网关" };
    }
    if (definition.updater && !this.machineUpdates?.catalog?.configured) {
      return { enabled: false, reason: "请先配置节点升级器签名公钥，确保新机器可持续更新" };
    }
    return { enabled: true };
  }

  async download(req, res, requestedPlatform, format = "skill") {
    for await (const chunk of req) {
      if (chunk.length) throw requestError("下载配置包不接受 owner、节点 ID 或密钥参数");
    }
    const platformId = requestedPlatform ?? "linux-x64";
    machinePlatform(platformId);
    const available = await this.availability(platformId, req.codeyPrincipal.id);
    if (!available.enabled) throw requestError(available.reason, 503);
    const selected = await this.selectedBundle(platformId);
    const packageInfo = format === "npm" ? selected.npmPackage : format === "installer" ? selected.installer : selected.package;
    if (!packageInfo) throw requestError("尚未发布支持直接 npm 安装的 Codey 包和 Linux 一键脚本，请先更新机器发行版", 503);
    const contentType = format === "npm" ? "application/gzip"
      : format === "installer" ? "text/x-shellscript; charset=utf-8" : "application/zip";
    res.writeHead(200, {
      "content-type": contentType, "content-length": packageInfo.size,
      "content-disposition": `attachment; filename="${packageInfo.file}"`,
      "cache-control": "private, no-store", vary: "Cookie", "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    await pipeline(createReadStream(packageInfo.path), res);
  }

  async limitedDownload(req, res, requestedPlatform, format = "skill") {
    if (this.downloading >= 4) throw requestError("配置包下载繁忙，请稍后重试", 429);
    this.downloading++;
    try { await this.download(req, res, requestedPlatform, format); } finally { this.downloading--; }
  }

  async activateRegistration(req, res) {
    const raw = await input(req);
    const platformId = raw?.package?.platform;
    const definition = machineRegistrationPlatform(platformId);
    const available = this.registrationAvailability(platformId);
    if (!available.enabled) throw requestError(available.reason, 503);
    const registration = machineRegistration(raw, {
      portalOrigin: this.origin,
      releaseId: undefined,
      platform: platformId,
    });
    if (this.verifying >= 4) throw requestError("正在验收其他机器，请稍后重试", 429);
    this.verifying++;
    try {
      const account = await this.accounts.byId(req.codeyPrincipal.id);
      await this.verifyTunnel(registration.machine.devTunnel, registration.connectToken);
      const verification = await this.verify(registration.machine, {
        principal: req.codeyPrincipal,
        clientKey: registration.credentials.clientSigningKey,
        workspaceBinding: {
          key: registration.credentials.workspaceSsoKey,
          subject: registration.credentials.workspaceSubject,
          username: registration.credentials.workspaceUsername,
        },
        getTunnelToken: async () => registration.connectToken,
      });
      if (res.destroyed || (this.authenticator && !(await this.authenticator.principal(req, { touch: false })))) {
        throw requestError("登录已失效或验收已取消，机器尚未添加", 401);
      }
      const current = await this.accounts.byId(req.codeyPrincipal.id);
      if (!account?.enabled || !current?.enabled || account.authVersion !== current.authVersion) {
        throw requestError("账号状态已变化，请重新登录", 401);
      }
      const staged = await this.nodePolicy.stageImportedMachine(
        req.codeyPrincipal.id,
        registration.machine,
        registration.credentials,
        registration.connectToken,
      );
      if (definition.updater && !staged.activated) {
        await this.machineUpdates.registerClientMachine(
          req.codeyPrincipal.id,
          registration.machine.id,
          registration.credentials.updaterCredential,
        );
      }
      const node = staged.activated
        ? staged.node
        : await this.nodePolicy.activateImportedMachine(
          req.codeyPrincipal.id, registration.machine.id,
        );
      await this.refreshGateways();
      json(res, 201, { node, verification });
    } finally {
      this.verifying--;
    }
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://portal.local");
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/settings/machines")) return false;
    try {
      if (!req.codeyPrincipal) throw requestError("需要登录", 401);
      if (["/api/settings/machines/skill", "/api/settings/machines/npm", "/api/settings/machines/installer"].includes(pathname)) {
        if (req.method !== "POST") throw requestError("Method not allowed", 405);
        if ([...url.searchParams.keys()].some((key) => key !== "platform") || url.searchParams.getAll("platform").length > 1) {
          throw requestError("只接受一个目标平台参数");
        }
        const platform = url.searchParams.get("platform") ?? undefined;
        machinePlatform(platform);
        await this.limitedDownload(req, res, platform, pathname.split("/").at(-1));
        return true;
      }
      if (pathname === "/api/settings/machines/activate") {
        if (req.method !== "POST") throw requestError("Method not allowed", 405);
        if (url.search) throw requestError("机器注册接口不接受查询参数");
        await this.activateRegistration(req, res);
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
        throw requestError("旧的个性化配置包不再重新下载；请使用固定无密钥 Skill", 410);
      }
      if (!activate || req.method !== "POST") throw requestError("Method not allowed", 405);
      const available = await this.availability(reserved.setup.platform ?? "linux-x64", req.codeyPrincipal.id);
      if (!available.enabled) throw requestError(available.reason, 503);
      const machine = machineIdentity(await input(req), nodeId);
      if (machine.platform !== (reserved.setup.platform ?? "linux-x64")) {
        throw requestError("机器文件的平台与下载时预留的平台不一致");
      }
      if (available.preview && machine.networkMode !== "devtunnel") {
        throw requestError("Windows 验收包必须通过私有 DevTunnel 完成接入");
      }
      if (machine.networkMode === "devtunnel" && (!reserved.tunnel ||
          reserved.tunnel.tunnelId !== machine.devTunnel.tunnelId || reserved.tunnel.clusterId !== machine.devTunnel.clusterId)) {
        throw requestError("请先由此机器的安装脚本提交并验证本节点隧道", 409);
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
