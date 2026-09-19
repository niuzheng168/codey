/** Linux ownership checks and systemd integration; all node setup is shared. */
import { appendFile, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { checkedPath, exists, requireValue } from "./machine-common.mjs";
import { installUnixCommand } from "./platform-unix.mjs";

const services = ["codey-copilot-api.service", "codey-cloudcli.service", "codey-devtunnel.service",
  "codey-devtunnel-renew.service", "codey-devtunnel-renew.timer", "codey-devtunnel-health.service", "codey-devtunnel-health.timer"];
const enabled = services.filter(name => !["codey-devtunnel-renew.service", "codey-devtunnel-health.service"].includes(name));
const safe = value => { requireValue(/^\/[a-zA-Z0-9_./@+-]+$/.test(value), "Linux paths must be free of systemd metacharacters"); return value; };
const environment = value => Object.entries(value).map(([key, val]) => {
  requireValue(/^[A-Z][A-Z0-9_]*$/.test(key) && !/[\r\n\0]/.test(val), "Invalid systemd environment");
  return `${key}=${JSON.stringify(val)}`;
}).join("\n") + "\n";

/** Inspect, never signal, Codex processes. A separate service's CODEX_HOME is not ours. */
export async function assertLinuxCodexAvailable(codexHome, {
  execute, procRoot = "/proc", pid = process.pid, uid = process.getuid(),
} = {}) {
  const candidates = new Set();
  for (const args of [["-x", "codex"], ["-f", "(^|/)[c]odex([.]js)?([[:space:]]|$)"]]) {
    const result = await execute("/usr/bin/pgrep", ["-u", String(uid), ...args], { check: false });
    requireValue(result.code === 0 || result.code === 1, "Cannot inspect running Codex processes");
    if (result.code === 0) {
      const values = result.stdout.trim().split(/\s+/);
      requireValue(values.every(value => /^[1-9][0-9]*$/.test(value)), "Cannot inspect running Codex processes");
      for (const value of values) candidates.add(Number(value));
    }
  }
  if (!candidates.size) return;
  const close = "Close Codex/Desktop yourself for the target CODEX_HOME and use an external terminal";
  requireValue(codexHome, close); // Callers without a verified target retain the conservative check.
  const snapshot = async id => {
    const text = await readFile(path.join(procRoot, String(id), "stat"), "utf8");
    const fields = text.slice(text.lastIndexOf(") ") + 2).trim().split(/\s+/);
    requireValue(fields.length >= 20 && /^\d+$/.test(fields[1]) && /^\d+$/.test(fields[19]),
      "Cannot inspect running Codex processes");
    return { parent: Number(fields[1]), start: fields[19] };
  };
  // Even a different CODEX_HOME must not allow an installer to mutate its own host.
  const visited = new Set();
  for (let current = pid; current > 1 && !visited.has(current);) {
    requireValue(!candidates.has(current), close);
    visited.add(current);
    try { current = (await snapshot(current)).parent; }
    catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  const canonical = async file => {
    requireValue(path.isAbsolute(file), "Cannot determine a running Codex process's CODEX_HOME");
    try { return await realpath(file); }
    catch (error) { if (error.code === "ENOENT") return path.resolve(file); throw error; }
  };
  const target = await canonical(codexHome);
  for (const id of candidates) {
    try {
      const before = await snapshot(id);
      const entries = (await readFile(path.join(procRoot, String(id), "environ"), "utf8")).split("\0");
      const values = Object.fromEntries(entries.filter(entry => /^(?:HOME|CODEX_HOME)=/.test(entry))
        .map(entry => { const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)]; }));
      const home = values.CODEX_HOME || (values.HOME && path.join(values.HOME, ".codex"));
      requireValue(home, "Cannot determine a running Codex process's CODEX_HOME; no process was stopped");
      const actual = await canonical(home);
      requireValue((await snapshot(id)).start === before.start, "Codex process changed during inspection; retry");
      requireValue(actual !== target && !actual.startsWith(target + path.sep) && !target.startsWith(actual + path.sep), close);
    } catch (error) {
      if (error.code === "ENOENT") continue; // It exited while being inspected.
      if (error.code === "EACCES" || error.code === "EPERM") {
        requireValue(false, "Cannot inspect a running Codex process; no process was stopped");
      }
      throw error;
    }
  }
}

// The installer, lifecycle CLI and package switch all use these exact definitions.
export function linuxUnitFiles(config) {
  const home = safe(config.ownerHome), root = safe(config.runtimeRoot), state = safe(config.stateRoot);
  const node = safe(config.nodeExe), entry = safe(config.codeyBin), tunnel = safe(config.devtunnelExe);
  const github = config.tunnelAuth?.source === "gh";
  const worker = `${node} ${safe(path.join(config.codeyDirectory, "lib/tunnel.mjs"))}`;
  const runtime = `${safe(config.configRoot)}/runtime.json`;
  requireValue(/^codey-n-[a-f0-9]{24}\.[a-z][a-z0-9]{1,15}$/.test(config.qualifiedTunnel));
  const commands = {
    "codey-copilot-api.service": `${node} ${entry} copilot start --host 127.0.0.1 --port 4141`,
    "codey-cloudcli.service": `${node} ${safe(path.join(config.codeyDirectory, "lib/workspace.mjs"))}`,
    "codey-devtunnel.service": github ? `${worker} host ${runtime}` :
      `${tunnel} host ${config.qualifiedTunnel} --host-header unchanged --origin-header unchanged`,
    "codey-devtunnel-renew.service": github ? `${worker} renew ${runtime}` : `${node} ${safe(config.helperPath)} renew ${runtime}`,
  };
  const files = {};
  for (const [name, command] of Object.entries(commands)) {
    const app = ["codey-copilot-api.service", "codey-cloudcli.service"].includes(name);
    const oneshot = name === "codey-devtunnel-renew.service";
    files[name] = `[Unit]\nDescription=Codey ${name}\nAfter=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\n` +
      `Type=${oneshot ? "oneshot" : "simple"}\nEnvironment=HOME=${home}\n` +
      (app ? `EnvironmentFile=${safe(config.configRoot)}/${name === "codey-cloudcli.service" ? "cloudcli" : "copilot"}.env\nWorkingDirectory=${safe(config.codeyDirectory)}\n` : "") +
      `ExecStart=${command}\nUMask=0077\n` + (oneshot ? "" : "Restart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n");
  }
  files["codey-devtunnel-renew.timer"] =
    "[Unit]\nDescription=Renew Codey connect token\n[Timer]\nOnActiveSec=30m\nOnUnitActiveSec=6h\nPersistent=true\nUnit=codey-devtunnel-renew.service\n[Install]\nWantedBy=timers.target\n";
  const health = github ? safe(path.join(config.codeyDirectory, "onboarding/scripts/linux-devtunnel-health.mjs")) :
    `${root}/linux-devtunnel-health.mjs`;
  files["codey-devtunnel-health.service"] = "[Unit]\nDescription=Check Codey DevTunnel host connectivity\nAfter=network-online.target\n\n" +
    `[Service]\nType=oneshot\nEnvironment=HOME=${home}\nExecStart=${node} ${health} ${tunnel} ${config.qualifiedTunnel} ${state}/devtunnel-health.json${github ? ` --runtime ${runtime}` : ""}\n` +
    "TimeoutStartSec=45s\nNoNewPrivileges=true\nUMask=0077\n";
  files["codey-devtunnel-health.timer"] = "[Unit]\nDescription=Monitor Codey DevTunnel for disconnected live hosts\n\n" +
    "[Timer]\nOnActiveSec=1min\nOnUnitInactiveSec=1min\nAccuracySec=5s\nUnit=codey-devtunnel-health.service\n\n[Install]\nWantedBy=timers.target\n";
  return files;
}

export function linuxAdapter(i) {
  const units = path.join(i.home, ".config/systemd/user");
  const preflight = path.join(i.skill, "scripts/linux-preflight.sh");
  const shell = async (body, args = []) => i.run("/bin/bash", ["-c", 'set -euo pipefail; source "$1"; ' + body, "codey-native", preflight, ...args]);
  const systemctl = args => i.run("/usr/bin/systemctl", ["--user", ...args]);
  let existingPackage = "", existingNode = "";
  const adapter = {
    startup: "systemd user services with linger",
    directories: [units],
    helpers: [],
    async nodePath(file) {
      const resolved = await realpath(file);
      if (resolved.startsWith(i.home + path.sep)) return checkedPath(resolved, i.home);
      requireValue(/^\/(?:usr|opt)\//.test(resolved), "Use an owner-private or root-managed Node installation");
      for (let cursor = resolved; cursor !== "/"; cursor = path.dirname(cursor)) {
        const info = await lstat(cursor);
        requireValue(info.uid === 0 && !(info.mode & 0o022), "System Node must not be writable by other users");
      }
      return file;
    },
    copilot: path.join(i.home, ".local/share/copilot-api"),
    data: path.join(i.home, ".local/share/codey-data/cloudcli"),
    devtunnel: path.join(i.home, ".local/share/codey-tools/devtunnel/devtunnel"),
    async inspect() {
      safe(i.home);
      const result = await shell('codey_linux_preflight; printf "\\nCODEY_RUNTIME=%s\\nCODEY_NODE=%s\\n" "$CODEY_EXISTING_PACKAGE" "$CODEY_EXISTING_NODE"');
      existingPackage = /^CODEY_RUNTIME=(.*)$/m.exec(result.stdout)?.[1] ?? "";
      existingNode = /^CODEY_NODE=(.*)$/m.exec(result.stdout)?.[1] ?? "";
    },
    async ports() {
      const result = await shell("codey_check_ports");
      const owned = new Set([...result.stdout.matchAll(/\[preflight\] Port (3001|4141|8443): verified owner-managed Codey/g)]
        .map(match => Number(match[1])));
      return [3001, 4141, 8443].map(port => ({ port, status: owned.has(port) ? "owned-codey" : "free" }));
    },
    async available(codexHome) {
      await assertLinuxCodexAvailable(codexHome, { execute: i.run });
      await i.run("/usr/bin/openssl", ["version"]);
      if ((await i.run("/usr/bin/loginctl", ["show-user", String(process.getuid()), "-p", "Linger", "--value"])).stdout.trim() !== "yes") {
        await i.run("/usr/bin/sudo", ["-n", "true"]);
      }
    },
    async ready(config) {
      requireValue(existingPackage === config.codeyDirectory && existingNode === config.nodeExe,
        "Runtime descriptor and owned systemd services disagree");
      for (const name of ["copilot.env", "cloudcli.env"]) await checkedPath(path.join(i.configRoot, name), i.home);
    },
    async existing(codexHome) {
      if (!existingPackage) return null;
      const values = {};
      for (const name of ["provider.env", "copilot.env", "cloudcli.env"]) {
        const file = await checkedPath(path.join(i.configRoot, name), i.home);
        for (const line of (await readFile(file, "utf8")).trim().split("\n")) {
          const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
          requireValue(match, "Invalid legacy environment; review it explicitly");
          values[match[1]] = match[2]; // Read data only. Never source a legacy environment file.
        }
      }
      const identityFile = path.join(i.state, "identity.json"), identity = await i.read(identityFile);
      requireValue(values.COPILOT_API_CODEY_ALLOWED_ORIGIN === i.setup.portalOrigin &&
        values.COPILOT_API_CODEY_NODE_ID === identity.nodeId && values.CODEX_HOME === codexHome,
      "Existing node configuration differs; no update or reconfiguration was attempted");
      const tunnelFile = path.join(i.configRoot, "tunnel.json");
      const raw = await i.read(tunnelFile), tunnel = raw.tunnel ?? raw;
      return { ...i.attemptIdentity(), schema: 2, layout: "npm-codey-package", computer: i.computer,
        nodeId: identity.nodeId, releaseId: i.setup.releaseId, runtimeRoot: i.root, configRoot: i.configRoot,
        stateRoot: i.state, releaseDirectory: path.resolve(existingPackage, "../../.."), codeyDirectory: existingPackage,
        codeyBin: path.join(existingPackage, "bin/codey.mjs"), nodeExe: existingNode, devtunnelExe: adapter.devtunnel,
        codeyEntrySha256: i.manifest.codey.entrySha256, identityFile, certificate: path.join(i.configRoot, "node-cert.pem"),
        serverName: `${identity.nodeId}.nodes.codey.internal`, tunnelFile,
        qualifiedTunnel: tunnel.tunnelId.includes(".") ? tunnel.tunnelId : `${tunnel.tunnelId}.${tunnel.clusterId}`,
        codexExe: values.CODEY_CODEX_EXECUTABLE, codexHome, modelKey: (await i.read(path.join(adapter.copilot, "config.json"))).auth.apiKeys[0],
        setupFile: path.join(existingPackage, "onboarding/setup.json"), helperPath: path.join(i.skill, "scripts/windows-runtime.mjs"),
        registrationHelper: path.join(i.skill, "scripts/registration.mjs"),
        environment: { ...i.baseEnvironment(existingNode), ...values }, baseEnvironment: i.baseEnvironment(existingNode),
        state: "ready", ready: true, legacy: true };
    },
    async configure(config) {
      for (const file of [config.nodeExe, config.codeyDirectory, config.devtunnelExe, config.codexExe]) safe(file);
      const env = { ...config.environment, HOST: "127.0.0.1", SERVER_PORT: "3001" };
      for (const name of ["copilot.env", "cloudcli.env"]) await i.write(path.join(i.configRoot, name), Buffer.from(environment(env)));
      await i.write(path.join(i.configRoot, "provider.env"), Buffer.from(`CODEY_MODEL_API_KEY=${config.modelKey}\n`));
    },
    async start(config, previous, started) {
      requireValue(!previous, "Failed Linux services require explicit cleanup before reinstalling; no service takeover");
      for (const name of services) requireValue(!await exists(path.join(units, name)), "Existing systemd unit collision");
      for (const [name, text] of Object.entries(linuxUnitFiles(config))) await i.write(path.join(units, name), Buffer.from(text));
      await i.write(path.join(i.root, "linux-devtunnel-health.mjs"),
        await readFile(path.join(i.skill, "scripts/linux-devtunnel-health.mjs")));
      if ((await i.run("/usr/bin/loginctl", ["show-user", String(process.getuid()), "-p", "Linger", "--value"])).stdout.trim() !== "yes") {
        await i.run("/usr/bin/sudo", ["-n", "loginctl", "enable-linger", osUsername()]);
      }
      await systemctl(["daemon-reload"]);
      for (const name of enabled) {
        started.push(name);
        await systemctl(["enable", "--now", name]);
      }
    },
    async stop(config, started) { for (const name of [...started].reverse()) await systemctl(["disable", "--now", name]); },
    async status(config) {
      const result = [];
      for (const [name, text] of Object.entries(linuxUnitFiles(config))) {
        const file = await i.checked(path.join(units, name));
        requireValue(await readFile(file, "utf8") === text, `Unrecognized service definition: ${name}`);
        const shown = await systemctl(["show", name,
          "--property=FragmentPath,DropInPaths,ActiveState,SubState,UnitFileState,MainPID"]);
        const values = Object.fromEntries(shown.stdout.trim().split("\n").map(line => {
          const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
        }));
        requireValue(values.FragmentPath === file && !values.DropInPaths, `Overridden service: ${name}`);
        result.push({ name, component: name.startsWith("codey-devtunnel") ? "tunnel" : "codey",
          auxiliary: !enabled.includes(name), enabled: values.UnitFileState === "enabled",
          running: ["active", "activating", "reloading"].includes(values.ActiveState),
          state: values.ActiveState, pid: Number(values.MainPID) || null });
      }
      return result;
    },
    async setStates(config, desired) {
      const before = await adapter.status(config);
      requireValue(desired.every(item => before.some(old => old.name === item.name)), "Unknown Codey service");
      // Stop timers before their jobs/host so a watchdog cannot undo an intentional stop.
      for (const item of [...desired].reverse().filter(item => !item.running)) {
        const old = before.find(value => value.name === item.name);
        if (!item.enabled && old.enabled) await systemctl(["disable", item.name]);
        await systemctl(["stop", item.name]);
      }
      for (const item of desired) {
        const old = before.find(value => value.name === item.name);
        if (!old.auxiliary && item.enabled !== old.enabled) await systemctl([item.enabled ? "enable" : "disable", item.name]);
        if (item.running && !old.running) await systemctl(["start", item.name]);
      }
    },
    async switchPackage(before, after) {
      await adapter.status(before);
      const files = linuxUnitFiles(after);
      const previous = linuxUnitFiles(before), changed = [];
      try {
        for (const name of Object.keys(files).filter(name => files[name] !== previous[name])) {
          changed.push(name);
          await i.write(path.join(units, name), Buffer.from(files[name]));
        }
        await systemctl(["daemon-reload"]);
      } catch (error) {
        for (const name of changed) await i.write(path.join(units, name), Buffer.from(previous[name]));
        await systemctl(["daemon-reload"]);
        throw error;
      }
    },
    async verify(config) {
      await adapter.inspect();
      await adapter.ready(config);
      for (const name of enabled) {
        requireValue((await systemctl(["is-enabled", name])).stdout.trim() === "enabled" &&
          (await systemctl(["is-active", name])).stdout.trim() === "active", `${name} is not enabled and active`);
      }
      const host = await readFile(path.join(units, "codey-devtunnel.service"), "utf8");
      requireValue(config.tunnelAuth?.source === "gh" ? host === linuxUnitFiles(config)["codey-devtunnel.service"] :
        host.split("\n").includes(`ExecStart=${config.devtunnelExe} host ${config.qualifiedTunnel} --host-header unchanged --origin-header unchanged`),
        "Tunnel service belongs to another configuration");
      requireValue((await i.run("/usr/bin/loginctl", ["show-user", String(process.getuid()), "-p", "Linger", "--value"])).stdout.trim() === "yes",
        "User linger is not enabled");
    },
    async command(config, { fresh } = {}) {
      if (config.legacy) return; // Never rewrite an existing command or its environment on acceptance-only runs.
      await installUnixCommand(i, config);
      if (!fresh) return;
      for (const name of [".profile", ".bashrc"]) {
        const file = path.join(i.home, name);
        const text = await readFile(file, "utf8");
        if (!text.includes("# >>> Codey model API >>>")) await appendFile(file,
          `\n# >>> Codey model API >>>\nif [ -r "${i.configRoot}/provider.env" ]; then\n  . "${i.configRoot}/provider.env"\n  export CODEY_MODEL_API_KEY\nfi\n# <<< Codey model API <<<\n`);
      }
    },
    resources: () => services.map(name => ({ kind: "systemd-user", name, path: path.join(units, name) })),
  };
  return adapter;
}

const osUsername = () => os.userInfo().username;
