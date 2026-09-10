import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { SignedStore, requestError } from "./signed-store.mjs";
import { NodeUpdateCatalog, UPDATE_PROTOCOL } from "./node-update-release.mjs";
import { zipStream } from "./zip-stream.mjs";

const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HEX = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const JOB_ID = /^[a-f0-9]{32}$/;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const terminal = new Set(["succeeded", "failed", "rolled_back", "needs_migration", "needs_action", "cancelled"]);
const active = new Set(["claimed", "downloading", "staging", "waiting_idle", "applying", "verifying"]);
const transitions = {
  claimed: ["downloading", "verifying", "needs_migration", "needs_action", "failed"],
  downloading: ["staging", "failed", "needs_action"],
  staging: ["waiting_idle", "applying", "failed", "needs_migration", "needs_action"],
  waiting_idle: ["applying", "failed", "needs_action"],
  applying: ["verifying", "rolled_back", "failed", "needs_action"],
  verifying: ["succeeded", "rolled_back", "failed", "needs_action"],
};
const CODES = new Set(["ok", "up_to_date", "busy", "unsupported_platform", "runtime_incompatible",
  "model_auth_migration_required", "migration_unsupported", "model_login_required", "download_failed",
  "signature_invalid", "stage_failed", "configuration_changed", "health_failed", "model_failed",
  "rollback_failed", "recovered_rollback", "canary_failed", "lease_lost", "operation_failed", "waiting_canary", "release_unavailable"]);
const id = () => randomBytes(16).toString("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sameHash = (left, right) => HEX.test(left ?? "") && HEX.test(right ?? "") &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

function send(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length,
    "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(body);
}

async function body(req, keys) {
  if (String(req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") {
    throw requestError("Expected JSON", 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw requestError("Request too large", 413);
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks)); } catch { throw requestError("Invalid JSON"); }
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).some((key) => !keys.includes(key))) throw requestError("包含不允许的字段");
  return result;
}

export function safeAgentReport(value) {
  const keys = ["platform", "layout", "components", "currentRelease", "highestSequence", "readyMigrations", "blockedReason", "busy"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      typeof value.platform !== "string" || !/^[a-z0-9-]{1,40}$/.test(value.platform) ||
      !["managed", "legacy", "npm", "unsupported"].includes(value.layout) ||
      !Number.isSafeInteger(value.highestSequence) || value.highestSequence < 0 ||
      !Array.isArray(value.readyMigrations) || value.readyMigrations.length > 20 ||
      value.readyMigrations.some((item) => !/^[a-z0-9-]{1,80}$/.test(item)) ||
      (value.blockedReason && !CODES.has(value.blockedReason)) ||
      (value.busy !== undefined && typeof value.busy !== "boolean") ||
      (value.currentRelease && !/^[a-z0-9-]{1,64}$/.test(value.currentRelease))) throw requestError("Invalid agent report");
  const components = {};
  for (const [name, item] of Object.entries(value.components ?? {})) {
    if (!["cloudcli", "copilotApi", "codey"].includes(name) || !item ||
        Object.keys(item).some((key) => !["version", "commit", "entrySha256", "nodeMajor"].includes(key)) ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(item.version ?? "") ||
        (item.commit && !/^[a-f0-9]{40}$/.test(item.commit)) || !HEX.test(item.entrySha256 ?? "") ||
        !Number.isInteger(item.nodeMajor) || item.nodeMajor < 1 || item.nodeMajor > 100) throw requestError("Invalid component report");
    components[name] = { ...item };
  }
  if ((value.layout === "npm") !== Object.hasOwn(components, "codey")) throw requestError("Invalid npm package report");
  return { platform: value.platform, layout: value.layout, highestSequence: value.highestSequence,
    currentRelease: value.currentRelease || null, readyMigrations: [...value.readyMigrations],
    blockedReason: value.blockedReason || null, busy: value.busy === true, components };
}

function eligibility(node, device, release) {
  if (node.id === "local") return { eligible: false, reason: "protected_local" };
  if (node.platform && node.platform !== "linux-x64") return { eligible: false, reason: "unsupported_platform" };
  if (!device || device.revoked || !device.report) return { eligible: false, reason: "needs_setup" };
  const report = device.report;
  if (report.platform !== release.platform || report.layout === "unsupported") return { eligible: false, reason: "unsupported_platform" };
  if ((report.layout === "npm") !== Object.hasOwn(release.components, "codey")) {
    return { eligible: false, reason: "runtime_incompatible" };
  }
  if (report.highestSequence > release.sequence) return { eligible: false, reason: "downgrade_blocked" };
  if (report.blockedReason) return { eligible: false, reason: report.blockedReason };
  if (release.migrations.some((migration) => !report.readyMigrations.includes(migration))) {
    return { eligible: false, reason: "model_auth_migration_required" };
  }
  for (const [name, component] of Object.entries(release.components)) {
    if (!component.nodeMajors.includes(report.components[name]?.nodeMajor)) {
      return { eligible: false, reason: "runtime_incompatible" };
    }
  }
  const changed = Object.entries(release.components).filter(([name, component]) =>
    report.components[name]?.entrySha256 !== component.entrySha256 || report.components[name]?.commit !== component.commit ||
    report.components[name]?.version !== component.version).map(([name]) => name);
  const unverified = report.highestSequence < release.sequence || report.currentRelease !== release.id;
  return { eligible: changed.length > 0 || unverified, reason: changed.length || unverified ? null : "up_to_date",
    changed, verificationOnly: changed.length === 0 && unverified };
}

function publicJob(job) {
  return Object.fromEntries(["id", "batchId", "nodeId", "releaseId", "state", "code", "createdAt", "updatedAt", "attempts"]
    .map((key) => [key, job[key] ?? null]));
}

export class MachineUpdates {
  constructor({ root, master, catalogRoot, publicKey, nodePolicy, accounts, authenticator, sourceRoot, clock = Date.now }) {
    this.store = new SignedStore(root, "machine-updates.json", master);
    this.catalog = new NodeUpdateCatalog({ root: catalogRoot, publicKey, clock });
    this.bootstrapSecret = master;
    Object.assign(this, { nodePolicy, accounts, authenticator, sourceRoot: path.resolve(sourceRoot), clock, publicKey });
  }

  initialize() { return this.store.initialize({ devices: {}, plans: {}, jobs: [], batches: {} }); }

  mutate(operation) {
    return this.store.mutate(async (data) => {
      for (const [key, plan] of Object.entries(data.plans)) if (plan.expiresAt < this.clock()) delete data.plans[key];
      const result = await operation(data);
      if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024) throw requestError("升级状态存储已达上限，请先归档历史", 409);
      return result;
    });
  }

  async owner(principalId, nodeId) {
    if (!NODE_ID.test(nodeId ?? "")) throw requestError("节点不存在或无权访问", 404);
    const account = await this.accounts.byId(principalId);
    if (!account?.enabled) throw requestError("账号已停用", 403);
    const node = await this.nodePolicy.owned(principalId, nodeId);
    if (nodeId === "local") throw requestError("受保护节点不接受页面或批量升级", 403);
    if (node.machine?.platform && node.machine.platform !== "linux-x64") {
      throw requestError("此平台尚未支持签名升级器；不会分发 Linux 升级脚本", 409);
    }
    return { account, node };
  }

  async list(principalId) {
    const nodes = await this.nodePolicy.list(principalId);
    const data = (await this.store.read()).data;
    const releases = await this.catalog.list();
    const latest = releases[0]?.release;
    const ids = new Set(nodes.map((node) => node.id));
    return {
      enabled: this.catalog.configured,
      reason: this.catalog.configured ? (latest ? null : "尚未发布签名的节点发行版") : "运维尚未配置节点更新目录与发行版签名公钥",
      releases: releases.map(({ release, digest }) => ({ ...release, digest })),
      nodes: nodes.map((node) => {
        const device = data.devices[node.id]?.ownerId === principalId ? data.devices[node.id] : null;
        const currentJob = data.jobs.findLast((job) => job.nodeId === node.id && job.ownerId === principalId && !terminal.has(job.state));
        return {
          id: node.id, name: node.name, protected: node.id === "local", enrolled: Boolean(device && !device.revoked),
          updaterSupported: !node.platform || node.platform === "linux-x64",
          connected: Boolean(device && !device.revoked && this.clock() - (device.lastSeen || 0) < HEARTBEAT_TIMEOUT_MS),
          lastSeen: device?.lastSeen || null, report: device?.report || null,
          ...(node.platform && node.platform !== "linux-x64" ? { eligible: false, reason: "unsupported_platform" }
            : latest ? eligibility(node, device, latest) : { eligible: false, reason: "no_release" }),
          activeJob: currentJob ? publicJob(currentJob) : null,
        };
      }),
      jobs: data.jobs.filter((job) => job.ownerId === principalId && ids.has(job.nodeId)).slice(-100).map(publicJob),
    };
  }

  async inventory(nodes) {
    // Read the signed heartbeat snapshot only. This must not probe machines,
    // load a target release, issue credentials, or grant owner capabilities.
    const { devices } = (await this.store.read()).data;
    const generatedAt = this.clock();
    return {
      generatedAt, heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      nodes: new Map(nodes.map((node) => {
        const saved = devices[node.id];
        const device = saved?.nodeId === node.id && saved.ownerId === node.ownerId ? saved : null;
        const lastSeen = Number.isSafeInteger(device?.lastSeen) && device.lastSeen > 0 ? device.lastSeen : null;
        const age = lastSeen === null ? null : generatedAt - lastSeen;
        const status = !device ? "not_enrolled" : device.revoked ? "revoked"
          : age === null ? "unreported" : age < 0 ? "unknown"
            : age < HEARTBEAT_TIMEOUT_MS ? "online" : "stale";
        // Explicit, narrower allowlist than the owner's updater report.
        const components = Object.fromEntries(["cloudcli", "copilotApi"].map((name) => {
          const component = device?.report?.components?.[name];
          return [name, component ? {
            version: component.version, commit: component.commit || null, nodeMajor: component.nodeMajor,
          } : null];
        }));
        return [node.id, {
          status, lastSeen, releaseId: device?.report?.currentRelease || null, components,
        }];
      })),
    };
  }

  async bootstrap(principalId, nodeId, replace = false) {
    if (!this.catalog.configured) throw requestError("节点更新尚未配置", 409);
    const { account, node } = await this.owner(principalId, nodeId);
    const workspace = node.keyMode === "client"
      ? await this.nodePolicy.workspaceBindingFor(principalId, nodeId)
      : null;
    // Load the executable payload before issuing/replacing a credential.
    const sources = await this.sources();
    const credential = randomBytes(32).toString("base64url");
    await this.mutate((data) => {
      if (data.jobs.some((job) => job.nodeId === nodeId && !terminal.has(job.state))) throw requestError("请等待当前升级任务结束", 409);
      if (Object.hasOwn(data.devices, nodeId) && !replace) throw requestError("升级器已绑定；重新接入需要明确确认凭据轮换", 409);
      if (!Object.hasOwn(data.devices, nodeId) && Object.keys(data.devices).length >= 1024) throw requestError("升级器数量已达上限", 409);
      const previous = data.devices[nodeId];
      data.devices[nodeId] = { nodeId, ownerId: principalId, credentialHash: hash(credential),
        createdAt: this.clock(), lastSeen: null,
        report: previous?.ownerId === principalId ? previous.report : null, revoked: false };
    });
    const config = this.config(account, nodeId, credential, workspace);
    const entries = [{ name: "codey-updater/config.json", data: JSON.stringify(config, null, 2) + "\n" }];
    entries.push(...sources);
    return zipStream(entries);
  }

  sources() {
    return Promise.all(["updater.py", "engine.py", "probe.mjs", "install.py", "UPGRADE.md"]
      .map(async (name) => ({ name: "codey-updater/" + name, data: await readFile(path.join(this.sourceRoot, name)) })));
  }

  config(account, nodeId, credential, workspace) {
    return { schema: 1, nodeId, ownerId: workspace?.subject ?? account.principalId,
      username: workspace?.username ?? account.username,
      portalOrigin: this.authenticator.origin, credential, releasePublicKey: this.publicKey, protocol: UPDATE_PROTOCOL };
  }

  async newMachineEntries(principalId, nodeId) {
    if (!this.catalog.configured) throw requestError("请先配置节点更新签名公钥", 409);
    const account = await this.accounts.byId(principalId);
    if (!account?.enabled) throw requestError("账号已停用", 403);
    await this.nodePolicy.reservedMachine(principalId, nodeId);
    const sources = await this.sources();
    const credential = await this.mutate((data) => {
      let device = Object.hasOwn(data.devices, nodeId) ? data.devices[nodeId] : null;
      if (device && (device.ownerId !== principalId || device.revoked || !device.enrollmentSalt)) {
        throw requestError("预留机器的升级器绑定已改变", 409);
      }
      if (!device) {
        if (Object.keys(data.devices).length >= 1024) throw requestError("升级器数量已达上限", 409);
        device = data.devices[nodeId] = { nodeId, ownerId: principalId, enrollmentSalt: id(),
          createdAt: this.clock(), lastSeen: null, report: null, revoked: false };
      }
      // Re-download the same pending identity without rotating a partially installed node.
      // Domain-separated from model/SSO keys; the master never leaves the Portal.
      const token = createHmac("sha256", this.bootstrapSecret)
        .update(JSON.stringify(["codey-node-updater-enrollment-v1", principalId, nodeId, device.enrollmentSalt]))
        .digest("base64url");
      device.credentialHash = hash(token);
      return token;
    });
    return [{ name: "codey-updater/config.json", data: JSON.stringify(this.config(account, nodeId, credential), null, 2) + "\n" },
      ...sources];
  }

  async registerClientMachine(principalId, nodeId, credential) {
    if (!this.catalog.configured) throw requestError("节点更新尚未配置", 409);
    if (!NODE_ID.test(nodeId ?? "") || !TOKEN.test(credential ?? "")) {
      throw requestError("客户端生成的升级器凭据无效");
    }
    const account = await this.accounts.byId(principalId);
    if (!account?.enabled) throw requestError("账号已停用", 403);
    return this.mutate((data) => {
      const existing = data.devices[nodeId];
      if (existing) {
        if (existing.ownerId !== principalId || existing.revoked ||
            !sameHash(existing.credentialHash, hash(credential))) {
          throw requestError("此机器的升级器身份已被使用", 409);
        }
        return { created: false };
      }
      if (Object.keys(data.devices).length >= 1024) throw requestError("升级器数量已达上限", 409);
      data.devices[nodeId] = {
        nodeId,
        ownerId: principalId,
        credentialHash: hash(credential),
        createdAt: this.clock(),
        lastSeen: null,
        report: null,
        revoked: false,
      };
      return { created: true };
    });
  }

  async revoke(principalId, nodeId) {
    await this.owner(principalId, nodeId);
    return this.mutate((data) => {
      const device = data.devices[nodeId];
      if (!device || device.ownerId !== principalId) throw requestError("升级器尚未接入", 404);
      device.revoked = true;
      for (const job of data.jobs) if (job.nodeId === nodeId && job.ownerId === principalId && !terminal.has(job.state)) {
        job.state = ["applying", "verifying"].includes(job.state) ? "needs_action" : "cancelled";
        job.code = "lease_lost"; job.updatedAt = this.clock(); job.leaseHash = null;
      }
      return { revoked: true, nodeId, nodeServicesStopped: false };
    });
  }

  async plan(principalId, nodeIds, releaseId) {
    if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.length > 32 ||
        new Set(nodeIds).size !== nodeIds.length) throw requestError("请选择 1–32 台不同的机器");
    // Validate every owner before persisting any part of a batch.
    const owned = await Promise.all(nodeIds.map((nodeId) => this.owner(principalId, nodeId)));
    const selected = await this.catalog.get(releaseId);
    const data = (await this.store.read()).data;
    const targets = owned.map(({ node }) => {
      const device = data.devices[node.id];
      const check = eligibility(node, device?.ownerId === principalId ? device : null, selected.release);
      const busy = data.jobs.some((job) => job.nodeId === node.id && !terminal.has(job.state));
      return { nodeId: node.id, name: node.name, ...check, ...(busy ? { eligible: false, reason: "job_active" } : {}),
        deferred: Boolean(device && this.clock() - (device.lastSeen || 0) >= HEARTBEAT_TIMEOUT_MS) };
    });
    const result = { id: id(), releaseId, digest: selected.digest, targets, expiresAt: this.clock() + 300000,
      notes: selected.release.notes, migrations: selected.release.migrations, components: selected.release.components,
      warning: "只更新已验证的软件包；短暂停止受影响服务，等待任务空闲。批量先更新一台，成功后最多并行三台。API key/未知迁移不会被强行执行。" };
    await this.mutate((state) => {
      for (const [key, item] of Object.entries(state.plans)) if (item.expiresAt < this.clock()) delete state.plans[key];
      if (Object.keys(state.plans).length >= 256) throw requestError("升级计划数量已达上限", 409);
      state.plans[result.id] = { ...result, ownerId: principalId };
    });
    return result;
  }

  async enqueue(principalId, planId) {
    const plan = (await this.store.read()).data.plans[planId];
    if (!plan || plan.ownerId !== principalId) throw requestError("升级计划不存在", 404);
    if (plan.expiresAt < this.clock()) throw requestError("升级计划已过期，请重新预览", 409);
    await Promise.all(plan.targets.map((target) => this.owner(principalId, target.nodeId)));
    const { release } = await this.catalog.get(plan.releaseId, plan.digest);
    return this.mutate((data) => {
      const current = data.plans[planId];
      if (!current || current.expiresAt < this.clock()) throw requestError("升级计划已过期，请重新预览", 409);
      if (current.jobIds) return data.jobs.filter((job) => current.jobIds.includes(job.id)).map(publicJob);
      const targets = current.targets.filter((target) => target.eligible);
      if (!targets.length) throw requestError("没有可更新的机器；请先处理迁移、兼容性或升级器接入", 409);
      if (data.jobs.some((job) => targets.some((target) => target.nodeId === job.nodeId) && !terminal.has(job.state))) {
        throw requestError("部分机器已有升级任务，请重新预览", 409);
      }
      for (const target of targets) {
        const device = data.devices[target.nodeId];
        if (device?.ownerId !== principalId || device.revoked || !eligibility({ id: target.nodeId }, device, release).eligible) {
          throw requestError("机器状态已改变，请重新预览", 409);
        }
      }
      data.jobs = data.jobs.filter((job) => !terminal.has(job.state) || job.updatedAt > this.clock() - 30 * 86400000);
      if (data.jobs.length + targets.length > 8000) throw requestError("升级任务记录已达上限", 409);
      const batchId = id();
      data.batches[batchId] = { id: batchId, ownerId: principalId, canaryJobId: null };
      const jobs = targets.map((target) => ({
        id: id(), batchId, nodeId: target.nodeId, ownerId: principalId,
        releaseId: release.id, digest: current.digest, state: "queued", code: null,
        createdAt: this.clock(), updatedAt: this.clock(), attempts: 0,
      }));
      data.jobs.push(...jobs);
      current.jobIds = jobs.map((job) => job.id);
      return jobs.map(publicJob);
    });
  }

  async authenticateAgent(req) {
    const nodeId = req.headers["x-codey-node-id"];
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!NODE_ID.test(nodeId ?? "") || !token || req.headers.cookie) throw requestError("Unauthorized updater", 401);
    const device = (await this.store.read()).data.devices[nodeId];
    if (!device || device.revoked || !sameHash(device.credentialHash, hash(token))) throw requestError("Unauthorized updater", 401);
    await this.owner(device.ownerId, nodeId);
    return device;
  }

  async poll(device, report, previousLease) {
    const clean = safeAgentReport(report);
    const state = (await this.store.read()).data;
    const job = state.jobs.find((item) => item.nodeId === device.nodeId && item.ownerId === device.ownerId && !terminal.has(item.state));
    let selected = null;
    let releaseUnavailable = false;
    try { if (job) selected = await this.catalog.get(job.releaseId, job.digest); }
    catch (error) {
      if (error.status !== 409) throw error; // Corrupt signatures still fail closed.
      releaseUnavailable = true;
    }
    return this.mutate((data) => {
      const current = data.devices[device.nodeId];
      if (!current || current.revoked || !sameHash(current.credentialHash, device.credentialHash)) throw requestError("Updater revoked", 401);
      if (current.report && clean.highestSequence < current.report.highestSequence) throw requestError("Updater sequence moved backwards", 409);
      current.lastSeen = this.clock();
      current.report = clean;
      const pending = data.jobs.find((item) => item.id === job?.id && !terminal.has(item.state));
      if (!pending) return { protocol: UPDATE_PROTOCOL, job: null, pollAfterSeconds: 15 };
      const batch = data.batches[pending.batchId];
      if (releaseUnavailable) {
        for (const item of data.jobs) if (item.id === pending.id || (item.batchId === pending.batchId && item.state === "queued")) {
          item.state = "needs_action"; item.code = "release_unavailable"; item.updatedAt = this.clock(); item.leaseHash = null;
        }
        return { protocol: UPDATE_PROTOCOL, job: null, pollAfterSeconds: 15 };
      }
      const canary = data.jobs.find((item) => item.id === batch.canaryJobId);
      if (canary && canary.id !== pending.id && canary.state !== "succeeded") {
        if (terminal.has(canary.state)) {
          pending.state = "needs_action"; pending.code = "canary_failed"; pending.updatedAt = this.clock();
        }
        return { protocol: UPDATE_PROTOCOL, job: null, waitingForCanary: true, pollAfterSeconds: 15 };
      }
      if (pending.state === "queued" && clean.busy &&
          !eligibility({ id: device.nodeId }, current, selected.release).verificationOnly) {
        pending.code = "busy"; pending.updatedAt = this.clock();
        return { protocol: UPDATE_PROTOCOL, job: null, waitingForIdle: true, pollAfterSeconds: 15 };
      }
      const others = data.jobs.filter((item) => item.batchId === pending.batchId && item.id !== pending.id && active.has(item.state));
      if (others.length >= 3) return { protocol: UPDATE_PROTOCOL, job: null, pollAfterSeconds: 15 };
      let lease = TOKEN.test(previousLease ?? "") && sameHash(pending.leaseHash, hash(previousLease)) ? previousLease : null;
      if (!lease && pending.leaseExpiresAt > this.clock()) return { protocol: UPDATE_PROTOCOL, job: null, pollAfterSeconds: 15 };
      if (!batch.canaryJobId) batch.canaryJobId = pending.id;
      if (!lease) {
        lease = randomBytes(32).toString("base64url");
        pending.leaseHash = hash(lease);
        pending.attempts++;
      }
      pending.leaseExpiresAt = this.clock() + 15 * 60000;
      if (pending.state === "queued") pending.state = "claimed";
      pending.updatedAt = this.clock();
      return { protocol: UPDATE_PROTOCOL, pollAfterSeconds: 15,
        job: { ...publicJob(pending), digest: pending.digest, envelope: selected.envelope,
          leaseToken: lease, leaseExpiresAt: pending.leaseExpiresAt } };
    });
  }

  async report(device, input) {
    if (!JOB_ID.test(input.jobId ?? "") || !TOKEN.test(input.leaseToken ?? "") ||
        !CODES.has(input.code) || ![...active, ...terminal].includes(input.state)) throw requestError("Invalid job report");
    return this.mutate((data) => {
      const currentDevice = data.devices[device.nodeId];
      if (!currentDevice || currentDevice.revoked || !sameHash(currentDevice.credentialHash, device.credentialHash)) {
        throw requestError("Updater revoked", 401);
      }
      const job = data.jobs.find((item) => item.id === input.jobId && item.nodeId === device.nodeId && item.ownerId === device.ownerId);
      if (!job || !sameHash(job.leaseHash, hash(input.leaseToken)) || job.leaseExpiresAt < this.clock()) {
        throw requestError("Upgrade lease is no longer valid", 409);
      }
      if (terminal.has(job.state)) {
        if (job.state !== input.state) throw requestError("Upgrade already completed", 409);
        return publicJob(job);
      }
      if (job.state !== input.state && !transitions[job.state]?.includes(input.state) &&
          !(input.state === "rolled_back" && input.code === "recovered_rollback")) throw requestError("Invalid upgrade state transition", 409);
      if (input.state === "succeeded" && job.state !== "verifying") {
        throw requestError("Upgrade was not verified", 409);
      }
      job.state = input.state; job.code = input.code; job.updatedAt = this.clock();
      job.leaseExpiresAt = this.clock() + 15 * 60000;
      if (terminal.has(job.state) && job.state !== "succeeded" && data.batches[job.batchId]?.canaryJobId === job.id) {
        for (const other of data.jobs) if (other.batchId === job.batchId && other.state === "queued") {
          other.state = "needs_action"; other.code = "canary_failed"; other.updatedAt = this.clock();
        }
      }
      return publicJob(job);
    });
  }

  async handleAgent(req, res) {
    const pathname = new URL(req.url, "http://portal.local").pathname;
    if (!pathname.startsWith("/api/node-updater/")) return false;
    try {
      const device = await this.authenticateAgent(req);
      if (pathname === "/api/node-updater/poll" && req.method === "POST") {
        const input = await body(req, ["protocol", "report", "leaseToken"]);
        if (input.protocol !== UPDATE_PROTOCOL) throw requestError("Updater protocol is not supported", 409);
        send(res, 200, await this.poll(device, input.report, input.leaseToken));
      } else if (pathname === "/api/node-updater/report" && req.method === "POST") {
        send(res, 200, await this.report(device, await body(req, ["jobId", "leaseToken", "state", "code"])));
      } else {
        const match = pathname.match(/^\/api\/node-updater\/releases\/([a-z0-9][a-z0-9-]{0,63})\/(cloudcli\.tar\.gz|gateway\.tar\.gz|codey-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\.tgz)$/);
        if (!match || req.method !== "GET") throw requestError("Not found", 404);
        const data = (await this.store.read()).data;
        if (!data.jobs.some((job) => job.nodeId === device.nodeId && job.ownerId === device.ownerId &&
            job.releaseId === match[1] && active.has(job.state))) throw requestError("Artifact is not assigned to this updater", 403);
        const file = await this.catalog.artifact(match[1], match[2]);
        res.writeHead(200, { "content-type": "application/gzip", "content-length": file.size,
          "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
        await pipeline(createReadStream(file.target), res);
      }
    } catch (error) {
      if (res.headersSent) res.destroy(error);
      else send(res, error.status || 503, { error: error.status ? error.message : "节点更新服务暂不可用" });
    }
    return true;
  }

  async handleOwner(req, res) {
    const pathname = new URL(req.url, "http://portal.local").pathname;
    if (!pathname.startsWith("/api/settings/updates")) return false;
    try {
      const principal = req.codeyPrincipal;
      if (!principal) throw requestError("需要登录", 401);
      if (req.method !== "GET" && !this.authenticator.sameOrigin(req)) throw requestError("不允许跨源更新请求", 403);
      if (pathname === "/api/settings/updates" && req.method === "GET") {
        send(res, 200, await this.list(principal.id));
      } else if (pathname === "/api/settings/updates/plans" && req.method === "POST") {
        const input = await body(req, ["nodeIds", "releaseId"]);
        send(res, 200, await this.plan(principal.id, input.nodeIds, input.releaseId));
      } else if (pathname === "/api/settings/updates/jobs" && req.method === "POST") {
        const input = await body(req, ["planId", "confirmation"]);
        if (input.confirmation !== "update-reviewed-machines") throw requestError("请先确认升级计划");
        send(res, 202, { jobs: await this.enqueue(principal.id, input.planId) });
      } else {
        const revoke = pathname.match(/^\/api\/settings\/updates\/revoke\/([a-z0-9][a-z0-9_-]{0,31})$/);
        if (revoke && req.method === "POST") {
          const input = await body(req, ["confirmation"]);
          if (input.confirmation !== "disable-node-updater") throw requestError("请确认撤销升级器授权");
          send(res, 200, await this.revoke(principal.id, revoke[1]));
          return true;
        }
        const match = pathname.match(/^\/api\/settings\/updates\/bootstrap\/([a-z0-9][a-z0-9_-]{0,31})$/);
        if (!match || req.method !== "POST") throw requestError("Not found", 404);
        const input = await body(req, ["confirmation", "replace"]);
        if (input.confirmation !== "enable-node-updater" || (input.replace !== undefined && typeof input.replace !== "boolean")) {
          throw requestError("请确认只在此机器安装独立升级器");
        }
        const zip = await this.bootstrap(principal.id, match[1], input.replace === true);
        res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length,
          "content-disposition": `attachment; filename="codey-updater-${match[1]}.zip"`,
          "cache-control": "private, no-store", "vary": "Cookie", "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer" });
        await pipeline(Readable.from(zip), res);
      }
    } catch (error) {
      if (res.headersSent) res.destroy(error);
      else send(res, error.status || 503, { error: error.status ? error.message : "机器升级设置暂不可用" });
    }
    return true;
  }
}
