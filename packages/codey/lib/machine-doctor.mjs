/** Read-only diagnostics, except an explicitly requested, bounded model probe. */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { doctorOptions, runDoctor, DOCTOR_HELP } from "./doctor.mjs";
import { openMachine } from "./machine.mjs";

export async function runDiagnostics(root, args, { open = openMachine, packageCheck = runDoctor, log = console.log } = {}) {
  const options = doctorOptions(args);
  if (options.help) return log(DOCTOR_HELP);
  if (options.packageOnly || options.runtimeOnly) return packageCheck(root, args);
  const checks = [];
  const check = async (name, action) => {
    try {
      const detail = await action();
      checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) });
    } catch {
      // Native errors/JSON can embed provider responses; output only the known check name.
      checks.push({ name, ok: false, detail: "Check failed; inspect the owner's private configuration/logs" });
    }
  };
  let pkg, m, modelRequests = false;
  await check("package/native", async () => {
    pkg = await packageCheck(root, ["--runtime-only", "--json"], { log() {} });
    return { version: pkg.version, native: pkg.native };
  });
  await check("node configuration", async () => {
    m = await open(root);
    if (!m) throw new Error("Not installed");
    return { nodeId: m.config.nodeId, platform: m.i.target };
  });
  if (m) {
    const c = m.config, i = m.i;
    let toolsTrusted = false, tunnelAuthenticated = false;
    await check("tool/worker integrity", async () => { await m.tools(); toolsTrusted = true; });
    const executableCheck = (name, action) => toolsTrusted ? check(name, action) :
      checks.push({ name, skipped: true, detail: "Tool/worker integrity failed; not executed" });
    await check("owned services", async () => {
      const services = await m.services();
      // Keep stopped/failed component names in the diagnostic output.
      for (const item of services.filter(item => !item.auxiliary)) {
        checks.push({ name: item.name, ok: item.enabled && item.running,
          detail: { state: item.state, enabled: item.enabled } });
      }
    });
    await check("port ownership", () => i.checkPorts(c));
    for (const [name, executable] of [["Node", c.nodeExe], ["Codex CLI", c.codexExe], ["DevTunnel CLI", c.devtunnelExe]]) {
      await executableCheck(name, async () => {
        await i.run(executable, ["--version"], { env: c.baseEnvironment, timeout: 15000 });
        return "executable";
      });
    }
    await check("Copilot saved login", async () => {
      const app = c.environment.COPILOT_API_OAUTH_APP ?? "";
      if (!/^[a-zA-Z0-9_-]*$/.test(app)) throw new Error();
      const token = path.join(c.environment.COPILOT_API_HOME, app,
        (c.environment.COPILOT_API_ENTERPRISE_URL ? "ent_" : "") + "github_token");
      await m.privateFile(token);
      if ((await lstat(token)).size === 0) throw new Error();
      return "token file present (not an online authentication proof)";
    });
    await check("TLS certificate/private key", async () => { await i.certificate(await i.read(c.identityFile), false); });
    await executableCheck("local gateway/TLS/SSO/authentication", async () => {
      await i.probe(c, "verify", { timeout: 60000 });
      return "verified";
    });
    if (!options.offline) {
      const helpers = await import(pathToFileURL(path.join(i.skill, "scripts/windows-runtime.mjs")).href);
      await executableCheck("DevTunnel GitHub login", async () => {
        const response = await i.run(c.devtunnelExe, ["user", "show", "--json"], { env: c.baseEnvironment, timeout: 30000 });
        const user = helpers.parseTunnelJson(response.stdout);
        if (user.status !== "Logged in" || user.provider !== "github") throw new Error();
        tunnelAuthenticated = true;
        return "GitHub account";
      });
      await executableCheck("private tunnel/host connection", async () => {
        if (!tunnelAuthenticated) throw new Error("Login required; doctor never logs in");
        const response = await i.run(c.devtunnelExe, ["show", c.qualifiedTunnel, "--json"], { env: c.baseEnvironment, timeout: 30000 });
        const document = helpers.parseTunnelJson(response.stdout);
        helpers.validateTunnel(document, `codey-${c.nodeId}`, c.qualifiedTunnel.split(".")[1]);
        const { hostConnectionCount } = await import(pathToFileURL(path.join(i.skill, "scripts/linux-devtunnel-health.mjs")).href);
        if (hostConnectionCount(response.stdout, c.qualifiedTunnel) < 1) throw new Error();
        return "private HTTPS ports 3001/8443, connected host";
      });
    } else checks.push({ name: "DevTunnel account/cloud connection", skipped: true, detail: "--offline" });
    if (options.model) await executableCheck("real Codex CLI/SDK model responses", async () => {
      modelRequests = true;
      await i.verifyModels(c);
    });
  }
  const result = { ok: checks.every(item => item.ok !== false), version: pkg?.version, checks,
    serviceChanges: false, modelRequests };
  log(JSON.stringify(result, null, options.json ? 0 : 2));
  if (!result.ok) process.exitCode = 1;
  return result;
}
