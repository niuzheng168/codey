import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  const step = installer.indexOf('log 2 "');
  const workspaceStop = installer.indexOf("stop_cloudcli_processes", step);
  const codexStop = installer.indexOf("stop_codex_processes", step);
  const keyRotation = installer.indexOf('MODEL_KEY="$(openssl rand');
  assert.ok(step >= 0 && step < workspaceStop && workspaceStop < codexStop && codexStop < keyRotation);
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

test("Linux installer stops both legacy and unified Codey workspace entrypoints", {
  skip: process.platform === "win32",
}, async () => {
  const { stdout } = await run("bash", ["-c", `${functions}
stop_user_unit() { printf 'user %s\\n' "$1"; }
stop_system_unit() { printf 'system %s\\n' "$1"; }
kill_matches() { printf 'kill %s\\n' "$1"; }
stop_cloudcli_processes
`]);
  assert.deepEqual(stdout.trim().split("\n"), [
    "user codey-cloudcli.service",
    "system codey-cloudcli.service",
    "user cloudcli.service",
    "system cloudcli.service",
    "kill [d]ist-server/server/index.js",
    String.raw`kill [/]bin/codey\.mjs workspace`,
  ]);
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

test("writing the stable Codey launcher replaces npm's bin symlink without corrupting its JavaScript target", {
  skip: process.platform === "win32",
}, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codey-npm-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = path.join(home, ".local/bin");
  await mkdir(bin, { recursive: true });
  const target = path.join(home, "original-codey.mjs");
  await writeFile(target, "// npm-managed JavaScript must remain intact\n");
  await symlink(target, path.join(bin, "codey"));
  await run("bash", ["-c", `${functions}\nwrite_codey_cli "$1" "$2" "$3"`, "fixture", home, process.execPath, "/example/codey"]);
  assert.equal(await readFile(target, "utf8"), "// npm-managed JavaScript must remain intact\n");
  assert.equal((await lstat(path.join(bin, "codey"))).isSymbolicLink(), false);
  assert.match(await readFile(path.join(bin, "codey"), "utf8"), /\/example\/codey\/bin\/codey\.mjs/);
});

async function cliPathFixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codey-shell-path-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = path.join(home, ".local/bin");
  const pkg = path.join(home, "package");
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(pkg, "bin"), { recursive: true });
  await writeFile(path.join(pkg, "bin/codey.mjs"), 'console.log("codey path-fixture");\n');
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  const expected = `${bin}/codey\ncodey path-fixture\n`;
  const install = () => run("/bin/bash", ["--noprofile", "--norc", "-c", `${functions}
write_codey_cli "$HOME" "$1" "$2"
command -v codey
codey --version
`, "fixture", process.execPath, pkg], { env });
  return { home, bin, env, expected, install };
}

test("the installed Codey CLI is on PATH in the installer and new interactive/login Bash shells", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await cliPathFixture(t);
  assert.equal((await f.install()).stdout, f.expected);
  for (const args of [["--noprofile", "-ic"], ["--login", "-c"]]) {
    const result = await run("/bin/bash", [...args, "command -v codey && codey --version"], { env: f.env });
    // A distribution's system bashrc may print a first-login banner.
    assert.ok(result.stdout.endsWith(f.expected), result.stdout);
  }
  for (const name of [".bash_profile", ".bash_login"]) {
    await assert.rejects(lstat(path.join(f.home, name)), { code: "ENOENT" });
  }
});

test("Codey PATH setup preserves dotfile symlinks/settings and is idempotent for installation and shell loading", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await cliPathFixture(t);
  const profile = path.join(f.home, ".profile");
  const bashrc = path.join(f.home, ".bashrc");
  const target = path.join(f.home, "bashrc-dotfile");
  const original = 'export CODEY_TEST_SETTING="keep this user setting"'; // No final newline.
  await writeFile(profile, original, { mode: 0o640 });
  await writeFile(target, original, { mode: 0o640 });
  await symlink(target, bashrc);
  await f.install();
  const before = await Promise.all([profile, bashrc].map(file => readFile(file, "utf8")));
  assert.ok(before.every(text => text.startsWith(original + "\n")));
  await f.install();
  assert.deepEqual(await Promise.all([profile, bashrc].map(file => readFile(file, "utf8"))), before);
  assert.equal((await lstat(bashrc)).isSymbolicLink(), true);
  assert.equal((await lstat(target)).mode & 0o777, 0o640);
  for (const existing of [
    "/usr/bin:/bin", `${f.bin}:/bin`, `/bin:${f.bin}:/usr/bin`, `/bin:${f.bin}`,
    `${f.bin}-other:/usr/bin:/bin`, "",
  ]) {
    const expected = existing.split(":").includes(f.bin)
      ? existing : f.bin + (existing ? `:${existing}` : "");
    const { stdout } = await run("/bin/sh", ["-uc", `
PATH="$1"
. "$HOME/.profile"
. "$HOME/.bashrc"
. "$HOME/.profile"
printf '%s\\n' "$PATH" "$CODEY_TEST_SETTING"
codey --version
`, "fixture", existing], { env: f.env });
    assert.equal(stdout, `${expected}\nkeep this user setting\ncodey path-fixture\n`);
  }
  const { stdout } = await run("/bin/sh", ["-uc", `
unset PATH
. "$HOME/.profile"
printf '%s\\n' "$PATH"
codey --version
`], { env: f.env });
  assert.equal(stdout, `${f.bin}\ncodey path-fixture\n`);
});

test("Codey PATH setup also updates existing Bash login overrides without replacing their settings", {
  skip: process.platform !== "linux",
}, async t => {
  for (const names of [[".bash_profile"], [".bash_login"], [".bash_profile", ".bash_login"]]) {
    await t.test(names.join(" and "), async t => {
      const f = await cliPathFixture(t);
      for (const name of names) {
        await writeFile(path.join(f.home, name),
          `export CODEY_TEST_LOGIN=${name}\nexport PATH=/usr/bin:/bin\n`);
      }
      await f.install();
      await f.install();
      const { stdout } = await run("/bin/bash", ["--login", "-c", `
printf '%s\\n' "$CODEY_TEST_LOGIN"
command -v codey
codey --version
`], { env: f.env });
      assert.equal(stdout, `${names[0]}\n${f.expected}`);
      for (const name of names) {
        const { stdout: loaded } = await run("/bin/bash", ["--noprofile", "--norc", "-c", `
. "$HOME/$1"
printf '%s\\n' "$CODEY_TEST_LOGIN"
command -v codey
codey --version
`, "fixture", name], { env: f.env });
        assert.equal(loaded, `${name}\n${f.expected}`);
      }
    });
  }
});
