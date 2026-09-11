// Run against an explicitly provided, freshly npm-installed build. Never load
// credentials from the user's actual COPILOT_API_HOME or call a real endpoint.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot] = process.argv.slice(2);
assert.ok(packageRoot && path.isAbsolute(packageRoot));
const home = await mkdtemp(path.join(os.tmpdir(), "codey-auth-reuse-"));
Object.assign(process.env, {
  COPILOT_API_HOME: home, COPILOT_API_GITHUB_TOKEN: "",
  COPILOT_API_OAUTH_APP: "", COPILOT_API_ENTERPRISE_URL: "",
});
const tokenFile = path.join(home, "github_token");
const credential = "fixture-only-persisted-credential";
await writeFile(tokenFile, credential);
let rejected = false;
let userCalls = 0;
globalThis.fetch = async (url) => {
  // Every unmocked request, including device-code authentication, is forbidden.
  assert.ok(String(url).endsWith("/copilot_internal/user"), "unexpected network operation");
  userCalls++;
  return Response.json(rejected ? { message: "fixture-invalid-authorization" } : {
    login: "fixture-user", endpoints: { api: "https://fixture.invalid" },
  }, { status: rejected ? 401 : 200 });
};
const gateway = path.join(packageRoot, "gateway");
let tokenModule;
for (const file of await readdir(gateway)) {
  if (!/^token-.*\.js$/.test(file)) continue;
  const body = await readFile(path.join(gateway, file), "utf8");
  if (body.includes("setupGitHubToken") && body.includes("setupCopilotToken")) {
    const loaded = await import(pathToFileURL(path.join(gateway, file)));
    // Bundling shortens export names; use the named export table, not a fixed hash.
    const name = original => new RegExp(`\\b${original} as (\\w+)\\b`).exec(body)?.[1] ?? original;
    tokenModule = {
      github: loaded[name("setupGitHubToken")],
      copilot: loaded[name("setupCopilotToken")],
      state: loaded[name("state")],
    };
    break;
  }
}
assert.ok(tokenModule);
try {
  await tokenModule.github();
  assert.equal(tokenModule.state.githubToken, credential);
  tokenModule.state.githubToken = undefined;
  await tokenModule.github(); // Same persisted file after a simulated reload.
  assert.equal(tokenModule.state.githubToken, credential);
  assert.equal(userCalls, 2);
  let exchanges = 0;
  await tokenModule.copilot({
    getCopilotToken: async () => ({
      token: `fixture-short-lived-${++exchanges}`, refresh_in: 0,
      endpoints: { api: "https://fixture.invalid" },
    }),
  });
  const deadline = Date.now() + 5000;
  while (exchanges < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(exchanges >= 2, "short-lived token automatically refreshed");
  assert.equal(tokenModule.state.copilotToken, `fixture-short-lived-${exchanges}`);
  assert.equal(await readFile(tokenFile, "utf8"), credential);
  rejected = true;
  await assert.rejects(tokenModule.github());
  assert.equal(await readFile(tokenFile, "utf8"), credential, "upstream rejection never deletes the credential");
  console.log("AUTH_REUSE_REFRESH_AND_REJECTION_PRESERVATION_OK");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(home).startsWith("codey-auth-reuse-"));
  await rm(home, { recursive: true, force: true });
}
// The bundled private refresh loop intentionally keeps a gateway alive.
process.exit(process.exitCode || 0);
