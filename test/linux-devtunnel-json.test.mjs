import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseTunnelJson, tokenFor } from "../skills/config-new-codey-machine/scripts/windows-runtime.mjs";

const run = promisify(execFile);
const banner = "Welcome to dev tunnels!\nCLI version: fixture\n\nLicense terms and help\n\n";
test("all platforms parse plain/banner-prefixed DevTunnel JSON without a shell parser", () => {
  const value = { token: "fixture-connect-token", tunnel: { ports: [3001, 8443] } };
  for (const prefix of ["", " \n", "\uFEFF", banner, "\uFEFF" + banner, "Warning: {not JSON}\n"]) {
    assert.deepEqual(parseTunnelJson(prefix + JSON.stringify(value)), value);
  }
});
test("DevTunnel JSON failures never echo credential output", () => {
  for (const text of ["", banner, "null", "[]", '"scalar"', banner + '{"token":"do-not-log-this",}',
    banner + '{"token":"do-not-log-this"}\nUnexpected trailer', '{"token":"do-not-log-this"}\n{}']) {
    assert.throws(() => parseTunnelJson(text), error => error.message === "DevTunnel did not return a valid JSON object");
  }
});

test("Linux renewal uses the shared runtime, validates banner-prefixed tokens, and rejects a failed CLI before any Portal request", {
  skip: process.platform !== "linux",
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-tunnel-renew-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tunnel = path.join(root, "devtunnel"), identity = path.join(root, "identity.json"), captured = path.join(root, "request.json");
  const coordinates = { tunnelId: "codey-n-" + "a".repeat(24), clusterId: "usw2" };
  const token = `e30.${Buffer.from(JSON.stringify({ ...coordinates, scp: "connect", exp: Math.floor(Date.now() / 1000) + 72000 })).toString("base64url")}.c2ln`;
  await writeFile(identity, JSON.stringify({ nodeId: "n-" + "a".repeat(24), tunnelUpdateKey: Buffer.alloc(32, 1).toString("base64url") }));
  await writeFile(path.join(root, "tunnel.json"), JSON.stringify({ ...coordinates,
    ports: [3001, 8443].map(portNumber => ({ portNumber, protocol: "https" })) }));
  await writeFile(tunnel, `#!/bin/sh\nprintf '%s\\n' 'Welcome to dev tunnels!' '{"token":"${token}"}'\nexit "\${CODEY_TEST_CLI_EXIT:-0}"\n`);
  await chmod(tunnel, 0o700);
  const config = { schema: 2, kind: "codey-linux-oneclick", layout: "npm-codey-package", platform: "linux-x64",
    portalOrigin: "https://portal.invalid", identityFile: identity, tunnelFile: path.join(root, "tunnel.json"), devtunnelExe: tunnel };
  const configFile = path.join(root, "runtime.json");
  await writeFile(configFile, JSON.stringify(config));
  await assert.rejects(tokenFor({ ...config, baseEnvironment: { ...process.env, CODEY_TEST_CLI_EXIT: "7" } }, coordinates), { code: 7 });
  const preload = path.join(root, "https-fixture.cjs");
  await writeFile(preload, `
const fs = require("node:fs"), {EventEmitter} = require("node:events");
require("node:https").request = (options, callback) => {
  const req = new EventEmitter(); req.setTimeout = () => req;
  req.end = body => {
    fs.writeFileSync(process.env.CODEY_TEST_CAPTURE, JSON.stringify({options, body}));
    const response = new EventEmitter(); response.statusCode = 200;
    callback(response); process.nextTick(() => response.emit("end"));
  }; return req;
};
`);
  const helper = fileURLToPath(new URL("../skills/config-new-codey-machine/scripts/windows-runtime.mjs", import.meta.url));
  const env = { ...process.env, NODE_OPTIONS: `--require=${preload}`, CODEY_TEST_CAPTURE: captured };
  await run(process.execPath, [helper, "renew", configFile], { env });
  const request = JSON.parse(await readFile(captured));
  assert.equal(request.options.path, `/api/machine-tunnels/n-${"a".repeat(24)}/token`);
  assert.deepEqual(JSON.parse(request.body), { ...coordinates, connectToken: token });
  assert.match(request.options.headers.authorization, /^CodeyTunnel /);
  await rm(captured);
  await assert.rejects(run(process.execPath, [helper, "renew", configFile], { env: { ...env, CODEY_TEST_CLI_EXIT: "7" } }), error => {
    assert.ok(!error.stderr.includes(token));
    return true;
  });
  await assert.rejects(readFile(captured), { code: "ENOENT" });
});
