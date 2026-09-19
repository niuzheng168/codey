import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authJson, findGh, ghConfigDirectory, ghEnvironment, readGhCredential, validateGhBinding, verifyGhCopilot,
} from "../skills/config-new-codey-machine/scripts/github-auth.mjs";

const token = "fixture_only_github_credential";
const binding = { schema: 1, source: "gh", host: "github.com", id: 42, login: "fixture_user",
  executable: "/fixture/bin/gh", configDir: "/fixture/config/gh" };
const environment = { HOME: "/fixture", PATH: "/fixture/bin:/usr/bin", GH_CONFIG_DIR: binding.configDir,
  GH_TOKEN: "wrong-account", GITHUB_TOKEN: "wrong-account", GH_ENTERPRISE_TOKEN: "wrong-host", GH_HOST: "enterprise.invalid",
  COPILOT_API_GITHUB_TOKEN: "unrelated-provider", CODEY_PORTAL_SSO_KEY: "unrelated-sso", GH_DEBUG: "api",
  NODE_OPTIONS: "--import=unrelated", DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/bus" };

function dependencies(changes = {}) {
  const calls = [];
  return {
    calls,
    locate: async env => { calls.push(["locate", env]); return binding.executable; },
    execute: async (...args) => { calls.push(["execute", ...args]); return { stdout: token + "\n" }; },
    request: async (...args) => { calls.push(["request", ...args]); return { status: 200, value: { id: 42, login: binding.login } }; },
    ...changes,
  };
}

test("gh token reads the active cached account, not aggregate status or environment overrides", async () => {
  const d = dependencies();
  const result = await readGhCredential({ environment }, d);
  assert.deepEqual(result.binding, binding);
  assert.equal(result.token, token);
  assert.ok(!JSON.stringify(result).includes(token));
  const call = d.calls.find(item => item[0] === "execute");
  assert.deepEqual(call[2], ["auth", "token", "--hostname", "github.com"]);
  assert.equal(call[3].env.GH_PROMPT_DISABLED, "1");
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST", "COPILOT_API_GITHUB_TOKEN", "CODEY_PORTAL_SSO_KEY", "GH_DEBUG", "NODE_OPTIONS"]) {
    assert.equal(call[3].env[name], undefined);
  }
  assert.equal(call[3].env.DBUS_SESSION_BUS_ADDRESS, environment.DBUS_SESSION_BUS_ADDRESS);
  assert.equal(call[3].env.GH_CONFIG_DIR, binding.configDir);
  assert.ok(!JSON.stringify(call[2]).includes(token), "no credential in argv");
  assert.equal(d.calls.find(item => item[0] === "request")[1], "https://api.github.com/user");
});

test("a pinned gh account uses its recorded executable, config directory and username", async () => {
  const d = dependencies({ locate: async () => assert.fail("must not follow a new PATH") });
  const result = await readGhCredential({ environment: { ...environment, GH_CONFIG_DIR: "/wrong" }, binding }, d);
  assert.equal(result.binding.id, 42);
  const call = d.calls.find(item => item[0] === "execute");
  assert.equal(call[1], binding.executable);
  assert.deepEqual(call[2].slice(-2), ["--user", binding.login]);
  assert.equal(call[3].env.GH_CONFIG_DIR, binding.configDir);
});

test("missing gh and missing login are optional but a broken pinned account is never switched", async () => {
  assert.equal(await readGhCredential({ environment }, dependencies({ locate: async () => null })), null);
  for (const code of [1, "ENOENT"]) {
    const d = dependencies({ execute: async () => { throw Object.assign(new Error(token), { code }); } });
    assert.equal(await readGhCredential({ environment }, d), null);
    await assert.rejects(readGhCredential({ environment, binding }, d),
      error => error.message.includes("selected GitHub CLI account") && !error.message.includes(token));
  }
  await assert.rejects(readGhCredential({ environment }, dependencies({ execute: async () => {
    throw Object.assign(new Error(token), { code: "ETIMEDOUT" });
  } })), error => !error.message.includes(token));
});

test("identity validation refuses account changes and sanitizes malformed/expired credentials", async () => {
  const unauthorized = dependencies({ request: async () => ({ status: 401, value: null }) });
  assert.equal(await readGhCredential({ environment }, unauthorized), null);
  await assert.rejects(readGhCredential({ environment, binding }, unauthorized), /HTTP 401/);
  for (const value of [{ id: 43, login: binding.login }, { id: 42, login: "another_user" }]) {
    await assert.rejects(readGhCredential({ environment, binding }, dependencies({ request: async () => ({ status: 200, value }) })), /differs from the pinned/);
  }
  for (const value of [{ id: 0, login: binding.login }, { id: 42, login: "../invalid" }, null]) {
    await assert.rejects(readGhCredential({ environment }, dependencies({ request: async () => ({ status: 200, value }) })), /identity verification failed/);
  }
  await assert.rejects(readGhCredential({ environment }, dependencies({
    execute: async () => ({ stdout: token + "\nUNEXPECTED OUTPUT" }),
  })), error => !error.message.includes(token));
});

test("bindings whitelist metadata and validate Unix/Windows host and paths", () => {
  assert.deepEqual(validateGhBinding({ ...binding, token }), binding);
  for (const changed of [{ schema: 2 }, { host: "elsewhere.invalid" }, { id: -1 }, { source: "other" },
    { executable: "gh" }, { configDir: "../gh" }, { executable: "/gh\nbad" }]) {
    assert.throws(() => validateGhBinding({ ...binding, ...changed }), /Invalid GitHub/);
  }
  const windows = { ...binding, executable: "C:\\Program Files\\GitHub CLI\\gh.exe", configDir: "C:\\Users\\owner\\gh" };
  assert.deepEqual(validateGhBinding(windows, "win32"), windows);
});

test("config directory discovery matches gh precedence without shell interpolation", () => {
  assert.equal(ghConfigDirectory({ HOME: "/owner" }), "/owner/.config/gh");
  assert.equal(ghConfigDirectory({ HOME: "/owner", XDG_CONFIG_HOME: "/xdg" }), "/xdg/gh");
  assert.equal(ghConfigDirectory({ HOME: "/owner", XDG_CONFIG_HOME: "/xdg", GH_CONFIG_DIR: "/chosen" }), "/chosen");
  assert.equal(ghConfigDirectory({ USERPROFILE: "C:\\Users\\owner", APPDATA: "C:\\AppData" }, "win32"), "C:\\AppData\\GitHub CLI");
  assert.equal(ghConfigDirectory({ USERPROFILE: "C:\\Users\\owner" }, "win32"), "C:\\Users\\owner\\.config\\gh");
  assert.throws(() => ghConfigDirectory({ GH_CONFIG_DIR: "relative" }), /must be absolute/);
  assert.equal(ghEnvironment(environment, "/pinned").GH_CONFIG_DIR, "/pinned");
});

test("background gh can use the current OS keyring session without persisting it or inheriting other credentials", t => {
  const keys = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "GH_TOKEN"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1234/bus";
  process.env.XDG_RUNTIME_DIR = "/run/user/1234";
  process.env.GH_TOKEN = "unrelated-parent-credential";
  const env = ghEnvironment({ HOME: "/fixture" }, binding.configDir);
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, process.env.DBUS_SESSION_BUS_ADDRESS);
  assert.equal(env.XDG_RUNTIME_DIR, process.env.XDG_RUNTIME_DIR);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(ghEnvironment({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/chosen" }, binding.configDir)
    .DBUS_SESSION_BUS_ADDRESS, "unix:path=/chosen");
  assert.equal(binding.DBUS_SESSION_BUS_ADDRESS, undefined);
});

test("gh executable discovery ignores relative PATH entries and does not execute files", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codey-gh-discovery-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(path.join(temp, "bin"));
  const executable = path.join(temp, "bin/gh");
  await writeFile(executable, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  assert.equal(await findGh({ PATH: ".:relative:" + path.dirname(executable) }), executable);
  await mkdir(path.join(temp, "launchers"));
  const launcher = path.join(temp, "launchers/gh");
  await symlink(executable, launcher);
  assert.equal(await findGh({ PATH: path.dirname(launcher) }), launcher, "keep stable Homebrew/snap launchers, not versioned/multicall targets");
  await chmod(executable, 0o600);
  assert.equal(await findGh({ PATH: path.dirname(executable) }), null);
});

test("authentication HTTP requests are bounded, do not follow redirects and never echo upstream bodies", async () => {
  const success = await authJson("https://api.github.com/user", {}, { fetch: async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ id: 42 });
  } });
  assert.deepEqual(success, { status: 200, value: { id: 42 } });
  assert.deepEqual(await authJson("https://api.github.com/user", {}, {
    fetch: async () => new Response(token, { status: 403 }),
  }), { status: 403, value: null });
  for (const response of [new Response(token), Response.json([]), new Response("x".repeat(2 * 1024 * 1024 + 1))]) {
    await assert.rejects(authJson("https://api.github.com/user", {}, { fetch: async () => response }),
      error => error.message.includes("invalid response") && !error.message.includes(token));
  }
  await assert.rejects(authJson("https://api.github.com/user", {}, { fetch: async () => { throw new Error(token); } }),
    error => !error.message.includes(token));
});

test("Copilot permission check requires matching account and real model catalog, never v2 token exchange", async () => {
  const credential = { binding, token }, calls = [];
  const request = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    return { status: 200, value: url.endsWith("/models") ? { data: [{ id: "fixture-model" }] } : { login: binding.login } };
  };
  await verifyGhCopilot(credential, { request });
  assert.deepEqual(calls, ["https://api.github.com/copilot_internal/user", "https://api.githubcopilot.com/models"]);
  await assert.rejects(verifyGhCopilot(credential, { request: async () => ({ status: 403 }) }), /cannot access Copilot/);
  await assert.rejects(verifyGhCopilot(credential, { request: async () => ({ status: 200, value: { login: "wrong" } }) }), /cannot access Copilot/);
  await assert.rejects(verifyGhCopilot(credential, { request: async url => ({
    status: 200, value: url.endsWith("/models") ? { data: [] } : { login: binding.login },
  }) }), /model access failed/);
});
