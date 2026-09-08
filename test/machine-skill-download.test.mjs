import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { settingsDom } from "./helpers/settings-dom.mjs";

const source = await readFile(new URL("../public/settings.js", import.meta.url), "utf8");
const nodeId = `n-${"a".repeat(24)}`;
const filename = `config-new-codey-machine-${nodeId}.zip`;
const endpoint = "/api/settings/machines/skill";

function archiveResponse({ type = "application/zip", body = "PK\u0003\u0004test archive", length } = {}) {
  return new Response(body, {
    headers: {
      "content-type": type,
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(length ?? Buffer.byteLength(body)),
    },
  });
}

async function page({ download = async () => archiveResponse(), pending = [] } = {}) {
  const requests = [];
  const { document, elements, downloads } = settingsDom();
  const objectUrls = [];
  const revoked = [];
  const timers = [];
  const redirects = [];
  const form = document.querySelector("#machine-skill-form");
  form.action = endpoint;
  const button = document.querySelector("#download-machine-skill");
  let settingsRequests = 0;
  runInNewContext(source, {
    document,
    window: {
      location: { hash: "", replace: (url) => redirects.push(url) },
      addEventListener() {},
      setTimeout(fn, delay) { timers.push({ fn, delay }); },
    },
    URL: {
      createObjectURL(blob) { objectUrls.push(blob); return "blob:test-download"; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    fetch: async (url, options) => {
      if (url === "/api/settings") {
        settingsRequests++;
        return { status: 200, ok: true, json: async () => ({
          nodes: [], user: { role: "user" },
          machineSetup: { enabled: true, bytes: 4194304, node: "24.20.0", cloudcli: "1.37.2", copilotApi: "2.5.1" },
          pendingMachines: pending,
        }) };
      }
      requests.push({ url, options });
      return download(url, options);
    },
  });
  await new Promise(setImmediate);
  const submit = (target = form) => {
    const event = { currentTarget: target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    const result = target.listeners.get("submit")?.(event);
    return { event, finished: Promise.resolve(result) };
  };
  return {
    submit, form, button, elements, requests, downloads, objectUrls, revoked, timers, redirects,
    get settingsRequests() { return settingsRequests; },
  };
}

test("machine skill submits an authenticated same-origin POST without navigating away, then saves the ZIP", async () => {
  const p = await page();
  const submission = p.submit();
  assert.equal(submission.event.defaultPrevented, true, "Native POST navigation must be prevented");
  assert.equal(p.button.disabled, true);
  await submission.finished;
  assert.equal(p.requests.length, 1);
  const { url, options } = p.requests[0];
  assert.equal(url, endpoint);
  assert.equal(options.method, "POST");
  assert.equal(options.mode, "same-origin");
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.cache, "no-store");
  assert.equal(options.redirect, "error");
  assert.equal(options.referrerPolicy, "same-origin", "Retain a verifiable Origin under the page's no-referrer policy");
  assert.equal(options.body, undefined, "Never send caller-supplied owner, node ID or credentials");
  assert.deepEqual(p.downloads, [{ href: "blob:test-download", download: filename }]);
  assert.equal(await p.objectUrls[0].text(), "PK\u0003\u0004test archive");
  assert.equal(p.button.disabled, false);
  assert.equal(p.settingsRequests, 2, "Refresh pending identities only after the response");
  assert.match(p.elements.get("#machine-download-message").textContent, /浏览器.*下载/);
  assert.equal(p.revoked.length, 0, "Do not revoke before the browser consumes the download");
  assert.equal(p.timers.length, 1);
  assert.ok(p.timers[0].delay >= 1000);
  p.timers[0].fn();
  assert.deepEqual(p.revoked, ["blob:test-download"]);
});

test("re-downloading a pending identity uses the same handler and disables all download buttons in flight", async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const p = await page({ pending: [{ id: nodeId, expired: false }], download: () => gate });
  const row = p.elements.get("#pending-machines").children[0];
  const retryForm = row.children.find((child) => child.tag === "form");
  const retryButton = retryForm.querySelector("button");
  const retry = p.submit(retryForm);
  assert.equal(retry.event.defaultPrevented, true);
  assert.equal(p.button.disabled, true);
  assert.equal(retryButton.disabled, true);
  const duplicate = p.submit();
  assert.equal(duplicate.event.defaultPrevented, true);
  assert.equal(p.requests.length, 1, "Double-clicking must not reserve another identity");
  assert.equal(p.requests[0].url, `/api/settings/machines/${nodeId}/skill`);
  finish(archiveResponse());
  await Promise.all([retry.finished, duplicate.finished]);
  assert.equal(p.downloads.length, 1);
  assert.equal(p.button.disabled, false);
});

test("expired pending identities stay disabled after a download completes", async () => {
  const p = await page({ pending: [{ id: nodeId, expired: true }] });
  await p.submit().finished;
  const row = p.elements.get("#pending-machines").children.at(-1);
  const retryForm = row.children.find((child) => child.tag === "form");
  assert.equal(retryForm.querySelector("button").disabled, true);
});

test("download failures stay on the settings page, show the error, refresh pending identities and permit retry", async () => {
  for (const [name, download, expected] of [
    ["origin", async () => new Response(JSON.stringify({ error: "Cross-origin operations are not allowed" }), { status: 403 }), /Cross-origin/],
    ["capacity", async () => new Response(JSON.stringify({ error: "待配置身份已达上限" }), { status: 409 }), /待配置身份已达上限/],
    ["unavailable", async () => new Response("<h1>Unavailable</h1>", { status: 503 }), /503/],
    ["network", async () => { throw new Error("Network interrupted"); }, /Network interrupted/],
    ["wrong type", async () => archiveResponse({ type: "text/html", body: "<html>login</html>" }), /ZIP|配置包/],
    ["empty", async () => archiveResponse({ body: "" }), /不完整|空/],
    ["truncated", async () => archiveResponse({ length: 1000 }), /不完整/],
  ]) {
    const p = await page({ download });
    const submission = p.submit();
    assert.equal(submission.event.defaultPrevented, true, name);
    await submission.finished;
    assert.deepEqual(p.downloads, [], name);
    assert.equal(p.button.disabled, false, name);
    assert.equal(p.settingsRequests, 2, name);
    assert.deepEqual(p.redirects, [], name);
    assert.match(p.elements.get("#machine-download-message").textContent, expected, name);
  }
});

test("expired login redirects to login rather than downloading an error as a ZIP", async () => {
  const p = await page({ download: async () => new Response('{"error":"请先登录 Codey"}', { status: 401 }) });
  await p.submit().finished;
  assert.deepEqual(p.redirects, ["/portal-auth/login"]);
  assert.deepEqual(p.downloads, []);
  assert.equal(p.button.disabled, false);
  assert.equal(p.settingsRequests, 1, "Do not make another authenticated request while redirecting");
});

test("the settings page has a visible, accessible download status next to the entry point", async () => {
  const html = await readFile(new URL("../public/settings.html", import.meta.url), "utf8");
  assert.match(html, /id="machine-download-message"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(html.indexOf('id="machine-download-message"') > html.indexOf('id="machine-skill-form"'));
  assert.ok(html.indexOf('id="machine-download-message"') < html.indexOf('id="add-prepared-machine-form"'));
});
