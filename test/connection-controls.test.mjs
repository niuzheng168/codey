import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("Usage and retained history keep their refresh actions without obsolete connection controls", () => {
  for (const [containerClass, refreshId] of [
    ["usage-control-actions", "refresh-button"],
    ["history-control-actions", "history-refresh"],
  ]) {
    const container = html.match(new RegExp(`<div class="${containerClass}">([\\s\\S]*?)</div>`))?.[1];
    assert.ok(container, containerClass);
    assert.ok(container.includes(`id="${refreshId}"`));
    assert.doesNotMatch(container, /data-node-connection-option|type="checkbox"|VNet/);
  }
  assert.doesNotMatch(html, /data-vnet-connection-toggle|id="node-connection-help"|id="local-connect-button"/);
  assert.match(html, /私有 DevTunnel/);
});
