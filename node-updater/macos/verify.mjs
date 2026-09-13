// This is a child of the independent updater, while native.py retains the
// original install.lock. Never run it from the target Codey launch agent.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, requireValue } from "../windows/client.mjs";
import { verifyRequest, verificationCode } from "../windows/verify.mjs";
import { Runtime, validateConfig } from "./runtime.mjs";

async function main() {
  requireValue(process.platform === "darwin" && process.argv.length === 3 && process.getuid() !== 0, "unsupported_platform");
  const request = await readJson(process.argv[2]);
  const expected = path.join(os.homedir(), ".config/codey-updater/config.json");
  requireValue(request.agentConfig === expected);
  const config = validateConfig(await readJson(expected));
  const runtime = new Runtime(config);
  const runtimeConfig = await readJson(runtime.runtimeFile);
  console.log(JSON.stringify(await verifyRequest(request, {
    config, runtimeConfig, platform: config.platform, runtimeFile: runtime.runtimeFile,
  })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = verificationCode(error);
    console.log(JSON.stringify({ passed: false, code, modelRequests: false }));
    console.error(code);
    process.exitCode = 1;
  });
}
