import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export async function registrationFixture(t, platform = "linux-x64") {
  const home = await mkdtemp(path.join(os.tmpdir(), "codey-registration-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const identity = {
    nodeId: "n-" + randomBytes(12).toString("hex"),
    workspaceSubject: "m-" + randomBytes(12).toString("hex"), workspaceUsername: "owner",
    ...Object.fromEntries(["clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey", "updaterCredential"]
      .map(key => [key, randomBytes(32).toString("base64url")])),
  };
  const serverName = `${identity.nodeId}.nodes.codey.internal`;
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-subj", `/CN=${serverName}`, "-addext", `subjectAltName=DNS:${serverName}`,
    "-addext", "basicConstraints=critical,CA:FALSE",
    "-keyout", path.join(home, "key.pem"), "-out", path.join(home, "cert.pem")]);
  const setup = { platform, portalOrigin: "https://codey.example.test", releaseId: "machine-" + "a".repeat(16) };
  const coordinates = { tunnelId: `codey-${identity.nodeId}`, clusterId: "jpe1" };
  const token = `e30.${Buffer.from(JSON.stringify({
    ...coordinates, scp: "connect", exp: Math.floor(Date.now() / 1000) + 72000,
  })).toString("base64url")}.c2ln`;
  return { home, identity, setup, coordinates, token, certificate: await readFile(path.join(home, "cert.pem"), "utf8") };
}
