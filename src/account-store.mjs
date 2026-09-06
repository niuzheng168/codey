import { createHash, randomUUID, randomBytes } from "node:crypto";
import { hashPassword } from "./password-auth.mjs";
import { SignedStore, requestError } from "./signed-store.mjs";

const USERNAME = /^[a-z][a-z0-9_-]{2,31}$/;
const HASH = /^scrypt-v1\$[A-Za-z0-9_-]{43}\$[A-Za-z0-9_-]{86}$/;
const nextVersion = () => randomBytes(32).toString("hex");

export function validateNewPassword(password) {
  if (typeof password !== "string" || password.trim().length < 12 || password.length > 1024) {
    throw requestError("新密码需至少 12 个字符，最多 1024 个字符");
  }
}

export function publicAccount(account) {
  return {
    id: account.principalId, username: account.username, role: account.role,
    enabled: account.enabled, createdAt: account.createdAt, updatedAt: account.updatedAt,
  };
}

export class AccountStore {
  constructor({ root, master, credential }) {
    if (!credential || !USERNAME.test(credential.username ?? "") ||
        !/^[a-z0-9-]{1,80}$/.test(credential.principalId ?? "") || !HASH.test(credential.passwordHash ?? "")) {
      throw new Error("Valid bootstrap account is required");
    }
    this.store = new SignedStore(root, "accounts.json", master);
    this.credential = credential;
  }

  async initialize() {
    const now = new Date().toISOString();
    const result = await this.store.initialize({
      bootstrapPrincipalId: this.credential.principalId,
      users: [{
        ...this.credential, role: "admin", enabled: true, createdAt: now, updatedAt: now,
        // Preserve the already deployed account's opaque sessions on migration.
        authVersion: createHash("sha256").update(JSON.stringify(this.credential)).digest("hex"),
      }],
    });
    if (result.data.bootstrapPrincipalId !== this.credential.principalId) {
      throw new Error("Account bootstrap identity does not match persisted state");
    }
    await this.records();
  }

  async records() {
    const { data } = await this.store.read();
    if (!Array.isArray(data.users) || data.users.length > 256) throw new Error("Invalid account registry");
    const ids = new Set();
    const names = new Set();
    for (const account of data.users) {
      if (!USERNAME.test(account.username ?? "") || !HASH.test(account.passwordHash ?? "") ||
          !/^[a-z0-9-]{1,80}$/.test(account.principalId ?? "") ||
          !["admin", "user"].includes(account.role) || typeof account.enabled !== "boolean" ||
          !/^[a-f0-9]{64}$/.test(account.authVersion ?? "") ||
          ids.has(account.principalId) || names.has(account.username)) {
        throw new Error("Invalid account record");
      }
      ids.add(account.principalId);
      names.add(account.username);
    }
    return data.users;
  }

  async byUsername(username) {
    return (await this.records()).find((account) => account.username === username) ?? null;
  }

  async byId(id) {
    return (await this.records()).find((account) => account.principalId === id) ?? null;
  }

  async list() { return (await this.records()).map(publicAccount); }

  async create({ username, password }) {
    username = typeof username === "string" ? username.trim().toLowerCase() : "";
    if (!USERNAME.test(username)) throw requestError("用户名需为 3–32 位小写字母、数字、下划线或连字符，并以字母开头");
    validateNewPassword(password);
    const passwordHash = await hashPassword(password);
    return this.store.mutate((data) => {
      if (data.users.some((user) => user.username === username)) throw requestError("用户名已存在", 409);
      if (data.users.length >= 256) throw requestError("账号数量已达上限", 409);
      const now = new Date().toISOString();
      const account = {
        username, principalId: `u-${randomUUID()}`, passwordHash, role: "user", enabled: true,
        authVersion: nextVersion(), createdAt: now, updatedAt: now,
      };
      data.users.push(account);
      return publicAccount(account);
    });
  }

  async setEnabled(id, enabled, actorId) {
    if (typeof enabled !== "boolean") throw requestError("enabled must be a boolean");
    return this.store.mutate((data) => {
      const account = data.users.find((user) => user.principalId === id);
      if (!account) throw requestError("账号不存在", 404);
      if (account.principalId === actorId || account.role === "admin") throw requestError("不能停用管理员或当前账号", 403);
      account.enabled = enabled;
      account.authVersion = nextVersion();
      account.updatedAt = new Date().toISOString();
      return publicAccount(account);
    });
  }

  async removeDisabled(id, actorId) {
    return this.store.mutate((data) => {
      const index = data.users.findIndex((user) => user.principalId === id);
      if (index < 0) throw requestError("账号不存在", 404);
      const account = data.users[index];
      if (id === actorId || account.role === "admin") throw requestError("不能删除管理员或当前账号", 403);
      if (account.enabled) throw requestError("请先停用账号", 409);
      data.users.splice(index, 1);
    });
  }

  async changePassword(id, expectedVersion, password) {
    validateNewPassword(password);
    const passwordHash = await hashPassword(password);
    return this.store.mutate((data) => {
      const account = data.users.find((user) => user.principalId === id && user.enabled);
      if (!account || account.authVersion !== expectedVersion) throw requestError("账号状态已变化，请重新登录", 409);
      account.passwordHash = passwordHash;
      account.authVersion = nextVersion();
      account.updatedAt = new Date().toISOString();
    });
  }
}
