/** Shared, non-interactive gh credential reader. Never copy a GitHub token to disk. */
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const loginPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const requireValue = (value, message) => { if (!value) throw new Error(message); };
export const GITHUB_USER_URL = "https://api.github.com/user";
export const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";

/** Response bodies, request headers and child errors must never escape this boundary. */
export async function authJson(url, options = {}, { fetch: fetchRequest = globalThis.fetch, timeout = 20000 } = {}) {
  let response;
  try {
    response = await fetchRequest(url, { ...options, redirect: "error", signal: AbortSignal.timeout(timeout) });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, value: null };
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error();
      chunks.push(Buffer.from(chunk));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requireValue(value && typeof value === "object" && !Array.isArray(value), "");
    return { status: response.status, value };
  } catch {
    throw new Error("Authentication request failed (network, timeout or invalid response); no login was started");
  }
}

export function validateGhBinding(value, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  requireValue(value?.schema === 1 && value.source === "gh" && value.host === "github.com" &&
    Number.isSafeInteger(value.id) && value.id > 0 && loginPattern.test(value.login ?? "") &&
    typeof value.executable === "string" && paths.isAbsolute(value.executable) &&
    typeof value.configDir === "string" && paths.isAbsolute(value.configDir) &&
    !/[\0\r\n]/.test(value.executable + value.configDir), "Invalid GitHub CLI account binding");
  // Only this whitelist is persisted or displayed; never return arbitrary saved properties.
  return { schema: 1, source: "gh", host: "github.com", id: value.id, login: value.login,
    executable: value.executable, configDir: value.configDir };
}

export function ghEnvironment(environment, configDir) {
  // A sanitized service descriptor does not contain the live Linux Secret
  // Service bus. Inherit its non-secret session coordinates at execution time,
  // rather than persisting a stale desktop/boot session in the account binding.
  const session = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => /^(?:DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR)$/i.test(name)));
  const env = Object.fromEntries(Object.entries({ ...session, ...environment }).filter(([name]) =>
    !/(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(name) &&
    !/^(?:CODEY_|COPILOT_API_|GH_HOST$|GH_DEBUG$|DEBUG$|NODE_OPTIONS$)/i.test(name)));
  return { ...env, GH_CONFIG_DIR: configDir, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", GH_TELEMETRY: "0" };
}

export function ghConfigDirectory(environment, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const get = name => Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const home = get(platform === "win32" ? "USERPROFILE" : "HOME") || os.homedir();
  const directory = get("GH_CONFIG_DIR") || (get("XDG_CONFIG_HOME") ? paths.join(get("XDG_CONFIG_HOME"), "gh") :
    platform === "win32" && get("APPDATA") ? paths.join(get("APPDATA"), "GitHub CLI") : paths.join(home, ".config/gh"));
  requireValue(paths.isAbsolute(directory) && !/[\0\r\n]/.test(directory), "GitHub CLI config directory must be absolute");
  return paths.resolve(directory);
}

export async function findGh(environment = process.env, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const searchPath = Object.entries(environment).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  for (const entry of searchPath.split(paths.delimiter)) {
    const directory = entry.replace(/^"|"$/g, "");
    if (!paths.isAbsolute(directory)) continue; // Never search the project's working directory.
    const file = paths.resolve(directory, platform === "win32" ? "gh.exe" : "gh");
    // Keep stable Homebrew/snap launchers. Resolving a multicall symlink can
    // change argv[0], and a Cellar version path disappears after an upgrade.
    try { await access(file, platform === "win32" ? constants.F_OK : constants.X_OK); return file; }
    catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw new Error("Cannot inspect GitHub CLI"); }
  }
  return null;
}

/** An absent installation/login is optional; a broken pinned account is not. */
export async function readGhCredential({ environment = process.env, binding, platform = process.platform } = {}, {
  execute = exec, locate = findGh, request = authJson,
} = {}) {
  const pinned = binding ? validateGhBinding(binding, platform) : null;
  const executable = pinned?.executable ?? await locate(environment, platform);
  if (!executable) return null;
  const configDir = pinned?.configDir ?? ghConfigDirectory(environment, platform);
  const args = ["auth", "token", "--hostname", "github.com", ...(pinned ? ["--user", pinned.login] : [])];
  let token;
  try {
    const result = await execute(executable, args, { env: ghEnvironment(environment, configDir),
      windowsHide: true, timeout: 15000, maxBuffer: 8192, encoding: "utf8" });
    token = result.stdout.trim();
  } catch (error) {
    if (!pinned && (error.code === 1 || error.code === "ENOENT")) return null;
    throw new Error("Cannot read the selected GitHub CLI account; run gh auth login in the owner's terminal");
  }
  requireValue(/^[A-Za-z0-9_-]{8,4096}$/.test(token), "GitHub CLI did not return a valid credential");
  const { status, value } = await request(GITHUB_USER_URL, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "codey-gh-auth" },
  });
  if (!pinned && status === 401) return null;
  requireValue(status === 200 && Number.isSafeInteger(value?.id) && value.id > 0 &&
    loginPattern.test(value.login ?? ""), `GitHub CLI identity verification failed (HTTP ${status}); no account was changed`);
  requireValue(!pinned || pinned.id === value.id && pinned.login.toLowerCase() === value.login.toLowerCase(),
    "GitHub CLI account differs from the pinned Codey account; no account was changed");
  const result = { binding: validateGhBinding({ schema: 1, source: "gh", host: "github.com",
    executable, configDir, id: value.id, login: value.login }, platform) };
  // Accidental JSON logging must not serialize this high-privilege credential.
  Object.defineProperty(result, "token", { value: token });
  return result;
}

export async function verifyGhCopilot(credential, { request = authJson } = {}) {
  const headers = { authorization: `Bearer ${credential.token}`, "user-agent": "codey-gh-auth", accept: "application/json" };
  const account = await request("https://api.github.com/copilot_internal/user", { headers });
  requireValue(account.status === 200 && account.value?.login?.toLowerCase() === credential.binding.login.toLowerCase(),
    `GitHub CLI account cannot access Copilot (HTTP ${account.status}); use an entitled account or codey copilot login --force`);
  const models = await request(COPILOT_MODELS_URL, { headers });
  requireValue(models.status === 200 && Array.isArray(models.value?.data) && models.value.data.length > 0,
    `GitHub CLI Copilot model access failed (HTTP ${models.status}); no device login was started`);
}
