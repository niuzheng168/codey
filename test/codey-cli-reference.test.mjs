import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { commandPlan } from "../packages/codey/lib/cli.mjs";
import { machineOptions, MACHINE_USAGE } from "../packages/codey/lib/machine.mjs";
import { doctorOptions } from "../packages/codey/lib/doctor.mjs";

const exec = promisify(execFile);
const source = name => readFile(new URL(`../copilot-api/src/${name}`, import.meta.url), "utf8");
const reference = await readFile(new URL("../skills/config-new-codey-machine/references/codey-cli.md", import.meta.url), "utf8");
const headings = [...reference.matchAll(/^(#{2,3}) (`codey [a-z]+(?: [a-z]+)?`)\n/gm)];

// Read the actual declarative command definitions without loading the gateway,
// native modules, credentials, configuration or any provider implementation.
async function definition(file, expression, values = {}) {
  const code = stripTypeScriptTypes(await source(file))
    .replace(/^import\b[\s\S]*?\bfrom\s+["'][^"']+["'];?/gm, "")
    .replace(/^export\s+/gm, "")
    .replaceAll("import.meta.url", '"file:///codey-cli-reference/entry.js"');
  return JSON.parse(runInNewContext(code + "\nJSON.stringify(" + expression + ")", {
    defineCommand: value => value, process: { env: {} }, ...values,
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }));
}

function section(name) {
  const index = headings.findIndex(heading => heading[2] === name);
  assert.notEqual(index, -1, `Missing CLI section: ${name}`);
  const heading = headings[index];
  const next = headings.slice(index + 1).find(item => item[1].length <= heading[1].length);
  return reference.slice(heading.index + heading[0].length, next?.index);
}

function flagsTable(text) {
  return text.split("\n").filter(line => /^\| `--/.test(line)).map(line => line.split("|")[1]).join("\n");
}

function assertFlags(name, definitions) {
  const table = flagsTable(section(name));
  const actual = [...new Set(table.match(/--[a-z][a-z0-9-]*|-[a-z]\b/g) ?? [])].sort();
  // Basic help/version usage is intentionally omitted from this business-command reference.
  const expected = Object.entries(definitions).flatMap(([key, value]) =>
    [`--${key}`, ...(value.alias ? [value.alias].flat().map(alias => "-" + alias) : [])]).sort();
  assert.deepEqual(actual, expected, `${name}: document this command's business options and aliases, without mixing sibling options`);
}

const quick = await definition("lib/quick-providers.ts", "QUICK_PROVIDER_CONFIGS");
const auth = await definition("auth.ts", "({auth, providers: AUTH_PROVIDER_NAMES})", { QUICK_PROVIDER_CONFIGS: quick });
const host = /export const DEFAULT_SERVER_HOST = "([^"]+)"/.exec(await source("lib/server-host.ts"))[1];
const start = await definition("start.ts", "start", { DEFAULT_SERVER_HOST: host });
const literal = /const cliArgs = (\{[\s\S]*?\n  \}) as const/.exec(await source("main.ts"))[1];
const globals = runInNewContext("(" + literal + ")");

test("every business command has its own reference entry under the actual CLI hierarchy", () => {
  const leaves = [...Object.keys(MACHINE_USAGE), "copilot login", "copilot start", "doctor"];
  const groups = ["copilot", "devtunnel"];
  assert.deepEqual(headings.map(heading => heading[2].slice(1, -1)).sort(),
    [...groups, ...leaves].map(command => `codey ${command}`).sort());
  for (const command of leaves) {
    const name = "`codey " + command + "`";
    const index = headings.findIndex(heading => heading[2] === name);
    const heading = headings[index];
    assert.equal(heading[1].length, command.includes(" ") ? 3 : 2, name);
    if (command.includes(" ")) {
      const parent = headings.slice(0, index).findLast(item => item[1] === "##");
      assert.equal(parent[2], "`codey " + command.split(" ")[0] + "`");
    }
    const text = section(name);
    assert.match(text, /```text\ncodey /, `${name}: usage`);
    assert.match(text, /\*\*示例\*\*\n\n```sh\ncodey /, `${name}: examples`);
    if (["export", "import", "update"].includes(command)) {
      assert.match(text, /^\| `FILE\.(?:gz|tgz)` \| 必填；/m, `${name}: required file argument`);
    }
  }
});

test("the public reference distinguishes Codey's force option from forwarded upstream Copilot options", () => {
  const select = (definitions, names) => Object.fromEntries(names.map(name => {
    assert.ok(definitions[name], `Missing underlying Copilot option: ${name}`);
    return [name, definitions[name]];
  }));
  assertFlags("`codey copilot login`", {
    force: {}, ...select(auth.auth.subCommands.login.args, ["verbose", "show-token"]), ...globals,
  });
  assertFlags("`codey copilot start`", {
    ...select(start.args, ["host", "port", "verbose", "proxy-env"]), ...globals,
  });
  assert.ok(auth.providers.includes("copilot"));
  assert.equal(start.args.headless.type, "boolean", "Codey always supplies headless internally");
  assert.ok(section("`codey copilot start`").includes("`" + start.args.port.default + "`"));
  assert.doesNotMatch(reference, /^#{2,3} `codey (setup|workspace|gateway|auth|mcp)(?: |`)/m);
});

test("documented Codey-native parameters follow the real parsers, including defaults and equals rejection", () => {
  assertFlags("`codey start`", { host: {}, "workspace-port": {}, "gateway-port": {}, foreground: {}, json: {}, timeout: {} });
  assertFlags("`codey doctor`", { "package-only": {}, "runtime-only": {}, offline: {}, model: {}, json: {} });
  assertFlags("`codey copilot login`", { force: {}, verbose: { alias: "v" }, "show-token": {}, "api-home": {}, "oauth-app": {}, "enterprise-url": {} });
  for (const [command, usage] of Object.entries(MACHINE_USAGE)) {
    if (command === "start") continue; // Foreground options are in the public router, checked above.
    const flags = Object.fromEntries([...usage.matchAll(/--([a-z][a-z0-9-]*)/g)].map(match => [match[1], {}]));
    assertFlags("`codey " + command + "`", flags);
  }
  const environment = { HOST: "127.0.0.2", SERVER_PORT: "3002" };
  assert.deepEqual(commandPlan(["start", "--foreground"], environment).commands, [
    { entry: "bin/codey.mjs", args: ["copilot", "start", "--host", "127.0.0.1", "--port", "4141"] },
    { entry: "lib/workspace.mjs", env: { HOST: "127.0.0.1", SERVER_PORT: "3002" } },
  ]);
  assert.deepEqual(commandPlan(["copilot", "start"], environment).args, ["start", "--headless", "--host", "127.0.0.1", "--port", "4141"]);
  for (const args of [["start", "--host=127.0.0.1"], ["start", "--workspace-port=3001"], ["start", "-p", "3001"],
    ["start", "--port", "3001"], ["workspace"], ["workspace", "--help"]]) assert.throws(() => commandPlan(args));
  for (const args of [["setup"], ["setup", "--help"], ["setup", "--check"]]) assert.throws(() => commandPlan(args));
  assert.deepEqual(commandPlan(["guard", "--timeout", "120", "--json"]),
    { kind: "machine", command: "guard", args: ["--timeout", "120", "--json"] });
  assert.throws(() => doctorOptions(["--fix"]));
  const modes = ["--offline", "--model", "--runtime-only", "--package-only"];
  for (let index = 0; index < modes.length; index++) {
    assert.doesNotThrow(() => doctorOptions([modes[index], "--json"]));
    for (const other of modes.slice(index + 1)) assert.throws(() => doctorOptions([modes[index], other]), /Incompatible/);
  }
  for (const alias of ["--version", "-v", "version"]) assert.equal(commandPlan([alias]).kind, "version");
  for (const command of ["export", "import", "update"]) assert.throws(() => machineOptions(command, []));
  assert.throws(() => machineOptions("export", ["backup.gz", "--check"]), /Invalid option/);
  assert.throws(() => machineOptions("devtunnel login", ["--json"]), /Invalid option/);
});

test("every shell example in the reference parses without running a login, service or model request", () => {
  const examples = [...reference.matchAll(/```sh\n([\s\S]*?)\n```/g)]
    .flatMap(match => match[1].split("\n")).filter(line => line.startsWith("codey "));
  const covered = new Set();
  for (const line of examples) {
    // Examples use only literal arguments and double-quoted paths; no shell evaluation.
    const tokens = line.match(/"[^"]*"|\S+/g).map(token => token.replace(/^"|"$/g, ""));
    assert.equal(tokens.shift(), "codey");
    const plan = commandPlan(tokens, {});
    if (plan.kind === "doctor") doctorOptions(plan.args);
    covered.add(tokens.slice(0, ["copilot", "devtunnel"].includes(tokens[0]) ? 2 : 1).join(" "));
  }
  assert.deepEqual([...covered].sort(),
    [...Object.keys(MACHINE_USAGE), "copilot login", "copilot start", "doctor"].sort());
});

test("documented Copilot examples parse without starting any service or authentication flow", async t => {
  let parser;
  try { parser = await import("../copilot-api/node_modules/citty/dist/index.mjs"); }
  catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") return t.skip("Optional local gateway parser is not installed");
    throw error;
  }
  // Replace every run handler, not just the leaf: citty also calls parent handlers.
  const noSideEffects = command => ({ ...command, run() {},
    subCommands: command.subCommands && Object.fromEntries(
      Object.entries(command.subCommands).map(([name, child]) => [name, noSideEffects(child)])),
  });
  const root = { args: globals, subCommands: Object.fromEntries(
    Object.entries({ start, auth: auth.auth }).map(([name, command]) => [name, noSideEffects(command)])) };
  for (const example of [
    ["copilot", "start", "--api-home", "/absolute/gateway home", "--host", "127.0.0.1", "-p", "4141", "-v", "--proxy-env"],
    ["copilot", "start", "--port=4142", "--no-proxy-env"],
    ["copilot", "login", "--api-home", "/absolute/gateway home"],
    ["copilot", "login", "--api-home=/absolute/gateway home", "--no-show-token"],
    ["copilot", "login", "--force", "--api-home=/absolute/gateway home"],
  ]) {
    const plan = commandPlan(example);
    assert.equal(plan.kind, "gateway");
    await parser.runCommand(root, { rawArgs: plan.args });
  }
  for (const invalid of [
    ["copilot", "start", "--port", "0"], ["copilot", "start", "--port", "65536"],
    ["copilot", "start", "--port", "4e3"], ["copilot", "start", "-p", "4141", "--port=4142"],
    ["copilot", "start", "--no-headless"], ["copilot", "start", "--github-token", "never-pass-secrets"],
    ["copilot", "start", "--claude-code"], ["copilot", "start", "--show-token"], ["copilot", "start", "mcp"],
  ]) {
    assert.throws(() => commandPlan(invalid), Error, invalid.join(" "));
  }
  const options = parser.parseArgs(["--no-headless", "--verbose=false"], start.args);
  assert.equal(options.headless, false);
  assert.equal(options.verbose, false);
});

test("top-level help exposes the expanded command index without importing or starting an application", async () => {
  const { stdout } = await exec(process.execPath, [
    fileURLToPath(new URL("../packages/codey/bin/codey.mjs", import.meta.url)), "--help",
  ]);
  for (const text of ["codey guard", "codey copilot login", "codey copilot start", "--api-home", "--oauth-app", "--enterprise-url",
    "--proxy-env", "onboarding/references/codey-cli.md", "print secrets", "Workspace/CloudCLI"]) assert.ok(stdout.includes(text), text);
  assert.doesNotMatch(stdout, /codey (setup|workspace|gateway|auth|mcp|debug)\b/);
});

test("Copilot startup keeps both model and configured HTTPS usage listeners in one server process", async () => {
  const listeners = [], app = { fetch() {} }, usageHandler = () => {};
  const sourceCode = stripTypeScriptTypes(await source("start.ts"))
    .replace(/^import\b[\s\S]*?\bfrom\s+["'][^"']+["'];?/gm, "")
    .replace(/^export\s+/gm, "")
    .replace('import("./lib/tls")', "Promise.resolve({enableSystemCACompat(){}})")
    .replace('import("./server")', "Promise.resolve({createServer:()=>app})");
  const runServer = runInNewContext(sourceCode + "\nrunServer", {
    defineCommand: value => value, DEFAULT_SERVER_HOST: "127.0.0.1", process: { env: {} },
    consola: { options: {}, info() {}, warn() {}, box() {} }, state: {}, app,
    mergeConfigWithDefaults() {}, getConfiguredApiKeys: () => ["fixture-key"], getConfiguredSessionHistoryApiKeys: () => [],
    resolveServerBinding: hostname => ({ hostname, clientHostname: hostname, networkExposed: false }),
    getMissingApiKeysMessage: () => null, initOpencodeVersion() {}, ensurePaths() {},
    formatServerUrl: (host, port) => `http://${host}:${port}`,
    readGitHubTokenFromEnv: () => null, readGitHubToken: () => null, listEnabledProviders: () => [],
    resolveCodeyHttpsConfig: () => ({ nodeId: "fixture-node", port: 8443, host: "127.0.0.1",
      certPath: "/fixture/cert.pem", keyPath: "/fixture/key.pem", signingKeyFile: "/fixture/signing.key",
      allowedOrigin: "https://portal.example.test" }),
    readFileSync: () => "fixture-signing-key-" + "a".repeat(32),
    createCodeyBrowserHandler: () => usageHandler,
    serve: options => listeners.push(options),
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  const plan = commandPlan(["copilot", "start"]);
  await runServer({ host: plan.args[3], port: Number(plan.args[5]), headless: plan.args.includes("--headless") });
  assert.deepEqual(listeners.map(item => [item.hostname, item.port]), [["127.0.0.1", 4141], ["127.0.0.1", 8443]]);
  assert.equal(listeners[0].fetch, app.fetch);
  assert.equal(listeners[1].fetch, usageHandler);
  assert.equal(listeners[1].tls.cert, "/fixture/cert.pem");
  assert.equal(listeners[1].tls.key, "/fixture/key.pem");
  const server = await source("server.ts");
  for (const [route, handler] of [["/responses", "responsesRoutes"], ["/v1/responses", "responsesRoutes"],
    ["/usage", "usageRoute"], ["/token-usage", "tokenUsageRoute"]]) {
    assert.ok(server.includes(`server.route("${route}", ${handler})`), route);
  }
});
