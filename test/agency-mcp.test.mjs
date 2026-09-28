import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AGENCY_SERVERS, StdioMcpClient, agencyMcpEnvironment, callReadOnlyTool, executableCandidates,
  installAgencyConfig, mergeAgencyConfig, newestAgency, parseToolData,
  redactDiagnostic, renderAgencyConfig, resolveExecutable, validateCodexConfig, validateReadOnlyCatalog,
  verifyAgencyReadAccess,
} from "../src/agency-mcp.mjs";

const fixture = fileURLToPath(new URL("./fixtures/agency-mcp-server.mjs", import.meta.url));
const catalog = service => AGENCY_SERVERS[service].tools.map(name => ({ name }));
const temporary = async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codey-agency-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codey-agency-test-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
};
const clientFor = (t, mode = "normal", options = {}) => {
  const client = new StdioMcpClient(process.execPath, [fixture, mode], { timeoutMs: 5000, ...options });
  t.after(() => client.close());
  return client;
};

test("headless Linux uses cached AzureAuth without persisting a session-specific browser or secrets", () => {
  for (const env of [{}, { BROWSER: "/private/vscode/browser.sh", API_TOKEN: "private" }]) {
    const original = { ...env };
    assert.deepEqual(agencyMcpEnvironment({ platform: "linux", env }), {
      AGENCY_AEC_ENABLED: "0", BROWSER: "/bin/false",
    });
    assert.deepEqual(env, original);
  }
});

test("Windows, macOS, and graphical Linux retain their native browser authentication environment", () => {
  for (const options of [
    { platform: "win32", env: {} }, { platform: "darwin", env: {} },
    { platform: "linux", env: { DISPLAY: ":0" } },
    { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } },
  ]) assert.deepEqual(agencyMcpEnvironment(options), { AGENCY_AEC_ENABLED: "0" });
});

test("generated entries persist the same headless authentication environment as setup probes", () => {
  const options = { platform: "linux", env: { BROWSER: "/private/vscode/browser.sh" } };
  const config = renderAgencyConfig("/bin/agency", "\n", options);
  assert.equal((config.match(/env = \{ AGENCY_AEC_ENABLED = "0", BROWSER = "\/bin\/false" \}/g) || []).length, 2);
  assert.doesNotMatch(config, /private\/vscode|devicecode/);
  for (const platform of ["win32", "darwin"]) {
    assert.doesNotMatch(renderAgencyConfig("/bin/agency", "\n", { platform, env: {} }), /BROWSER/);
  }
});

test("headless environment upgrades preserve unrelated config and remain idempotent", () => {
  const prefix = 'model = "keep"\n\n';
  const suffix = '\n[projects."keep"]\ntrust_level = "trusted"\n';
  const old = prefix + renderAgencyConfig("/bin/agency", "\n", { platform: "linux", env: { DISPLAY: ":0" } }) + suffix;
  const options = { platform: "linux", env: {} };
  const updated = mergeAgencyConfig(old, "/bin/agency", options);
  assert.ok(updated.startsWith(prefix));
  assert.ok(updated.endsWith(suffix));
  assert.equal((updated.match(/BROWSER = "\/bin\/false"/g) || []).length, 2);
  assert.equal(mergeAgencyConfig(updated, "/bin/agency", options), updated);
});

test("Windows discovers native per-user Agency before PATH, with spaces and no shell", () => {
  const candidates = executableCandidates("agency", {
    platform: "win32", home: "C:\\Users\\A User",
    env: { APPDATA: "C:\\Users\\A User\\AppData\\Roaming", Path: ';C:\\.Tools\\agency\\CurrentVersion;"C:\\Program Files\\Agency";relative;.' },
  });
  assert.deepEqual(candidates, [
    "C:\\Users\\A User\\AppData\\Roaming\\agency\\CurrentVersion\\agency.exe",
    "C:\\.Tools\\agency\\CurrentVersion\\agency.exe", "C:\\Program Files\\Agency\\agency.exe",
  ]);
  assert.ok(candidates.every(value => !value.endsWith(".cmd")));
});

for (const [platform, home] of [["darwin", "/Users/some user"], ["linux", "/home/some user"]]) {
  test(`${platform} resolves POSIX Agency without Windows paths or empty PATH entries`, () => {
    const candidates = executableCandidates("agency", { platform, home, env: { PATH: ":/usr/bin:relative:/usr/local/bin:." } });
    assert.deepEqual(candidates, [
      ...(platform === "linux" ? [`${home}/.config/agency/CurrentVersion/agency`] : []),
      "/usr/bin/agency", "/usr/local/bin/agency", `${home}/.local/bin/agency`, "/opt/homebrew/bin/agency",
    ]);
    assert.ok(candidates.every(value => !value.includes("\\") && !value.endsWith(".exe")));
  });
}

test("Linux discovers PathInstaller Agency with an empty PATH, deduplicates it and leaves other tools alone", () => {
  const home = "/home/some user";
  const installed = `${home}/.config/agency/CurrentVersion/agency`;
  for (const env of [{}, { PATH: "" }, { PATH: `${home}/.config/agency/CurrentVersion:/usr/bin` }]) {
    const before = { ...env };
    const candidates = executableCandidates("agency", { platform: "linux", home, env });
    assert.equal(candidates[0], installed);
    assert.equal(candidates.filter(file => file === installed).length, 1);
    assert.deepEqual(env, before, "Discovery must not modify shell startup files or environment");
    assert.ok(executableCandidates("codex", { platform: "linux", home, env: {} })
      .every(file => !file.includes("/.config/agency/")));
  }
});

test("the Linux PathInstaller candidate runs with spaces and no PATH without invoking authentication", {
  skip: process.platform === "win32",
}, async t => {
  const home = path.join(await temporary(t), "home with spaces");
  const command = executableCandidates("agency", { platform: "linux", home, env: {} })[0];
  await mkdir(path.dirname(command), { recursive: true });
  await writeFile(command, '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 91\nprintf "agency 2026.9.26.2 (fixture)\\n"\n', { mode: 0o700 });
  const found = await resolveExecutable("agency", { explicit: command, env: { PATH: "" } });
  assert.equal(found.command, command);
  assert.equal(found.version, "agency 2026.9.26.2 (fixture)");
});

test("chooses the newer installed Agency without updating PATH or downloading software", () => {
  const choices = [
    { command: "old", version: "agency 2026.4.7.9 (target: x86_64-windows)" },
    { command: "new", version: "agency 2026.9.16.4 (target: aarch64-apple-darwin)" },
    { command: "invalid", version: "not agency" },
  ];
  assert.equal(newestAgency(choices).command, "new");
  assert.equal(choices[0].command, "old");
  assert.throws(() => executableCandidates("agency", { platform: "unsupported" }), /Unsupported platform/);
});

test("read-only catalogs use exact names; newly added tools stay excluded", () => {
  const tools = [...catalog("teams"), { name: "SendMessageToChat" }, { name: "GetAndDeleteMessages" }];
  const result = validateReadOnlyCatalog("teams", tools);
  assert.deepEqual(result.enabledTools, AGENCY_SERVERS.teams.tools);
  assert.deepEqual(result.excludedTools, ["SendMessageToChat", "GetAndDeleteMessages"]);
  assert.throws(() => validateReadOnlyCatalog("teams", []), /missing reviewed/);
  assert.throws(() => validateReadOnlyCatalog("unknown", []), /Unsupported Agency service/);
});

test("contradictory read-only/destructive annotations fail closed", () => {
  for (const annotations of [{ readOnlyHint: false }, { destructiveHint: true }]) {
    const tools = catalog("mail");
    tools[0].annotations = annotations;
    assert.throws(() => validateReadOnlyCatalog("mail", tools), /writable\/destructive/);
  }
});

test("write calls are refused before reaching the MCP server", async () => {
  let calls = 0;
  const client = { request: async () => { calls++; return { content: [] }; } };
  for (const [service, name] of [["teams", "UpdateChat"], ["teams", "SendMessageToChat"], ["mail", "CreateDraftMessage"], ["mail", "DeleteMessage"]]) {
    await assert.rejects(callReadOnlyTool(client, service, name, {}), /not in the read-only allowlist/);
  }
  assert.equal(calls, 0);
  await assert.rejects(callReadOnlyTool({ request: async () => ({ isError: true }) }, "mail", "GetMessage", {}), /tool error/);
});

test("read-tool RPC errors cannot echo private message identifiers or text", async () => {
  await assert.rejects(callReadOnlyTool({ request: async () => {
    throw new Error("private-message-id private subject private@example.com");
  } }, "mail", "GetMessage", { id: "private-message-id" }),
  error => /RPC failed/.test(error.message) && !/private-message-id|private subject|private@example/.test(error.message));
});

for (const command of ["C:\\Users\\A User\\Agency\\agency.exe", "/Users/a user/.local/bin/agency", "/home/a user/.local/bin/agency"]) {
  test(`configuration safely quotes native executable ${command}`, () => {
    const config = renderAgencyConfig(command);
    assert.ok(config.includes(`command = ${JSON.stringify(command)}`));
    assert.ok(config.includes('args = ["mcp", "teams"]'));
    assert.ok(config.includes('args = ["mcp", "mail"]'));
    assert.equal((config.match(/^enabled_tools = /gm) || []).length, 2);
    assert.doesNotMatch(config, /SendMessage|DeleteMessage|UpdateChat|CreateDraft|bearer_token|client_secret|password/i);
    assert.ok(config.includes('AGENCY_AEC_ENABLED = "0"'));
  });
}

for (const newline of ["\n", "\r\n"]) {
  test(`managed configuration is idempotent and preserves unrelated content (${JSON.stringify(newline)})`, () => {
    const original = '\uFEFFmodel = "unchanged"\n\n[mcp_servers.keep]\ncommand = "keep"\n'.replaceAll("\n", newline);
    const once = mergeAgencyConfig(original, "/bin/agency");
    assert.ok(once.startsWith(original));
    assert.equal(mergeAgencyConfig(once, "/bin/agency"), once);
    const suffix = `${newline}[projects."unchanged"]${newline}trust_level = "trusted"${newline}`;
    const next = mergeAgencyConfig(once + suffix, "/new/agency");
    assert.ok(next.startsWith(original));
    assert.ok(next.endsWith(suffix));
    assert.ok(next.includes('command = "/new/agency"'));
  });
}

test("refuses unmanaged, malformed, or unexpectedly expanded managed config", () => {
  for (const original of [
    '[mcp_servers.agency_teams]\ncommand = "custom"',
    '[mcp_servers."agency_mail"]\ncommand = "custom"',
    "# BEGIN Codey Agency MCP - read-only\n",
    "# END Codey Agency MCP - read-only\n",
    renderAgencyConfig("/bin/agency").replace("# END", '[mcp_servers.other]\ncommand = "keep"\n# END'),
  ]) assert.throws(() => mergeAgencyConfig(original, "/bin/agency"), /unmanaged|Malformed|Unexpected/);
});

test("apply backs up exact bytes, preserves unrelated settings, and is idempotent", async t => {
  const root = await temporary(t), configPath = path.join(root, "config.toml");
  const original = 'model = "existing"\r\n[mcp_servers.keep]\r\ncommand = "existing"\r\n';
  await writeFile(configPath, original);
  const updated = mergeAgencyConfig(original, "/bin/agency");
  const result = await installAgencyConfig(configPath, original, updated);
  assert.equal(result.changed, true);
  assert.equal(await readFile(result.backupPath, "utf8"), original);
  assert.equal(await readFile(configPath, "utf8"), updated);
  assert.equal((await installAgencyConfig(configPath, updated, updated)).changed, false);
  assert.equal((await readdir(root)).filter(name => name.includes(".agency-backup-")).length, 1);
  assert.ok((await readdir(root)).every(name => !name.endsWith(".tmp")));
  if (process.platform !== "win32") {
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
  }
});

test("apply does not overwrite edits made after the setup plan", async t => {
  const root = await temporary(t), configPath = path.join(root, "config.toml");
  await writeFile(configPath, "new user edit");
  await assert.rejects(installAgencyConfig(configPath, "original", "replacement"), /changed during setup/);
  assert.equal(await readFile(configPath, "utf8"), "new user edit");
  assert.deepEqual(await readdir(root), ["config.toml"]);
  await assert.rejects(installAgencyConfig(root, "", "replacement"), /non-regular/);
});

test("new configuration gets no fake backup of a nonexistent file", async t => {
  const root = await temporary(t), configPath = path.join(root, "new-home", "config.toml");
  const result = await installAgencyConfig(configPath, "", renderAgencyConfig("/bin/agency"));
  assert.equal(result.backupPath, undefined);
  assert.equal(result.changed, true);
});

test("candidate validation uses isolated CODEX_HOME and checks the exact native allowlists", async () => {
  let temporaryRoot, calls = 0;
  const contents = mergeAgencyConfig('model = "keep"\n', "/bin/agency");
  await validateCodexConfig("codex", contents, "/bin/agency", {
    executeImpl: async (command, args, options) => {
      assert.equal(command, "codex");
      assert.equal(options.windowsHide, true);
      temporaryRoot = options.env.CODEX_HOME;
      assert.equal(await readFile(path.join(temporaryRoot, "config.toml"), "utf8"), contents);
      const service = args[2].slice("agency_".length);
      calls++;
      return { stdout: JSON.stringify({
        enabled: true, enabled_tools: AGENCY_SERVERS[service].tools,
        transport: { command: "/bin/agency", args: ["mcp", service], env: agencyMcpEnvironment() },
      }) };
    },
  });
  assert.equal(calls, 2);
  await assert.rejects(stat(temporaryRoot), { code: "ENOENT" });
});

test("native validation rejects missing or changed authentication environment overrides", async () => {
  const environment = agencyMcpEnvironment({ platform: "linux", env: {} });
  for (const env of [
    { AGENCY_AEC_ENABLED: "0" },
    { AGENCY_AEC_ENABLED: "1", BROWSER: "/bin/false" },
    { AGENCY_AEC_ENABLED: "0", BROWSER: "/private/vscode/browser.sh" },
  ]) {
    await assert.rejects(validateCodexConfig("codex", "", "/bin/agency", {
      environment,
      executeImpl: async (command, args) => {
        const service = args[2].slice("agency_".length);
        return { stdout: JSON.stringify({
          enabled: true, enabled_tools: AGENCY_SERVERS[service].tools,
          transport: { command: "/bin/agency", args: ["mcp", service], env },
        }) };
      },
    }), /rejected/);
  }
});

test("candidate validation never prints secret-bearing native config errors", async () => {
  await assert.rejects(validateCodexConfig("codex", 'secret = "private"', "/bin/agency", {
    executeImpl: async () => { throw new Error("secret = private"); },
  }), error => !error.message.includes("private") && /existing config was not changed/.test(error.message));
  await assert.rejects(validateCodexConfig("codex", "", "/bin/agency", {
    executeImpl: async () => ({ stdout: JSON.stringify({ enabled: true, enabled_tools: null }) }),
  }), /rejected/);
});

test("native stdio initialization, pagination, and read-only tool calls", async t => {
  const client = clientFor(t);
  assert.equal((await client.initialize()).serverInfo.name, "fixture");
  const tools = await client.listTools();
  assert.equal(tools.length, AGENCY_SERVERS.teams.tools.length + 1);
  assert.deepEqual(validateReadOnlyCatalog("teams", tools).excludedTools, ["SendMessageToChat"]);
  const result = await callReadOnlyTool(client, "teams", "ListChats", {});
  assert.deepEqual(parseToolData(result), { value: [{ id: "fixture", body: "not real user data" }] });
});

for (const [mode, message] of [["duplicate", /duplicate/], ["cursor-loop", /pagination cursor/]]) {
  test(`MCP catalog fails closed for ${mode}`, async t => {
    const client = clientFor(t, mode);
    await client.initialize();
    await assert.rejects(client.listTools(), message);
  });
}

for (const [mode, options, message] of [
  ["silent", { timeoutMs: 100 }, /timed out/],
  ["malformed", {}, /non-JSON/],
  ["normal", { maxBytes: 32 }, /size limit/],
  ["rpc-error", {}, /\[REDACTED\]/],
]) {
  test(`MCP errors are bounded and close their own child (${mode})`, async t => {
    const client = clientFor(t, mode, options);
    await assert.rejects(client.initialize(), message);
    await client.close();
    assert.equal(client.pending.size, 0);
  });
}

test("tool success requires structured non-error content, including nested Agency errors", () => {
  for (const data of [
    { isError: true },
    { content: [{ type: "text", text: "unexpected private body" }] },
    { structuredContent: { error: { message: "denied" } } },
    { structuredContent: { rawResponse: '{"error":{"code":"Unauthorized"}}' } },
    { structuredContent: { rawResponse: "not JSON" } },
    { structuredContent: { statusCode: 403 } },
  ]) assert.throws(() => parseToolData(data), /error|structured|wrapper/);
  assert.deepEqual(parseToolData({ structuredContent: { value: [] } }), { value: [] });
});

test("authentication diagnostics redact tokens without exposing credential contents", () => {
  const output = redactDiagnostic('Bearer token access_token=abc refresh_token="def" client_secret: ghi password=jkl eyJabc.abc.abc');
  for (const secret of ["Bearer token", "=abc", '"def"', "ghi", "jkl", "eyJabc"]) assert.ok(!output.includes(secret));
});

test("live-read verifier reads one mail preview without writing or returning private content", async () => {
  const calls = [];
  const client = { request: async (method, params) => {
    calls.push({ method, ...params });
    return { structuredContent: params.name === "SearchMessagesQueryParameters"
      ? { value: [{ id: "private-id", isRead: false }] }
      : { data: { id: "private-id", isRead: false, bodyPreview: "private message" } } };
  } };
  assert.deepEqual(await verifyAgencyReadAccess(client, "mail"), { querySucceeded: true, returnedItems: 1, messageRead: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].arguments, { queryParameters: "?$top=1&$select=id,receivedDateTime,isRead" });
  assert.deepEqual(calls[1].arguments, { id: "private-id", bodyPreviewOnly: true });
  assert.ok(calls.every(call => AGENCY_SERVERS.mail.tools.includes(call.name)));
});

test("live-read verifier uses retrieved Teams IDs and bounded search results", async () => {
  const calls = [];
  const client = { request: async (method, params) => {
    calls.push({ method, ...params });
    return { structuredContent: params.name === "SearchTeamMessagesQueryParameters"
      ? { value: [{ hitsContainers: [{ hits: [{ resource: { chatId: "private@thread.v2", id: "private-id" } }] }] }] }
      : { id: "private-id", body: { content: "private message" } } };
  } };
  assert.deepEqual(await verifyAgencyReadAccess(client, "teams", { now: new Date("2026-09-28T00:00:00Z") }),
    { querySucceeded: true, returnedItems: 1, messageRead: true });
  assert.deepEqual(calls[0].arguments, { queryString: "sent>=2026-09-21", from: 0, size: 1 });
  assert.deepEqual(calls[1].arguments, { chatId: "private@thread.v2", messageId: "private-id" });
});

test("live-read verification distinguishes empty, failed, and changed read-state responses", async () => {
  const wrap = structuredContent => ({ request: async () => ({ structuredContent }) });
  assert.deepEqual(await verifyAgencyReadAccess(wrap({ value: [] }), "mail"),
    { querySucceeded: true, returnedItems: 0, messageRead: false });
  assert.deepEqual(await verifyAgencyReadAccess(wrap({ value: [] }), "teams"),
    { querySucceeded: true, returnedItems: 0, messageRead: false });
  await assert.rejects(verifyAgencyReadAccess(wrap({ unexpected: true }), "mail"), /collection/);
  await assert.rejects(verifyAgencyReadAccess(wrap({ value: [{}] }), "teams"), /collection/);
  await assert.rejects(verifyAgencyReadAccess({ request: async (method, params) => ({ structuredContent:
    params.name === "SearchMessagesQueryParameters"
      ? { value: [{ id: "message-id", isRead: false }] }
      : { data: { id: "message-id", isRead: true, bodyPreview: "private" } },
  }) }, "mail"), /read-state changed/);
});
