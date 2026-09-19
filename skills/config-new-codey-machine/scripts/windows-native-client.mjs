import { spawn } from "node:child_process";
import { InstallationError } from "./machine-common.mjs";

export function windowsShellEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
}

/** One private pipe, not one PowerShell/module/C# startup per filesystem operation. */
export function nativeClient(powershell, script, { env = process.env, idleMs = 1000 } = {}) {
  let worker, pending, idle, buffer = "", queue = Promise.resolve();
  const reference = active => {
    for (const handle of [worker, worker?.stdin, worker?.stdout, worker?.stderr]) {
      if (active) handle?.ref?.(); else handle?.unref?.();
    }
  };
  const stop = () => {
    clearTimeout(idle);
    if (!worker) return;
    const child = worker;
    worker = undefined;
    process.off("exit", stop);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    child.stdin.destroy();
    child.kill();
  };
  const fail = message => {
    const request = pending;
    pending = undefined;
    if (request) { clearTimeout(request.timer); request.reject(new InstallationError(message)); }
    stop();
  };
  const interrupt = () => fail("Windows native operation interrupted; its owned child job was stopped.");
  const start = () => {
    buffer = "";
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-NativeServer"],
      { env: windowsShellEnvironment(env), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    worker = child;
    process.on("exit", stop);
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", text => {
      if (worker !== child) return;
      buffer += text;
      if (buffer.length > 4 * 1024 * 1024) return fail("Windows native response exceeded its size limit.");
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let response;
      try { response = JSON.parse(line); }
      catch { return fail("Windows native operation returned invalid JSON."); }
      if (!pending || typeof response?.ok !== "boolean" || buffer.trim()) {
        return fail("Windows native operation returned an unexpected response.");
      }
      const request = pending;
      pending = undefined;
      clearTimeout(request.timer);
      if (response.ok) request.resolve(response.result);
      else {
        const safe = /^Windows native [a-z-]{1,32} failed \([A-Za-z0-9]+, line \d+\); inspect the private installation state\.$/;
        request.reject(new InstallationError(safe.test(response.error) ? response.error : "Windows native operation failed."));
      }
      reference(false);
      idle = setTimeout(stop, idleMs);
      idle.unref();
    });
    // Raw errors can echo private requests. Only structured diagnostics cross the bridge.
    child.stderr.resume();
    child.stdin.on("error", () => { if (worker === child) fail("Windows native request pipe closed."); });
    child.once("error", () => { if (worker === child) fail("Windows PowerShell could not start."); });
    child.once("close", () => { if (worker === child) fail("Windows native host exited before completing its request."); });
  };
  return request => {
    if (!/^[a-z-]{1,32}$/.test(request.operation)) return Promise.reject(new InstallationError("Invalid Windows native operation."));
    const result = queue.then(() => new Promise((resolve, reject) => {
      clearTimeout(idle);
      if (!worker) start();
      reference(true);
      pending = { resolve, reject, timer: setTimeout(() => fail(
        `Windows native ${request.operation} timed out; its owned child job was stopped.`),
      (request.timeout ?? 180) * 1000 + 30000) };
      worker.stdin.write(JSON.stringify(request) + "\n");
    }));
    queue = result.catch(() => {});
    return result;
  };
}
