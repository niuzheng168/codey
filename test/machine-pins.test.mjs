import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPins } from "../skills/config-new-codey-machine/scripts/machine-package.mjs";
import { Installer } from "../skills/config-new-codey-machine/scripts/install-machine.mjs";
import { machineFixture } from "./helpers/machine-installer-fixture.mjs";

const source = fileURLToPath(new URL("../skills/config-new-codey-machine/", import.meta.url));
async function fixture(t) {
  const skill = await mkdtemp(path.join(os.tmpdir(), "codey-pins-"));
  t.after(() => rm(skill, { recursive: true, force: true }));
  for (const name of ["dependencies.json", "dependencies.windows.json", "dependencies.macos.json"]) {
    await cp(path.join(source, name), path.join(skill, name));
  }
  return skill;
}

for (const target of ["windows-x64", "linux-x64", "macos-arm64", "macos-x64"]) {
  const pinFile = target.startsWith("macos-") ? "dependencies.macos.json" :
    target === "windows-x64" ? "dependencies.windows.json" : "dependencies.json";
  const platformPins = raw => raw.platforms?.[target] ?? raw;

  test(`${target}: current DevTunnel ignores legacy SHA pins; immutable Node pins stay intact`, async t => {
    const skill = await fixture(t);
    const file = path.join(skill, pinFile);
    const raw = JSON.parse(await readFile(file, "utf8"));
    const original = platformPins(raw);
    assert.equal(original.devTunnel.sha256, undefined);
    assert.equal((await readPins(skill, target)).node.sha256, original.node.sha256);
    for (const legacyHash of ["0".repeat(64), "an-old-invalid-pin"]) {
      platformPins(raw).devTunnel.sha256 = legacyHash;
      await writeFile(file, JSON.stringify(raw));
      const actual = await readPins(skill, target);
      assert.equal(Object.hasOwn(actual.devTunnel, "sha256"), false);
      assert.equal(actual.node.sha256, original.node.sha256);
    }
  });

  test(`${target}: removing the rolling hash does not allow other URLs or an unchecked Node archive`, async t => {
    const skill = await fixture(t), file = path.join(skill, pinFile);
    const raw = JSON.parse(await readFile(file, "utf8"));
    for (const mutate of [
      pins => { pins.devTunnel.url = pins.devTunnel.url.replace("https:", "http:"); },
      pins => { pins.devTunnel.url = "https://example.test/devtunnel"; },
      pins => { pins.devTunnel.url += "?mirror=unreviewed"; },
      pins => { pins.node.sha256 = ""; },
      pins => { pins.node.url = "https://example.test/node.zip"; },
    ]) {
      const changed = structuredClone(raw);
      mutate(platformPins(changed));
      await writeFile(file, JSON.stringify(changed));
      await assert.rejects(readPins(skill, target), /Invalid official runtime pins/);
    }
  });

  if (target === "windows-x64") continue;
  test(`${target}: refreshed official bytes download over HTTPS, but corrupt Node bytes still fail`, async t => {
    const skill = await fixture(t), file = path.join(skill, pinFile);
    const raw = JSON.parse(await readFile(file, "utf8"));
    platformPins(raw).devTunnel.sha256 = "0".repeat(64); // Legacy release, no longer current.
    await writeFile(file, JSON.stringify(raw));
    const pins = await readPins(skill, target);
    const destination = path.join(skill, "devtunnel"), bytes = Buffer.from("refreshed official fixture");
    await writeFile(destination, "stale partial download");
    const requests = [];
    const context = {
      adapter: {},
      run: async (executable, args) => {
        assert.equal(executable, "/usr/bin/curl");
        assert.equal(args[args.indexOf("--proto") + 1], "=https");
        assert.equal(args[args.indexOf("--proto-redir") + 1], "=https");
        requests.push(args.at(-1));
        await writeFile(args[args.indexOf("--output") + 1], bytes);
      },
    };
    await Installer.prototype.download.call(context, pins.devTunnel, destination);
    assert.deepEqual(await readFile(destination), bytes);
    assert.deepEqual(requests, [pins.devTunnel.url]);
    if (process.platform !== "win32") assert.equal((await stat(destination)).mode & 0o777, 0o700);
    await assert.rejects(Installer.prototype.download.call(context, pins.node, path.join(skill, "node-archive")),
      /Official runtime checksum mismatch/);
  });
}

test("Windows workflow accepts refreshed bytes only after the signature step and records their actual hash",
  { skip: process.platform === "win32" }, async t => {
    const f = await machineFixture(t, "windows-x64");
    let verified = false;
    const execute = f.installer.run;
    f.installer.run = async (file, args, options) => {
      if (path.basename(file).startsWith("devtunnel")) assert.equal(verified, true, "Never run DevTunnel before verifying its signature");
      return execute(file, args, options);
    };
    f.installer.adapter.verifyTunnelBinary = async file => {
      assert.equal((await readFile(file)).toString(), "fixture native tunnel");
      assert.equal(f.installer.pins.devTunnel.sha256, undefined);
      verified = true;
    };
    const config = await f.installer.apply(f.options);
    assert.equal(verified, true);
    assert.match(config.fileHashes.devtunnelExe, /^[a-f0-9]{64}$/);
  });

test("Windows signature failure stops before DevTunnel login or service startup",
  { skip: process.platform === "win32" }, async t => {
    const f = await machineFixture(t, "windows-x64");
    f.installer.adapter.verifyTunnelBinary = async () => { throw new Error("DevTunnel Authenticode verification failed."); };
    await assert.rejects(f.installer.apply(f.options), /Authenticode verification failed/);
    assert.equal(f.calls.some(call => path.basename(call.file).startsWith("devtunnel")), false);
    assert.equal(f.native.includes("start"), false);
  });
