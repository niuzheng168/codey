import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { settingsDom } from "./helpers/settings-dom.mjs";

const source = await readFile(new URL("../public/machine-updates.js", import.meta.url), "utf8");
const tick = () => new Promise(setImmediate);
const downloadBytes = Buffer.from("verified synthetic Codey package");

function data() {
  const target = { id: "release-one", sequence: 1, platform: "linux-x64", migrations: ["gateway-api-key-v1"],
    notes: "<img src=x onerror=evil()>", components: {
      codey: { version: "0.2.0", commit: "b".repeat(40), entrySha256: "b".repeat(64), nodeMajors: [24],
        file: "codey-0.2.0.tgz", size: downloadBytes.length,
        sha256: createHash("sha256").update(downloadBytes).digest("hex") },
    } };
  const report = { platform: "linux-x64", layout: "npm", highestSequence: 0, readyMigrations: ["gateway-api-key-v1"],
    components: { codey: {
      version: "0.1.0", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24,
    } } };
  return { enabled: true, reason: null, releases: [target], jobs: [], nodes: [
    { id: "alpha", name: "Alpha", enrolled: true, connected: true, report, eligible: true },
    { id: "beta", name: "Beta", enrolled: true, connected: false, report, eligible: true },
    { id: "new-node", name: "Unpaired", enrolled: false, connected: false, report: null, reason: "needs_setup" },
    { id: "local", name: "Protected local", protected: true, enrolled: false, report: null, reason: "protected_local" },
  ] };
}

async function page({ failPlan = false, pendingPlan = null, initialData, planComponents, downloadStatus = 200, tamperDownload = false,
  readStatus } = {}) {
  const { document, elements, downloads } = settingsDom();
  const requests = [];
  const timers = [];
  const redirects = [];
  const status = initialData ?? data();
  runInNewContext(source, {
    document, clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cancelled = true; }, crypto: webcrypto, Blob,
    window: { confirm: () => true, location: { replace: (url) => redirects.push(url) },
      setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; } },
    URL: { createObjectURL: () => "blob:fixture", revokeObjectURL() {} },
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      requests.push({ url, options, body });
      if (url === "/api/settings/updates") return readStatus ? readStatus(status)
        : { ok: true, status: 200, json: async () => structuredClone(status) };
      if (url.endsWith("/codey.tgz")) return {
        ok: downloadStatus === 200, status: downloadStatus,
        json: async () => ({ error: "download unavailable" }),
        headers: { get: name => ({
          "content-type": "application/gzip", "content-disposition": 'attachment; filename="codey-0.2.0.tgz"',
        })[name] },
        arrayBuffer: async () => new Uint8Array(tamperDownload ? Buffer.from("tampered") : downloadBytes).buffer,
      };
      if (url.endsWith("/plans")) {
        if (pendingPlan) await pendingPlan;
        if (failPlan) return { ok: false, status: 403, json: async () => ({ error: "Owner mismatch" }) };
        const release = status.releases.find(item => item.id === body.releaseId);
        return { ok: true, status: 200, json: async () => ({
          id: "plan-one", releaseId: body.releaseId, notes: release.notes, warning: "Review this plan",
          components: planComponents ?? release.components,
          targets: body.nodeIds.map((id) => ({ nodeId: id, name: id, eligible: true, changed: ["codey"],
            notes: release.notes, deferred: id === "beta" })),
        }) };
      }
      if (url.endsWith("/jobs")) {
        status.jobs = [{ id: "job-one", nodeId: "alpha", releaseId: "release-one", state: "queued" }];
        return { ok: true, status: 202, json: async () => ({ jobs: status.jobs }) };
      }
      throw new Error("Unexpected request " + url);
    },
  });
  await tick(); await tick();
  return { elements, requests, timers, redirects, status, document, downloads,
    async poll() {
      const timer = timers.findLast(item => !item.cancelled);
      assert.ok(timer, "A read-only refresh must remain scheduled");
      timer.cancelled = true;
      await timer.callback(); await tick();
    },
    get: (suffix) => document.querySelector("#node-update-" + suffix) };
}

test("package download verifies the selected artifact and never previews or submits a node update", async () => {
  const p = await page();
  assert.equal(p.get("download").disabled, false);
  assert.match(p.get("download-info").textContent, /codey-0.2.0.tgz.*SHA-256/);
  await p.get("download").click();
  assert.equal(p.downloads.length, 1);
  assert.equal(p.downloads[0].download, "codey-0.2.0.tgz");
  const request = p.requests.at(-1);
  assert.equal(request.url, "/api/settings/updates/releases/release-one/codey.tgz");
  assert.equal(request.options.credentials, "same-origin");
  assert.ok(!p.requests.some(row => /\/(plans|jobs)$/.test(row.url)));
  assert.match(p.get("message").textContent, /未提交任何节点升级任务/);
});

test("tampered downloads and expired login never save a package; an empty catalog disables download", async () => {
  const bad = await page({ tamperDownload: true });
  await bad.get("download").click();
  assert.equal(bad.downloads.length, 0);
  assert.match(bad.get("message").textContent, /不匹配/);
  const loggedOut = await page({ downloadStatus: 401 });
  await loggedOut.get("download").click();
  assert.deepEqual(loggedOut.redirects, ["/portal-auth/login"]);
  assert.equal(loggedOut.downloads.length, 0);
  const status = data();
  status.releases = [];
  assert.equal((await page({ initialData: status })).get("download").disabled, true);
});

test("machine update controls include single-node, selected/all batch, setup and protected-local states", async () => {
  const p = await page();
  const rows = p.get("list").children;
  assert.equal(rows.length, 4);
  assert.equal(rows[0].children[0].children[0].disabled, false);
  assert.equal(rows[2].children[0].children[0].disabled, true);
  assert.equal(rows[3].children[0].children[0].disabled, true);
  assert.ok(rows[0].children.at(-1).children.some((button) => button.textContent === "更新此机器"));
  assert.ok(rows[2].querySelectorAll("button").some((button) => button.textContent === "接入升级器"));
  assert.ok(!rows[3].querySelectorAll("button").some((button) => button.textContent === "接入升级器"));
  assert.equal(p.get("all").disabled, false);
  assert.equal(p.get("selected").disabled, true);
});

test("npm node controls never offer split component updates and show the Codey package version", async () => {
  const status = data();
  const unifiedRelease = structuredClone(status.releases[0]);
  status.releases[0].components = { cloudcli: {
    version: "1.37.2", commit: "b".repeat(40), entrySha256: "b".repeat(64), nodeMajors: [24],
  } };
  const split = await page({ initialData: status });
  assert.equal(split.get("list").children[0].children[0].children[0].disabled, true);
  assert.equal(split.get("release").disabled, true);
  assert.doesNotMatch(split.get("release").textContent, /cloudcli|1\.37\.2/i);
  assert.match(split.get("message").textContent, /尚未发布 Codey npm 整包/);
  status.releases = [{ ...status.releases[0], id: "legacy-release" }, unifiedRelease];
  status.nodes[1].report = { ...status.nodes[1].report, layout: "legacy", components: { cloudcli: {
    version: "1.37.2", commit: "a".repeat(40), entrySha256: "a".repeat(64), nodeMajor: 24,
  } } };
  // The server's generic latest-release reason may refer to a legacy release.
  status.nodes[0].reason = "runtime_incompatible";
  const unified = await page({ initialData: status });
  assert.equal(unified.get("list").children[0].children[0].children[0].disabled, false);
  assert.equal(unified.get("list").children[1].children[0].children[0].disabled, true);
  assert.equal(unified.get("release").children.length, 1);
  assert.equal(unified.get("release").value, unifiedRelease.id);
  assert.match(unified.get("release").textContent, /Codey 0\.2\.0/);
  assert.match(unified.get("list").children[0].textContent, /Codey 0\.1\.0/);
  assert.doesNotMatch(unified.get("list").children[0].textContent, /运行时不兼容/);
  assert.match(unified.get("list").children[1].textContent, /Codey 版本未上报.*需先迁移到 Codey npm 包/);
  assert.doesNotMatch(unified.get("list").textContent, /cloudcli|copilot-api|1\.37\.2/i);
});

test("a split-component preview response cannot be confirmed as a Codey update", async () => {
  const p = await page({ planComponents: { cloudcli: {
    version: "1.37.2", commit: "b".repeat(40), entrySha256: "b".repeat(64), nodeMajors: [24],
  } } });
  await p.get("all").click();
  assert.equal(p.get("confirm").open, false);
  assert.equal(p.get("apply").disabled, true);
  assert.match(p.get("message").textContent, /Codey 整包发行版不一致/);
  assert.ok(!p.requests.some(request => request.url.endsWith("/jobs")));
});

test("changing the selected Codey release recomputes eligibility and status from the installed package", async () => {
  const status = data();
  status.releases.push({ ...status.releases[0], id: "release-two", sequence: 2, components: {
    codey: { ...status.releases[0].components.codey, version: "0.3.0", sha256: "c".repeat(64) },
  } });
  status.nodes[0].report = { ...status.nodes[0].report, highestSequence: 1, currentRelease: "release-one", components: {
    codey: { ...status.releases[0].components.codey, nodeMajor: 24 },
  } };
  const p = await page({ initialData: status });
  p.get("release").value = "release-one";
  p.get("release").dispatch("change");
  assert.match(p.get("list").children[0].textContent, /已是目标版本/);
  assert.equal(p.get("list").children[0].querySelector("input").disabled, true);
  p.get("release").value = "release-two";
  p.get("release").dispatch("change");
  assert.equal(p.get("list").children[0].querySelector("input").disabled, false);
  assert.doesNotMatch(p.get("list").children[0].textContent, /已是目标版本/);
});

test("one shared version automatically matches Windows and Linux without a platform selector", async () => {
  const status = data();
  status.releases.push({ ...status.releases[0], id: "windows-release", platform: "windows-x64", sequence: 2 });
  status.nodes[1] = { ...status.nodes[1], platform: "windows-x64", updaterSupported: true,
    report: { ...status.nodes[1].report, platform: "windows-x64" } };
  status.nodes[2] = { ...status.nodes[2], platform: "windows-x64", updaterSupported: true };
  const p = await page({ initialData: status });
  assert.equal(p.get("release").children.length, 1);
  assert.equal(p.get("release").textContent, "Codey 0.2.0");
  assert.match(p.get("download-info").textContent, /Linux x64/);
  assert.match(p.get("download-info").textContent, /Windows x64/);
  assert.doesNotMatch(p.get("list").textContent, /对应平台/);
  assert.ok(p.get("list").children[2].querySelectorAll("button").some(button => button.textContent === "接入升级器"));
  assert.equal(p.get("list").children[0].querySelector("input").disabled, false);
  assert.equal(p.get("list").children[1].querySelector("input").disabled, false);
  await p.get("all").click();
  assert.deepEqual(p.requests.at(-1).body.nodeIds, ["alpha", "beta"]);
});

test("Mac ARM/Intel releases and unreported enrollment stay explicit instead of silently choosing Linux", async () => {
  const status = data();
  status.releases.push(...["macos-arm64", "macos-x64"].map((platform, index) => ({
    ...status.releases[0], id: platform + "-release", platform, sequence: index + 2,
  })));
  status.nodes[1] = { ...status.nodes[1], platform: "macos-arm64", updaterSupported: true,
    report: { ...status.nodes[1].report, platform: "macos-arm64" } };
  status.nodes[2] = { ...status.nodes[2], platform: "macos-x64", updaterSupported: true };
  const p = await page({ initialData: status });
  assert.equal(p.get("release").children.length, 1);
  assert.match(p.get("download-info").textContent, /macOS Apple Silicon/);
  assert.match(p.get("download-info").textContent, /macOS Intel/);
  const unpaired = p.get("list").children[2];
  assert.match(unpaired.textContent, /Codey 版本未上报/);
  assert.ok(unpaired.querySelectorAll("button").some(button => button.textContent === "接入升级器"));
  assert.equal(p.get("list").children[0].querySelector("input").disabled, false);
  assert.equal(p.get("list").children[1].querySelector("input").disabled, false);
  await p.get("all").click();
  assert.deepEqual(p.requests.at(-1).body.nodeIds, ["alpha", "beta"]);
});

test("single-machine action only previews its node; no job is sent until explicit confirmation", async () => {
  const p = await page();
  await p.get("list").children[0].children.at(-1).children.find((button) => button.textContent === "更新此机器").click();
  assert.equal(p.get("confirm").open, true);
  assert.deepEqual(p.requests.filter((row) => row.url.endsWith("/plans"))[0].body.nodeIds, ["alpha"]);
  assert.equal(p.requests.filter((row) => row.url.endsWith("/jobs")).length, 0);
  assert.ok(p.get("plan-targets").textContent.includes("<img src=x onerror=evil()>"));
  assert.match(p.get("plan-note").textContent, /Codey 0\.2\.0/);
  assert.match(p.get("plan-targets").textContent, /更新 Codey 应用包，复用未变化的依赖/);
  assert.doesNotMatch(p.get("plan-targets").textContent, /cloudcli|copilotApi/);
  await p.get("apply").click();
  const jobs = p.requests.filter((row) => row.url.endsWith("/jobs"));
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].body, { planId: "plan-one", confirmation: "update-reviewed-machines" });
  assert.equal(p.get("confirm").open, false);
  assert.ok(p.get("message").textContent.includes("不代表升级已完成"));
  assert.ok(p.timers.some((timer) => timer.delay === 5000));
});

test("batch all excludes unpaired/protected nodes, selected batch contains only checked nodes, cancel is non-mutating", async () => {
  const p = await page();
  await p.get("all").click();
  assert.deepEqual(p.requests.at(-1).body.nodeIds, ["alpha", "beta"]);
  await p.get("cancel").click();
  assert.equal(p.requests.filter((row) => row.url.endsWith("/jobs")).length, 0);
  const beta = p.get("list").children[1].children[0].children[0];
  beta.checked = true; beta.listeners.get("change")();
  assert.equal(p.get("selected").disabled, false);
  await p.get("selected").click();
  assert.deepEqual(p.requests.at(-1).body.nodeIds, ["beta"]);
});

test("in-flight previews are deduplicated and authorization failures never become successful jobs", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const p = await page({ pendingPlan: pending, failPlan: true });
  const first = p.get("all").click();
  const second = p.get("all").click();
  assert.equal(p.requests.filter((row) => row.url.endsWith("/plans")).length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(p.get("confirm").open, false);
  assert.equal(p.requests.filter((row) => row.url.endsWith("/jobs")).length, 0);
  assert.equal(p.get("message").textContent, "Owner mismatch");
});

test("the settings HTML loads the updater module and provides accessible confirmation/status controls", async () => {
  const html = await readFile(new URL("../public/settings.html", import.meta.url), "utf8");
  assert.match(html, /<script type="module" src="\/machine-updates\.js"><\/script>/);
  assert.match(html, /id="node-update-message"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /<dialog id="node-update-confirm"[^>]*aria-labelledby="node-update-confirm-title"/);
  for (const id of ["selected", "all", "release", "cancel", "apply"]) assert.ok(html.includes(`id="node-update-${id}"`));
});

test("compact update rows keep maintenance actions in a collapsed, named disclosure", async () => {
  const p = await page();
  const rows = p.get("list").children;
  const menu = rows[0].querySelector(".updater-menu");
  assert.equal(menu.open, false);
  assert.match(menu.querySelector("summary").getAttribute("aria-label"), /Alpha.*升级器管理/);
  assert.deepEqual(menu.querySelectorAll("button").map((button) => button.textContent), ["重新接入升级器", "停用升级器"]);
  assert.equal(rows[3].querySelector(".updater-menu"), null, "Protected local has no maintenance menu");
  assert.equal(p.get("history").hidden, true);
  assert.equal(p.get("count-label").textContent, "2");
  assert.equal(p.get("count").hidden, false);
  menu.open = true;
  await p.get("refresh").click();
  assert.equal(p.get("list").children[0].querySelector(".updater-menu").open, true);
});

test("active and failed jobs remain discoverable from the tab even while update history is collapsed", async () => {
  const p = await page();
  p.status.jobs = [{ nodeId: "alpha", releaseId: "release-one", state: "verifying" }];
  await p.get("refresh").click();
  assert.equal(p.get("history").hidden, false);
  assert.equal(p.get("history").open, false);
  assert.equal(p.get("count-label").textContent, "1 进行中");
  assert.equal(p.get("count-compact").textContent, "1");
  assert.match(p.get("job-count").textContent, /1 条.*1 进行中/);
  p.status.jobs[0].state = "failed";
  await p.get("refresh").click();
  assert.equal(p.get("count-label").textContent, "1 待处理");
  assert.equal(p.get("count").classList.contains("update-warning"), true);
  p.status.jobs.push({ nodeId: "alpha", releaseId: "release-one", state: "succeeded" });
  await p.get("refresh").click();
  assert.equal(p.get("count-label").textContent, "2", "A later successful job resolves the historical failure badge");
});

test("disabled updating and an empty release catalog cannot leave actionable selections", async () => {
  const p = await page();
  const checkbox = p.get("list").children[0].querySelector("input");
  checkbox.checked = true; checkbox.dispatch("change");
  assert.equal(p.get("selected").disabled, false);
  p.status.enabled = false;
  await p.get("refresh").click();
  assert.equal(p.get("selected").disabled, true);
  assert.equal(p.get("all").disabled, true);
  assert.equal(p.get("list").children[0].querySelector("input").checked, false);
  p.status.releases = [];
  await p.get("refresh").click();
  assert.equal(p.get("release").disabled, true);
  assert.equal(p.get("release").children[0].textContent, "暂无 Codey 发行版");
});

test("switching into the update panel refreshes node membership without submitting an operation", async () => {
  const p = await page();
  p.status.nodes = p.status.nodes.slice(0, 2);
  p.document.dispatchEvent(new CustomEvent("settings-panel-change", { detail: "machine-updates" }));
  await tick();
  assert.equal(p.get("list").children.length, 2);
  assert.equal(p.requests.length, 2);
  assert.ok(p.requests.every((request) => request.options.method === "GET"));
});

test("polling retains a maintenance menu's keyboard focus, while Escape closes it without mutating a machine", async () => {
  const p = await page();
  const menu = p.get("list").children[0].querySelector(".updater-menu");
  menu.open = true;
  menu.querySelector("summary").focus();
  await p.get("refresh").click();
  const refreshed = p.get("list").children[0].querySelector(".updater-menu");
  assert.equal(refreshed.open, true);
  assert.equal(p.document.activeElement, refreshed.querySelector("summary"));
  p.document.getElementById("machine-updates").dispatch("keydown", { key: "Escape" });
  assert.equal(refreshed.open, false);
  assert.equal(p.document.activeElement, refreshed.querySelector("summary"));
  assert.ok(p.requests.every((request) => request.options.method === "GET"));
});

test("idle pages keep polling and terminal jobs never invent the installed version before the next heartbeat", async () => {
  const p = await page();
  assert.equal(p.timers.at(-1).delay, 10000);
  p.status.jobs = [{ id: "job", nodeId: "alpha", releaseId: "release-one", state: "verifying", updatedAt: 1000 }];
  await p.poll();
  assert.equal(p.timers.at(-1).delay, 5000);
  p.status.jobs[0] = { ...p.status.jobs[0], state: "succeeded", updatedAt: 2000 };
  p.status.nodes[0].lastSeen = 2000;
  await p.poll();
  assert.match(p.get("list").children[0].textContent, /Codey 0\.1\.0/);
  assert.match(p.get("list").children[0].textContent, /等待版本心跳刷新/);
  assert.equal(p.timers.at(-1).delay, 10000);
  p.status.nodes[0].report = { ...p.status.nodes[0].report, currentRelease: "release-one", highestSequence: 1,
    components: { codey: { ...p.status.releases[0].components.codey, nodeMajor: 24 } } };
  p.status.nodes[0].lastSeen = 3000;
  await p.poll();
  assert.match(p.get("list").children[0].textContent, /Codey 0\.2\.0.*已是目标版本/);
  assert.doesNotMatch(p.get("list").children[0].textContent, /等待版本心跳刷新/);
  assert.ok(p.requests.every(row => row.options.method === "GET"));
});

test("local updates without Portal jobs also refresh; failed jobs keep their actual version and visible error", async () => {
  const p = await page();
  p.status.nodes[0].report = { ...p.status.nodes[0].report, components: {
    codey: { ...p.status.nodes[0].report.components.codey, version: "0.1.7" },
  } };
  p.status.jobs = [{ nodeId: "alpha", state: "needs_action", code: "configuration_changed", updatedAt: 1000 }];
  await p.poll();
  assert.match(p.get("list").children[0].textContent, /Codey 0\.1\.7.*需要人工处理.*节点配置已改变/);
  assert.doesNotMatch(p.get("list").children[0].textContent, /升级成功/);
});

test("unsupported version platforms stay explicit; different tarballs with the same version never collapse", async () => {
  const status = data();
  status.nodes[1] = { ...status.nodes[1], platform: "windows-x64",
    report: { ...status.nodes[1].report, platform: "windows-x64" } };
  const p = await page({ initialData: status });
  assert.match(p.get("list").children[1].textContent, /此版本尚未向该平台开放/);
  assert.equal(p.get("list").children[1].querySelector("input").disabled, true);
  status.releases.push({ ...status.releases[0], id: "different-bytes", platform: "windows-x64", sequence: 2,
    components: { codey: { ...status.releases[0].components.codey, sha256: "c".repeat(64) } } });
  await p.poll();
  assert.equal(p.get("release").children.length, 2);
  assert.match(p.get("release").textContent, /cccccccccccc/);
  assert.equal(p.get("list").children[1].querySelector("input").disabled, true,
    "The original selected artifact was retained, not replaced with a same-version different package");
});

test("refresh requests are deduplicated, pause in hidden tabs and do not change a confirmation in progress", async () => {
  let releaseRead, reads = 0;
  const p = await page({ readStatus: async status => {
    reads++;
    if (reads === 2) await new Promise(resolve => { releaseRead = resolve; });
    return { status: 200, ok: true, json: async () => structuredClone(status) };
  } });
  const first = p.get("refresh").click();
  const second = p.get("refresh").click();
  assert.equal(reads, 2);
  releaseRead();
  await Promise.all([first, second]);
  await p.get("all").click();
  const before = reads, note = p.get("plan-note").textContent;
  await p.poll();
  assert.equal(reads, before);
  assert.equal(p.get("plan-note").textContent, note);
  await p.get("cancel").click();
  p.document.hidden = true;
  p.document.dispatchEvent(new Event("visibilitychange"));
  assert.ok(p.timers.every(timer => timer.cancelled));
  p.document.hidden = false;
  p.document.dispatchEvent(new Event("visibilitychange"));
  await tick(); await tick();
  assert.equal(reads, before + 1);
  assert.ok(!p.requests.some(row => row.url.endsWith("/jobs")));
});
