/** Codey's gh fallback lives outside the provider gateway: existing provider choices win. */
import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const GH_BINDING_FILE = "github-cli.json";
const fail = message => { throw new Error(message); };

async function optionalFile(file, { privateFile = false, limit = 16384 } = {}) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit ||
      process.platform !== "win32" && (info.uid !== process.getuid() || privateFile && info.mode & 0o077)) {
    fail("Copilot authentication state must be a bounded, owner-private regular file");
  }
  return readFile(file, "utf8");
}

export function copilotAuthSettings(root, args, environment = process.env) {
  const value = name => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  return {
    home: path.resolve(root, value("--api-home") || environment.COPILOT_API_HOME ||
      path.join(os.homedir(), ".local/share/copilot-api")),
    app: (value("--oauth-app") ?? environment.COPILOT_API_OAUTH_APP ?? "").trim(),
    enterprise: (value("--enterprise-url") ?? environment.COPILOT_API_ENTERPRISE_URL ?? "").trim(),
  };
}

async function saveBinding(file, binding, validate) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      process.platform !== "win32" && (info.uid !== process.getuid() || info.mode & 0o022)) {
    fail("GitHub CLI binding directory must belong to this owner and not be writable by other users");
  }
  const temporary = file + "." + randomBytes(12).toString("hex") + ".next";
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(binding, null, 2) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    // Atomic, no-replace publication: neither interruption nor two simultaneous
    // starts can publish half a binding or overwrite a different account.
    try { await link(temporary, file); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      try { previous = validate(JSON.parse(await optionalFile(file, { privateFile: true }))); }
      catch { fail("Copilot account binding changed concurrently; no credentials were overwritten"); }
      if (JSON.stringify(previous) !== JSON.stringify(binding)) fail("Copilot account binding changed concurrently; no credentials were overwritten");
    }
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function prepareCopilotAuth(root, args, {
  environment = process.env, force = false, github, log = console.log,
} = {}) {
  const login = args[0] === "auth";
  const settings = copilotAuthSettings(root, args, environment);
  // Explicit enterprise/app choices retain their own authentication semantics.
  if (force || settings.app || settings.enterprise) return { handled: false, environment: force ?
    { ...environment, COPILOT_API_AUTH_MODE: "" } : environment };
  github ??= await import(pathToFileURL(path.join(root, "onboarding/scripts/github-auth.mjs")).href);
  const saved = await optionalFile(path.join(settings.home, "github_token"), { privateFile: true, limit: 8192 });
  const token = environment.COPILOT_API_GITHUB_TOKEN?.trim() || saved?.trim();
  if (token) {
    if (login) {
      const result = await github.authJson("https://api.github.com/copilot_internal/user", {
        headers: { authorization: `Bearer ${token}`, "user-agent": "codey-gh-auth", accept: "application/json" },
      });
      if (result.status !== 200 || typeof result.value?.login !== "string") {
        fail("Existing Copilot credentials were rejected; no account was switched. Use codey copilot login --force to reauthenticate");
      }
      log("Reused existing Copilot credentials; use --force only to sign in again.");
    }
    return { handled: login, environment, source: environment.COPILOT_API_GITHUB_TOKEN?.trim() ? "environment" : "saved" };
  }
  const file = path.join(settings.home, GH_BINDING_FILE);
  const raw = await optionalFile(file, { privateFile: true });
  let binding;
  if (raw !== null) {
    try { binding = github.validateGhBinding(JSON.parse(raw)); }
    catch { fail("Invalid saved GitHub CLI account binding; no account was changed"); }
  }
  const credential = await github.readGhCredential({ environment, binding });
  if (binding && !credential) fail("The pinned GitHub CLI account is unavailable; no other account was selected");
  if (!credential) return { handled: false, environment };
  // A /user or /usage success alone does not prove that the direct OAuth model route works.
  await github.verifyGhCopilot(credential);
  if (!binding) await saveBinding(file, credential.binding, github.validateGhBinding);
  log(`Using GitHub CLI account ${credential.binding.login} for Copilot; no additional login required.`);
  return { handled: login, source: "gh", environment: { ...environment,
    COPILOT_API_GITHUB_TOKEN: credential.token, COPILOT_API_AUTH_MODE: "direct" } };
}
