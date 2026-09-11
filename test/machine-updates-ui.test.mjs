import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { settingsDom } from "./helpers/settings-dom.mjs";

const source = await readFile(new URL("../public/machine-updates.js", import.meta.url), "utf8");
const tick = () => new Promise(setImmediate);

function data() {
  const target = { id: "release-one", sequence: 1, platform: "linux-x64", migrations: ["gateway-api-key-v1"],
    notes: "<img src=x onerror=evil()>", components: {
      codey: { version: "0.2.0", commit: "b".repeat(40), entrySha256: "b".repeat(64), nodeMajors: [24] },
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

async function page({ failPlan = false, pendingPlan = null, initialData, planComponents } = {}) {
  const { document, elements } = settingsDom();
  const requests = [];
  const timers = [];
  const redirects = [];
  const status = initialData ?? data();
  runInNewContext(source, {
    document, clearTimeout() {},
    window: { confirm: () => true, location: { replace: (url) => redirects.push(url) },
      setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; } },
    URL: { createObjectURL: () => "blob:fixture", revokeObjectURL() {} },
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      requests.push({ url, options, body });
      if (url === "/api/settings/updates") return { ok: true, status: 200, json: async () => status };
      if (url.endsWith("/plans")) {
        if (pendingPlan) await pendingPlan;
        if (failPlan) return { ok: false, status: 403, json: async () => ({ error: "Owner mismatch" }) };
        const release = status.releases.find(item => item.id === body.releaseId);
        return { ok: true, status: 200, json: async () => ({
          id: "plan-one", releaseId: body.releaseId, notes: release.notes, warning: "Review this plan",
          components: planComponents ?? release.components,
          targets: body.nodeIds.map((id) => ({ nodeId: id, name: id, eligible: true, changed: ["codey"], deferred: id === "beta" })),
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
  return { elements, requests, timers, redirects, status, document,
    get: (suffix) => document.querySelector("#node-update-" + suffix) };
}

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
  status.releases.push({ ...status.releases[0], id: "release-two", sequence: 2 });
  status.nodes[0].report = { ...status.nodes[0].report, highestSequence: 1, currentRelease: "release-one", components: {
    codey: { ...status.releases[0].components.codey, nodeMajor: 24 },
  } };
  const p = await page({ initialData: status });
  assert.match(p.get("list").children[0].textContent, /已是目标版本/);
  assert.equal(p.get("list").children[0].querySelector("input").disabled, true);
  p.get("release").value = "release-two";
  p.get("release").dispatch("change");
  assert.equal(p.get("list").children[0].querySelector("input").disabled, false);
  assert.doesNotMatch(p.get("list").children[0].textContent, /已是目标版本/);
});

test("single-machine action only previews its node; no job is sent until explicit confirmation", async () => {
  const p = await page();
  await p.get("list").children[0].children.at(-1).children.find((button) => button.textContent === "更新此机器").click();
  assert.equal(p.get("confirm").open, true);
  assert.deepEqual(p.requests.filter((row) => row.url.endsWith("/plans"))[0].body.nodeIds, ["alpha"]);
  assert.equal(p.requests.filter((row) => row.url.endsWith("/jobs")).length, 0);
  assert.ok(p.get("plan-note").textContent.includes("<img src=x onerror=evil()>"));
  assert.match(p.get("plan-note").textContent, /Codey 0\.2\.0/);
  assert.match(p.get("plan-targets").textContent, /更新 Codey 整包/);
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
