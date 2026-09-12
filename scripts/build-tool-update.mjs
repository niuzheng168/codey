// Wrap an independently verified, extracted vendor distribution. No download or execution.
import { chmod, copyFile, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectToolPackage, payloadNames, TOOL_BASELINE, toolEntry, validateToolManifest,
} from "../packages/codey/lib/tool-update-package.mjs";
import { fileHash, hash, inside } from "../packages/codey/lib/update-files.mjs";

export async function buildToolUpdate({ component, platform, version, source, output }) {
  source = await realpath(source);
  output = path.resolve(output);
  if (source === output || inside(source, output) || inside(output, source)) throw new Error("Use a new output outside the vendor directory.");
  const entry = toolEntry(component, platform);
  const files = Object.create(null);
  for (const name of await payloadNames(source)) {
    const file = path.join(source, name), info = await lstat(file);
    files[name] = { sha256: await fileHash(file), size: info.size,
      executable: name === entry || platform === "linux-x64" && Boolean(info.mode & 0o111) || /\.exe$/i.test(name) };
  }
  const manifest = validateToolManifest({
    schema: 1, kind: "codey-tool-update", component, platform, version,
    minimumCodeyVersion: TOOL_BASELINE, entry, files,
  });
  await mkdir(output, { mode: 0o700 }); // Refuse an existing bundle/release directory.
  for (const [name, item] of Object.entries(files)) {
    const target = path.join(output, "files", name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(source, name), target);
    await chmod(target, item.executable ? 0o700 : 0o600);
    if (await fileHash(target) !== item.sha256) throw new Error("Vendor files changed during packaging.");
  }
  const filename = path.join(output, "tool-update.json");
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(filename, bytes, { mode: 0o600, flag: "wx" });
  const sha256 = hash(bytes);
  await inspectToolPackage(filename, sha256, { component, platform });
  await writeFile(path.join(output, "tool-update.json.sha256"), `${sha256}  tool-update.json\n`, { mode: 0o600, flag: "wx" });
  return { component, platform, version, manifest: filename, sha256, files: Object.keys(files).length,
    downloaded: false, executed: false, published: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const name = process.argv[index]?.slice(2), value = process.argv[index + 1];
      if (!["component", "platform", "version", "source", "output"].includes(name)
          || !process.argv[index].startsWith("--") || !value || options[name]) throw new Error("Use --component --platform --version --source --output.");
      options[name] = value;
    }
    if (Object.keys(options).length !== 5) throw new Error("Specify all five options; use a reviewed extracted vendor directory.");
    console.log(JSON.stringify(await buildToolUpdate(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
