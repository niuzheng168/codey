import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Azure CLI's Linux installation already carries the Storage SDK. Other
// operators can select their deployment venv without adding Portal dependencies.
const args = process.argv.slice(2);
const needsAzureSdk = args.includes("--apply") && !args.includes("--local");
const candidates = process.env.CODEY_DEPLOY_PYTHON
  ? [process.env.CODEY_DEPLOY_PYTHON]
  : needsAzureSdk ? ["/opt/az/bin/python3", "python3", "python"] : ["python3", "python"];
const python = candidates.find((candidate) => spawnSync(candidate, [
  "-I", "-c", `import sys; assert sys.version_info >= (3, 10)${needsAzureSdk ? "; import azure.storage.fileshare" : ""}`,
], { stdio: "ignore" }).status === 0);
if (!python) {
  console.error("Set CODEY_DEPLOY_PYTHON to Python 3.10+ with azure-storage-file-share for Azure publication.");
  process.exitCode = 1;
} else {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "publish-cloudcli-ui.py");
  const child = spawn(python, ["-I", script, ...args], { stdio: "inherit" });
  child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}
