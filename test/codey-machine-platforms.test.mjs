import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { linuxAdapter, linuxUnitFiles } from "../skills/config-new-codey-machine/scripts/platform-linux.mjs";
import { macosAdapter } from "../skills/config-new-codey-machine/scripts/platform-macos.mjs";
import { agentDefinition, COMPONENTS, label, plist } from "../skills/config-new-codey-machine/scripts/macos-service.mjs";
import { managedFixture } from "./helpers/managed-node-fixture.mjs";
import { runMachine } from "../packages/codey/lib/machine.mjs";
const exec = promisify(execFile);

test("real Linux adapter validates every unit and disables timers before stopping jobs/host", async t => {
  const f = await managedFixture(t), units = path.join(f.home, ".config/systemd/user");
  await f.i.directory(units);
  const definitions = linuxUnitFiles(f.config), states = new Map(), calls = [];
  assert.ok(definitions["codey-cloudcli.service"].split("\n").includes(
    `ExecStart=${f.config.nodeExe} ${path.join(f.config.codeyDirectory, "lib/workspace.mjs")}`));
  for (const [name, text] of Object.entries(definitions)) {
    await f.i.write(path.join(units, name), Buffer.from(text));
    states.set(name, { running: !name.endsWith("renew.service") && !name.endsWith("health.service"),
      enabled: !name.endsWith("renew.service") && !name.endsWith("health.service") });
  }
  f.i.run = async (file, args) => {
    assert.equal(file, "/usr/bin/systemctl");
    assert.equal(args[0], "--user");
    const [operation, name] = args.slice(1);
    if (operation === "daemon-reload") return { stdout: "", code: 0 };
    const state = states.get(name); assert.ok(state);
    if (operation === "show") return { stdout: `FragmentPath=${path.join(units, name)}\nDropInPaths=\nActiveState=${state.running ? "active" : "inactive"}\nSubState=running\nUnitFileState=${state.enabled ? "enabled" : "disabled"}\nMainPID=0\n`, code: 0 };
    calls.push([operation, name]);
    if (operation === "disable" || operation === "enable") state.enabled = operation === "enable";
    if (operation === "stop" || operation === "start") state.running = operation === "start";
    return { stdout: "", code: 0 };
  };
  const adapter = linuxAdapter(f.i), original = await adapter.status(f.config);
  f.i.adapter = adapter;
  t.mock.method(console, "log", () => {});
  await adapter.setStates(f.config, original.map(item => ({ ...item, running: false, enabled: false })));
  assert.ok([...states.values()].every(item => !item.running && !item.enabled));
  const stopped = calls.filter(item => item[0] === "stop").map(item => item[1]);
  assert.ok(stopped.indexOf("codey-devtunnel-health.timer") < stopped.indexOf("codey-devtunnel-health.service"));
  assert.ok(stopped.indexOf("codey-devtunnel-renew.timer") < stopped.indexOf("codey-devtunnel.service"));
  await runMachine(f.app, "guard", [], { open: async () => f.m });
  assert.equal((await adapter.status(f.config)).filter(item => !item.auxiliary).every(item => item.running && item.enabled), true);
  assert.deepEqual(calls.filter(item => item[0] === "start").map(item => item[1]), [
    "codey-copilot-api.service", "codey-cloudcli.service", "codey-devtunnel.service",
    "codey-devtunnel-renew.timer", "codey-devtunnel-health.timer",
  ], "Guard starts native supervisors/timers, not one-shot maintenance jobs or extra processes");
  const guarded = calls.length;
  await runMachine(f.app, "guard", [], { open: async () => f.m });
  assert.equal(calls.length, guarded, "Repeated guard must not restart or re-enable running units");
  const next = { ...f.config, codeyDirectory: path.join(f.i.root, "releases/new/app"), codeyBin: path.join(f.i.root, "releases/new/app/bin/codey.mjs") };
  await adapter.switchPackage(f.config, next);
  for (const name of ["codey-copilot-api.service", "codey-cloudcli.service"]) {
    assert.equal(await readFile(path.join(units, name), "utf8"), linuxUnitFiles(next)[name]);
  }
  await adapter.switchPackage(next, f.config);
  await writeFile(path.join(units, "codey-devtunnel-health.service"), "unowned job\n");
  const before = calls.length;
  await assert.rejects(adapter.setStates(f.config, original), /Unrecognized service/);
  assert.equal(calls.length, before, "Validate all definitions before changing any unit");
});

test("real macOS adapter bootouts disabled jobs, starts idempotently and never rewrites LaunchAgents", async t => {
  const f = await managedFixture(t, "macos-arm64"), definitions = new Map(), states = new Map(), calls = [];
  f.config.workerPath = path.join(f.i.root, "supervisor/macos-service.mjs");
  const adapter = macosAdapter(f.i);
  await f.i.directory(f.i.agents);
  for (const component of COMPONENTS) {
    const name = label(f.config.nodeId, component), file = path.join(f.i.agents, name + ".plist");
    definitions.set(file, agentDefinition(f.config, f.i.file, component));
    await f.i.write(file, plist(definitions.get(file)));
    states.set(name, { loaded: true, enabled: true });
  }
  f.i.run = async (executable, args) => {
    if (executable === "/usr/bin/plutil") return { stdout: JSON.stringify(definitions.get(args.at(-1))), code: 0 };
    assert.equal(executable, "/bin/launchctl");
    const [action, target] = args;
    if (action === "print-disabled") return { stdout: [...states].filter(([, item]) => !item.enabled).map(([name]) => `"${name}" => true`).join("\n"), code: 0 };
    const name = (action === "bootstrap" ? path.basename(args[2], ".plist") : target.split("/").at(-1));
    const state = states.get(name); assert.ok(state);
    if (action === "print") return { code: state.loaded ? 0 : 113,
      stdout: state.loaded ? `path = ${path.join(f.i.agents, name + ".plist")}\npid = 1234\n` : "" };
    calls.push(action);
    if (action === "disable" || action === "enable") state.enabled = action === "enable";
    if (action === "bootout" || action === "bootstrap") state.loaded = action === "bootstrap";
    return { code: 0, stdout: "" };
  };
  const before = await adapter.status(f.config);
  await adapter.setStates(f.config, before.map(item => ({ ...item, enabled: false, running: false })));
  assert.ok([...states.values()].every(item => !item.loaded && !item.enabled));
  await adapter.setStates(f.config, before);
  const changes = calls.length;
  await adapter.setStates(f.config, before);
  assert.equal(calls.length, changes);
  assert.equal(calls.filter(item => item === "bootstrap").length, 3);
  definitions.values().next().value.ProgramArguments = ["/foreign/worker"];
  await assert.rejects(adapter.setStates(f.config, before), /another installation/);
});

test("real PowerShell task-state and binary writer logic, without native services/registry", {
  skip: !process.env.CODEY_TEST_PWSH,
}, async () => {
  const { stdout } = await exec(process.env.CODEY_TEST_PWSH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./windows-lifecycle-fixture.ps1", import.meta.url)),
    "-Common", fileURLToPath(new URL("../skills/config-new-codey-machine/scripts/windows-common.ps1", import.meta.url))],
  { timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.match(stdout, /WINDOWS_LIFECYCLE_OK/);
});
