import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const installer = await readFile(
  new URL("../skills/config-new-codey-machine/scripts/install.sh", import.meta.url), "utf8",
);
const helpers = installer.slice(0, installer.indexOf('[[ "$(uname -s)"'));
const supported = { skip: process.platform === "win32" };
const banner = "Welcome to dev tunnels!\nCLI version: fixture\n\nLicense terms and help\n\n";

function parse(output, exitCode = 0) {
  return run("bash", ["-c", `${helpers}
emit() { printf '%s' "$1"; return "$2"; }
emit "$1" "$2" | parse_devtunnel_json "$3"
`, "fixture", output, String(exitCode), process.execPath]);
}

test("Linux DevTunnel JSON parsing accepts plain and banner-prefixed objects", supported, async t => {
  const value = { token: "fixture-connect-token", tunnel: { ports: [3001, 8443] } };
  for (const prefix of ["", " \n", "\uFEFF", banner, "\uFEFF" + banner, "Warning: {not JSON}\n"]) {
    await t.test(JSON.stringify(prefix), async () => {
      const result = await parse(prefix + JSON.stringify(value, null, 2) + "\n");
      assert.deepEqual(JSON.parse(result.stdout), value);
      assert.equal(result.stderr, "");
    });
  }
});

test("Linux DevTunnel JSON failures are closed and never echo credential output", supported, async t => {
  for (const output of [
    "", banner, "null", "[]", '"scalar"', banner + '{"token":"do-not-log-this",}',
    banner + '{"token":"do-not-log-this"}\nUnexpected trailer',
    '{"token":"do-not-log-this"}\n{}',
  ]) {
    await t.test(JSON.stringify(output), async () => {
      await assert.rejects(parse(output), error => {
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /DevTunnel did not return a valid JSON object/);
        assert.ok(!error.stderr.includes("do-not-log-this"));
        return true;
      });
    });
  }
});

test("a failed DevTunnel command cannot succeed just because its output contains JSON", supported, async () => {
  await assert.rejects(parse(banner + '{"token":"fixture"}', 7), { code: 7 });
});

test("generated Linux renewal is self-contained and filters the CLI banner before signing", supported, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-tunnel-renew-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tunnel = path.join(root, "devtunnel");
  const identity = path.join(root, "identity.json");
  const captured = path.join(root, "request.json");
  const preload = path.join(root, "https-fixture.cjs");
  const nodeId = "n-" + "a".repeat(24);
  const tunnelId = `codey-${nodeId}`;
  await writeFile(identity, JSON.stringify({
    nodeId, tunnelUpdateKey: Buffer.alloc(32, 1).toString("base64url"),
  }));
  await writeFile(path.join(root, "tunnel.json"), JSON.stringify({
    tunnel: { tunnelId: `${tunnelId}.usw2` },
  }));
  await writeFile(tunnel, `#!/bin/sh
printf '%s\\n' 'Welcome to dev tunnels!' '{"token":"fixture-connect-token"}'
exit "\${CODEY_TEST_CLI_EXIT:-0}"
`);
  await chmod(tunnel, 0o700);
  // Never contact a real Portal. Capture the generated script's signed request.
  await writeFile(preload, `
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
require("node:https").request = (url, options, callback) => {
  const request = new EventEmitter();
  request.end = body => {
    fs.writeFileSync(process.env.CODEY_TEST_CAPTURE, JSON.stringify({url, options, body}));
    const response = new EventEmitter();
    response.statusCode = 200;
    response.resume = () => {};
    callback(response);
    process.nextTick(() => response.emit("end"));
  };
  return request;
};
`);
  const start = installer.indexOf('RENEW_SCRIPT="$RUNTIME_ROOT/renew-devtunnel.sh"');
  const endMarker = 'chmod 700 "$RENEW_SCRIPT"';
  const end = installer.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  await run("bash", ["-c", `${helpers}\n${installer.slice(start, end + endMarker.length)}`], {
    env: {
      ...process.env, RUNTIME_ROOT: root, CONFIG_ROOT: root,
      IDENTITY: identity, NODE: process.execPath, DEVTUNNEL: tunnel,
      QUALIFIED_TUNNEL: `${tunnelId}.usw2`, PORTAL_ORIGIN: "https://portal.invalid",
    },
  });
  const script = path.join(root, "renew-devtunnel.sh");
  await run("bash", ["-n", script]);
  const env = {
    ...process.env, NODE_OPTIONS: `--require=${preload}`, CODEY_TEST_CAPTURE: captured,
  };
  await run("bash", [script], { env });
  const request = JSON.parse(await readFile(captured, "utf8"));
  assert.equal(request.url, `https://portal.invalid/api/machine-tunnels/${nodeId}/token`);
  assert.deepEqual(JSON.parse(request.body), {
    tunnelId, clusterId: "usw2", connectToken: "fixture-connect-token",
  });
  assert.match(request.options.headers.authorization, /^CodeyTunnel /);
  // Preserve the stable entrypoint contract used by codey update devtunnel.
  assert.ok((await readFile(script, "utf8")).includes(
    `"${tunnel}" token "${tunnelId}.usw2" --scope connect --json`,
  ));
  await rm(captured);
  await assert.rejects(run("bash", [script], {
    env: { ...env, CODEY_TEST_CLI_EXIT: "7" },
  }), { code: 7 });
  await assert.rejects(readFile(captured), { code: "ENOENT" });
});
