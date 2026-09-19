import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  ensureGhTunnel, getGhTunnel, hostGhTunnel, issueGhTunnelToken, listGhTunnels, scopedTunnelToken, tunnelCoordinates,
} from "../skills/config-new-codey-machine/scripts/github-tunnel.mjs";
import { loginTunnel, tokenFor } from "../skills/config-new-codey-machine/scripts/windows-runtime.mjs";

const target = { tunnelId: "codey-n-" + "a".repeat(24), clusterId: "jpe1" };
const qualified = `${target.tunnelId}.${target.clusterId}`;
const binding = { schema: 1, source: "gh", host: "github.com", id: 42, login: "fixture_user",
  executable: "/fixture/bin/gh", configDir: "/fixture/.config/gh" };
const credential = { token: "fixture-only-github-secret", binding };
const now = 1800000000000;
const jwt = (changes = {}) => ["e30", Buffer.from(JSON.stringify({
  ...target, scp: "host", exp: now / 1000 + 7200, ...changes,
})).toString("base64url"), "c2ln"].join(".");
const tunnel = changes => ({ ...target, ports: [3001, 8443].map(portNumber => ({ portNumber, protocol: "https" })),
  accessControl: { entries: [] }, ...changes });
const config = () => ({ tunnelAuth: binding, qualifiedTunnel: qualified, devtunnelExe: "/fixture/devtunnel",
  baseEnvironment: { HOME: "/fixture", GH_TOKEN: credential.token, COPILOT_API_GITHUB_TOKEN: credential.token } });

function responses(values) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.authorization, `github ${credential.token}`);
    assert.ok(!url.includes(credential.token));
    assert.ok(values.length, "Unexpected network request");
    return values.shift();
  };
  return { request, calls };
}

test("DevTunnel login preserves native GitHub/other-provider choices before trying gh", async () => {
  let interactive = 0;
  const execute = async (_file, args, options) => {
    if (args[1] === "login") { interactive++; assert.equal(options.interactive, true); }
    return { code: 0, stdout: JSON.stringify({ status: "Logged in", provider: "github" }) };
  };
  const result = await loginTunnel("/devtunnel", {}, execute, { github: async () => assert.fail("existing login wins") });
  assert.equal(result.existing, true);
  assert.equal(interactive, 0);
  await assert.rejects(loginTunnel("/devtunnel", {}, async () => ({
    code: 0, stdout: JSON.stringify({ status: "Logged in", provider: "microsoft", token: credential.token }),
  }), { github: async () => assert.fail("do not switch provider") }), error => /another provider/.test(error.message) &&
    !error.message.includes(credential.token));
});

test("missing native login uses verified gh without device code; pinned gh does not inspect another native account", async () => {
  const calls = [];
  const result = await loginTunnel("/devtunnel", {}, async (_file, args) => {
    calls.push(args);
    return { code: 0, stdout: '{"status":"Not logged in"}' };
  }, { github: async () => credential, verify: async value => assert.equal(value, credential) });
  assert.equal(result.source, "gh");
  assert.equal(result.credential, credential);
  assert.deepEqual(calls, [["user", "show", "--json"]]);
  assert.ok(!JSON.stringify(result).includes(credential.token));
  const pinned = await loginTunnel("/devtunnel", {}, async () => assert.fail("no native cache access"), {
    binding, github: async options => { assert.equal(options.binding, binding); return credential; }, verify: async () => {},
  });
  assert.equal(pinned.source, "gh");
});

test("new Mac gh preference avoids native Keychain reads and never falls through on a rejected gh account", async () => {
  const execute = async () => assert.fail("Do not open the native Keychain when gh is available");
  const result = await loginTunnel("/devtunnel", {}, execute, {
    preferGh: true, github: async () => credential, verify: async value => assert.equal(value, credential),
  });
  assert.equal(result.source, "gh");
  assert.ok(!JSON.stringify(result).includes(credential.token));
  await assert.rejects(loginTunnel("/devtunnel", {}, execute, {
    preferGh: true, github: async () => credential, verify: async () => { throw new Error("HTTP 403"); },
  }), /403/);
  let discoveries = 0;
  const fallback = await loginTunnel("/devtunnel", {}, async () => ({
    code: 0, stdout: '{"status":"Logged in","provider":"github"}',
  }), { preferGh: true, github: async () => { discoveries++; return null; } });
  assert.equal(fallback.existing, true);
  assert.equal(discoveries, 1);
});

test("device login remains an explicit fallback; service starts never prompt and gh failures do not fall through", async () => {
  let loggedIn = false, logins = 0;
  const execute = async (_file, args) => {
    if (args[1] === "login") { logins++; loggedIn = true; }
    return { code: 0, stdout: JSON.stringify({ status: loggedIn ? "Logged in" : "Not logged in", provider: "github" }) };
  };
  await assert.rejects(loginTunnel("/devtunnel", {}, execute, { github: async () => null, interactive: false }), /run codey devtunnel login/);
  assert.equal(logins, 0);
  assert.equal((await loginTunnel("/devtunnel", {}, execute, { github: async () => null })).existing, false);
  assert.equal(logins, 1);
  loggedIn = false;
  await assert.rejects(loginTunnel("/devtunnel", {}, execute, {
    github: async () => credential, verify: async () => { throw new Error("Access denied"); },
  }), /Access denied/);
  assert.equal(logins, 1);
  await assert.rejects(loginTunnel("/devtunnel", {}, execute, {
    binding, github: async () => null, verify: async () => assert.fail(),
  }), /selected GitHub CLI account is unavailable/);
});

test("gh creates only the new private Codey tunnel using conditional PUT and fixed management hosts", async () => {
  const d = responses([
    { status: 200, value: { value: [] } }, { status: 201, value: tunnel() },
    { status: 200, value: tunnel() }, { status: 200, value: tunnel() },
  ]);
  assert.deepEqual(await ensureGhTunnel(credential, target.tunnelId, d), tunnel());
  assert.equal(d.calls[1].options.method, "PUT");
  assert.equal(d.calls[1].options.headers["if-none-match"], "*");
  const body = JSON.parse(d.calls[1].options.body);
  assert.deepEqual(body.ports, tunnel().ports);
  assert.deepEqual(body.accessControl, { entries: [] });
  assert.ok(d.calls[0].url.startsWith("https://global.rel.tunnels.api.visualstudio.com/tunnels?"));
  assert.ok(d.calls.at(-1).url.startsWith(`https://jpe1.rel.tunnels.api.visualstudio.com/tunnels/${target.tunnelId}?`));
  assert.ok(!JSON.stringify(body).includes(credential.token));
});

test("an existing private tunnel receives only missing HTTPS ports, never unrelated port deletion", async () => {
  const d = responses([
    { status: 200, value: { value: [{ value: [target] }] } },
    { status: 200, value: tunnel({ ports: [{ portNumber: 3001, protocol: "https" }] }) },
    { status: 200, value: { portNumber: 8443, protocol: "https" } },
    { status: 200, value: tunnel() },
  ]);
  await ensureGhTunnel(credential, target.tunnelId, d);
  assert.equal(d.calls.filter(call => call.options.method === "PUT").length, 1);
  assert.equal(new URL(d.calls[2].url).pathname, `/tunnels/${target.tunnelId}/ports/8443`);
  for (const changed of [
    { accessControl: { entries: [{ type: "anonymous" }] } },
    { ports: [...tunnel().ports, { portNumber: 4141, protocol: "http" }] },
  ]) {
    const bad = responses([{ status: 200, value: { value: [{ value: [target] }] } }, { status: 200, value: tunnel(changed) }]);
    await assert.rejects(ensureGhTunnel(credential, target.tunnelId, bad));
    assert.ok(bad.calls.every(call => call.options.method === "GET"));
  }
});

test("incomplete lists, ambiguous identities, authentication failures and foreign returned tunnels fail closed", async () => {
  for (const value of [{}, { value: [{ error: "unavailable" }] }, { value: [], nextLink: "elsewhere" }]) {
    await assert.rejects(listGhTunnels(credential, responses([{ status: 200, value }])), /complete tunnel list/);
  }
  await assert.rejects(ensureGhTunnel(credential, target.tunnelId, responses([
    { status: 200, value: { value: [{ value: [target, target] }] } },
  ])), /Ambiguous/);
  await assert.rejects(getGhTunnel(credential, target, responses([{ status: 403, value: { token: credential.token } }])),
    error => /HTTP 403/.test(error.message) && !error.message.includes(credential.token));
  await assert.rejects(getGhTunnel(credential, target, responses([{ status: 200, value: tunnel({ clusterId: "usw2" }) }])), /Unexpected/);
  await assert.rejects(ensureGhTunnel(credential, "../invalid"), /Invalid Codey/);
  assert.throws(() => tunnelCoordinates("host/path.evil"), /Invalid/);
  assert.throws(() => tunnelCoordinates(qualified + ".evil"), /Invalid/);
});

test("tunnel inspection strips unsolicited access tokens from returned JSON", async () => {
  const value = await getGhTunnel(credential, target, responses([{ status: 200, value: tunnel({
    accessTokens: { host: jwt() }, ports: [{ portNumber: 3001, protocol: "https", accessTokens: { connect: jwt() } }],
  }) }]));
  assert.equal(value.accessTokens, undefined);
  assert.ok(!JSON.stringify(value).includes(jwt()));
});

test("host/connect issuance re-reads the pinned gh account, verifies identity/scope/expiry, and never asks for manage", async () => {
  for (const scope of ["host", "connect"]) {
    const token = jwt({ scp: scope }), d = responses([{ status: 200, value: tunnel({ accessTokens: { [scope]: token } }) }]);
    const issue = { ...d, now: () => now, github: async options => { assert.deepEqual(options.binding, binding); return credential; } };
    const result = await issueGhTunnelToken(config(), target, scope, issue);
    assert.equal(result.token, token);
    assert.ok(!JSON.stringify(result).includes(token));
    assert.equal(new URL(d.calls[0].url).searchParams.get("tokenScopes"), scope);
    if (scope === "connect") {
      d.calls.length = 0;
      const renewed = await tokenFor(config(), target, { ...issue,
        request: async () => ({ status: 200, value: tunnel({ accessTokens: { connect: token } }) }),
      });
      assert.equal(renewed, token);
    }
  }
  await assert.rejects(issueGhTunnelToken({}, target, "host"), /not configured/);
  await assert.rejects(issueGhTunnelToken(config(), target, "manage", {
    github: async () => credential,
    request: async () => assert.fail("must not request manage"),
  }), /Unsupported/);
  for (const changes of [{ scp: "connect" }, { scp: "host connect" }, { scp: "manage" },
    { tunnelId: "another" }, { clusterId: "usw2" }, { exp: now / 1000 }, { exp: now / 1000 + 100000 }]) {
    assert.throws(() => scopedTunnelToken(jwt(changes), target, "host", now), /Wrong scope/);
  }
  assert.throws(() => scopedTunnelToken("invalid", target, "host", now), /Invalid scoped/);
});

function hostFixture() {
  const child = new EventEmitter(), signals = new EventEmitter(), timers = [], calls = [];
  child.stdin = new EventEmitter();
  child.stdin.end = value => { calls.push({ input: value }); };
  child.kill = signal => { calls.push({ kill: signal }); return true; };
  const dependencies = {
    issue: async () => scopedTunnelToken(jwt(), target, "host", now),
    spawnProcess: (...args) => { calls.push({ spawn: args }); return child; },
    signals, now: () => now,
    schedule: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
  };
  return { child, signals, timers, calls, dependencies };
}

test("host-only token travels on stdin, not argv/environment; native service rotates five minutes before expiry", async () => {
  const f = hostFixture();
  const result = hostGhTunnel(config(), f.dependencies);
  await new Promise(resolve => setImmediate(resolve));
  const [exe, args, options] = f.calls[0].spawn;
  assert.equal(exe, "/fixture/devtunnel");
  assert.deepEqual(args.slice(-2), ["--access-token", "-"]);
  assert.ok(!args.includes(jwt()));
  assert.equal(options.env.GH_TOKEN, undefined);
  assert.equal(options.env.COPILOT_API_GITHUB_TOKEN, undefined);
  assert.deepEqual(options.stdio, ["pipe", "ignore", "ignore"]);
  assert.equal(f.calls[1].input, jwt() + "\n");
  assert.equal(f.timers[0].ms, 7200000 - 300000);
  f.timers[0].fn();
  assert.deepEqual(f.calls.at(-1), { kill: "SIGTERM" });
  assert.equal(f.timers[1].ms, 10000);
  f.timers[1].fn();
  assert.deepEqual(f.calls.at(-1), { kill: "SIGKILL" });
  f.child.emit("close", 143);
  assert.equal(await result, 0, "existing native service will restart and fetch a new token");
  assert.equal(f.signals.listenerCount("SIGTERM"), 0);
  assert.ok(f.timers.every(timer => timer.cancelled));
});

test("host exits/errors/signals are bounded and sanitized, and failed authentication never launches a process", async () => {
  for (const scenario of ["exit", "error", "signal"]) {
    const f = hostFixture(), result = hostGhTunnel(config(), f.dependencies);
    await new Promise(resolve => setImmediate(resolve));
    if (scenario === "error") {
      const assertion = assert.rejects(result, error => /could not start/.test(error.message) && !error.message.includes(jwt()));
      f.child.emit("error", new Error(jwt()));
      await assertion;
    } else {
      if (scenario === "signal") f.signals.emit("SIGTERM");
      f.child.emit("close", 2);
      assert.equal(await result, scenario === "signal" ? 0 : 2);
    }
    assert.equal(f.signals.listenerCount("SIGINT"), 0);
    assert.ok(f.timers.every(timer => timer.cancelled));
  }
  await assert.rejects(hostGhTunnel(config(), {
    issue: async () => { throw new Error("gh unavailable"); }, spawnProcess: () => assert.fail(),
  }), /gh unavailable/);
});
