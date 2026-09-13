import assert from "node:assert/strict";
import test from "node:test";
import { nativeProbeEnvironment } from "../node-updater/probe.mjs";

test("the native probe accepts the actual Windows schema-2 descriptor without inventing a platform field", () => {
  const config = { kind: "codey-windows-oneclick", schema: 2, layout: "npm-codey-package",
    ownerHome: "C:\\Owner", nodeId: "windows-node", nodeExe: "C:\\Owner\\node.exe",
    codeyDirectory: "C:\\Owner\\codey", services: { codey: { environment: { CODEY_PORTAL_NODE_ID: "windows-node" } } } };
  const input = { nodeId: config.nodeId, cloudcliPath: config.codeyDirectory };
  const context = { platform: "win32", arch: "x64", home: config.ownerHome, node: config.nodeExe };
  assert.equal(nativeProbeEnvironment(config, input, context).CODEY_PORTAL_NODE_ID, "windows-node");
  assert.equal(nativeProbeEnvironment({ ...config, platform: "windows-x64" }, input, context).HOST, "127.0.0.1");
  for (const patch of [{ kind: "codey-macos-oneclick" }, { schema: 1 }, { layout: "legacy" },
    { platform: "linux-x64" }, { ownerHome: "C:\\Another" }, { nodeId: "another-node" },
    { nodeExe: "C:\\Unrelated\\node.exe" }, { codeyDirectory: "C:\\Another\\codey" }]) {
    assert.throws(() => nativeProbeEnvironment({ ...config, ...patch }, input, context));
  }
  assert.throws(() => nativeProbeEnvironment(config, input, { ...context, arch: "arm64" }));
});

test("Mac native probes still require their explicit platform and architecture", () => {
  const config = { kind: "codey-macos-oneclick", platform: "macos-arm64", ownerHome: "/Users/owner",
    nodeId: "mac-node", nodeExe: "/Users/owner/node", codeyDirectory: "/Users/owner/codey", environment: {} };
  const input = { nodeId: config.nodeId, cloudcliPath: config.codeyDirectory };
  const context = { platform: "darwin", arch: "arm64", home: config.ownerHome, node: config.nodeExe };
  assert.equal(nativeProbeEnvironment(config, input, context).HOST, "127.0.0.1");
  assert.throws(() => nativeProbeEnvironment({ ...config, platform: undefined }, input, context));
  assert.throws(() => nativeProbeEnvironment(config, input, { ...context, arch: "x64" }));
});
