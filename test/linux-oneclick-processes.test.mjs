import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { treeFiles } from "./codey-update-fixture.mjs";

const run = promisify(execFile);
const installer = await readFile(
  new URL("../skills/config-new-codey-machine/scripts/install.sh", import.meta.url),
  "utf8",
);
const functions = installer.slice(0, installer.indexOf('[[ "$(uname -s)"'));
const helper = await readFile(new URL("../skills/config-new-codey-machine/scripts/linux-preflight.sh", import.meta.url), "utf8");
const skill = fileURLToPath(new URL("../skills/config-new-codey-machine", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function executable(file, body) {
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o700);
}

async function preflightFixture(t, { installed = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-linux-preflight-"));
  const home = path.join(root, "home"), bin = path.join(root, "stubs");
  const pkg = path.join(home, ".local/share/codey-machine/releases/fixture/lib/node_modules/codey");
  const units = path.join(home, ".config/systemd/user");
  const listeners = path.join(root, "listeners"), calls = path.join(root, "calls");
  await mkdir(home, { mode: 0o700 });
  await mkdir(bin);
  await writeFile(listeners, "");
  await writeFile(calls, "");
  const env = { ...process.env, HOME: home, SUDO_USER: "", PATH: `${bin}:/usr/bin:/bin`,
    CODEY_TEST_LISTENERS: listeners, CODEY_TEST_CALLS: calls };
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
    }));
    await rm(root, { recursive: true, force: true });
  });
  await executable(path.join(bin, "ss"), 'cat "$CODEY_TEST_LISTENERS"');
  await executable(path.join(bin, "getent"), 'printf "fixture:x:%s:1000:fixture:%s:/bin/bash\\n" "$(id -u)" "$HOME"');
  await executable(path.join(bin, "systemctl"), `
printf 'systemctl %s\\n' "$*" >>"$CODEY_TEST_CALLS"
[ "$2" = is-enabled ] && { echo enabled; exit 0; }
[ "$2" = is-active ] && { echo active; exit 0; }
[ "$2" = show ] || exit 88
case "$5" in
 FragmentPath) printf '%s/.config/systemd/user/%s\\n' "$HOME" "$3";;
 DropInPaths) printf '%s' "\${CODEY_TEST_DROP_IN:-}";;
 MainPID) if [ "$3" = codey-cloudcli.service ]; then echo "$CODEY_TEST_WORKSPACE_PID"; else echo "$CODEY_TEST_GATEWAY_PID"; fi;;
 *) exit 88;;
esac`);
  await executable(path.join(bin, "loginctl"), 'echo yes');
  for (const name of ["sudo", "pkill", "fuser", "curl"]) await executable(path.join(bin, name), 'echo forbidden-operation >&2; exit 88');
  await executable(path.join(bin, "pgrep"), 'exit 1');
  if (installed) {
    await mkdir(path.join(pkg, "bin"), { recursive: true, mode: 0o700 });
    await mkdir(units, { recursive: true, mode: 0o700 });
    await writeFile(path.join(pkg, "bin/codey.mjs"), 'process.send("ready");setInterval(()=>{},1000);\n', { mode: 0o600 });
    await writeFile(path.join(pkg, "codey-build.json"), "{}");
    for (const role of ["workspace", "gateway"]) {
      const args = [path.join(pkg, "bin/codey.mjs"), role,
        ...(role === "gateway" ? ["start", "--headless", "--host", "127.0.0.1", "--port", "4141"] : [])];
      const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      children.push(child);
      await once(child, "message");
      env[`CODEY_TEST_${role.toUpperCase()}_PID`] = String(child.pid);
      const unit = role === "workspace" ? "codey-cloudcli.service" : "codey-copilot-api.service";
      await writeFile(path.join(units, unit),
        `[Service]\nWorkingDirectory=${pkg}\nExecStart=${process.execPath} ${args.join(" ")}\n`, { mode: 0o600 });
    }
    const state = path.join(home, ".local/state/codey-machine");
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeFile(path.join(state, "identity.json"), '{"preserve":"existing identity"}', { mode: 0o600 });
  }
  const check = (body = "codey_linux_preflight", extra = {}) =>
    run("bash", ["-c", helper + "\n" + body], { env: { ...env, ...extra } });
  return { root, home, bin, pkg, units, listeners, calls, env, check, children };
}

const linuxTest = (name, fn) => test(name, { skip: process.platform !== "linux" || process.arch !== "x64" }, fn);
linuxTest("Linux preflight permits free ports or exact owner-managed Codey listeners, including IPv6", async t => {
  const f = await preflightFixture(t);
  await f.check();
  await writeFile(f.listeners, [
    `LISTEN 0 511 127.0.0.1:3001 0.0.0.0:* users:(("node",pid=${f.env.CODEY_TEST_WORKSPACE_PID},fd=20))`,
    `LISTEN 0 511 127.0.0.1:4141 0.0.0.0:* users:(("node",pid=${f.env.CODEY_TEST_GATEWAY_PID},fd=20))`,
    `LISTEN 0 511 [::1]:8443 [::]:* users:(("node",pid=${f.env.CODEY_TEST_GATEWAY_PID},fd=21))`,
  ].join("\n"));
  const before = await treeFiles(f.home);
  const result = await f.check();
  assert.match(result.stdout, /Port 3001: verified owner-managed Codey/);
  assert.match(result.stdout, /Port 4141: verified owner-managed Codey/);
  assert.match(result.stdout, /Port 8443: verified owner-managed Codey/);
  assert.deepEqual(await treeFiles(f.home), before);
  assert.doesNotMatch(await readFile(f.calls, "utf8"), /stop|kill|disable|restart/);
});

linuxTest("Linux rejects foreign/hidden listeners, wildcard binds, wrong roles, overridden units and spoofed argv", async t => {
  const f = await preflightFixture(t), pid = f.env.CODEY_TEST_GATEWAY_PID;
  for (const line of [
    "LISTEN 0 511 127.0.0.1:4141 0.0.0.0:*",
    `LISTEN 0 511 127.0.0.1:4141 0.0.0.0:* users:(("codey",pid=${process.pid},fd=20))`,
    `LISTEN 0 511 0.0.0.0:4141 0.0.0.0:* users:(("node",pid=${pid},fd=20))`,
    `LISTEN 0 511 [::]:8443 [::]:* users:(("node",pid=${pid},fd=20))`,
    `LISTEN 0 511 127.0.0.1:3001 0.0.0.0:* users:(("node",pid=${pid},fd=20))`,
    `LISTEN 0 511 127.0.0.1:4141 0.0.0.0:* users:(("node",pid=${pid},fd=20),("node",pid=${process.pid},fd=21))`,
  ]) {
    await writeFile(f.listeners, line);
    await assert.rejects(f.check(), error => /foreign or unverified/.test(error.stderr));
  }
});

linuxTest("Linux does not trust an overridden service or a PID with another command line", async t => {
  const f = await preflightFixture(t);
  await assert.rejects(f.check("codey_linux_preflight", { CODEY_TEST_DROP_IN: "/unreviewed/override.conf" }),
    error => /overridden/.test(error.stderr));
  const child = spawn(process.execPath, [path.join(f.pkg, "bin/codey.mjs"), "gateway",
    "--eval", "codey gateway start --headless --host 127.0.0.1 --port 4141"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  f.children.push(child);
  await once(child, "message");
  await writeFile(f.listeners, `LISTEN 0 511 127.0.0.1:4141 0.0.0.0:* users:(("node",pid=${child.pid},fd=20))`);
  await assert.rejects(f.check("codey_linux_preflight", { CODEY_TEST_GATEWAY_PID: String(child.pid) }),
    error => /foreign or unverified/.test(error.stderr));
});

linuxTest("a foreign Linux listener aborts the standalone installer before Node/npm downloads or file changes", async t => {
  const f = await preflightFixture(t, { installed: false });
  await writeFile(f.listeners, `LISTEN 0 511 127.0.0.1:8443 0.0.0.0:* users:(("node",pid=${process.pid},fd=20))`);
  const before = await treeFiles(f.home);
  await assert.rejects(run("bash", [fileURLToPath(new URL("../scripts/linux/install-codey.sh", import.meta.url)),
    "--package", path.join(f.root, "unused.tgz"), "--expected-computer", os.hostname()], { env: f.env }),
  error => /Port 8443.*foreign or unverified/.test(error.stderr) && !/forbidden-operation/.test(error.stderr));
  assert.deepEqual(await treeFiles(f.home), before);
});

linuxTest("the Skill's Linux entry delegates to the one npm installer instead of staging or switching an application", async t => {
  const f = await preflightFixture(t, { installed: false }), localSkill = path.join(f.root, "skill with spaces");
  const scripts = path.join(localSkill, "scripts"), assets = path.join(localSkill, "assets");
  await mkdir(scripts, { recursive: true });
  await mkdir(assets);
  await writeFile(path.join(scripts, "install.sh"), installer);
  await executable(path.join(scripts, "install-npm.sh"), `printf '<%s>\\n' "$@"`);
  const tgz = path.join(assets, "codey-0.1.16.tgz");
  await writeFile(tgz, "fixture");
  await writeFile(path.join(assets, "SHA256SUMS"), `${hash("fixture")}  codey-0.1.16.tgz\n`);
  const before = await treeFiles(f.home);
  const result = await run("bash", [path.join(scripts, "install.sh"), "--expected-computer", "fixture host", "--replace-existing"],
    { env: { ...f.env, CODEY_INSTALLED_PACKAGE: "" } });
  assert.equal(result.stdout, `<--package>\n<${tgz}>\n<--expected-computer>\n<fixture host>\n<--replace-existing>\n`);
  assert.deepEqual(await treeFiles(f.home), before);
  await writeFile(tgz, "tampered");
  await assert.rejects(run("bash", [path.join(scripts, "install.sh")], {
    env: { ...f.env, CODEY_INSTALLED_PACKAGE: "" },
  }), error => /checksum/.test(error.stderr));
  await writeFile(path.join(assets, "codey-0.1.17.tgz"), "ambiguous");
  await assert.rejects(run("bash", [path.join(scripts, "install.sh")], {
    env: { ...f.env, CODEY_INSTALLED_PACKAGE: "" },
  }), error => /exactly one/.test(error.stderr));
  assert.doesNotMatch(installer, /\bSTAGE_PACKAGE\b|\bRELEASE_PACKAGE\b|RELEASE\.next|nodejs\.org\/dist|npm" install|systemctl --user restart/);
});

linuxTest("the Linux installer renders the shared model template instead of maintaining a second TOML configuration", async t => {
  const f = await preflightFixture(t, { installed: false });
  const home = path.join(f.home, "owner's $& home 中文");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  const start = installer.indexOf('"$NODE" - "$MODEL_CONFIG"');
  const end = installer.indexOf("\nNODE\n", start) + "\nNODE\n".length;
  assert.ok(start >= 0 && end > start);
  const templateFile = path.join(skill, "templates/codex-config.toml");
  await run("bash", ["-euc", installer.slice(start, end)], {
    env: { ...f.env, NODE: process.execPath, MODEL_CONFIG: templateFile, HOME_DIR: home },
  });
  const actual = await readFile(path.join(home, ".codex/config.toml"), "utf8");
  const template = await readFile(templateFile, "utf8");
  assert.equal(actual, template.replace("__CODEY_MODEL_CATALOG__", () => JSON.stringify(path.join(home, ".codex/models.json"))));
});

linuxTest("Linux asks the owner to close unmanaged Codex instead of killing it", async t => {
  const f = await preflightFixture(t, { installed: false });
  await executable(path.join(f.bin, "pgrep"), 'exit 0');
  await assert.rejects(run("bash", ["-c", functions + "\nrequire_closed_codex"], { env: f.env }),
    error => /Close Codex\/Desktop yourself/.test(error.stderr) && !/forbidden-operation/.test(error.stderr));
});

test("Linux installation does not probe Python, install an updater, or erase its old state", () => {
  assert.doesNotMatch(installer, /PYTHON|python3|updaterCredential|UPDATER_SOURCE/);
  assert.doesNotMatch(installer, /rm -rf .*codey-updater/);
  assert.match(helper, /This node still has a retired updater/);
  assert.ok(installer.indexOf("codey_linux_preflight") < installer.indexOf('mkdir -p "$TOOLS"'));
  assert.doesNotMatch(installer, /\bpkill\b|\bfuser\b|stop_system_unit|kill_matches/);
});

linuxTest("Linux still rejects incomplete nodes and retired updater state without touching them", async t => {
  const f = await preflightFixture(t);
  await rm(path.join(f.units, "codey-cloudcli.service"));
  const before = await treeFiles(f.home);
  await assert.rejects(f.check(), error => /Incomplete Codey/.test(error.stderr));
  assert.deepEqual(await treeFiles(f.home), before);
  await mkdir(path.join(f.home, ".config/codey-updater"));
  await assert.rejects(f.check(), error => /retired updater/.test(error.stderr));
});

linuxTest("same-release Linux rerun verifies and exports without reinstalling, restarting or changing identity/TLS/model config", async t => {
  const f = await preflightFixture(t), config = path.join(f.home, ".config/codey-machine");
  const state = path.join(f.home, ".local/state/codey-machine"), copilot = path.join(f.home, ".local/share/copilot-api");
  const localSkill = path.join(f.root, "skill"), assets = path.join(localSkill, "assets");
  for (const folder of [config, copilot, assets, path.join(localSkill, "scripts"), path.join(localSkill, "templates")]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
  }
  const secret = () => randomBytes(32).toString("base64url");
  const identity = { schema: 1, nodeId: "n-" + "a".repeat(24), workspaceSubject: "m-" + "b".repeat(24),
    workspaceUsername: "fixture", clientSigningKey: secret(), workspaceSsoKey: secret(), tunnelUpdateKey: secret() };
  const identityFile = path.join(state, "identity.json");
  await writeFile(identityFile, JSON.stringify(identity), { mode: 0o600 });
  const entry = "// already-installed fixture\n", lock = '{"name":"codey"}\n';
  for (const file of ["gateway/main.js", "dist-server/server/index.js"]) {
    await mkdir(path.dirname(path.join(f.pkg, file)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(f.pkg, file), entry);
  }
  const build = JSON.stringify({ gatewayEntrySha256: hash(entry), workspaceEntrySha256: hash(entry) });
  await writeFile(path.join(f.pkg, "codey-build.json"), build);
  await writeFile(path.join(f.pkg, "npm-shrinkwrap.json"), lock);
  const manifest = { schema: 2, name: "codey", platform: "linux-x64", releaseId: "machine-" + hash(build).slice(0, 16),
    node: process.versions.node, dependencyMode: "npm-installed", artifacts: [],
    bundledRuntimes: ["cloudcli", "copilot-api"], codey: { version: "0.1.16", entrySha256: hash(build), lockSha256: hash(lock) } };
  const setup = { schema: 1, platform: "linux-x64", releaseId: manifest.releaseId, portalOrigin: "https://codey.example.test" };
  const sums = [];
  for (const [file, document] of [["manifest.json", manifest], ["setup.json", setup]]) {
    const bytes = JSON.stringify(document) + "\n";
    await writeFile(path.join(assets, file), bytes);
    sums.push(`${hash(bytes)}  ${file}`);
  }
  await writeFile(path.join(assets, "SHA256SUMS"), sums.join("\n") + "\n");
  await writeFile(path.join(localSkill, "templates/a100-models.json"), "{}");
  await writeFile(path.join(localSkill, "templates/codex-config.toml"),
    await readFile(path.join(skill, "templates/codex-config.toml")));
  for (const file of ["install.sh", "linux-preflight.sh", "registration.mjs", "install-devtunnel-health.sh", "linux-devtunnel-health.mjs"]) {
    await writeFile(path.join(localSkill, "scripts", file), await readFile(path.join(skill, "scripts", file)));
  }
  // Only local service probes are stubbed. Package hashes, TLS key pairing,
  // native PID/argv checks and the real registration validator still execute.
  await writeFile(path.join(localSkill, "scripts/windows-runtime.mjs"),
    'export async function verifyLocal() {}\nexport const validateTunnel = raw => ({tunnelId:raw.tunnelId,clusterId:raw.clusterId});\n');
  const cert = path.join(config, "node-cert.pem"), key = path.join(config, "node-key.pem");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "365",
    "-subj", `/CN=${identity.nodeId}.nodes.codey.internal`,
    "-addext", `subjectAltName=DNS:${identity.nodeId}.nodes.codey.internal`,
    "-addext", "basicConstraints=critical,CA:FALSE", "-keyout", key, "-out", cert]);
  await Promise.all([key, cert].map(file => chmod(file, 0o600)));
  const coordinates = { tunnelId: "codey-" + identity.nodeId, clusterId: "jpe1" };
  for (const [file, content] of [
    ["tunnel.json", JSON.stringify({ ...coordinates, ports: [3001, 8443].map(portNumber => ({ portNumber, protocol: "https" })) })],
    ["copilot.env", `COPILOT_API_CODEY_ALLOWED_ORIGIN=${setup.portalOrigin}\nCOPILOT_API_CODEY_NODE_ID=${identity.nodeId}\n`],
    ["cloudcli.env", "preserve workspace environment\n"],
  ]) await writeFile(path.join(config, file), content, { mode: 0o600 });
  await writeFile(path.join(copilot, "config.json"), JSON.stringify({ auth: { apiKeys: [secret()] } }), { mode: 0o600 });
  const tunnel = path.join(f.home, ".local/share/codey-tools/devtunnel/devtunnel");
  await mkdir(path.dirname(tunnel), { recursive: true, mode: 0o700 });
  const token = ["e30", Buffer.from(JSON.stringify({ ...coordinates, scp: "connect",
    exp: Math.floor(Date.now() / 1000) + 72000 })).toString("base64url"), "c2ln"].join(".");
  await executable(tunnel, `printf '%s\\n' '{"token":"${token}"}'`);
  await writeFile(f.listeners, [3001, 4141, 8443].map(port =>
    `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=${port === 3001 ? f.env.CODEY_TEST_WORKSPACE_PID : f.env.CODEY_TEST_GATEWAY_PID},fd=20))`).join("\n"));
  const before = await treeFiles(f.home);
  const args = [path.join(localSkill, "scripts/install.sh"), "--expected-computer", os.hostname()];
  const env = { ...f.env, CODEY_INSTALLED_PACKAGE: f.pkg, CODEY_SETUP_NODE: process.execPath, CODEY_SETUP_ASSETS: assets };
  const result = await run("bash", args, { env, timeout: 20000 });
  assert.match(result.stdout, /already installed and verified; no reinstall/);
  const output = path.join(f.home, "codey-machine-registration.json");
  assert.equal(JSON.parse(await readFile(output, "utf8")).machine.nodeId, identity.nodeId);
  await rm(output);
  assert.deepEqual(await treeFiles(f.home), before);
  assert.doesNotMatch(await readFile(f.calls, "utf8"), /stop|restart|enable --now|disable/);
  await writeFile(path.join(f.pkg, "gateway/main.js"), "modified application");
  await assert.rejects(run("bash", args, { env, timeout: 20000 }),
    error => /differs from this release/.test(error.stderr));
  await assert.rejects(lstat(output), { code: "ENOENT" });
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
  // Set the fixture's initial permissions independently of a private CI umask.
  await Promise.all([profile, target].map(file => chmod(file, 0o640)));
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
