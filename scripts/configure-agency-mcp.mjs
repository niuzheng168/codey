#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  AGENCY_SERVERS, StdioMcpClient, installAgencyConfig, mergeAgencyConfig,
  resolveExecutable, validateCodexConfig, validateReadOnlyCatalog, verifyAgencyReadAccess,
} from "../src/agency-mcp.mjs";

const { values } = parseArgs({ options: {
  apply: { type: "boolean", default: false },
  "verify-read": { type: "boolean", default: false },
  agency: { type: "string" },
  codex: { type: "string" },
  "codex-home": { type: "string" },
  timeout: { type: "string", default: "120" },
  help: { type: "boolean", short: "h", default: false },
} });

if (values.help) {
  console.log(`Configure read-only Agency Teams/Mail MCP for native Codex on Windows, macOS, or Linux.

Usage: node scripts/configure-agency-mcp.mjs [--apply] [--verify-read] [--agency ABSOLUTE_PATH] [--codex ABSOLUTE_PATH]
       [--codex-home DIRECTORY] [--timeout SECONDS]

Default: discover both servers and validate a plan without changing config.toml.
--apply: back up config.toml, then atomically install the verified read-only entries.
--verify-read: read at most one search result per service and its message/preview.
               Only success/counts are printed; no message content or IDs are saved.
Agency and Codex must already be installed. Agency handles per-host Entra sign-in.
No install, PATH change, credential copying, gateway change, or service restart.`);
} else {
  try {
    const timeoutMs = Number(values.timeout) * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error("--timeout must be between 1 and 600 seconds.");
    const home = path.resolve(values["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    const configPath = path.join(home, "config.toml");
    const original = await readFile(configPath, "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const agency = await resolveExecutable("agency", { explicit: values.agency || process.env.AGENCY_BIN });
    const codex = await resolveExecutable("codex", { explicit: values.codex || process.env.CODEX_BIN });
    const updated = mergeAgencyConfig(original, agency.command);
    const catalogs = [];
    for (const service of Object.keys(AGENCY_SERVERS)) {
      const client = new StdioMcpClient(agency.command, ["mcp", service], {
        timeoutMs, env: { ...process.env, AGENCY_AEC_ENABLED: "0" },
      });
      try {
        const initialized = await client.initialize();
        const catalog = validateReadOnlyCatalog(service, await client.listTools());
        const readProbe = values["verify-read"] ? await verifyAgencyReadAccess(client, service) : undefined;
        catalogs.push({ ...catalog, serverInfo: initialized.serverInfo, readProbe });
      } finally { await client.close(); }
    }
    await validateCodexConfig(codex.command, updated, agency.command);
    const result = values.apply
      ? await installAgencyConfig(configPath, original, updated)
      : { changed: false, configPath, wouldChange: original !== updated };
    console.log(JSON.stringify({
      ok: true, mode: values.apply ? "apply" : "plan", platform: process.platform,
      agency, codex, ...result, servers: catalogs,
      note: `${values["verify-read"] ? "Read probes completed; private content was not printed or saved." : "Only tool discovery was performed."} Restart the MCP servers or open a new Codex task to load the configuration.`,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
