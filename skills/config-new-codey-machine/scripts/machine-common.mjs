/** Shared installer primitives. Windows ACLs/process jobs live in its native adapter. */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
export class InstallationError extends Error {}
export function requireValue(value, message = "Invalid private Codey installation") {
  if (!value) throw new InstallationError(message);
}
export const exists = async file => {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};
export const inside = (home, file) => {
  const relative = path.relative(home, file);
  return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
export async function digest(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
export async function checkedPath(file, home, uid = process.getuid()) {
  home = await realpath(home);
  file = path.resolve(file);
  requireValue(inside(home, file), "Path must remain under the original owner's home");
  const owner = await lstat(home);
  requireValue(owner.isDirectory() && owner.uid === uid && !(owner.mode & 0o022), "Owner home must not be writable by other users");
  for (let entry = file; inside(home, entry); entry = path.dirname(entry)) {
    if (!await exists(entry)) continue;
    const info = await lstat(entry);
    requireValue(!info.isSymbolicLink() && info.uid === uid && !(info.mode & 0o022),
      "Unowned, linked or writable installation path");
  }
  return file;
}
export async function directory(file, home) {
  await checkedPath(file, home);
  await mkdir(file, { recursive: true, mode: 0o700 });
  await chmod(file, 0o700);
  return file;
}
export async function readPrivate(file) {
  const info = await lstat(file);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() &&
    !(info.mode & 0o077) && info.size <= 4 * 1024 * 1024);
  return JSON.parse(await readFile(file, "utf8"));
}
export async function writePrivate(file, value) {
  if (await exists(file)) {
    const info = await lstat(file);
    requireValue(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid(),
      "Refusing to replace a linked or unowned file");
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const temporary = file + "." + randomBytes(12).toString("hex") + ".next";
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
export function run(file, args, { env = process.env, cwd, timeout = 180000, interactive = false, check = true, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args.map(String), { env, cwd, shell: false, detached: !interactive && process.platform !== "win32", windowsHide: !interactive,
      stdio: interactive ? "inherit" : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    let stdout = "", stderr = "", timedOut = false, interrupted = false, forceTimer;
    const stop = signal => {
      try { if (interactive || process.platform === "win32") child.kill(signal); else if (child.pid) process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") child.kill(signal); }
    };
    const timer = setTimeout(() => { timedOut = true; stop("SIGKILL"); }, timeout);
    const interrupt = signal => {
      if (interrupted) return;
      interrupted = true;
      stop(signal);
      forceTimer = setTimeout(() => stop("SIGKILL"), 10000);
    };
    const onInterrupt = () => interrupt("SIGINT"), onTerminate = () => interrupt("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    for (const [stream, name] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
      stream?.setEncoding("utf8");
      stream?.on("data", bytes => {
        if (name === "stdout") stdout += bytes; else stderr += bytes;
        if (stdout.length + stderr.length > 2 * 1024 * 1024) { timedOut = true; stop("SIGKILL"); }
      });
    }
    child.once("error", () => { cleanup(); reject(new InstallationError(`${path.basename(file)} could not start`)); });
    child.once("close", (code, signal) => {
      cleanup();
      if (timedOut || interrupted || signal || check && code !== 0) {
        reject(new InstallationError(`${path.basename(file)} failed; inspect the private installation state`));
      } else resolve({ code, stdout, stderr });
    });
  });
}
