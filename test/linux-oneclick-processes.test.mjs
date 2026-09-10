import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const installer = await readFile(
  new URL("../skills/config-new-codey-machine/scripts/install.sh", import.meta.url),
  "utf8",
);
const functions = installer.slice(0, installer.indexOf('[[ "$(uname -s)"'));

async function executable(file, body) {
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o700);
}

test("Linux installer stops the workspace and every owner Codex process before rotating the key", async (t) => {
  assert.ok(installer.indexOf("stop_cloudcli_processes", installer.indexOf('log 2 "')) <
    installer.indexOf('MODEL_KEY="$(openssl rand'));
  assert.ok(installer.indexOf("stop_codex_processes", installer.indexOf('log 2 "')) <
    installer.indexOf('MODEL_KEY="$(openssl rand'));
  if (process.platform === "win32") return;

  const root = await mkdtemp(path.join(os.tmpdir(), "codey-codex-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const log = path.join(root, "calls.log");
  const state = path.join(root, "state");
  await mkdir(bin);
  await writeFile(state, "running");
  await executable(path.join(bin, "id"), 'printf "%s\\n" 1000');
  await executable(path.join(bin, "sleep"), "exit 0");
  await executable(path.join(bin, "pgrep"), `[ "$(cat "$CODEY_TEST_STATE")" = running ]`);
  await executable(path.join(bin, "pkill"), `
printf 'pkill %s\\n' "$*" >>"$CODEY_TEST_LOG"
[ "$1" = -KILL ] && printf stopped >"$CODEY_TEST_STATE"
exit 0`);

  await run("bash", ["-c", `${functions}\nstop_codex_processes`], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      CODEY_TEST_LOG: log,
      CODEY_TEST_STATE: state,
    },
  });
  const calls = await readFile(log, "utf8");
  assert.match(calls, /pkill -TERM -u 1000 -x codex/);
  assert.match(calls, /pkill -TERM -u 1000 -f/);
  assert.match(calls, /pkill -KILL -u 1000 -x codex/);
  assert.match(calls, /pkill -KILL -u 1000 -f/);
});

test("updater Python probing prefers system Python and cannot hang forever", () => {
  const start = installer.indexOf('PYTHON=""');
  const end = installer.indexOf('[[ -n "$PYTHON" ]]', start);
  const probe = installer.slice(start, end);
  assert.ok(probe.indexOf("/usr/bin/python3.13") < probe.indexOf("/opt/az/bin/python3"));
  assert.match(probe, /timeout --kill-after=2s 10s "\$candidate"/);
});

test("Codex validation closes stdin and has a hard timeout", () => {
  assert.match(
    installer,
    /timeout --kill-after=5s 300s "\$CODEX" exec[\s\S]*?CODEY_CODEX_OK" <\/dev\/null/,
  );
});
