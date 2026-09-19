/** macOS native ownership, sockets and LaunchAgents only; no installation workflow. */
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { InstallationError, checkedPath, exists, requireValue, run, writePrivate } from "./machine-common.mjs";
import { COMPONENTS, agentDefinition, label, plist, runtime } from "./macos-service.mjs";
import { installUnixCommand } from "./platform-unix.mjs";
async function freePort(port) {
  for (const host of ["0.0.0.0", "::"]) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", error => {
        if (host === "::" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) resolve();
        else reject(new InstallationError(`Port ${port} is occupied or cannot be inspected; installation stopped`));
      });
      server.listen({ port, host, ipv6Only: host === "::" }, () => server.close(resolve));
    });
  }
}
export async function macPortPreflight(port, previous, { execute = run, bind = freePort, uid = process.getuid() } = {}) {
  const failure = `Port ${port} is occupied by a foreign or unverified listener; installation stopped. No process was killed.`;
  // lsof's field output is independent of localized headings and includes both
  // address families. If a listener is hidden from this user, bind fails closed.
  const snapshot = await execute("/usr/sbin/lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpun"], { check: false });
  requireValue([0, 1].includes(snapshot.code) && !snapshot.stderr.trim(), `Cannot inspect port ${port}; installation stopped`);
  const listeners = [];
  let pid, owner;
  for (const line of snapshot.stdout.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); owner = undefined; }
    else if (line.startsWith("u")) owner = Number(line.slice(1));
    else if (line.startsWith("n")) listeners.push({ pid, owner, address: line.slice(1) });
  }
  if (!listeners.length) {
    await bind(port);
    return { port, status: "free" };
  }
  requireValue(previous && previous.ownerUid === uid && previous.codeyBin === path.join(previous.codeyDirectory, "bin/codey.mjs"), failure);
  const commands = (port === 3001 ? [path.join(previous.codeyDirectory, "lib/workspace.mjs"),
    `${previous.codeyBin} workspace --host 127.0.0.1 --port 3001`] :
    [`${previous.codeyBin} copilot start --host 127.0.0.1 --port 4141`,
      `${previous.codeyBin} gateway start --headless --host 127.0.0.1 --port 4141`])
    .map(command => `${previous.nodeExe} ${command}`);
  const pids = new Set();
  for (const listener of listeners) {
    requireValue(Number.isSafeInteger(listener.pid) && listener.pid > 0 && listener.owner === uid &&
      [`127.0.0.1:${port}`, `[::1]:${port}`].includes(listener.address), failure);
    if (pids.has(listener.pid)) continue;
    const ps = async field => {
      // macOS ps escapes non-printable characters using the current locale.
      // Keep ordinary Unicode installation paths readable even in a C shell locale.
      const result = await execute("/bin/ps", ["-ww", "-p", String(listener.pid), "-o", field + "="],
        { check: false, env: { ...process.env, LC_ALL: "en_US.UTF-8" } });
      requireValue(result.code === 0, failure);
      return result.stdout.trim();
    };
    // Legacy argv is recognized only for ownership, never exposed as a runnable alias.
    requireValue(await ps("uid") === String(uid) && await ps("comm") === previous.nodeExe &&
      commands.includes(await ps("command")), failure);
    pids.add(listener.pid);
  }
  return { port, status: "owned-codey", pids: [...pids] };
}
export function macosAdapter(i) {
  i.agents = path.join(i.home, "Library/LaunchAgents");
  i.domain = `gui/${process.getuid()}`;
  const adapter = {
    startup: "owner GUI logon LaunchAgents",
    directories: [i.agents],
    helpers: ["macos-service.mjs"],
    async inspect() {
      const translated = await i.run("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], { check: false });
      requireValue(translated.stdout.trim() !== "1", "Use a native terminal/Node, not Rosetta");
      await i.run("/bin/launchctl", ["print", i.domain]);
    },
    async ready(config) { await runtime(i.file, { home: i.home, worker: config.workerPath }); },
    async available() {
      const codex = await i.run("/usr/bin/pgrep", ["-u", String(process.getuid()), "-x", "codex"], { check: false });
      requireValue(codex.code === 1, "Close Codex/Desktop and use an external Mac terminal first");
      await i.run("/usr/bin/openssl", ["version"]);
    },
    port: (port, previous) => macPortPreflight(port, previous, { execute: i.run }),
    configure: config => { config.workerPath = path.join(config.runtimeRoot, "supervisor/macos-service.mjs"); },
    async start(config, previous, started) {
      for (const component of COMPONENTS) {
        const file = path.join(i.agents, label(config.nodeId, component) + ".plist");
        if (await exists(file)) {
          await checkedPath(file, i.home);
          const saved = JSON.parse((await i.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file])).stdout);
          requireValue(previous && isDeepStrictEqual(saved, agentDefinition(previous, i.file, component)), "Existing LaunchAgent collision");
        }
      }
      for (const component of COMPONENTS) {
        const id = label(config.nodeId, component), file = path.join(i.agents, id + ".plist");
        await writePrivate(file, plist(agentDefinition(config, i.file, component)));
        started.push(id);
        await i.run("/bin/launchctl", ["enable", i.domain + "/" + id]);
        await i.run("/bin/launchctl", ["bootstrap", i.domain, file]);
      }
    },
    async stop(config, started) {
      for (const id of [...started].reverse()) {
        await i.run("/bin/launchctl", ["disable", i.domain + "/" + id], { check: false });
        await i.run("/bin/launchctl", ["bootout", i.domain + "/" + id], { check: false });
      }
    },
    async status(config) {
      const disabled = (await i.run("/bin/launchctl", ["print-disabled", i.domain])).stdout;
      const result = [];
      for (const component of COMPONENTS) {
        const name = label(config.nodeId, component), file = await i.checked(path.join(i.agents, name + ".plist"));
        const saved = JSON.parse((await i.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file])).stdout);
        requireValue(isDeepStrictEqual(saved, agentDefinition(config, i.file, component)), "LaunchAgent belongs to another installation");
        const shown = await i.run("/bin/launchctl", ["print", i.domain + "/" + name], { check: false });
        const loaded = shown.code === 0;
        if (loaded) requireValue(/^\s*path = (.+)$/m.exec(shown.stdout)?.[1] === file, "LaunchAgent path mismatch");
        const pid = Number(/^\s*pid = ([1-9][0-9]*)$/m.exec(shown.stdout)?.[1]) || null;
        result.push({ name, component: component === "codey" ? "codey" : "tunnel",
          auxiliary: false, enabled: !disabled.includes(`"${name}" => true`), loaded, pid,
          running: loaded && (component === "renew" || Boolean(pid)), state: loaded ? pid ? "running" : "waiting" : "stopped" });
      }
      return result;
    },
    async setStates(config, desired) {
      const before = await adapter.status(config);
      requireValue(desired.every(item => before.some(old => old.name === item.name)), "Unknown Codey LaunchAgent");
      for (const item of [...desired].reverse()) {
        const old = before.find(value => value.name === item.name), target = i.domain + "/" + item.name;
        if (item.enabled !== old.enabled) await i.run("/bin/launchctl", [item.enabled ? "enable" : "disable", target]);
        if (!item.running && old.loaded) await i.run("/bin/launchctl", ["bootout", target]);
      }
      for (const item of desired.filter(item => item.running)) {
        const old = before.find(value => value.name === item.name), target = i.domain + "/" + item.name;
        if (!item.enabled && !old.running) await i.run("/bin/launchctl", ["enable", target]);
        if (!old.loaded) await i.run("/bin/launchctl", ["bootstrap", i.domain, path.join(i.agents, item.name + ".plist")]);
        else if (!old.running) await i.run("/bin/launchctl", ["kickstart", target]);
        if (!item.enabled && !old.running) await i.run("/bin/launchctl", ["disable", target]);
      }
    },
    async switchPackage(before, after) {
      await adapter.status(before);
      const changed = [];
      try {
        for (const component of COMPONENTS) {
          const old = agentDefinition(before, i.file, component), next = agentDefinition(after, i.file, component);
          if (isDeepStrictEqual(old, next)) continue;
          const file = path.join(i.agents, label(before.nodeId, component) + ".plist");
          changed.push({ file, old });
          await i.write(file, plist(next));
        }
      } catch (error) {
        for (const { file, old } of changed) await i.write(file, plist(old));
        throw error;
      }
    },
  async verify(config) {
    const disabled = (await i.run("/bin/launchctl", ["print-disabled", i.domain])).stdout;
    for (const component of COMPONENTS) {
      const id = label(config.nodeId, component), file = path.join(i.agents, id + ".plist");
      requireValue(!disabled.includes(`"${id}" => true`), "LaunchAgent is disabled");
      await checkedPath(file, i.home);
      const saved = JSON.parse((await i.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file])).stdout);
      requireValue(isDeepStrictEqual(saved, agentDefinition(config, i.file, component)), "LaunchAgent belongs to another installation");
      const status = (await i.run("/bin/launchctl", ["print", i.domain + "/" + id])).stdout;
      requireValue([...status.matchAll(/^\s*path = (.+)$/gm)].map(match => match[1]).join("\n") === file,
        "LaunchAgent path mismatch");
      requireValue(component === "renew" || /^\s*pid = [1-9][0-9]*$/m.test(status), "LaunchAgent is not running");
    }
  },
    command: config => installUnixCommand(i, config),
    resources: config => COMPONENTS.map(component => ({ kind: "launchagent", name: label(config.nodeId, component),
      path: path.join(i.agents, label(config.nodeId, component) + ".plist") })),
  };
  return adapter;
}
