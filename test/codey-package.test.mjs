import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { commandPlan, supervise } from "../packages/codey/lib/cli.mjs";

const exec = promisify(execFile);
const packageRoot = new URL("../packages/codey/", import.meta.url);
const json = async (url) => JSON.parse(await readFile(url, "utf8"));

test("Codey has one application identity, executable and lock, not dependencies on the two apps", async () => {
  const pkg = await json(new URL("package.json", packageRoot));
  const lock = await json(new URL("package-lock.json", packageRoot));
  assert.equal(pkg.name, "codey");
  assert.deepEqual(pkg.bin, { codey: "bin/codey.mjs" });
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  const sources = await Promise.all(["cloudcli", "copilot-api"].map(name =>
    json(new URL(`../${name}/package.json`, import.meta.url))));
  for (const group of ["dependencies", "optionalDependencies"]) {
    const expected = Object.assign({}, ...sources.map(source => source[group]));
    delete expected["@openai/codex"];
    delete expected["@openai/codex-sdk"];
    assert.deepEqual(pkg[group], expected);
    assert.deepEqual(lock.packages[""][group], expected);
  }
  for (const name of ["@cloudcli-ai/cloudcli", "@jeffreycao/copilot-api", "@openai/codex"]) {
    assert.equal(pkg.dependencies[name], undefined);
    assert.equal(lock.packages[`node_modules/${name}`], undefined);
  }
  assert.ok(pkg.files.includes("npm-shrinkwrap.json"));
  assert.deepEqual(pkg.imports, { "#codey/codex-sdk": "./lib/codex-sdk/index.js" });
});

test("single CLI starts CloudCLI only through the whole-node command", () => {
  assert.deepEqual(commandPlan([]), { kind: "help" });
  assert.deepEqual(commandPlan(["--version"]), { kind: "version" });
  assert.deepEqual(commandPlan(["copilot", "login"]), {
    kind: "gateway", args: ["auth", "login", "--provider", "copilot"],
  });
  assert.deepEqual(commandPlan(["copilot", "start"]), {
    kind: "gateway", args: ["start", "--headless", "--host", "127.0.0.1", "--port", "4141"],
  });
  assert.deepEqual(commandPlan(["start"], {}), { kind: "machine", command: "start", args: [] });
  assert.deepEqual(commandPlan(["guard"], {}), { kind: "machine", command: "guard", args: [] });
  assert.deepEqual(commandPlan(["start", "--foreground"], {}).commands, [
    { entry: "bin/codey.mjs", args: ["copilot", "start", "--host", "127.0.0.1", "--port", "4141"] },
    { entry: "lib/workspace.mjs", env: { HOST: "127.0.0.1", SERVER_PORT: "3001" } },
  ]);
  for (const args of [
    ["unknown"], ["--version", "ignored"], ["start", "--port", "3001"],
    ["start", "--workspace-port"], ["start", "--workspace-port", "0"], ["start", "--workspace-port", "65536"],
    ["start", "--workspace-port", "3e3"], ["start", "--host", "--workspace-port"],
    ["start", "--workspace-port", "3001", "--workspace-port", "3002"],
    ["start", "--workspace-port", "4141", "--gateway-port", "4141"],
  ]) assert.throws(() => commandPlan(args, {}), Error, args.join(" "));
});

test("deleted setup/workspace/gateway/auth/debug/mcp commands fail before importing an app or reading credentials", async t => {
  const f = await fixture(t);
  const help = (await f.invoke(["--help"])).stdout;
  assert.doesNotMatch(help, /codey (setup|workspace|gateway|auth|mcp|debug)\b/);
  for (const args of [
    ["gateway"], ["gateway", "--help"], ["gateway", "start"], ["gateway", "auth", "login"],
    ["gateway", "auth", "keys"], ["gateway", "auth", "codex"], ["gateway", "debug"], ["gateway", "mcp"],
    ["auth", "login"], ["auth", "keys", "--list"], ["auth", "codex"], ["mcp"], ["debug"],
    ["copilot", "auth"], ["copilot", "debug"], ["copilot", "mcp"],
    ["workspace"], ["workspace", "--help"], ["workspace", "-h"],
    ["workspace", "--host", "127.0.0.1", "--port", "3001"],
    ["setup"], ["setup", "--help"], ["setup", "--check"],
    ["setup", "--expected-computer", os.hostname(), "--replace-existing"],
  ]) {
    assert.throws(() => commandPlan(args));
    await assert.rejects(f.invoke(args), error => error.code === 1 && !/ERR_MODULE_NOT_FOUND/.test(error.stderr));
  }
  for (const action of ["login", "start"]) {
    assert.match((await f.invoke(["copilot", action, "--help"])).stdout, new RegExp(`codey copilot ${action}`));
  }
});

test("guard help works without an installed node and never imports either application or the installer", async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, "lib/install.mjs"));
  for (const flag of ["--help", "-h"]) {
    const help = (await f.invoke(["guard", flag])).stdout;
    assert.match(help, /Usage: codey guard \[--json\] \[--timeout SECONDS\]/);
    for (const word of ["CloudCLI", "Copilot API", "DevTunnel", "renewal", "Linux", "60", "1–600"]) assert.ok(help.includes(word));
  }
  await assert.rejects(f.invoke(["setup", "--help"]), error => error.code === 1 && /Unknown command: setup/.test(error.stderr));
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-npm-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL("bin", packageRoot), path.join(root, "bin"), { recursive: true });
  await cp(new URL("lib", packageRoot), path.join(root, "lib"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"codey","version":"1.2.3","type":"module"}');
  const invoke = (args, env = {}) => exec(process.execPath, [path.join(root, "bin/codey.mjs"), ...args], {
    env: { ...process.env, ...env }, cwd: os.tmpdir(),
  });
  return { root, invoke };
}

test("help and version work without importing either server; errors return a failing exit code", async t => {
  const f = await fixture(t);
  assert.match((await f.invoke(["--help"])).stdout, /codey start/);
  assert.equal((await f.invoke(["--version"])).stdout.trim(), "codey 1.2.3");
  await assert.rejects(f.invoke(["invalid"]), error => error.code === 1 && /Unknown command/.test(error.stderr));
});

test("one-shot package update has help while retired remote/tool entrypoints still fail before services", async t => {
  const f = await fixture(t);
  assert.match((await f.invoke(["update", "--help"])).stdout, /codey update FILE.tgz/);
  for (const args of [["--update"], ["update"], ["update", "--recover"],
    ["update", "codex", "tool-update.json"], ["update", "devtunnel", "--help"]]) {
    assert.throws(() => commandPlan(args));
    await assert.rejects(f.invoke(args), error => error.code === 1);
  }
});

test("the npm prepack guard refuses to publish an unbuilt source scaffold", async () => {
  await assert.rejects(exec(process.execPath, [
    fileURLToPath(new URL("../packages/codey/scripts/verify-package.mjs", import.meta.url)),
  ]), error => error.code === 1 && /npm run codey:build/.test(error.stderr));
});

test("both internal entrypoints use the same package root and dependency tree in the same PID", async t => {
  const f = await fixture(t);
  const dependency = path.join(f.root, "node_modules/shared-fixture");
  await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, "package.json"), '{"name":"shared-fixture","main":"index.cjs"}');
  await writeFile(path.join(dependency, "index.cjs"), 'module.exports = "one shared installation";');
  const body = `
import dependency from "shared-fixture";
console.log(JSON.stringify({
  dependency, cwd: process.cwd(), pid: process.pid, args: process.argv.slice(2),
  host: process.env.HOST, port: process.env.SERVER_PORT, managed: process.env.CODEY_MANAGED,
  codex: process.env.CODEY_CODEX_EXECUTABLE
}));
`;
  for (const name of ["gateway/main.js", "dist-server/server/index.js"]) {
    const target = path.join(f.root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  const gatewayRun = f.invoke(["copilot", "start"], { CODEY_MANAGED: "false" });
  const workspaceRun = exec(process.execPath, [path.join(f.root, "lib/workspace.mjs")], {
    cwd: os.tmpdir(), env: { ...process.env, HOST: "::1", SERVER_PORT: "4000", CODEY_MANAGED: "false",
      CODEY_CODEX_EXECUTABLE: path.join(f.root, "official-codex") },
  });
  const gateway = JSON.parse((await gatewayRun).stdout), workspace = JSON.parse((await workspaceRun).stdout);
  assert.equal(gateway.pid, gatewayRun.child.pid);
  assert.equal(workspace.pid, workspaceRun.child.pid);
  for (const value of [gateway, workspace]) {
    assert.equal(value.dependency, "one shared installation");
    assert.equal(value.cwd, f.root);
    assert.ok(Number.isInteger(value.pid));
  }
  assert.deepEqual(gateway.args, ["start", "--headless", "--host", "127.0.0.1", "--port", "4141"]);
  assert.equal(gateway.managed, "true");
  assert.deepEqual(workspace.args, []);
  assert.equal(workspace.host, "::1");
  assert.equal(workspace.port, "4000");
  assert.equal(workspace.managed, "true");
  assert.equal(workspace.codex, path.join(f.root, "official-codex"));
});

test("private CloudCLI worker keeps loopback defaults and discovers Codex only in absolute PATH entries", async t => {
  const f = await fixture(t), official = path.join(f.root, "official");
  const filename = process.platform === "win32" ? "codex.exe" : "codex";
  for (const directory of [official, path.join(f.root, "relative-bin"), path.join(f.root, "dist-server/server")]) {
    await mkdir(directory, { recursive: true });
  }
  for (const directory of [official, path.join(f.root, "relative-bin")]) {
    await writeFile(path.join(directory, filename), "fixture, never executed\n", { mode: 0o700 });
  }
  await writeFile(path.join(f.root, "dist-server/server/index.js"), `
console.log(JSON.stringify({host:process.env.HOST,port:process.env.SERVER_PORT,codex:process.env.CODEY_CODEX_EXECUTABLE}));
`);
  const env = { ...process.env, PATH: ["relative-bin", official].join(path.delimiter) };
  for (const key of ["HOST", "SERVER_PORT", "CODEY_CODEX_EXECUTABLE"]) delete env[key];
  const result = JSON.parse((await exec(process.execPath, [path.join(f.root, "lib/workspace.mjs")], { cwd: f.root, env })).stdout);
  assert.deepEqual(result, { host: "127.0.0.1", port: "3001", codex: await realpath(path.join(official, filename)) });
});

test("real foreground CLI launches both internal processes and stops them together without the workspace command", {
  skip: process.platform === "win32", timeout: 15000,
}, async t => {
  const f = await fixture(t);
  for (const [entry, component] of [["gateway/main.js", "copilot"], ["dist-server/server/index.js", "workspace"]]) {
    const file = path.join(f.root, entry);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `
console.log(JSON.stringify({component:${JSON.stringify(component)},cwd:process.cwd(),pid:process.pid,ppid:process.ppid,
  args:process.argv.slice(2),host:process.env.HOST,port:process.env.SERVER_PORT,managed:process.env.CODEY_MANAGED}));
setInterval(()=>{},1000);
`);
  }
  const child = spawn(process.execPath, [path.join(f.root, "bin/codey.mjs"), "start", "--foreground",
    "--host", "::1", "--workspace-port", "4567", "--gateway-port", "4568"], {
    cwd: os.tmpdir(), env: { ...process.env, HOST: "ignored-host", SERVER_PORT: "ignored-port", CODEY_MANAGED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stopped = once(child, "exit");
  let output = "", errors = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { errors += data; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await stopped; });
  for (let attempt = 0; output.trim().split("\n").length < 2 && attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, errors);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const messages = output.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(messages.length, 2, errors);
  for (const message of messages) {
    assert.equal(message.cwd, f.root);
    assert.equal(message.ppid, child.pid, "Both components are direct children, without another wrapper process");
    assert.equal(message.managed, "true");
  }
  const copilot = messages.find(message => message.component === "copilot");
  assert.deepEqual(copilot.args, ["start", "--headless", "--host", "::1", "--port", "4568"]);
  const workspace = messages.find(message => message.component === "workspace");
  assert.deepEqual(workspace.args, []);
  assert.equal(workspace.host, "::1");
  assert.equal(workspace.port, "4567");
  child.kill("SIGTERM");
  const [code, signal] = await stopped;
  assert.equal(code, 143, errors);
  assert.equal(signal, null);
  for (const message of messages) assert.throws(() => process.kill(message.pid, 0), { code: "ESRCH" });
});

function fakeProcesses() {
  const children = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      queueMicrotask(() => child.emit("exit", null, signal));
    };
    Object.assign(child, { executable, args, options });
    children.push(child);
    return child;
  };
  return { children, spawnProcess, signals: new EventEmitter() };
}

test("foreground supervisor uses a private CloudCLI worker and terminates its sibling on failure", async () => {
  const f = fakeProcesses();
  const done = supervise(commandPlan(["start", "--foreground"], {}).commands, { ...f, root: "/tmp/codey", env: { HOME: "/tmp/test" } });
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.children.map(child => child.args), [
    [path.join("/tmp/codey", "bin/codey.mjs"), "copilot", "start", "--host", "127.0.0.1", "--port", "4141"],
    [path.join("/tmp/codey", "lib/workspace.mjs")],
  ],
    "Whole-node foreground worker includes both Copilot API and CloudCLI");
  for (const child of f.children) {
    assert.equal(child.executable, process.execPath);
    assert.equal(child.options.shell, false);
    assert.equal(child.options.windowsHide, true);
  }
  assert.deepEqual(f.children[0].options.env, { HOME: "/tmp/test" });
  assert.deepEqual(f.children[1].options.env, { HOME: "/tmp/test", HOST: "127.0.0.1", SERVER_PORT: "3001" });
  f.children[0].emit("exit", 7);
  assert.equal(await done, 7);
  assert.deepEqual(f.children[1].signals, ["SIGTERM"]);
  assert.equal(f.signals.listenerCount("SIGTERM"), 0);
});

test("foreground signals are forwarded once and spawn failures clean up the other process", async () => {
  for (const [signal, expected] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const f = fakeProcesses();
    const done = supervise(commandPlan(["start", "--foreground"], {}).commands, f);
    f.signals.emit(signal);
    f.signals.emit(signal);
    assert.equal(await done, expected);
    assert.ok(f.children.every(child => child.signals.join() === signal));
    assert.equal(f.signals.listenerCount(signal), 0);
  }
  const f = fakeProcesses();
  const done = supervise(commandPlan(["start", "--foreground"], {}).commands, f);
  f.children[0].emit("error", new Error("spawn failed"));
  assert.equal(await done, 1);
  assert.deepEqual(f.children[1].signals, ["SIGTERM"]);
});
