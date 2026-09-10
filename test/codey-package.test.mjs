import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("single CLI routes gateway commands verbatim and isolates workspace configuration", () => {
  assert.deepEqual(commandPlan([]), { kind: "help" });
  assert.deepEqual(commandPlan(["--version"]), { kind: "version" });
  assert.deepEqual(commandPlan(["auth", "login", "--provider", "copilot"]), {
    kind: "gateway", args: ["auth", "login", "--provider", "copilot"],
  });
  const args = ["mcp", "--api-home", "/tmp/path with spaces;not-a-shell"];
  assert.deepEqual(commandPlan(args), { kind: "gateway", args });
  assert.deepEqual(commandPlan(["gateway", "debug", "--json"]), {
    kind: "gateway", args: ["debug", "--json"],
  });
  assert.deepEqual(commandPlan(["workspace"], { SERVER_PORT: "4567", HOST: "127.0.0.2" }), {
    kind: "workspace", env: { SERVER_PORT: "4567", HOST: "127.0.0.2", CODEY_MANAGED: "true" },
  });
  assert.deepEqual(commandPlan(["workspace", "--port", "7654", "--host", "::1"], {}), {
    kind: "workspace", env: { SERVER_PORT: "7654", HOST: "::1", CODEY_MANAGED: "true" },
  });
  assert.deepEqual(commandPlan(["start"], {}).commands, [
    ["gateway", "start", "--headless", "--host", "127.0.0.1", "--port", "4141"],
    ["workspace", "--host", "127.0.0.1", "--port", "3001"],
  ]);
  for (const args of [
    ["unknown"], ["--version", "ignored"], ["start", "--port", "3001"],
    ["workspace", "--port"], ["workspace", "--port", "0"], ["workspace", "--port", "65536"],
    ["workspace", "--port", "3e3"], ["workspace", "--host", "--port"],
    ["workspace", "--port", "3001", "--port", "3002"],
    ["start", "--workspace-port", "4141", "--gateway-port", "4141"],
  ]) assert.throws(() => commandPlan(args, {}), Error, args.join(" "));
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
  host: process.env.HOST, port: process.env.SERVER_PORT, managed: process.env.CODEY_MANAGED
}));
`;
  for (const name of ["gateway/main.js", "dist-server/server/index.js"]) {
    const target = path.join(f.root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  const gateway = JSON.parse((await f.invoke(["gateway", "debug", "--json"], { CODEY_MANAGED: "false" })).stdout);
  const workspace = JSON.parse((await f.invoke(["workspace", "--port", "4000", "--host", "::1"])).stdout);
  for (const value of [gateway, workspace]) {
    assert.equal(value.dependency, "one shared installation");
    assert.equal(value.cwd, f.root);
    assert.ok(Number.isInteger(value.pid));
  }
  assert.deepEqual(gateway.args, ["debug", "--json"]);
  assert.equal(gateway.managed, "true");
  assert.deepEqual(workspace.args, []);
  assert.equal(workspace.host, "::1");
  assert.equal(workspace.port, "4000");
  assert.equal(workspace.managed, "true");
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

test("foreground supervisor starts one binary twice and terminates its sibling on failure", async () => {
  const f = fakeProcesses();
  const done = supervise([["gateway", "start"], ["workspace"]], { ...f, root: "/tmp/codey", env: { HOME: "/tmp/test" } });
  assert.equal(f.children.length, 2);
  for (const child of f.children) {
    assert.equal(child.executable, process.execPath);
    assert.equal(child.args[0], path.join("/tmp/codey", "bin/codey.mjs"));
    assert.equal(child.options.shell, false);
    assert.deepEqual(child.options.env, { HOME: "/tmp/test" });
  }
  f.children[0].emit("exit", 7);
  assert.equal(await done, 7);
  assert.deepEqual(f.children[1].signals, ["SIGTERM"]);
  assert.equal(f.signals.listenerCount("SIGTERM"), 0);
});

test("foreground signals are forwarded once and spawn failures clean up the other process", async () => {
  for (const [signal, expected] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const f = fakeProcesses();
    const done = supervise([["gateway"], ["workspace"]], f);
    f.signals.emit(signal);
    f.signals.emit(signal);
    assert.equal(await done, expected);
    assert.ok(f.children.every(child => child.signals.join() === signal));
    assert.equal(f.signals.listenerCount(signal), 0);
  }
  const f = fakeProcesses();
  const done = supervise([["gateway"], ["workspace"]], f);
  f.children[0].emit("error", new Error("spawn failed"));
  assert.equal(await done, 1);
  assert.deepEqual(f.children[1].signals, ["SIGTERM"]);
});
