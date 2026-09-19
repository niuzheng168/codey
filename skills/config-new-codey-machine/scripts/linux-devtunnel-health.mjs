#!/usr/bin/env node
// The host CLI can stay alive after a failed reconnect. Check the service's
// actual host connection, not just its PID, without issuing or logging tokens.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const HOST_SERVICE = "codey-devtunnel.service";
export const HEALTH_POLICY = Object.freeze({
  startupGraceMs: 120_000,
  minSampleIntervalMs: 45_000,
  maxSampleGapMs: 180_000,
  failureThreshold: 3,
  restartCooldownMs: 600_000,
});
const tunnelPattern = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]\.[a-z][a-z0-9]{1,15}$/;
const exec = promisify(execFile);
const systemctl = "/usr/bin/systemctl";

export async function boundedCommand(file, args, timeoutMs) {
  const { stdout } = await exec(file, args, {
    encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
  });
  return stdout;
}

export function healthOptions(args) {
  const checkOnly = args.at(-1) === "--check";
  const values = checkOnly ? args.slice(0, -1) : args;
  const [devtunnel, tunnelId, stateFile, flag, runtimeFile] = values;
  if (!(values.length === 3 || values.length === 5 && flag === "--runtime" && path.isAbsolute(runtimeFile || "")) ||
      !path.isAbsolute(devtunnel || "") ||
      !tunnelPattern.test(tunnelId || "") || !path.isAbsolute(stateFile || "")) {
    throw new Error("Usage: linux-devtunnel-health.mjs DEVTUNNEL TUNNEL.CLUSTER STATE_FILE [--runtime FILE] [--check]");
  }
  return { devtunnel, tunnelId, stateFile, checkOnly, ...(runtimeFile ? { runtimeFile } : {}) };
}

export function hostConnectionCount(output, expectedTunnel) {
  try {
    const text = output.replace(/^\uFEFF/, "");
    const start = text.search(/^\s*\{/m);
    if (start < 0) throw new Error();
    const document = JSON.parse(text.slice(start));
    const tunnel = document?.tunnel ?? document;
    const qualified = tunnel.tunnelId?.includes(".")
      ? tunnel.tunnelId : `${tunnel.tunnelId}.${tunnel.clusterId}`;
    // CLI releases have returned both the display DTO and the service status
    // DTO. Accept explicit numeric counts only; conflicting reports are unknown.
    const counts = [tunnel.hostConnections, tunnel.status?.hostConnectionCount]
      .filter(value => value !== undefined)
      .map(value => value && typeof value === "object" ? value.current : value);
    if (qualified !== expectedTunnel ||
        (tunnel.clusterId && tunnel.clusterId !== expectedTunnel.split(".")[1]) ||
        !counts.length || counts.some(count => !Number.isSafeInteger(count) || count < 0 || count !== counts[0])) throw new Error();
    return counts[0];
  } catch {
    // CLI output and JSON exceptions may contain credentials.
    throw new Error("DevTunnel did not return host connectivity for the configured tunnel");
  }
}

function validTime(value, now) {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= now);
}

/** Monotonic, boot-bound state: rapid retries, stale samples and PID changes
 * cannot turn a single outage observation into permission to restart. */
export function healthDecision(previous, observation, policy = HEALTH_POLICY) {
  const { bootId, tunnelId, invocationId, now, status, hostAgeMs } = observation;
  const valid = previous?.schema === 1 && previous.bootId === bootId &&
    previous.tunnelId === tunnelId &&
    Number.isSafeInteger(previous.failures) && previous.failures >= 0 &&
    previous.failures <= policy.failureThreshold &&
    validTime(previous.sampleAt, now) && validTime(previous.lastRestartAt, now);
  const state = {
    schema: 1, bootId, tunnelId, invocationId,
    failures: 0, sampleAt: null, lastRestartAt: valid ? previous.lastRestartAt : null,
  };
  const result = reason => ({ state, reason, restart: false });
  if (status !== "host-offline") return result(status);
  if (!Number.isFinite(hostAgeMs) || hostAgeMs < policy.startupGraceMs) return result("startup-grace");
  if (valid && previous.invocationId === invocationId && previous.sampleAt !== null &&
      now - previous.sampleAt <= policy.maxSampleGapMs) {
    state.failures = previous.failures;
    state.sampleAt = previous.sampleAt;
    if (now - state.sampleAt < policy.minSampleIntervalMs) return result("waiting-for-next-sample");
  }
  state.failures = Math.min(state.failures + 1, policy.failureThreshold);
  state.sampleAt = now;
  if (state.failures < policy.failureThreshold) return result("host-offline");
  if (state.lastRestartAt !== null && now - state.lastRestartAt < policy.restartCooldownMs) {
    return result("restart-cooldown");
  }
  return { state, reason: "host-offline", restart: true };
}

async function saveState(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseService(output) {
  const unit = Object.fromEntries(output.trim().split("\n").map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  return {
    active: unit.ActiveState === "active" && unit.SubState === "running" && !unit.Job,
    pid: Number(unit.MainPID),
    invocationId: unit.InvocationID || "",
    startedMs: Number(unit.ActiveEnterTimestampMonotonic) / 1000,
  };
}

export async function healthRuntime(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 1024 * 1024) {
    throw new Error("Invalid private tunnel runtime");
  }
  return JSON.parse(await readFile(file, "utf8"));
}

function hostArguments(options, config) {
  if (config) return [config.nodeExe, path.join(config.codeyDirectory, "lib/tunnel.mjs"), "host", options.runtimeFile];
  return [options.devtunnel, "host", options.tunnelId, "--host-header", "unchanged", "--origin-header", "unchanged"];
}

export async function checkTunnelHealth(options, {
  command = boundedCommand,
  read = file => readFile(file, "utf8"),
  save = saveState,
  clock = () => Math.floor(os.uptime() * 1000),
  runtime = healthRuntime,
} = {}) {
  const config = options.runtimeFile ? await runtime(options.runtimeFile) : null;
  if (options.runtimeFile && (!config || config.schema !== 2 || config.platform !== "linux-x64" || config.tunnelAuth?.source !== "gh" ||
      config.ownerUid !== process.getuid() || typeof config.ownerHome !== "string" ||
      options.runtimeFile !== path.join(config.ownerHome, ".config/codey-machine/runtime.json") ||
      config.devtunnelExe !== options.devtunnel || config.qualifiedTunnel !== options.tunnelId ||
      !path.isAbsolute(config.nodeExe ?? "") || !path.isAbsolute(config.codeyDirectory ?? "") ||
      config.codeyBin !== path.join(config.codeyDirectory, "bin/codey.mjs"))) {
    throw new Error("Tunnel health runtime identity mismatch");
  }
  const bootId = (await read("/proc/sys/kernel/random/boot_id")).trim();
  if (!/^[a-f0-9-]{36}$/.test(bootId)) throw new Error("Cannot identify the current boot");
  const service = async () => parseService(await command(systemctl, [
    "--user", "show", HOST_SERVICE,
    "--property=ActiveState,SubState,MainPID,InvocationID,ActiveEnterTimestampMonotonic,Job",
  ], 5000));
  const matchesHost = async unit => {
    if (!unit.active || !Number.isSafeInteger(unit.pid) || unit.pid <= 1 ||
        !/^[a-f0-9]{32}$/.test(unit.invocationId)) return false;
    const args = (await read(`/proc/${unit.pid}/cmdline`)).replace(/\0$/, "").split("\0");
    return JSON.stringify(args) === JSON.stringify(hostArguments(options, config));
  };
  let previous;
  try {
    previous = JSON.parse(await read(options.stateFile));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw new Error("Cannot read tunnel health state");
  }
  let before;
  let connections = null;
  let status = "probe-unavailable";
  try {
    before = await service();
    if (!before.active) status = "service-inactive";
    else if (!await matchesHost(before)) status = "unrecognized-host";
    else if (clock() - before.startedMs < HEALTH_POLICY.startupGraceMs) status = "startup-grace";
    else {
      connections = hostConnectionCount(config ? await command(config.nodeExe, [
        path.join(config.codeyDirectory, "lib/tunnel.mjs"), "show", options.runtimeFile,
      ], 25000) : await command(options.devtunnel, ["show", options.tunnelId, "--json"], 15000), options.tunnelId);
      status = connections > 0 ? "host-online" : "host-offline";
    }
  } catch {
    // A network/auth/CLI failure is unknown, not proof that the host is offline.
    // It breaks the failure streak and must never trigger a restart or a login.
    status = "probe-unavailable";
  }
  const observation = {
    bootId, tunnelId: options.tunnelId, invocationId: before?.invocationId || "",
    now: clock(), hostAgeMs: before ? clock() - before.startedMs : 0, status,
  };
  let decision = healthDecision(previous, observation);
  let restartRequested = false;
  if (decision.restart && !options.checkOnly) {
    try {
      const current = await service();
      if (current.invocationId !== before.invocationId || current.pid !== before.pid || !await matchesHost(current)) {
        decision = healthDecision(previous, { ...observation, status: "service-changed" });
      }
    } catch {
      decision = healthDecision(previous, { ...observation, status: "probe-unavailable" });
    }
    if (decision.restart) {
      // Persist the cooldown BEFORE submitting a restart. Even a rejected job or
      // a monitor interruption must not cause a restart loop on subsequent runs.
      decision.state.lastRestartAt = clock();
      decision.state.failures = 0;
      decision.state.sampleAt = null;
      await save(options.stateFile, decision.state);
      try {
        await command(systemctl, [
          "--user", "--no-block", "--job-mode=fail", "try-restart", HOST_SERVICE,
        ], 5000);
        restartRequested = true;
        decision.reason = "restart-requested";
      } catch {
        decision.reason = "restart-failed";
      }
    }
  }
  if (!options.checkOnly && !decision.restart) await save(options.stateFile, decision.state);
  return {
    status: decision.reason, hostConnections: connections, failures: decision.state.failures,
    restartRequested, ...(options.checkOnly ? { checkOnly: true, wouldRestart: decision.restart } : {}),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.platform !== "linux" || process.getuid() === 0) throw new Error();
    console.log(JSON.stringify(await checkTunnelHealth(healthOptions(process.argv.slice(2)))));
  } catch {
    console.error("Codey DevTunnel health check failed; no credentials or other services were changed.");
    process.exitCode = 1;
  }
}
