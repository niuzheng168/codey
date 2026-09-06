import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("compact VNet checkboxes live next to each view's refresh button, not in a page banner", () => {
  assert.doesNotMatch(html, /<section[^>]+id="node-connection-options"/);
  assert.doesNotMatch(html, /id="vnet-local-note"/);
  for (const [containerClass, refreshId, checkboxId] of [
    ["usage-control-actions", "refresh-button", "vnet-connection-toggle"],
    ["history-control-actions", "history-refresh", "history-vnet-connection-toggle"],
  ]) {
    const container = html.match(new RegExp(`<div class="${containerClass}">([\\s\\S]*?)</div>`))?.[1];
    assert.ok(container, containerClass);
    assert.ok(container.includes(`id="${refreshId}"`));
    assert.ok(container.includes(`id="${checkboxId}"`));
    assert.ok(container.indexOf(`id="${refreshId}"`) < container.indexOf(`id="${checkboxId}"`));
    assert.match(container, /data-node-connection-option[^>]+hidden/);
    assert.match(container, /<span>VNet<\/span>/);
    assert.match(container, /type="checkbox" data-vnet-connection-toggle aria-label="[^"]+" aria-describedby="node-connection-help"/);
    assert.doesNotMatch(container, /<input[^>]+\schecked(?:\s|\/?>)/);
  }
  assert.equal((html.match(/data-vnet-connection-toggle/g) ?? []).length, 2);
  assert.equal((html.match(/id="node-connection-help"/g) ?? []).length, 1);
  assert.match(html, /id="node-connection-help" class="sr-only"/);
});
