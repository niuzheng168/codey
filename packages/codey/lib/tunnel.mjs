#!/usr/bin/env node
/** Internal native-service entrypoint, not another public CLI or supervisor service. */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openMachine } from "./machine.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export async function runTunnelWorker(root, args, {
  open = openMachine, log = console.log, load = file => import(pathToFileURL(file).href),
} = {}) {
  const [operation, file] = args;
  if (args.length !== 2 || !["host", "show", "renew"].includes(operation) || !path.isAbsolute(file ?? "")) {
    throw new Error("Invalid internal tunnel operation");
  }
  const machine = await open(root);
  if (!machine || file !== machine.i.file || machine.config.tunnelAuth?.source !== "gh") {
    throw new Error("This node is not configured for GitHub CLI tunnel authentication");
  }
  await machine.tools();
  const { config, i } = machine;
  const github = await load(path.join(i.skill, "scripts/github-auth.mjs"));
  const tunnel = await load(path.join(i.skill, "scripts/github-tunnel.mjs"));
  const helpers = await load(path.join(i.skill, "scripts/windows-runtime.mjs"));
  const identity = await i.read(config.identityFile);
  const target = tunnel.tunnelCoordinates(config.qualifiedTunnel);
  if (identity.nodeId !== config.nodeId || target.tunnelId !== `codey-${config.nodeId}`) {
    throw new Error("Tunnel worker identity does not match this node");
  }
  const coordinates = helpers.validateTunnel(await i.read(config.tunnelFile), target.tunnelId, target.clusterId);
  if (operation === "host") return tunnel.hostGhTunnel(config);
  if (operation === "renew") {
    await helpers.renew(config, identity, coordinates, await helpers.tokenFor(config, coordinates));
    return 0;
  }
  const credential = await github.readGhCredential({ environment: config.baseEnvironment, binding: config.tunnelAuth });
  const shown = await tunnel.getGhTunnel(credential, coordinates);
  helpers.validateTunnel(shown, coordinates.tunnelId, coordinates.clusterId);
  log(JSON.stringify(shown));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTunnelWorker(ROOT, process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error("Codey tunnel authentication/operation failed; check the pinned gh account with codey doctor. No login was started.");
    process.exitCode = 1;
  });
}
