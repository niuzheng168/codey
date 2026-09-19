// Isolated fixture for the real shared workflow. Only native commands/network are replaced.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Installer } from "../../skills/config-new-codey-machine/scripts/install-machine.mjs";
import { agentDefinition } from "../../skills/config-new-codey-machine/scripts/macos-service.mjs";
import { digest, readPrivate, writePrivate } from "../../skills/config-new-codey-machine/scripts/machine-common.mjs";
import { registrationDocument, writeRegistration } from "../../skills/config-new-codey-machine/scripts/registration.mjs";
import { packageFixture, packFixture } from "../codey-update-fixture.mjs";
const execute = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonFile = async file => JSON.parse(await readFile(file, "utf8"));
const source = fileURLToPath(new URL("../../skills/config-new-codey-machine", import.meta.url));
const computer = "fixture-mac";
export async function machineFixture(t, target = "macos-arm64") {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "codey-mac-node-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, "owner's home 中文"), skill = path.join(temp, "skill"), assets = path.join(skill, "assets");
  await mkdir(home, { mode: 0o700 });
  await cp(source, skill, { recursive: true });
  await mkdir(assets, { recursive: true });
  const mac = target.startsWith("macos-"), windows = target === "windows-x64", arch = target.split("-")[1];
  const pinFile = mac ? "dependencies.macos.json" : windows ? "dependencies.windows.json" : "dependencies.json";
  const rawPins = await jsonFile(path.join(skill, pinFile));
  const pins = mac ? rawPins : { nodeVersion: rawPins.node.version, platforms: { [target]: rawPins } };
  const nodeArchive = Buffer.from("verified fixture Node archive"), tunnelBinary = Buffer.from("fixture native tunnel");
  pins.platforms[target].node.sha256 = hash(nodeArchive);
  pins.platforms[target].devTunnel.sha256 = hash(tunnelBinary);
  await writePrivate(path.join(skill, pinFile), rawPins);
  const appSource = await packageFixture(path.join(temp, "synthetic-application"), "0.1.16");
  const build = await readFile(path.join(appSource, "codey-build.json"));
  const lock = await readFile(path.join(appSource, "npm-shrinkwrap.json"));
  const pkg = JSON.parse(await readFile(path.join(appSource, "package.json")));
  const tgzFile = await packFixture(appSource, path.join(assets, "codey-0.1.16.tgz"));
  const tgz = await readFile(tgzFile);
  const setup = { schema: 1, portalOrigin: "https://codey.example.test", releaseId: "machine-" + hash(build).slice(0, 16),
    platform: "linux-x64", network: { mode: "devtunnel" }, tunnelAuthProvider: "github" };
  const manifest = { schema: 2, name: "codey", platform: "linux-x64", releaseId: setup.releaseId,
    runtimePlatforms: ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"],
    bundledRuntimes: ["cloudcli", "copilot-api"], dependencyMode: "npm-codey-package",
    codey: { version: "0.1.16", entrySha256: hash(build), lockSha256: hash(lock) },
    artifacts: [{ file: "codey-0.1.16.tgz", size: tgz.length, sha256: hash(tgz) }] };
  await writePrivate(path.join(assets, "manifest.json"), manifest);
  await writePrivate(path.join(assets, "setup.json"), setup);
  await writeFile(path.join(assets, "codey-0.1.16.tgz"), tgz);
  const refreshSums = async () => {
    const rows = [];
    for (const name of ["codey-0.1.16.tgz", "manifest.json", "setup.json"]) rows.push(`${await digest(path.join(assets, name))}  ${name}`);
    await writeFile(path.join(assets, "SHA256SUMS"), rows.join("\n") + "\n");
  };
  await refreshSums();
  const f = { temp, home, skill, assets, setup, manifest, pins, build, lock, refreshSums, calls: [], native: [], answer: "CODEY_CODEX_OK" };
  f.machineId = "12345678-1234-1234-1234-123456789abc";
  const createFile = async (file, bytes) => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode: 0o700 });
  };
  const runner = async (file, args, options = {}) => {
    f.calls.push({ file, args, options });
    const ok = stdout => ({ code: 0, stdout: stdout || "", stderr: "" });
    if (file === "/usr/sbin/sysctl") return ok("0");
    if (file === "/usr/sbin/ioreg") return ok(`"IOPlatformUUID" = "${f.machineId}"`);
    if (file === "/usr/bin/codesign") { if (f.badSignature) throw new Error("invalid OpenAI signature"); return ok(); }
    if (file === "/usr/bin/lipo") return ok(arch === "arm64" ? "arm64" : "x86_64");
    if (file === "/usr/bin/pgrep") return { ...ok(), code: 1 };
    if (file === "/usr/bin/openssl") {
      if (args[0] === "version") return ok("fixture");
      const result = await execute(file, args);
      return ok(result.stdout);
    }
    if (file === "/usr/bin/curl") {
      const url = args.at(-1), destination = args[args.indexOf("--output") + 1];
      await createFile(destination, url === pins.platforms[target].node.url ? nodeArchive :
        url === pins.platforms[target].devTunnel.url ? tunnelBinary : Buffer.from("# fixture https://releases.openai.com/codex\n"));
      return ok();
    }
    if (file === "/usr/bin/tar") {
      await createFile(path.join(args[args.indexOf("-C") + 1], `node-v${pins.nodeVersion}-${mac ? "darwin" : windows ? "win" : "linux"}-${arch}/${windows ? "node.exe" : "bin/node"}`), "fixture Node");
      return ok();
    }
    if (file === "/usr/bin/plutil") {
      const config = await readPrivate(f.installer.file);
      const component = args.at(-1).split(".").at(-2);
      assert.match(await readFile(args.at(-1), "utf8"), /<plist version="1.0">[\s\S]*<\/plist>/);
      return ok(JSON.stringify(agentDefinition(config, f.installer.file, component)));
    }
    if (file === "/bin/launchctl") {
      if (args[0] === "print-disabled") return ok("{}");
      if (args[0] === "print" && args[1] !== f.installer.domain) {
        return ok(`path = ${path.join(f.installer.agents, args[1].split("/").at(-1) + ".plist")}\npid = 1234\n`);
      }
      if (args[0] === "bootstrap" && f.failBootstrap && args.at(-1).endsWith("." + f.failBootstrap + ".plist")) {
        throw new Error("fixture LaunchAgent failure");
      }
      return ok();
    }
    if (file === "/bin/bash" || file === "/fixture/powershell.exe") {
      if (mac) {
        const root = path.join(options.env.CODEX_HOME, "packages/standalone/releases",
          `0.152.0-${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`);
        await f.createCodex(root);
        for (const name of ["codex", "codex-code-mode-host"]) {
          await symlink(path.join(root, "bin", name), path.join(options.env.CODEX_INSTALL_DIR, name));
        }
      } else await createFile(path.join(options.env.CODEX_INSTALL_DIR, windows ? "codex.exe" : "codex"), "fixture Codex");
      return ok();
    }
    if (args[0] === "--version") return ok(path.basename(file).startsWith("codex") ? `codex-cli ${mac ? "0.152.0" : "fixture"}\n` : `v${pins.nodeVersion}\n`);
    if (args[0]?.endsWith("install-runtime.mjs")) {
      const app = path.join(args[args.indexOf("--prefix") + 1], windows ? "node_modules/codey" : "lib/node_modules/codey");
      await mkdir(path.dirname(app), { recursive: true, mode: 0o700 });
      await cp(appSource, app, { recursive: true });
      await mkdir(path.join(app, "node_modules"), { recursive: true });
      if (f.failNpm) throw new Error("fixture npm failure");
      return ok();
    }
    if (path.basename(file).startsWith("devtunnel")) {
      if (f.failTunnel) throw new Error("fixture tunnel login failure");
      if (args[0] === "user") return ok(JSON.stringify({ status: "Logged in", provider: "github" }));
      const id = args[1].split(".")[0];
      return ok(JSON.stringify({ tunnelId: id, clusterId: "jpe1",
        ports: [3001, 8443].map(portNumber => ({ portNumber, protocol: "https" })) }));
    }
    if (args[0]?.endsWith("windows-runtime.mjs")) {
      if (["verify", "registration"].includes(args[1]) && f.failVerify) throw new Error("fixture TLS/SSO failure");
      if (args[1] === "registration") {
        const config = await readPrivate(args[2]), identity = await readPrivate(config.identityFile);
        const coordinates = { tunnelId: `codey-${config.nodeId}`, clusterId: "jpe1" };
        const token = ["e30", Buffer.from(JSON.stringify({ ...coordinates, scp: "connect",
          exp: Math.floor(Date.now() / 1000) + 72000 })).toString("base64url"), "c2ln"].join(".");
        await writeRegistration(path.join(home, "codey-machine-registration.json"), registrationDocument(
          { ...setup, platform: target }, identity, coordinates, token, await readFile(config.certificate, "utf8"), computer));
      }
      return ok();
    }
    if (args[0] === "exec") {
      await writeFile(args[args.indexOf("--output-last-message") + 1], f.answer);
      return ok();
    }
    if (args[1] === "copilot" && args[2] === "login") {
      if (f.failAuthentication) throw new Error("fixture GitHub HTTP 401");
      if (f.occupyAfterAuth) f.blockPort = 8443;
      return ok();
    }
    if (args[1] === "doctor" && args.includes("--runtime-only")) {
      if (f.failNative) throw new Error("fixture native dependency failure");
      return ok('{"ok":true}');
    }
    assert.fail("Unexpected fixture command: " + path.basename(file));
  };
  f.createCodex = async root => {
    for (const name of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/resource"]) {
      await createFile(path.join(root, name), "fixture official " + name);
    }
    await writePrivate(path.join(root, "codex-package.json"), { layoutVersion: 1, version: "0.152.0",
      target: `${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`, variant: "codex",
      entrypoint: "bin/codex", resourcesDir: "codex-resources", pathDir: "codex-path" });
    await symlink("bin/codex", path.join(root, "codex"));
  };
  const fakeNative = i => ({
    startup: "fixture native services", directories: [], helpers: [],
    async inspect() { if (windows) i.ownerSid = "S-1-5-21-fixture"; },
    async available() {}, async ready() {},
    async download(item, destination) { await runner("/usr/bin/curl", ["--output", destination, item.url]); },
    async extract(archive, destination) { await runner("/usr/bin/tar", ["-C", destination]); },
    async certificate(serverName, cert, key) {
      await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365", "-subj", "/CN=" + serverName,
        "-addext", "subjectAltName=DNS:" + serverName, "-addext", "basicConstraints=critical,CA:FALSE", "-out", cert, "-keyout", key]);
      await Promise.all([cert, key].map(file => chmod(file, 0o600)));
    },
    async configure(config) { config.powershellExe = "/fixture/powershell.exe"; },
    async start(config) { f.native.push("start"); if (f.failStart) throw new Error("native startup failed"); },
    async stop(config, started) { if (started.length) f.native.push("stop"); },
    async verify() { f.native.push("verify"); },
    async command(config) {
      const file = windows ? path.join(i.root, "bin/codey.ps1") : path.join(home, ".local/bin/codey");
      await createFile(file, "# fixture native command");
    },
    resources: config => [{ kind: "fixture-service", name: "codey-" + config.nodeId, path: path.join(i.root, "supervisor/service") }],
  });
  f.installer = new Installer(skill, { home, platform: mac ? "darwin" : windows ? "win32" : "linux", arch, computer, execute: runner,
    ...(mac ? {} : { adapter: fakeNative }), auth: { github: async () => null },
    portCheck: async port => { if (f.blockPort === port) throw new Error("foreign or unverified listener"); return { port, status: "free" }; },
    diskUsage: async () => ({ bavail: 16 * 1024 ** 3, bsize: 1 }), pause: async () => {} });
  f.options = { apply: true, "network-approved": true, "expected-computer": computer, "codex-home": path.join(home, ".codex") };
  return f;
}
