import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// These suites exercise durable filesystem journals, including real fsync.
// Disk-backed isolated CI homes can take >30s without a failed assertion.
// Bound the suite, not the application's idle/health/recovery timeouts.
const serviceSuiteTimeout = 120000;

test("Linux local service switching, busy/concurrent guards and recovery are isolated", {
  timeout: serviceSuiteTimeout, skip: process.platform === "win32",
}, async () => {
  const output = await promisify(execFile)(process.env.PYTHON || "python3", [
    "-I", "-B", "test/test_codey_local_update.py",
  ], { timeout: serviceSuiteTimeout - 5000, maxBuffer: 1024 * 1024 });
  assert.match(output.stderr, /OK/);
});

test("Linux tool switching, companion validation, CLI/tunnel isolation and recovery are isolated", {
  timeout: serviceSuiteTimeout, skip: process.platform === "win32",
}, async () => {
  const output = await promisify(execFile)(process.env.PYTHON || "python3", [
    "-I", "-B", "test/test_codey_tool_update.py",
  ], { timeout: serviceSuiteTimeout - 5000, maxBuffer: 1024 * 1024 });
  assert.match(output.stderr, /OK/);
});

test("the native Windows update adapter changes no tool, helper, model configuration or non-Codey task", async () => {
  const source = await readFile(new URL("../packages/codey/lib/update-windows.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Install-CodeyTasks|Repair-CodeyWindowsServices|Install-CodeyTaskHost|Stop-Process|taskkill|Invoke-WebRequest|Set-ExecutionPolicy/);
  const switches = source.split("\n").filter(line => /^\s*Set-CodeyTaskState\b/.test(line));
  assert.ok(switches.length >= 4);
  assert.ok(switches.every(line => /@\('codey'\)/.test(line)));
  assert.match(source, /Local\\CodeyWindowsInstall-/);
  assert.match(source, /Assert-Protected \$request.plan.protected/);
  assert.match(source, /Concurrent runtime change/);
  assert.match(source, /runtime-before\.json/);
  assert.match(source, /runtime-after\.json/);
  assert.doesNotMatch(source, /\$home\b/i, "PowerShell's automatic HOME variable is read-only, including function parameters.");
});

const powershell = process.env.CODEY_TEST_POWERSHELL ||
  (process.platform === "win32" && process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe") : null);
test("PowerShell parses the complete adapter and exercises native descriptor/rollback logic with mocked tasks", {
  skip: !powershell, timeout: 30000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey Windows update 中文 "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = await promisify(execFile)(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./windows-local-update-fixture.ps1", import.meta.url)),
    "-Root", root, "-Source", fileURLToPath(new URL("../packages/codey/lib/update-windows.ps1", import.meta.url)),
  ], { timeout: 29000, maxBuffer: 1024 * 1024, windowsHide: true });
  const result = JSON.parse(output.stdout);
  assert.equal(result.passed, true);
  assert.equal(result.nativeServices, false);
  assert.equal(result.models, false);
});

test("native Windows tool adapter retains pinned helpers, login, identity and explicitly scoped tasks", async () => {
  const source = await readFile(new URL("../packages/codey/lib/tool-update-windows.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Install-CodeyTasks|Repair-CodeyWindowsServices|Install-CodeyTaskHost|Stop-Process|taskkill|Invoke-WebRequest|Set-ExecutionPolicy/);
  assert.match(source, /Local\\CodeyWindowsInstall-/);
  assert.match(source, /allowDisconnect -eq \$true/);
  assert.match(source, /Assert-ToolPayload \$request \$job/);
  assert.match(source, /\[IO.Directory\]::Delete\(\$anchor, \$false\)/);
  assert.match(source, /beforeHash -eq \$request.plan.configHash/);
  assert.match(source, /Assert-Protected \$request.plan.protected/);
  assert.match(source, /\$toolAction = \$Action[\s\S]*-Library[\s\S]*\$Action = \$toolAction/);
});

test("PowerShell tool descriptors, scoped rollback and interrupted CLI directory switches use isolated fixtures", {
  skip: !powershell, timeout: 30000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey Windows tool 中文 "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = await promisify(execFile)(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./windows-tool-update-fixture.ps1", import.meta.url)),
    "-Root", root,
    "-Source", fileURLToPath(new URL("../packages/codey/lib/tool-update-windows.ps1", import.meta.url)),
    "-Library", fileURLToPath(new URL("../packages/codey/lib/update-windows.ps1", import.meta.url)),
  ], { timeout: 29000, maxBuffer: 1024 * 1024, windowsHide: true });
  const result = JSON.parse(output.stdout);
  assert.equal(result.passed, true);
  assert.equal(result.nativeServices, false);
  assert.equal(result.models, false);
});
