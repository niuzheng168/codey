import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "./config.mjs";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TENANT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRA_RESOURCE_PATTERN =
  /^api:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanMessage(value, maximumLength = 1200) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(-maximumLength);
}

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
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
        finish(new Error("Azure CLI output exceeded the safety limit"));
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
              `Azure CLI exited with code ${code}`,
          ),
        );
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Azure CLI token acquisition timed out"));
    }, options.timeoutMs ?? 60000);
    timer.unref?.();
  });
}

export async function loadSessionHistoryConfig(configPath) {
  const resolvedPath = path.resolve(
    configPath ??
      process.env.SESSION_SHARE_PORTAL_CONFIG ??
      path.join(PROJECT_ROOT, "config", "session-share.json"),
  );
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to load Session Share Portal config: ${cleanMessage(error?.message)}`,
    );
  }
  const baseUrl = String(parsed?.baseUrl ?? "").trim().replace(/\/+$/, "");
  const entraResource = String(parsed?.entraResource ?? "").trim();
  const tenantId = String(parsed?.tenantId ?? "").trim().toLowerCase();
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Session Share baseUrl is invalid");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Session Share baseUrl must use HTTPS");
  }
  if (!ENTRA_RESOURCE_PATTERN.test(entraResource)) {
    throw new Error("Session Share entraResource is invalid");
  }
  if (!TENANT_PATTERN.test(tenantId)) {
    throw new Error("Session Share tenantId is invalid");
  }
  return { baseUrl, entraResource, tenantId, configPath: resolvedPath };
}

export class SessionHistoryClient {
  constructor(options = {}) {
    this.config = options.config ?? null;
    this.configPath = options.configPath;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.runCommand = options.runCommand ?? runCommand;
    this.platform = options.platform ?? process.platform;
    this.cachedToken = null;
    this.tokenPromise = null;
  }

  async status() {
    try {
      const config = await this.#config();
      return {
        configured: true,
        baseUrl: config.baseUrl,
        tenantId: config.tenantId,
      };
    } catch (error) {
      return {
        configured: false,
        error: cleanMessage(error?.message),
      };
    }
  }

  async list({
    state = "active",
    query = "",
    limit = 50,
    offset = 0,
    startAt = 0,
  } = {}) {
    const params = new URLSearchParams({
      state,
      q: query,
      limit: String(limit),
      offset: String(offset),
    });
    if (startAt > 0) params.set("start_at", String(startAt));
    return this.#json(`/v1/session-history?${params}`);
  }

  async detail(state, sessionName) {
    return this.#json(
      `/v1/session-history/${this.#state(state)}/${this.#name(sessionName)}`,
    );
  }

  async rename(sessionName, newName) {
    return this.#json(
      `/v1/session-history/active/${this.#name(sessionName)}/rename`,
      {
        method: "POST",
        body: JSON.stringify({ new_name: this.#name(newName) }),
      },
    );
  }

  async trash(sessionName) {
    return this.#json(
      `/v1/session-history/active/${this.#name(sessionName)}`,
      { method: "DELETE" },
    );
  }

  async restore(sessionName) {
    return this.#json(
      `/v1/session-history/trash/${this.#name(sessionName)}/restore`,
      { method: "POST" },
    );
  }

  async purge(state, sessionName) {
    const normalizedState = this.#state(state);
    return this.#json(
      normalizedState === "active"
        ? `/v1/session-history/active/${this.#name(sessionName)}/purge`
        : `/v1/session-history/trash/${this.#name(sessionName)}`,
      { method: "DELETE" },
    );
  }

  async archive(state, sessionName) {
    return this.#request(
      `/v1/session-history/${this.#state(state)}/${this.#name(sessionName)}/archive`,
    );
  }

  async reserveUpload(payload) {
    return this.#json("/v1/session-history/upload", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async uploadArchive(url, filePath, expectedSize) {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size !== expectedSize) {
      throw new Error("Prepared session archive size changed before upload");
    }
    return this.#json(url, {
      method: "PUT",
      headers: {
        "content-type": "application/gzip",
        "content-length": String(expectedSize),
      },
      body: createReadStream(filePath),
      duplex: "half",
      timeoutMs: 30 * 60 * 1000,
    });
  }

  async #config() {
    if (!this.config) {
      this.config = await loadSessionHistoryConfig(this.configPath);
    }
    return this.config;
  }

  #name(value) {
    const name = String(value ?? "").trim();
    if (!SESSION_NAME_PATTERN.test(name)) {
      throw requestError("Session name is invalid");
    }
    return encodeURIComponent(name);
  }

  #state(value) {
    if (value !== "active" && value !== "trash") {
      throw requestError("Session state must be active or trash");
    }
    return value;
  }

  async #token(forceRefresh = false) {
    if (forceRefresh) {
      this.cachedToken = null;
      this.tokenPromise = null;
    }
    if (
      this.cachedToken?.expiresAt - 300 > Math.floor(Date.now() / 1000)
    ) {
      return this.cachedToken.token;
    }
    if (this.tokenPromise) return this.tokenPromise;

    const promise = (async () => {
      const config = await this.#config();
      const identityEndpoint = String(process.env.IDENTITY_ENDPOINT ?? "").trim();
      const identityHeader = String(process.env.IDENTITY_HEADER ?? "").trim();
      if (identityEndpoint && identityHeader) {
        const target = new URL(identityEndpoint);
        target.searchParams.set("api-version", "2019-08-01");
        target.searchParams.set("resource", config.entraResource);
        const clientId = String(
          process.env.PORTAL_MANAGED_IDENTITY_CLIENT_ID ?? "",
        ).trim();
        if (clientId) target.searchParams.set("client_id", clientId);
        const response = await this.fetchImpl(target, {
          headers: { "x-identity-header": identityHeader },
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) {
          throw new Error(`Managed identity token request returned HTTP ${response.status}`);
        }
        const value = await response.json();
        const token = String(value.access_token ?? value.accessToken ?? "").trim();
        const expiresAt = Number(value.expires_on ?? value.expiresOn ?? 0);
        if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000) {
          throw new Error("Managed identity returned an invalid or expired access token");
        }
        this.cachedToken = { token, expiresAt };
        return token;
      }
      const command = this.platform === "win32" ? "az.cmd" : "az";
      const result = await this.runCommand(
        command,
        [
          "account",
          "get-access-token",
          "--resource",
          config.entraResource,
          "--tenant",
          config.tenantId,
          "--output",
          "json",
        ],
        { timeoutMs: 60000 },
      );
      let value;
      try {
        value = JSON.parse(result.stdout);
      } catch {
        throw new Error("Azure CLI returned invalid token JSON");
      }
      const token = String(value.accessToken ?? "").trim();
      const tenant = String(value.tenant ?? value.tenantId ?? "")
        .trim()
        .toLowerCase();
      const expiresAt = Number(value.expires_on ?? value.expiresOnTimestamp ?? 0);
      if (
        !token ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now() / 1000
      ) {
        throw new Error("Azure CLI returned an invalid or expired access token");
      }
      if (tenant && tenant !== config.tenantId) {
        throw new Error(
          `Azure CLI token tenant ${tenant} does not match the configured tenant`,
        );
      }
      this.cachedToken = { token, expiresAt };
      return token;
    })();
    this.tokenPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.tokenPromise === promise) this.tokenPromise = null;
    }
  }

  async #request(endpoint, options = {}, retried = false) {
    const config = await this.#config();
    const token = await this.#token(retried);
    const target = new URL(endpoint, `${config.baseUrl}/`);
    if (target.origin !== new URL(config.baseUrl).origin) {
      throw new Error("Session Share transfer URL changed origin");
    }
    const { timeoutMs = 120000, ...requestOptions } = options;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(target, {
        ...requestOptions,
        headers: {
          accept: "application/json",
          ...(requestOptions.body ? { "content-type": "application/json" } : {}),
          ...requestOptions.headers,
          authorization: `Bearer ${token}`,
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 401 && !retried) {
        this.cachedToken = null;
        await response.body?.cancel().catch(() => {});
        return this.#request(endpoint, options, true);
      }
      if (!response.ok) {
        const body = await response.text();
        let message = body;
        try {
          message = JSON.parse(body)?.error ?? body;
        } catch {
          // Keep the bounded plain-text response.
        }
        throw requestError(
          `Session Share returned HTTP ${response.status}: ${cleanMessage(message, 600)}`,
          response.status,
        );
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #json(endpoint, options = {}) {
    const response = await this.#request(endpoint, options);
    return response.json();
  }
}

export const sessionHistoryClientInternals = Object.freeze({
  SESSION_NAME_PATTERN,
  cleanMessage,
});
