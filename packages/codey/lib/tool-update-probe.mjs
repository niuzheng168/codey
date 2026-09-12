// Native tool compatibility checks. Isolated HOME; no login, prompt, thread creation or model call.
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export function toolVersion(output, component) {
  const prefix = component === "codex" ? "codex(?:-cli)?" : "devtunnel";
  const match = output.trim().match(new RegExp(`^${prefix}\\s+(?:version\\s+)?v?(\\d+\\.\\d+\\.\\d+(?:\\.\\d+)?(?:[-+][A-Za-z0-9.-]+)?)(?:\\s|$)`, "i"));
  if (!match) throw new Error("Unrecognized native tool version output.");
  return match[1];
}

export function isolatedToolEnvironment(home, node, source = process.env) {
  const env = {};
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "LANG", "LC_ALL"]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  const system = process.platform === "win32"
    ? [source.SystemRoot && path.join(source.SystemRoot, "System32"), source.SystemRoot].filter(Boolean).join(path.delimiter)
    : "/usr/bin:/bin";
  return { ...env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"),
    APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    TEMP: home, TMP: home, TMPDIR: home, PATH: path.dirname(node) + path.delimiter + system,
    CODEX_DISABLE_UPDATE_CHECK: "1", CI: "true" };
}

export async function appServerHandshake(file, { env, cwd, timeout = 15000 } = {}) {
  const child = spawn(file, ["app-server"], {
    env, cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "", size = 0, initialized = false, timer;
  // Drain private diagnostics without writing configuration or printing tool output.
  child.stderr.resume();
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    return await new Promise((resolve, reject) => {
      const fail = () => reject(new Error("Codex app-server protocol compatibility check failed."));
      timer = setTimeout(fail, timeout);
      child.once("error", fail);
      child.once("exit", fail);
      child.stdin.on("error", fail);
      const send = value => child.stdin.write(JSON.stringify(value) + "\n");
      child.once("spawn", () => send({ id: 1, method: "initialize",
        params: { clientInfo: { name: "codey_updater", version: "0.1.3" }, capabilities: { experimentalApi: false } } }));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 1024 * 1024) { fail(); return; }
        buffer += chunk;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n"), line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { fail(); return; }
          if (!message || typeof message !== "object" || message.error) { fail(); return; }
          if (message.id === 1) {
            if (initialized || !message.result || typeof message.result !== "object") { fail(); return; }
            initialized = true;
            send({ method: "initialized" });
            send({ id: 2, method: "thread/loaded/list", params: {} });
          } else if (message.id === 2) {
            if (!initialized || !Array.isArray(message.result?.data) || message.result.data.length) { fail(); return; }
            resolve({ appServer: true, loadedThreads: 0, modelRequests: false });
          } else if (Object.hasOwn(message, "id")) { fail(); return; }
        }
      });
    });
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    let grace;
    await Promise.race([closed, new Promise(resolve => { grace = setTimeout(resolve, 1000); })]);
    clearTimeout(grace);
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      // Only this isolated probe's process tree, never a running user CLI/Desktop app.
      if (process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      } else {
        await promisify(execFile)(path.join(env.SystemRoot, "System32/taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }).catch(() => child.kill());
      }
      await closed;
    }
  }
}

export function assertTunnelConnected(document, qualified) {
  const tunnel = document?.tunnel ?? document;
  const [id, cluster] = qualified.split(".");
  const reportedId = tunnel?.tunnelId;
  const count = tunnel?.status?.hostConnectionCount;
  const hosts = typeof count === "number" ? count : count?.current;
  if (![id, qualified].includes(reportedId) || tunnel?.clusterId !== cluster || hosts !== 1) {
    throw new Error("The original DevTunnel does not report exactly one connected host.");
  }
  return { connected: true, modelRequests: false };
}

export async function probeTool(request, { file = request.candidate, home = path.join(request.job, "tool-probe-home") } = {}) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env = isolatedToolEnvironment(home, request.plan.node);
  await mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  const output = await promisify(execFile)(file, ["--version"], {
    env, cwd: home, timeout: 15000, killSignal: "SIGKILL", maxBuffer: 65536, windowsHide: true, shell: false,
  });
  const version = toolVersion(output.stdout, request.component);
  if (version !== request.version) throw new Error("Native tool version differs from the reviewed manifest.");
  const protocol = request.component === "codex" ? await appServerHandshake(file, { env, cwd: home }) : {};
  return { ok: true, component: request.component, version, ...protocol, modelRequests: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, input, file] = process.argv.slice(2);
    const request = JSON.parse((await readFile(input, "utf8")).replace(/^\uFEFF/, ""));
    if (action === "probe") console.log(JSON.stringify(await probeTool(request, { file: file || request.candidate })));
    else if (action === "tunnel") {
      if (request.component !== "devtunnel" || !/^[a-z0-9][a-z0-9-]{1,58}\.[a-z0-9]{2,12}$/.test(request.plan.tunnelId ?? "")) {
        throw new Error("Invalid tunnel probe.");
      }
      // Read-only management query using the owner's existing login, not a new login/token/port.
      const result = await promisify(execFile)(file || request.candidate, ["show", request.plan.tunnelId, "--json"],
        { timeout: 20000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true, shell: false });
      console.log(JSON.stringify(assertTunnelConnected(JSON.parse(result.stdout), request.plan.tunnelId)));
    } else throw new Error("Invalid tool probe.");
  } catch {
    console.error("Native tool compatibility/connectivity check failed; no model requests were made.");
    process.exitCode = 1;
  }
}
