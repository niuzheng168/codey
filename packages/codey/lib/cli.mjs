import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { machineOptions } from "./machine.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const COPILOT_LOGIN_HELP = `Usage: codey copilot login [--force] [--verbose|-v] [--show-token]
                           [--api-home DIR] [--oauth-app APP] [--enterprise-url DOMAIN]
Reuse existing Copilot credentials, then a signed-in gh account, before device login.
Pins the gh account without copying its token. Existing accounts are not silently switched.
--force skips reuse and explicitly performs GitHub device login.
No API service starts. Explicit OAuth-app/Enterprise choices keep their own login flow.
--verbose defaults to false. --show-token defaults to false and prints secrets.
Reused credentials (especially gh tokens) are never printed, even with --show-token.
Connection options default to the matching COPILOT_API_* environment variables.
--api-home otherwise defaults to HOME/.local/share/copilot-api.
--provider/--alias overrides are not supported here. --help/-h displays this help.
`;
const COPILOT_START_HELP = `Usage: codey copilot start [--host HOST] [--port PORT|-p PORT]
                           [--verbose|-v] [--proxy-env]
                           [--api-home DIR] [--oauth-app APP] [--enterprise-url DOMAIN]
Run only the Copilot API in the foreground; Ctrl+C stops it.
Defaults: --host 127.0.0.1 (ignores HOST), --port 4141 (range 1–65535).
The same server exposes /responses, /v1/responses, /usage and /token-usage.
A managed node also retains its configured HTTPS 8443 read-only usage/history API.
No Workspace/CloudCLI or DevTunnel starts, and no services or certificates are created.
Startup never prompts. Without explicit/saved credentials it automatically reuses gh.
Use codey copilot login if neither existing credentials nor gh are available.
--verbose and --proxy-env default to false. --proxy-env enables proxy environment variables.
Connection options use the same COPILOT_API_* defaults as copilot login.
There are no --headless, --github-token, --show-token or --claude-code startup options.
--help/-h displays this help. Use codey start for the whole background node.
`;
const HELP = `Codey — workspace and model gateway

Usage:
  codey [--help|-h|help]
  codey --version|-v|version
  codey copilot login [--force] [--verbose|-v] [--show-token] [connection options]
  codey copilot start [--host HOST] [--port PORT|-p PORT]
    [--verbose|-v] [--proxy-env] [connection options]
  codey devtunnel login
  codey devtunnel start|stop [--json] [--timeout SECONDS]
  codey guard [--json] [--timeout SECONDS]
  codey status [--json]
  codey start|restart|stop [--json] [--timeout SECONDS]
  codey start --foreground [--host HOST] [--workspace-port PORT] [--gateway-port PORT]
  codey export FILE.gz [--json]
  codey import FILE.gz [--check] [--replace-existing] [--settings-only] [--json]
  codey update FILE.tgz [--sha256 HASH] [--check] [--offline] [--json]
  codey doctor [--json] [--offline] [--model]
  codey doctor --runtime-only|--package-only [--json]

Copilot connection options (after copilot login/start, not top-level Codey options):
  --api-home DIR         Gateway config/credentials/data; default COPILOT_API_HOME
                        or HOME/.local/share/copilot-api.
  --oauth-app APP        OAuth app selector; default COPILOT_API_OAUTH_APP.
  --enterprise-url HOST GitHub Enterprise domain; default COPILOT_API_ENTERPRISE_URL.
Use "<subcommand> --help" (or -h) for its help.

start/restart/stop manage this owner's Copilot API, Workspace/CloudCLI and DevTunnel.
guard enables and starts all installed native supervisors: CloudCLI/Copilot API,
DevTunnel host, token renewal and Linux tunnel health monitoring.
It shares background start's idempotent operation; it never installs services or adds another daemon.
devtunnel start/stop manage only the tunnel and its renewal/health watchdogs.
stop disables watchdogs until start or guard; lifecycle timeout defaults to 60 seconds (1–600).
start --foreground runs just workspace/gateway; Ctrl+C stops both, no tunnel.
Legacy start with host/port arguments also selects foreground mode.
start --foreground and copilot start use 127.0.0.1 by default.
Workspace port defaults to SERVER_PORT or 3001; gateway defaults to 4141.
copilot start includes both Responses and usage APIs, plus configured HTTPS 8443.
CloudCLI starts through codey start, not a separate command. Do not duplicate an active background node.
Codey's start/guard require space-separated values, not --name=value.
Port changes do not reconfigure model URLs, HTTPS 8443, DevTunnel or OS services.

Copilot and DevTunnel reuse gh when their own credentials are absent; existing accounts win.
GitHub CLI bindings pin the account; changing gh's active account does not switch Codey.
copilot login --force explicitly signs in again; --show-token can print secrets during that flow.
doctor checks the package and node components without repair or interactive login.
--model permits bounded real model requests; --offline skips online tunnel checks.
--runtime-only skips the managed node; --package-only also skips native/SDK/PTY.
doctor emits formatted JSON (compact with --json).
Responses WebSocket defaults to off; explicit gateway config takes precedence.
Installation belongs to the installation Skill/scripts, not the runtime CLI.
export/import use bounded gzip/JSON settings archives, not registration JSON.
Backups contain secrets, are private but NOT encrypted; OS login stores are excluded.
Full restore is for the same node. --settings-only transfers gateway/Codex settings.
import --check and update --check are read-only. Confirm overwrites with --replace-existing.
update uses a local trusted .tgz; unchanged dependencies are reused, otherwise npm
downloads are needed. --offline forbids downloads; --sha256 checks an expected hash.
Update preserves configuration, tools, identity, service state and the previous release.
No Portal update agent or persistent local updater. Do not rerun installation to upgrade.
There is no unified uninstall command.
Full parameter reference: onboarding/references/codey-cli.md in the package,
or references/codey-cli.md in the complete installation Skill.
`;

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

function copilotOptions(args, action) {
  const seen = new Set(), options = {}, forwarded = [];
  const booleans = action === "login" ? ["--force", "--verbose", "--show-token"] : ["--verbose", "--proxy-env"];
  const values = ["--api-home", "--oauth-app", "--enterprise-url", ...(action === "start" ? ["--host", "--port"] : [])];
  for (let index = 0; index < args.length; index++) {
    const [name, ...tail] = args[index].split("="), value = tail.join("=");
    const canonical = name === "-v" ? "--verbose" : name === "-p" ? "--port" : name.replace(/^--no-/, "--");
    if (seen.has(canonical)) throw new Error(`Duplicate Copilot ${action} option`);
    seen.add(canonical);
    if (booleans.includes(canonical)) {
      if (tail.length && !["true", "false"].includes(value)) throw new Error(`Invalid Copilot ${action} boolean`);
      if (canonical === "--force") options.force = !name.startsWith("--no-") && value !== "false";
      else forwarded.push(args[index]);
    } else if (values.includes(canonical) && !name.startsWith("--no-")) {
      const argument = tail.length ? value : args[++index];
      if (!argument?.trim() || argument.startsWith("-") || /[\0\r\n]/.test(argument)) throw new Error(`Missing or invalid Copilot ${action} option value`);
      if (canonical === "--port" && (!/^\d+$/.test(argument) || +argument < 1 || +argument > 65535)) throw new Error("Invalid Copilot API port");
      options[canonical] = argument;
      if (!["--host", "--port"].includes(canonical)) forwarded.push(canonical, argument);
    } else throw new Error(`Invalid Copilot ${action} option; use --help`);
  }
  return { options, forwarded };
}

/** The executable and tests use the same argument routing without loading either server. */
export function commandPlan(args, env = process.env) {
  const [command = "--help", ...rest] = args;
  if (["--help", "-h", "help"].includes(command)) return { kind: "help" };
  if (["--version", "-v", "version"].includes(command)) {
    if (rest.length) throw new Error("codey --version does not accept arguments");
    return { kind: "version" };
  }
  if (command === "copilot") {
    if (!rest.length || rest.length === 1 && ["--help", "-h"].includes(rest[0])) {
      return { kind: "help", text: COPILOT_LOGIN_HELP + "\n" + COPILOT_START_HELP };
    }
    const [action, ...parameters] = rest;
    if (!["login", "start"].includes(action)) throw new Error("Use codey copilot login or codey copilot start");
    if (parameters.length === 1 && ["--help", "-h"].includes(parameters[0])) {
      return { kind: "help", text: action === "login" ? COPILOT_LOGIN_HELP : COPILOT_START_HELP };
    }
    const { options, forwarded } = copilotOptions(parameters, action);
    return { kind: "gateway", ...(options.force ? { force: true } : {}), args: action === "login" ? ["auth", "login", "--provider", "copilot", ...forwarded] :
      ["start", "--headless", "--host", options["--host"] ?? "127.0.0.1", "--port", options["--port"] ?? "4141", ...forwarded] };
  }
  if (command === "doctor") return { kind: "doctor", args: rest };
  if (command === "--update") throw new Error("Use codey update FILE.tgz; remote/tool updater entrypoints are not supported");
  if (command === "devtunnel") {
    if (rest.length === 1 && ["--help", "-h"].includes(rest[0])) return { kind: "help" };
    const operation = `devtunnel ${rest[0]}`;
    machineOptions(operation, rest.slice(1));
    return { kind: "machine", command: operation, args: rest.slice(1) };
  }
  if (["guard", "status", "stop", "restart", "export", "import", "update"].includes(command)) {
    machineOptions(command, rest);
    return { kind: "machine", command, args: rest };
  }
  if (command === "start") {
    if (rest.length === 1 && ["--help", "-h"].includes(rest[0])) return { kind: "help" };
    const foreground = rest.includes("--foreground") || rest.some(arg => ["--host", "--workspace-port", "--gateway-port"].includes(arg));
    if (!foreground) {
      machineOptions(command, rest);
      return { kind: "machine", command, args: rest };
    }
    if (rest.filter(arg => arg === "--foreground").length > 1) throw new Error("Duplicate --foreground");
    const options = serverOptions(rest.filter(arg => arg !== "--foreground"), ["--host", "--workspace-port", "--gateway-port"]);
    const host = options["--host"] ?? "127.0.0.1";
    const workspacePort = options["--workspace-port"] ?? env.SERVER_PORT ?? "3001";
    const gatewayPort = options["--gateway-port"] ?? "4141";
    if (Number(workspacePort) === Number(gatewayPort)) throw new Error("The two services need distinct ports");
    return { kind: "start", commands: [
      { entry: "bin/codey.mjs", args: ["copilot", "start", "--host", host, "--port", gatewayPort] },
      { entry: "lib/workspace.mjs", env: { HOST: host, SERVER_PORT: workspacePort } },
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
    for (const { entry, args = [], env: overrides } of commands) {
      if (stopping) break;
      const child = spawnProcess(process.execPath, [path.join(root, entry), ...args], {
        cwd: root, env: { ...env, ...overrides }, stdio: "inherit", shell: false, windowsHide: true,
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

/** Single public CLI; Copilot imports its entrypoint in the same PID. */
export async function runCli(args = process.argv.slice(2)) {
  const plan = commandPlan(args);
  if (plan.kind === "help") {
    console.log(plan.text ?? HELP);
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
  if (plan.kind === "machine") {
    await (await import("./machine.mjs")).runMachine(ROOT, plan.command, plan.args);
    return;
  }
  if (plan.kind === "doctor") {
    const { runDiagnostics } = await import("./machine-doctor.mjs");
    await runDiagnostics(ROOT, plan.args);
    return;
  }
  const entry = path.join(ROOT, "gateway/main.js");
  const { prepareCopilotAuth } = await import("./copilot-auth.mjs");
  const authentication = await prepareCopilotAuth(ROOT, plan.args ?? [], { force: plan.force });
  if (authentication.handled) return;
  Object.assign(process.env, authentication.environment);
  process.env.CODEY_MANAGED = "true";
  process.chdir(ROOT);
  process.argv = [process.execPath, entry, ...(plan.args ?? [])];
  await import(pathToFileURL(entry).href);
}
