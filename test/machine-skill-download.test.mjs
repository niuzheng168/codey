import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { settingsDom } from "./helpers/settings-dom.mjs";

const source = await readFile(new URL("../public/settings.js", import.meta.url), "utf8");
const nodeId = `n-${"a".repeat(24)}`;
const filename = "config-new-codey-machine.zip";
const endpoint = "/api/settings/machines/skill";
const privateToken = "private-connect-token-must-not-appear-in-notices";

function registration(platform = "linux-x64") {
  return {
    schema: 2,
    package: { platform, releaseId: "release-fixture" },
    machine: { nodeId, tlsCertificate: "public certificate fixture" },
    credentials: { clientSigningKey: "private-signing-key", workspaceSsoKey: "private-sso-key" },
    devTunnelConnectToken: privateToken,
  };
}

function archiveResponse({ type = "application/zip", body = "PK\u0003\u0004test archive", length, name = filename } = {}) {
  return new Response(body, {
    headers: {
      "content-type": type,
      "content-disposition": `attachment; filename="${name}"`,
      "content-length": String(length ?? Buffer.byteLength(body)),
    },
  });
}

async function page({ download = async () => archiveResponse(), pending = [], machineSetup } = {}) {
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
    CustomEvent: class {
      constructor(type, options) { this.type = type; this.detail = options?.detail; }
    },
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
          machineSetup: machineSetup ?? { enabled: true, bytes: 4194304, node: "24.20.0", cloudcli: "1.37.2", copilotApi: "2.5.1" },
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
  assert.equal(p.settingsRequests, 1, "A static download must not create or refresh pending identities");
  assert.match(p.elements.get("#machine-download-message").textContent, /不含 token.*复用/);
  assert.equal(p.revoked.length, 0, "Do not revoke before the browser consumes the download");
  assert.equal(p.timers.length, 1);
  assert.ok(p.timers[0].delay >= 1000);
  p.timers[0].fn();
  assert.deepEqual(p.revoked, ["blob:test-download"]);
});

test("only Linux download is enabled while Windows and macOS native launchers are pending", async () => {
  const entry = { enabled: true, bytes: 4194304, node: "24.20.0", cloudcli: "1.37.2", copilotApi: "2.5.1" };
  const machineSetup = { ...entry, platforms: [
    { platform: "windows-x64", enabled: false, planned: true }, { ...entry, platform: "linux-x64" },
    { platform: "macos-arm64", enabled: false, planned: true },
    { platform: "macos-x64", enabled: false, planned: true },
  ] };
  const p = await page({ machineSetup });
  assert.equal(p.elements.get("#download-machine-skill").disabled, false);
  assert.equal(p.elements.get("#download-machine-windows-skill").disabled, true);
  assert.equal(p.elements.get("#download-machine-macos-skill").disabled, true);
  assert.equal(p.elements.get("#download-machine-macos-intel-skill").disabled, true);
});

test("the package status presents one Codey npm version rather than two installable apps", async () => {
  const p = await page({ machineSetup: {
    enabled: true, bytes: 7 * 1024 * 1024, node: "24.20.0",
    codey: "0.1.0", cloudcli: "1.37.2", copilotApi: "2.5.3",
  } });
  const status = p.elements.get("#machine-package-status").textContent;
  assert.match(status, /Codey 0\.1\.0（统一 npm 包）/);
  assert.doesNotMatch(status, /CloudCLI|copilot-api/);
});

test("static downloads ignore legacy pending identities and disable all download buttons in flight", async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const p = await page({ pending: [{ id: nodeId, expired: false }], download: () => gate });
  assert.equal(p.elements.has("#pending-machines"), false);
  const retry = p.submit();
  assert.equal(retry.event.defaultPrevented, true);
  assert.equal(p.button.disabled, true);
  assert.equal(p.elements.get("#download-machine-windows-skill").disabled, true);
  assert.equal(p.elements.get("#download-machine-macos-skill").disabled, true);
  assert.equal(p.elements.get("#download-machine-macos-intel-skill").disabled, true);
  const duplicate = p.submit();
  assert.equal(duplicate.event.defaultPrevented, true);
  assert.equal(p.requests.length, 1, "Double-clicking must not start another transfer");
  assert.equal(p.requests[0].url, endpoint);
  finish(archiveResponse());
  await Promise.all([retry.finished, duplicate.finished]);
  assert.equal(p.downloads.length, 1);
  assert.equal(p.button.disabled, false);
  assert.equal(p.settingsRequests, 1);
});

test("the same static package can be downloaded repeatedly without refreshing machine identity state", async () => {
  const p = await page();
  await p.submit().finished;
  await p.submit().finished;
  assert.deepEqual(p.downloads.map((item) => item.download), [filename, filename]);
  assert.equal(p.requests.length, 2);
  assert.equal(p.settingsRequests, 1);
});

test("download failures stay on the settings page, show the error and permit retry without identity refresh", async () => {
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
    assert.equal(p.settingsRequests, 1, name);
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
  assert.match(html, /Linux 固定包不含 token[^<]*并行分发/);
  assert.match(html, /机器注册 JSON（最多 32 KB；传输后文件名允许改变）/);
  assert.match(html, /含私密凭据[^<]*HTTPS Portal[^<]*立即删除/);
});

test("adding a node with unavailable quota shows the warning and never claims model inference was verified", async () => {
  for (const usage of [true, false]) {
    const p = await page({ download: async () => new Response(JSON.stringify({
      node: { name: "Windows Dev Box" }, verification: { usage, tokenUsage: true },
    }), { status: 201, headers: { "content-type": "application/json" } }) });
    const payload = registration();
    p.elements.get("#prepared-machine-file").files = [{
      name: "codey-machine-registration.json", size: 500, text: async () => JSON.stringify(payload),
    }];
    const form = p.elements.get("#add-prepared-machine-form");
    p.submit(form);
    for (let attempt = 0; attempt < 20 && form.querySelector("button").disabled; attempt++) {
      await new Promise(setImmediate);
    }
    assert.equal(form.querySelector("button").disabled, false);
    assert.equal(p.requests[0].url, "/api/settings/machines/activate");
    assert.deepEqual(p.requests[0].options.body, JSON.stringify(payload));
    const notice = p.elements.get("#settings-message").textContent;
    assert.match(notice, /机器已验通并添加/);
    assert.match(notice, /模型推理仍需单独验收/);
    assert.match(notice, /立即删除 codey-machine-registration\.json/);
    assert.doesNotMatch(notice, new RegExp(privateToken));
    assert.doesNotMatch(p.elements.get("#machine-activation-message").textContent, new RegExp(privateToken));
    if (usage) assert.doesNotMatch(notice, /配额暂不可用/);
    else {
      assert.match(notice, /Copilot 配额暂不可用/);
      assert.match(notice, /本地 Token 统计/);
    }
  }
});
