import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HELP = `Codey — workspace and model gateway

Usage:
  codey start [--host HOST] [--workspace-port PORT] [--gateway-port PORT]
  codey workspace [--host HOST] [--port PORT]
  codey gateway [start|auth|debug|mcp] [arguments...]
  codey auth [arguments...]
  codey mcp [arguments...]
  codey doctor [--package-only] [--json]
  codey update PACKAGE.tgz [--check] [--sha256 HASH]
  codey update codex TOOL-UPDATE.json --sha256 HASH [--check]
  codey update devtunnel TOOL-UPDATE.json --sha256 HASH [--check | --allow-disconnect]
  codey update --recover
  codey setup [--config FILE] [--check]
  codey --version

start runs both services in the foreground; Ctrl+C stops both.
Defaults: loopback only, workspace :3001, gateway :4141.
Responses WebSocket defaults to off; explicit gateway config takes precedence.
doctor checks the shared Linux/Windows runtime; managed setup is Linux-only.
update selects one component at a time; it never runs setup. See "codey update --help".
Use "codey gateway --help" for gateway options.
Install the official Codex CLI separately and authenticate the gateway with
"codey auth login --provider copilot". Existing configuration is preserved.
`;

async function findCodex() {
  if (process.env.CODEY_CODEX_EXECUTABLE) return process.env.CODEY_CODEX_EXECUTABLE;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* Try the next absolute PATH entry, never the package's own dependencies. */ }
  }
  return null;
}

function serverOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.includes(name) || value === undefined || value.startsWith("--") ||
        Object.hasOwn(options, name) || !value.trim()) {
      throw new Error(`Invalid option: ${name}`);
    }
    if (name !== "--host" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) {
      throw new Error(`Invalid port: ${value}`);
    }
    options[name] = value;
  }
  return options;
}

/** The executable and tests use the same argument routing without loading either server. */
export function commandPlan(args, env = process.env) {
  const [command = "--help", ...rest] = args;
  if (["--help", "-h", "help"].includes(command)) return { kind: "help" };
  if (["--version", "-v", "version"].includes(command)) {
    if (rest.length) throw new Error("codey --version does not accept arguments");
    return { kind: "version" };
  }
  if (["auth", "mcp"].includes(command)) return { kind: "gateway", args: [command, ...rest] };
  if (command === "doctor") return { kind: "doctor", args: rest };
  if (command === "update") return { kind: "update", args: rest };
  if (command === "setup") return { kind: "setup", args: rest };
  if (command === "gateway") return {
    kind: "gateway",
    args: rest.length ? rest : ["start", "--headless", "--host", "127.0.0.1", "--port", "4141"],
  };
  if (command === "workspace") {
    if (rest.length === 1 && ["--help", "-h"].includes(rest[0])) return { kind: "help" };
    const options = serverOptions(rest, ["--host", "--port"]);
    return {
      kind: "workspace",
      env: {
        HOST: options["--host"] ?? env.HOST ?? "127.0.0.1",
        SERVER_PORT: options["--port"] ?? env.SERVER_PORT ?? "3001",
        CODEY_MANAGED: "true",
      },
    };
  }
  if (command === "start") {
    if (rest.length === 1 && ["--help", "-h"].includes(rest[0])) return { kind: "help" };
    const options = serverOptions(rest, ["--host", "--workspace-port", "--gateway-port"]);
    const host = options["--host"] ?? "127.0.0.1";
    const workspacePort = options["--workspace-port"] ?? env.SERVER_PORT ?? "3001";
    const gatewayPort = options["--gateway-port"] ?? "4141";
    if (Number(workspacePort) === Number(gatewayPort)) throw new Error("The two services need distinct ports");
    return { kind: "start", commands: [
      ["gateway", "start", "--headless", "--host", host, "--port", gatewayPort],
      ["workspace", "--host", host, "--port", workspacePort],
    ] };
  }
  throw new Error(`Unknown command: ${command}. Run codey --help`);
}

/** Supervise the two internal processes without creating a second installed application. */
export async function supervise(commands, {
  root = ROOT, env = process.env, spawnProcess = spawn, signals = process, graceMs = 10000,
} = {}) {
  const children = new Set();
  const exits = [];
  let stopping = false;
  let exitCode = 0;
  let forceTimer;
  const stop = (signal, code) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const child of children) child.kill(signal);
    forceTimer = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, graceMs);
    forceTimer.unref();
  };
  const onInterrupt = () => stop("SIGINT", 130);
  const onTerminate = () => stop("SIGTERM", 143);
  signals.on("SIGINT", onInterrupt);
  signals.on("SIGTERM", onTerminate);
  try {
    for (const args of commands) {
      if (stopping) break;
      const child = spawnProcess(process.execPath, [path.join(root, "bin/codey.mjs"), ...args], {
        cwd: root, env, stdio: "inherit", shell: false, windowsHide: true,
      });
      children.add(child);
      exits.push(new Promise((resolve) => {
        child.once("error", () => {
          children.delete(child);
          stop("SIGTERM", 1);
          resolve();
        });
        child.once("exit", (code) => {
          children.delete(child);
          if (!stopping) stop("SIGTERM", code || 1);
          resolve();
        });
      }));
    }
    await Promise.all(exits);
    return exitCode;
  } catch (error) {
    stop("SIGTERM", 1);
    await Promise.all(exits);
    throw error;
  } finally {
    clearTimeout(forceTimer);
    signals.off("SIGINT", onInterrupt);
    signals.off("SIGTERM", onTerminate);
  }
}

/** Single public CLI; the service subcommands import their entrypoint in the same PID. */
export async function runCli(args = process.argv.slice(2)) {
  const plan = commandPlan(args);
  if (plan.kind === "help") {
    console.log(HELP);
    return;
  }
  if (plan.kind === "version") {
    const metadata = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    console.log(`codey ${metadata.version}`);
    return;
  }
  if (plan.kind === "start") {
    process.exitCode = await supervise(plan.commands);
    return;
  }
  if (plan.kind === "setup") {
    const { runSetup } = await import("./setup.mjs");
    await runSetup(ROOT, plan.args);
    return;
  }
  if (plan.kind === "update") {
    const { runUpdate } = await import("./update.mjs");
    await runUpdate(ROOT, plan.args);
    return;
  }
  if (plan.kind === "doctor") {
    const { runDoctor } = await import("./doctor.mjs");
    await runDoctor(ROOT, plan.args);
    return;
  }
  const entry = path.join(ROOT, plan.kind === "gateway" ? "gateway/main.js" : "dist-server/server/index.js");
  Object.assign(process.env, { CODEY_MANAGED: "true" }, plan.env);
  if (plan.kind === "workspace") {
    const codex = await findCodex();
    if (codex) process.env.CODEY_CODEX_EXECUTABLE = codex;
  }
  process.chdir(ROOT);
  process.argv = [process.execPath, entry, ...(plan.args ?? [])];
  await import(pathToFileURL(entry).href);
}
