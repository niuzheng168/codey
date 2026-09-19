import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commandPlan } from "../packages/codey/lib/cli.mjs";
import { GH_BINDING_FILE, copilotAuthSettings, prepareCopilotAuth } from "../packages/codey/lib/copilot-auth.mjs";
import { validateGhBinding } from "../skills/config-new-codey-machine/scripts/github-auth.mjs";

const secret = "fixture_only_gh_secret";
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codey-gh-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const api = path.join(home, "api");
  const binding = { schema: 1, source: "gh", host: "github.com", id: 42, login: "fixture_user",
    executable: path.join(home, "bin/gh"), configDir: path.join(home, ".config/gh") };
  const f = { home, api, binding, log: [], calls: [], available: true,
    environment: { HOME: home, COPILOT_API_HOME: api } };
  f.github = {
    validateGhBinding,
    async readGhCredential(options) {
      f.calls.push({ operation: "gh", options });
      return f.available ? { binding: options.binding ?? f.binding, token: secret } : null;
    },
    async verifyGhCopilot() { f.calls.push({ operation: "models" }); if (f.denied) throw new Error("Copilot access denied"); },
    async authJson() { f.calls.push({ operation: "saved" }); return f.savedRejected ? { status: 401 } :
      { status: 200, value: { login: "existing_different_user" } }; },
  };
  f.prepare = (args = ["start"], options = {}) => prepareCopilotAuth(home, args, {
    environment: f.environment, github: f.github, log: message => f.log.push(message), ...options,
  });
  f.save = async (file, bytes) => {
    await mkdir(api, { recursive: true, mode: 0o700 });
    await writeFile(path.join(api, file), bytes, { mode: 0o600 });
  };
  return f;
}

test("copilot start automatically pins gh, enables direct OAuth and never writes the token", async t => {
  const f = await fixture(t);
  const result = await f.prepare();
  assert.equal(result.handled, false);
  assert.equal(result.source, "gh");
  assert.equal(result.environment.COPILOT_API_AUTH_MODE, "direct");
  assert.equal(result.environment.COPILOT_API_GITHUB_TOKEN, secret);
  const text = await readFile(path.join(f.api, GH_BINDING_FILE), "utf8");
  assert.deepEqual(JSON.parse(text), f.binding);
  assert.ok(!text.includes(secret));
  assert.ok(!f.log.join("\n").includes(secret));
  assert.equal((await lstat(path.join(f.api, GH_BINDING_FILE))).mode & 0o777, 0o600);
  await assert.rejects(lstat(path.join(f.api, "github_token")), { code: "ENOENT" });
  assert.deepEqual(f.calls.map(call => call.operation), ["gh", "models"]);
});

test("copilot login with gh is handled without importing OAuth, and later active-account changes do not switch it", async t => {
  const f = await fixture(t);
  assert.equal((await f.prepare(["auth", "login", "--provider", "copilot"])).handled, true);
  const first = structuredClone(f.binding);
  f.binding = { ...f.binding, id: 99, login: "different_active_user" };
  f.calls.length = 0;
  const again = await f.prepare();
  assert.deepEqual(f.calls[0].options.binding, first);
  assert.equal(again.environment.COPILOT_API_GITHUB_TOKEN, secret);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.api, GH_BINDING_FILE))), first);
});

test("existing saved/environment credentials take precedence without reading gh or switching accounts", async t => {
  const f = await fixture(t);
  await f.save("github_token", "fixture-existing-copilot");
  assert.equal((await f.prepare()).source, "saved");
  assert.deepEqual(f.calls, []);
  assert.equal((await f.prepare(["auth", "login"])).handled, true);
  assert.deepEqual(f.calls.map(call => call.operation), ["saved"]);
  assert.equal(await readFile(path.join(f.api, "github_token"), "utf8"), "fixture-existing-copilot");
  f.environment.COPILOT_API_GITHUB_TOKEN = "explicit-provider";
  assert.equal((await f.prepare()).source, "environment");
  await assert.rejects(lstat(path.join(f.api, GH_BINDING_FILE)), { code: "ENOENT" });
  f.savedRejected = true;
  await assert.rejects(f.prepare(["auth", "login"]), /no account was switched/);
  assert.ok(!f.calls.some(call => call.operation === "gh"));
});

test("force opts into device login; provider-specific and Enterprise choices bypass gh fallback", async t => {
  const f = await fixture(t);
  f.environment.COPILOT_API_AUTH_MODE = "direct";
  const forced = await f.prepare(["auth", "login"], { force: true });
  assert.equal(forced.handled, false);
  assert.equal(forced.environment.COPILOT_API_AUTH_MODE, "");
  for (const args of [["auth", "--oauth-app", "opencode"], ["start", "--enterprise-url", "enterprise.invalid"]]) {
    assert.equal((await f.prepare(args)).handled, false);
  }
  assert.deepEqual(f.calls, []);
  const plan = commandPlan(["copilot", "login", "--force"]);
  assert.equal(plan.force, true);
  assert.deepEqual(plan.args, ["auth", "login", "--provider", "copilot"]);
  assert.equal(commandPlan(["copilot", "login", "--no-force"]).force, undefined);
  assert.equal(commandPlan(["copilot", "login", "--force=false"]).force, undefined);
  assert.throws(() => commandPlan(["copilot", "start", "--force"]));
});

test("missing gh falls back without side effects but a pinned unavailable account cannot fall back", async t => {
  const f = await fixture(t);
  f.available = false;
  assert.equal((await f.prepare()).handled, false);
  assert.equal((await f.prepare(["auth", "login"])).handled, false);
  await assert.rejects(lstat(f.api), { code: "ENOENT" });
  await f.save(GH_BINDING_FILE, JSON.stringify(f.binding));
  await assert.rejects(f.prepare(["auth", "login"]), /pinned GitHub CLI account is unavailable/);
});

test("permission denial is not mistaken for a need to launch device login or persist a gh binding", async t => {
  const f = await fixture(t);
  f.denied = true;
  await assert.rejects(f.prepare(["auth", "login"]), /Copilot access denied/);
  await assert.rejects(lstat(path.join(f.api, GH_BINDING_FILE)), { code: "ENOENT" });
});

test("malformed, linked or public binding files fail without leaking saved content", async t => {
  const f = await fixture(t);
  await f.save(GH_BINDING_FILE, "{ " + secret);
  await assert.rejects(f.prepare(), error => /Invalid saved/.test(error.message) && !error.message.includes(secret));
  await chmod(path.join(f.api, GH_BINDING_FILE), 0o644);
  await assert.rejects(f.prepare(), /owner-private/);
  await rm(path.join(f.api, GH_BINDING_FILE));
  const elsewhere = path.join(f.home, "elsewhere.json");
  await writeFile(elsewhere, JSON.stringify(f.binding), { mode: 0o600 });
  await symlink(elsewhere, path.join(f.api, GH_BINDING_FILE));
  await assert.rejects(f.prepare(), /regular file/);
  assert.equal(await readFile(elsewhere, "utf8"), JSON.stringify(f.binding));
});

test("an empty legacy token file does not suppress gh fallback and connection flags match gateway path selection", async t => {
  const f = await fixture(t);
  await f.save("github_token", " \n");
  assert.equal((await f.prepare()).source, "gh");
  assert.deepEqual(copilotAuthSettings("/package", ["start", "--api-home", "relative", "--oauth-app", "opencode"], {
    COPILOT_API_HOME: "/ignored", COPILOT_API_ENTERPRISE_URL: "enterprise.invalid",
  }), { home: "/package/relative", app: "opencode", enterprise: "enterprise.invalid" });
});

test("simultaneous starts atomically pin one account and cannot overwrite it with another", async t => {
  for (const different of [false, true]) {
    const f = await fixture(t);
    let count = 0, unblock;
    const ready = new Promise(resolve => { unblock = resolve; });
    f.github.readGhCredential = async () => {
      const index = count++;
      return { token: secret, binding: different && index ? { ...f.binding, id: 99, login: "another_account" } : f.binding };
    };
    let verified = 0;
    f.github.verifyGhCopilot = async () => { if (++verified === 2) unblock(); await ready; };
    const results = await Promise.allSettled([f.prepare(), f.prepare()]);
    assert.equal(results.filter(item => item.status === "fulfilled").length, different ? 1 : 2);
    if (different) assert.match(results.find(item => item.status === "rejected").reason.message, /changed concurrently/);
    const saved = JSON.parse(await readFile(path.join(f.api, GH_BINDING_FILE), "utf8"));
    assert.ok([42, 99].includes(saved.id));
    assert.deepEqual(await readdir(f.api), [GH_BINDING_FILE], "no partial binding or temporary file remains");
  }
});
