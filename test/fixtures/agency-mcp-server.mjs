import { createInterface } from "node:readline";
import { AGENCY_SERVERS } from "../../src/agency-mcp.mjs";

const mode = process.argv[2] || "normal";
const tools = [...AGENCY_SERVERS.teams.tools, "SendMessageToChat"].map(name => ({
  name, inputSchema: { type: "object", properties: {} },
}));
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (mode === "silent") continue;
  if (mode === "malformed") { process.stdout.write("not JSON\n"); continue; }
  if (mode === "rpc-error") {
    send({ id: request.id, error: { code: -32603, message: "Bearer secret-token access_token=secret-token" } });
    continue;
  }
  if (request.method === "initialize") {
    send({ id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
  } else if (request.method === "tools/list") {
    if (mode === "duplicate") send({ id: request.id, result: { tools: [tools[0], tools[0]] } });
    else if (mode === "cursor-loop") send({ id: request.id, result: { tools: [], nextCursor: "again" } });
    else send({ id: request.id, result: request.params.cursor
      ? { tools: tools.slice(7) } : { tools: tools.slice(0, 7), nextCursor: "second-page" } });
  } else if (request.method === "tools/call") {
    send({ id: request.id, result: { content: [{ type: "text", text: JSON.stringify({
      rawResponse: JSON.stringify({ value: [{ id: "fixture", body: "not real user data" }] }),
    }) }] } });
  }
}
