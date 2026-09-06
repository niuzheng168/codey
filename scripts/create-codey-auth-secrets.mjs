import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashPassword } from "../src/password-auth.mjs";
import { workspaceNodeKey } from "../src/workspace-sso.mjs";

// Run once with a private, access-controlled output directory. Read the initial
// password from stdin, never argv, source files, logs, or an environment dump.
const [directory, principalId] = process.argv.slice(2);
if (!directory || !/^[a-f0-9-]{36}$/.test(principalId ?? "")) {
  throw new Error("Usage: node create-codey-auth-secrets.mjs <private-directory> <existing-owner-id>");
}
const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const password = Buffer.concat(input).toString("utf8").replace(/\r?\n$/, "");
if (password.length < 8 || password.length > 1024) throw new Error("Invalid initial password length");
const master = randomBytes(32).toString("base64url");
const credential = { username: "zhn", principalId, passwordHash: await hashPassword(password) };
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(path.join(directory, "secrets.json"), JSON.stringify({ master, credential }), { mode: 0o600, flag: "wx" });
for (const id of ["zhn-a100", "jpe2", "jpe3", "westus2"]) {
  const environment = [
    "CODEY_PORTAL_SSO=true",
    `CODEY_PORTAL_NODE_ID=${id}`,
    "CODEY_PORTAL_USERNAME=zhn",
    `CODEY_PORTAL_PRINCIPAL_ID=${principalId}`,
    `CODEY_PORTAL_SSO_KEY=${workspaceNodeKey(master, id)}`,
    "CODEY_PORTAL_TLS_CERT=/home/zhn/.config/copilot-api/codey-tls/fullchain.pem",
    "CODEY_PORTAL_TLS_KEY=/home/zhn/.config/copilot-api/codey-tls/server.key.pem",
  ].join("\n") + "\n";
  await writeFile(path.join(directory, `${id}.env`), environment, { mode: 0o600, flag: "wx" });
}
console.log("Prepared a salted password verifier and four isolated node keys. No plaintext password was saved.");
