/** Windows ACLs, process jobs, certificates and Task Scheduler adapter. */
import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { digest, requireValue } from "./machine-common.mjs";

export function windowsAdapter(i) {
  const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const native = path.join(i.skill, "scripts/windows-native.ps1"), execute = i.run;
  const invoke = async request => {
    const result = await execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", native],
      { input: JSON.stringify(request), timeout: (request.timeout ?? 180) * 1000 + 30000 });
    return JSON.parse(result.stdout.trim());
  };
  i.run = async (executable, args, options = {}) => {
    const request = { operation: "run", executable, arguments: args, environment: options.env ?? {},
      cwd: options.cwd ?? i.home, timeout: Math.ceil((options.timeout ?? 180000) / 1000),
      interactive: Boolean(options.interactive), allowFailure: options.check === false,
      replaceEnvironment: Boolean(options.replaceEnvironment) };
    if (!options.interactive) return invoke(request);
    // Interactive children inherit the actual console. Put the private request
    // in the existing ACL-protected config directory, never in command arguments.
    const file = path.join(i.configRoot, "native-" + randomBytes(12).toString("hex") + ".json");
    await i.write(file, request);
    try {
      await execute(powershell, ["-NoLogo", "-NoProfile", "-File", native, "-RequestFile", file],
        { interactive: true, timeout: request.timeout * 1000 + 30000 });
      return { code: 0, stdout: "", stderr: "" };
    } finally { await unlink(file); }
  };
  return {
    startup: "owner logon Task Scheduler watchdogs",
    directories: [],
    helpers: ["windows-common.ps1", "windows-process.cs", "windows-service.ps1"],
    checked: file => invoke({ operation: "path", file, private: false }),
    directory: file => invoke({ operation: "directory", file }),
    async read(file) {
      await invoke({ operation: "path", file, private: true });
      return JSON.parse(await readFile(file, "utf8"));
    },
    write: (file, value) => invoke({ operation: "write", file,
      bytes: (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2) + "\n")).toString("base64") }),
    private: file => invoke({ operation: "path", file, private: true }),
    async inspect() {
      const owner = await invoke({ operation: "owner" });
      requireValue(owner.Home.toLowerCase() === i.home.toLowerCase() && owner.Computer.toLowerCase() === i.computer.toLowerCase(),
        "Run as the original Windows owner");
      i.computer = owner.Computer;
      i.ownerSid = owner.Sid;
    },
    async ports(previous) {
      const listeners = await invoke({ operation: "ports", previous });
      return [3001, 4141, 8443].map(port => ({
        port, status: (listeners ?? []).some(item => item.LocalPort === port) ? "owned-codey" : "free",
      }));
    },
    available: () => invoke({ operation: "available" }),
    async ready(config) {
      for (const [name, expected] of Object.entries(config.helperHashes ?? {})) {
        const file = path.join(i.root, "supervisor", name);
        await i.checked(file);
        requireValue(await digest(file) === expected, "Native watchdog fingerprint mismatch");
      }
      for (const [name, expected] of Object.entries(config.fileHashes ?? {})) {
        await i.checked(config[name]);
        requireValue(await digest(config[name]) === expected, "Native tool fingerprint mismatch");
      }
    },
    download: (item, destination) => invoke({ operation: "download", url: item.url, sha256: item.sha256 ?? "", destination, timeout: 330 }),
    extract: (archive, destination) => invoke({ operation: "extract", archive, destination }),
    verifyTunnelBinary: file => invoke({ operation: "signature", file }),
    certificate: (serverName, certificate, key) => invoke({ operation: "certificate", node: process.execPath, serverName, certificate, key }),
    environment: node => {
      const keep = /^(?:systemroot|windir|comspec|temp|tmp|username|userdomain|userprofile|homedrive|homepath|appdata|localappdata|programdata|programfiles(?:\(x86\))?|https?_proxy|no_proxy|node_extra_ca_certs)$/i;
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => keep.test(name))),
        PATH: path.dirname(node) + path.delimiter + process.env.PATH,
        NODE_ENV: "production", NODE_USE_SYSTEM_CA: "1", ELECTRON_SKIP_BINARY_DOWNLOAD: "1" };
      return env;
    },
    async configure(config) {
      const supervisor = path.join(i.root, "supervisor");
      config.powershellExe = powershell;
      config.runnerPath = path.join(supervisor, "windows-service.ps1");
      config.taskHostExe = await invoke({ operation: "task-host", directory: supervisor });
      config.registrationStaging = path.join(i.configRoot, "registration-export.json");
      config.codexStandaloneRoot = path.join(i.root, "codex-install");
      config.services = {
        codey: { executable: config.nodeExe, arguments: [config.codeyBin, "start", "--foreground", "--host", "127.0.0.1",
          "--workspace-port", "3001", "--gateway-port", "4141"], workingDirectory: config.codeyDirectory, environment: config.environment },
        tunnel: { executable: config.tunnelAuth?.source === "gh" ? config.nodeExe : config.devtunnelExe,
          arguments: config.tunnelAuth?.source === "gh" ? [path.join(config.codeyDirectory, "lib/tunnel.mjs"), "host", i.file] :
            ["host", config.qualifiedTunnel, "--host-header", "unchanged", "--origin-header", "unchanged"],
          workingDirectory: config.releaseDirectory, environment: config.baseEnvironment },
        renew: { executable: config.nodeExe, arguments: [config.tunnelAuth?.source === "gh" ?
          path.join(config.codeyDirectory, "lib/tunnel.mjs") : config.helperPath, "renew", i.file],
          workingDirectory: config.releaseDirectory, environment: config.baseEnvironment },
      };
      config.helperHashes = {};
      for (const name of ["windows-common.ps1", "windows-process.cs", "windows-service.ps1", "windows-runtime.mjs",
        "registration.mjs", "machine-common.mjs", "github-auth.mjs", "github-tunnel.mjs",
        "codey-task-host.exe"]) config.helperHashes[name] = await digest(path.join(supervisor, name));
    },
    async start(config, previous, started) {
      started.push("tasks");
      await invoke({ operation: "start", config, previous, file: i.file });
    },
    async stop(config, started) {
      if (started.length) await invoke({ operation: "stop", config, file: i.file });
    },
    status: config => invoke({ operation: "service-status", config, file: i.file }),
    setStates: (config, states) => invoke({ operation: "service-state", config, file: i.file, states }),
    switchPackage: async () => {}, // Task actions use the stable runtime.json; no task is re-registered.
    external: () => invoke({ operation: "external" }),
    modelKey: key => invoke({ operation: "model-key", key }),
    verify: config => invoke({ operation: "verify", config, file: i.file }),
    command: (config, { fresh } = {}) => invoke({ operation: "command", config, file: i.file, fresh: Boolean(fresh) }),
    async exportRegistration(config, output) {
      await i.write(output, await readFile(config.registrationStaging));
      await unlink(config.registrationStaging);
    },
    resources: config => ["codey", "tunnel", "renew"].map(component => ({
      kind: "scheduled-task", name: `Codey Machine ${config.nodeId} ${component}`, path: config.runnerPath, ownerSid: i.ownerSid,
    })),
  };
}
