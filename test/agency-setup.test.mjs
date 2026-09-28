import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AGENCY_SERVERS, agencyMcpEnvironment } from "../packages/codey/lib/agency-mcp.mjs";
import { configureAgency } from "../packages/codey/lib/agency-setup.mjs";
import { commandPlan } from "../packages/codey/lib/cli.mjs";

const exec = promisify(execFile);
const packageRoot = new URL("../packages/codey/", import.meta.url);
const privateText = "PRIVATE-FIXTURE-CONTENT-MUST-NOT-ESCAPE";

async function fixture(t, fail) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agency-package-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = path.join(home, "config.toml");
  const original = '# retained\nmodel_provider = "existing"\n[mcp_servers.other]\ncommand = "keep"\n';
  await writeFile(configPath, original);
  const calls = [], closed = [];
  const implementations = {
    resolve: async name => ({ command: path.join(home, `${name} fixture`), version: "fixture" }),
    Client: class {
      constructor(command, args, options) {
        this.service = args[1];
        assert.deepEqual(args, ["mcp", this.service]);
        for (const [key, value] of Object.entries(agencyMcpEnvironment())) assert.equal(options.env[key], value);
      }
      async initialize() {
        if (fail === this.service) throw new Error("fixture authentication failed");
        return { serverInfo: { name: "fixture", version: "1" } };
      }
      async listTools() {
        return [...AGENCY_SERVERS[this.service].tools, "NewUnreviewedTool"].map(name => ({
          name, inputSchema: { type: "object", properties: {} },
        }));
      }
      async request(method, params) {
        assert.equal(method, "tools/call");
        assert.ok(AGENCY_SERVERS[this.service].tools.includes(params.name));
        calls.push([this.service, params.name]);
        let data;
        if (this.service === "teams") data = { value: [{ hitsContainers: [{ hits: [] }] }] };
        else if (params.name === "SearchMessagesQueryParameters") data = { value: [{ id: privateText, isRead: false }] };
        else data = { id: privateText, isRead: false, bodyPreview: privateText };
        return { structuredContent: data, isError: false };
      }
      async close() { closed.push(this.service); }
    },
    validate: async (codex, contents) => {
      assert.match(contents, /mcp_servers\.agency_teams/);
      assert.match(contents, /mcp_servers\.agency_mail/);
      assert.equal(await readFile(configPath, "utf8"), original);
      if (fail === "validation") throw new Error("fixture native validation failed");
    },
  };
  return { home, configPath, original, calls, closed, implementations };
}

test("packaged Agency setup routes independently from the gateway or managed node", () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    assert.deepEqual(commandPlan(["agency", ...args]), { kind: "agency", args: ["--help"] });
  }
  assert.deepEqual(commandPlan(["agency", "setup", "--apply", "--verify-read"]), {
    kind: "agency", args: ["--apply", "--verify-read"],
  });
  for (const action of ["login", "send", "start"]) assert.throws(() => commandPlan(["agency", action]), /Use codey agency setup/);
});

test("package-only Agency help needs no source checkout, native dependencies, credentials or servers", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-agency-relocated-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL("lib", packageRoot), path.join(root, "lib"), { recursive: true });
  await cp(new URL("bin", packageRoot), path.join(root, "bin"), { recursive: true });
  const home = path.join(root, "home");
  await mkdir(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"),
    AGENCY_BIN: path.join(root, "missing-agency"), CODEX_BIN: path.join(root, "missing-codex") };
  for (const args of [["agency"], ["agency", "setup", "--help"]]) {
    const { stdout } = await exec(process.execPath, [path.join(root, "bin/codey.mjs"), ...args], { cwd: home, env });
    assert.match(stdout, /Usage: codey agency setup/);
    assert.match(stdout, /browser-login commands/);
  }
  for (const args of [["--timeout", "0"], ["--unknown"], ["--timeout", "601"]]) {
    await assert.rejects(exec(process.execPath, [path.join(root, "bin/codey.mjs"), "agency", "setup", ...args], { cwd: home, env }),
      error => error.code === 1 && /"ok":false/.test(error.stderr) && !/ERR_MODULE_NOT_FOUND/.test(error.stderr));
  }
  assert.deepEqual(await readdir(home), []);
  const { stdout } = await exec(process.execPath, [
    fileURLToPath(new URL("../scripts/configure-agency-mcp.mjs", import.meta.url)), "--help",
  ], { cwd: home, env });
  assert.match(stdout, /Usage: codey agency setup/);
});

test("default setup only discovers; explicit verify-read checks both services without returning private content", async t => {
  const f = await fixture(t);
  const options = { "codex-home": f.home };
  const plan = await configureAgency(options, f.implementations);
  assert.equal(plan.mode, "plan");
  assert.equal(plan.changed, false);
  assert.equal(plan.wouldChange, true);
  assert.deepEqual(f.calls, []);
  const verified = await configureAgency({ ...options, "verify-read": true }, f.implementations);
  assert.deepEqual(verified.servers.map(s => s.readProbe.returnedItems), [0, 1]);
  assert.equal(verified.servers[1].readProbe.messageRead, true);
  assert.doesNotMatch(JSON.stringify(verified), new RegExp(privateText));
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
  assert.deepEqual(await readdir(f.home), ["config.toml"]);
});

test("setup forwards its timeout to both executable version probes and both MCP clients", async t => {
  const f = await fixture(t);
  for (const [extra, expected] of [[{}, 120000], [{ timeout: "60" }, 60000]]) {
    const resolved = [], started = [];
    const FakeClient = f.implementations.Client;
    await configureAgency({ "codex-home": f.home, ...extra }, {
      ...f.implementations,
      resolve: async (name, options) => {
        resolved.push(name);
        assert.equal(options.timeoutMs, expected);
        return f.implementations.resolve(name);
      },
      Client: class extends FakeClient {
        constructor(command, args, options) {
          super(command, args, options);
          started.push(args[1]);
          assert.equal(options.timeoutMs, expected);
        }
      },
    });
    assert.deepEqual(resolved, ["agency", "codex"]);
    assert.deepEqual(started, ["teams", "mail"]);
  }
});

test("apply validates both services before backing up, retains other settings and reapplies idempotently", async t => {
  const f = await fixture(t);
  const options = { "codex-home": f.home, apply: true, "verify-read": true };
  const result = await configureAgency(options, f.implementations);
  assert.equal(result.changed, true);
  assert.equal(await readFile(result.backupPath, "utf8"), f.original);
  const updated = await readFile(f.configPath, "utf8");
  assert.ok(updated.startsWith(f.original));
  assert.equal(result.servers[0].enabledTools.length, 15);
  assert.equal(result.servers[1].enabledTools.length, 5);
  const again = await configureAgency(options, { ...f.implementations, validate: async () => {} });
  assert.equal(again.changed, false);
  assert.equal((await readdir(f.home)).length, 2);
});

for (const failure of ["teams", "mail", "validation"]) {
  test(`${failure} failure preserves original config and closes all started clients`, async t => {
    const f = await fixture(t, failure);
    await assert.rejects(configureAgency({ "codex-home": f.home, apply: true }, f.implementations), /fixture/);
    assert.equal(await readFile(f.configPath, "utf8"), f.original);
    assert.deepEqual(await readdir(f.home), ["config.toml"]);
    assert.deepEqual(f.closed, failure === "teams" ? ["teams"] : ["teams", "mail"]);
  });
}
