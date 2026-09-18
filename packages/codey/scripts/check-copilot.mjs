// Build/test-only smoke: actual CLI and HTTP handlers, isolated credentials, no upstream requests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvironment } from "../lib/package-files.mjs";

export async function checkCopilot(root, node = process.execPath) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codey-copilot-smoke-"));
  const apiHome = path.join(home, "api"), configFile = path.join(apiHome, "config.json");
  const key = "isolated-smoke-key-not-a-real-credential";
  const denied = path.join(home, "unexpected-network");
  try {
    await mkdir(apiHome, { mode: 0o700 });
    const preload = path.join(home, "offline.mjs");
    await writeFile(preload, `import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
  writeFileSync(${JSON.stringify(denied)}, "unexpected upstream request", {mode:0o600});
  throw new Error("Upstream network is disabled in the package smoke test");
};\n`, { mode: 0o600 });
    for (const explicitWebSocket of [undefined, true]) {
      const authenticated = explicitWebSocket !== undefined;
      // First boot initializes the real defaults. Second boot verifies an explicit
      // setting and configured API keys without requiring a removed debug command.
      if (authenticated) await writeFile(configFile, JSON.stringify({ auth: { apiKeys: [key] },
        useResponsesApiWebSocket: explicitWebSocket }), { mode: 0o600 });
      const reservation = net.createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      const child = spawn(node, ["--import", preload, path.join(root, "bin/codey.mjs"),
        "copilot", "start", "--host", "127.0.0.1", "--port", String(port)], {
        cwd: root, shell: false, windowsHide: true, stdio: "ignore",
        env: { ...buildEnvironment(home, node), COPILOT_API_HOME: apiHome, CODEX_HOME: path.join(home, ".codex"),
          COPILOT_API_GITHUB_TOKEN: "", COPILOT_API_OAUTH_APP: "", COPILOT_API_ENTERPRISE_URL: "" },
      });
      const exited = once(child, "exit");
      const request = (target, options = {}) => fetch(`http://127.0.0.1:${port}${target}`,
        { ...options, signal: AbortSignal.timeout(2000) });
      try {
        let ready = false;
        for (let attempt = 0; attempt < 120; attempt++) {
          assert.equal(child.exitCode, null, "Copilot API exited during startup");
          try { if ((await request("/")).ok) { ready = true; break; } } catch { /* Wait for the owned server. */ }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(ready, "Copilot API did not become ready");
        assert.equal((await request("/token-usage")).status, authenticated ? 401 : 200);
        const usage = await request("/token-usage", { headers: { authorization: `Bearer ${key}` } });
        assert.equal(usage.status, 200);
        assert.equal(typeof await usage.json(), "object");
        for (const target of ["/responses", "/v1/responses"]) {
          assert.equal((await request(target, { method: "POST", body: "{" })).status, authenticated ? 401 : 500);
          // Invalid JSON reaches the real Responses handler but never a model/provider.
          const response = await request(target, { method: "POST", body: "{",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
          assert.equal(response.status, 500);
          assert.equal(typeof (await response.json()).error.message, "string");
        }
        const config = JSON.parse(await readFile(configFile, "utf8"));
        assert.equal(config.useResponsesApiWebSocket, explicitWebSocket ?? false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    }
    await assert.rejects(readFile(denied), { code: "ENOENT" });
    return { ok: true, responsesRoutes: true, usageApi: true, configuredDefaultsPreserved: true, modelRequests: false };
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw new Error("Provide the built Codey package directory");
  console.log(JSON.stringify(await checkCopilot(process.argv[2])));
}
