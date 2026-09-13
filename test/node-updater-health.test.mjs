import assert from "node:assert/strict";
import test from "node:test";
import { probeCloudCliHealth } from "../node-updater/probe.mjs";

test("Linux whole-app health uses only authenticated/anonymous GET checks, never sessions or model inference", async () => {
  const calls = [];
  const proof = await probeCloudCliHealth(async (...args) => {
    calls.push(args);
    if (args[0] === "/api/auth/status") throw new Error("HTTP 401");
    return { version: "0.1.7" };
  }, "0.1.7", 2);
  assert.deepEqual(calls, [["/api/auth/status", "GET", undefined, false], ["/health"]]);
  assert.deepEqual(proof, { healthy: true, authenticated: true, version: "0.1.7", runningSessions: 2, modelRequests: false });
  await assert.rejects(probeCloudCliHealth(async pathname => {
    if (pathname === "/api/auth/status") throw new Error("HTTP 401");
    return { version: "0.1.6" };
  }, "0.1.7", 0));
  await assert.rejects(probeCloudCliHealth(async () => ({ version: "0.1.7" }), "0.1.7", 0),
    /Workspace authentication changed/);
  await assert.rejects(probeCloudCliHealth(async () => { throw new Error("authentication failed"); }, "0.1.7", 0));
  await assert.rejects(probeCloudCliHealth(async () => { throw new Error("TLS failed"); }, "0.1.7", 0));
});
