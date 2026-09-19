#!/usr/bin/env node
// Build-time only. Reuses CloudCLI's TypeScript parser; ships no new dependency.
import { builtinModules, createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const builtins = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, "")]));
const runtimeDirectories = ["bin", "lib", "gateway", "dist-server", "scripts", "onboarding/scripts"];

function packageName(specifier) {
  if (/^(?:[.#/]|[a-z][a-z+.-]*:)/i.test(specifier) || builtins.has(specifier)) return null;
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

function caughtRequire(node, ts) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
    if (ts.isBlock(parent) && ts.isTryStatement(parent.parent) &&
        parent.parent.tryBlock === parent && parent.parent.catchClause) return true;
  }
  return false;
}

function hostProvided(name, file, kind, node, ts) {
  // These were never installed by Codey: Electron supplies its own module;
  // Browser Use installs Playwright explicitly when enabled by the user.
  // Managed Codex uses CODEY_CODEX_EXECUTABLE, not the source-only npm fallback.
  if (!caughtRequire(node, ts)) return false;
  if (name === "@openai/codex") {
    return kind === "resolve" && node.arguments[0].text === "@openai/codex/bin/codex.js" &&
      /^dist-server\/server\/modules\/providers\/list\/codex\/codex-(?:app-server|stdio)\.client\.js$/.test(file);
  }
  return kind === "require" && (
    name === "electron" && /^gateway\/electron-fetch-[^/]+\.js$/.test(file) ||
    name === "playwright" && file === "dist-server/server/modules/browser-use/browser-use.service.js"
  );
}

export function runtimeImports(source, file, ts) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [], loaders = new Set(["require", "__require"]), factories = new Set(["createRequire"]);
  function visit(node, callback) { callback(node); ts.forEachChild(node, child => visit(child, callback)); }
  visit(tree, node => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "node:module") {
      for (const entry of node.importClause?.namedBindings?.elements ?? []) {
        if ((entry.propertyName?.text ?? entry.name.text) === "createRequire") factories.add(entry.name.text);
      }
    }
  });
  const factory = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && factories.has(node.expression.text);
  visit(tree, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && factory(node.initializer)) {
      loaders.add(node.name.text);
    }
  });
  const loader = node => ts.isIdentifier(node) && (loaders.has(node.text) || /^require\$\d+$/.test(node.text)) || factory(node);
  function record(value, node, kind) {
    if (!value || !ts.isStringLiteralLike(value)) return;
    const name = packageName(value.text);
    if (!name || hostProvided(name, file, kind, node, ts)) return;
    imports.push({ name, specifier: value.text, file, line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  }
  visit(tree, node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(node.moduleSpecifier, node, "import");
    if (!ts.isCallExpression(node)) return;
    const target = node.expression;
    if (target.kind === ts.SyntaxKind.ImportKeyword) record(node.arguments[0], node, "import");
    else if (loader(target)) {
      record(node.arguments[0], node, "require");
    } else if (ts.isPropertyAccessExpression(target) && target.name.text === "resolve" && loader(target.expression)) {
      record(node.arguments[0], node, "resolve");
    }
  });
  return imports;
}

export async function checkRuntimeDependencies(root, ts) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }));
  const imports = [];
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Runtime import audit refuses symbolic links");
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "tests", "__tests__"].includes(entry.name)) await scan(file);
      } else if (/\.(?:mjs|cjs|js)$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?js$/.test(entry.name)) {
        imports.push(...runtimeImports(await readFile(file, "utf8"), path.relative(root, file).split(path.sep).join("/"), ts));
      }
    }
  }
  // Parse Node-loaded code only. Browser dist/pages assets are already bundled.
  for (const directory of runtimeDirectories) await scan(path.join(root, directory));
  const used = new Set(imports.map(item => item.name));
  const missing = imports.filter(item => !declared.has(item.name));
  const unused = [...declared].filter(name => !used.has(name)).sort();
  if (missing.length || unused.length) {
    throw new Error("Codey runtime dependency audit failed:\n" + [
      ...missing.map(item => `Undeclared ${item.name}: ${item.file}:${item.line}`),
      ...unused.map(name => `Unused runtime dependency: ${name}`),
    ].join("\n"));
  }
  return { ok: true, dependencies: [...used].sort(), imports: imports.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, compilerRoot, ...extra] = process.argv.slice(2);
    if (!root || !compilerRoot || extra.length) throw new Error("Usage: check-codey-runtime-dependencies.mjs RUNTIME CLOUDCLI_BUILD");
    const ts = createRequire(path.resolve(compilerRoot, "package.json"))("typescript");
    console.log(JSON.stringify(await checkRuntimeDependencies(path.resolve(root), ts)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
