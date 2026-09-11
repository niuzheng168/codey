import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { RUNTIME_PLATFORMS } from "../packages/codey/lib/package-info.mjs";

export const digest = value => createHash("sha256").update(value).digest("hex");
const source = new URL("../packages/codey/", import.meta.url);
export const jsonFile = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

export async function treeFiles(root, prefix = "") {
  const result = new Map();
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = [prefix, item.name].filter(Boolean).join("/");
    if (item.isDirectory()) for (const [file, body] of await treeFiles(root, name)) result.set(file, body);
    else result.set(name, await readFile(path.join(root, name)));
  }
  return result;
}

export function tarEntries(entries) {
  const chunks = [];
  for (const { name, body = Buffer.alloc(0), type = "0", link = "" } of entries) {
    const data = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(link, 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

export async function fingerprint(root) {
  const files = await treeFiles(root);
  const lock = files.get("npm-shrinkwrap.json");
  const pkg = JSON.parse(files.get("package.json"));
  const build = {
    schema: 1, name: "codey", version: pkg.version, sourceCommit: pkg.version.startsWith("1.") ? "a".repeat(40) : "b".repeat(40),
    runtimePlatforms: RUNTIME_PLATFORMS,
    cloudcli: { version: pkg.version, commit: "c".repeat(40) }, copilotApi: { version: pkg.version, commit: "d".repeat(40) },
    lockSha256: digest(lock),
    workspaceEntrySha256: digest(files.get("dist-server/server/index.js")),
    gatewayEntrySha256: digest(files.get("gateway/main.js")),
  };
  const content = createHash("sha256");
  for (const name of [...files.keys()].filter(name => name !== "codey-build.json").sort()) {
    content.update(name + "\0");
    content.update(Buffer.from(digest(files.get(name)), "hex"));
  }
  build.contentSha256 = content.digest("hex");
  await jsonFile(path.join(root, "codey-build.json"), build);
  return build;
}

export async function packageFixture(root, version) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await cp(new URL("lib/", source), path.join(root, "lib"), { recursive: true });
  await cp(new URL("bin/", source), path.join(root, "bin"), { recursive: true });
  const pkg = {
    name: "codey", version, type: "module", bin: { codey: "bin/codey.mjs" },
    engines: { node: ">=22.13.0" }, dependencies: {}, optionalDependencies: {},
  };
  await jsonFile(path.join(root, "package.json"), pkg);
  await jsonFile(path.join(root, "npm-shrinkwrap.json"), {
    name: "codey", version, lockfileVersion: 3,
    packages: { "": { ...pkg } },
  });
  for (const name of ["dist-server/server/index.js", "gateway/main.js", "dist/index.html", "pages/index.html"]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), `// Synthetic ${version} package; no real server/model.\n`);
  }
  // The real CLI/router/installer run; only native-module probes are synthetic in this dependency-free fixture.
  await writeFile(path.join(root, "lib/doctor.mjs"),
    `import { readPackageInfo } from "./package-info.mjs";\nexport async function runDoctor(root) {
      const info = await readPackageInfo(root); console.log(JSON.stringify({ok:true,version:info.pkg.version,fixture:true}));
    }\n`);
  await fingerprint(root);
  return root;
}

export async function packFixture(root, file, extra = []) {
  const entries = [...await treeFiles(root)].map(([name, body]) => ({ name: "package/" + name, body }));
  await writeFile(file, tarEntries([...entries, ...extra]));
  return file;
}

export async function updateFixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codey local update 中文 "));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, "owner home");
  await mkdir(home, { mode: 0o700 });
  const old = await packageFixture(path.join(home, ".local/lib/node_modules/codey"), "1.0.0");
  const next = await packageFixture(path.join(temp, "new package"), "2.0.0");
  const archive = await packFixture(next, path.join(temp, "codey-2.0.0.tgz"));
  return { temp, home, old, next, archive };
}
