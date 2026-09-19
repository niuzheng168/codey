import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeImports, checkRuntimeDependencies } from "../scripts/check-codey-runtime-dependencies.mjs";

let ts;
try { ts = createRequire(new URL("../cloudcli/package.json", import.meta.url))("typescript"); }
catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
const needsCompiler = { skip: ts ? false : "Install CloudCLI build dependencies for the emitted-JS audit tests" };

test("runtime audit sees static/lazy imports, subpaths and createRequire aliases, not comments or strings", needsCompiler, () => {
  const imports = runtimeImports(`
    import fs from "node:fs";
    import { createRequire as makeLoader } from "node:module";
    import { Codex } from "#codey/codex-sdk";
    import "shared-pkg/init";
    export { api } from "@scope/client/api";
    await import("lazy-provider");
    const req_ = makeLoader(import.meta.url);
    req_("native-addon");
    req_.resolve("resolver/package.json");
    makeLoader(import.meta.url).resolve("another-resolver");
    // import "comment-only";
    const example = 'require("example-only")';
  `, "lib/fixture.mjs", ts);
  assert.deepEqual(imports.map(item => item.name).sort(), [
    "@scope/client", "another-resolver", "lazy-provider", "native-addon", "resolver", "shared-pkg",
  ]);
});

test("only guarded host-provided imports at reviewed locations are exempt", needsCompiler, () => {
  const body = `function optional() { try { return require("playwright"); } catch { return null; } }`;
  const browser = "dist-server/server/modules/browser-use/browser-use.service.js";
  assert.deepEqual(runtimeImports(body, browser, ts), []);
  assert.equal(runtimeImports(body, "lib/unreviewed.mjs", ts)[0].name, "playwright");
  assert.equal(runtimeImports('import "playwright";', browser, ts)[0].name, "playwright");
  assert.equal(runtimeImports('require("playwright");', browser, ts)[0].name, "playwright");
  assert.deepEqual(runtimeImports('try { require("electron"); } catch {}', "gateway/electron-fetch-fixture.js", ts), []);
  assert.equal(runtimeImports('import "electron";', "gateway/electron-fetch-fixture.js", ts)[0].name, "electron");
  const codexFile = "dist-server/server/modules/providers/list/codex/codex-stdio.client.js";
  assert.deepEqual(runtimeImports(`import { createRequire } from "node:module";
    try { createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"); } catch {}`, codexFile, ts), []);
  assert.equal(runtimeImports(`try { require("@openai/codex"); } catch {}`, codexFile, ts)[0].name, "@openai/codex");
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-dependency-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["bin", "lib", "gateway", "dist-server", "scripts", "onboarding/scripts", "dist", "pages"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  const put = async (file, body) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  await put("package.json", JSON.stringify({ dependencies: { server: "1", native: "1" } }));
  await put("gateway/main.js", 'import "server";');
  await put("dist-server/server/platform.js", 'if (process.platform === "win32") await import("native");');
  await put("dist/browser.js", 'import "react";');
  await put("pages/browser.js", 'import "mermaid";');
  await put("dist-server/server/tests/example.test.js", 'import "test-only";');
  return { root, put };
}

test("audit excludes browser/test assets but includes inactive Windows/macOS branches", needsCompiler, async t => {
  const f = await fixture(t);
  assert.deepEqual((await checkRuntimeDependencies(f.root, ts)).dependencies, ["native", "server"]);
  await f.put("lib/mac.mjs", 'if (process.platform === "darwin") await import("missing-macos");');
  await assert.rejects(checkRuntimeDependencies(f.root, ts), /Undeclared missing-macos: lib\/mac.mjs:1/);
});

test("audit rejects missing runtime packages and reintroduced frontend dependencies", needsCompiler, async t => {
  const f = await fixture(t);
  await f.put("package.json", JSON.stringify({ dependencies: { native: "1", react: "1" } }));
  await assert.rejects(checkRuntimeDependencies(f.root, ts), error =>
    /Undeclared server/.test(error.message) && /Unused runtime dependency: react/.test(error.message));
});
