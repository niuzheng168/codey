import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { settingsDom } from "./helpers/settings-dom.mjs";

const source = await readFile(new URL("../public/admin-nodes.js", import.meta.url), "utf8");
const tick = () => new Promise(setImmediate);
const now = Date.UTC(2026, 8, 8, 9, 0, 0);
const owner = { id: "owner-zhn", username: "zhn", enabled: true };
const bob = { id: "owner-bob", username: "bob", enabled: true };
const version = { version: "0.1.0", commit: "a".repeat(40), nodeMajor: 24 };
const node = (id, values = {}) => ({
  id, name: id, region: "Japan East", owner, status: "online", lastSeen: now,
  releaseId: "installed-release",
  components: { codey: version, cloudcli: { ...version, version: "1.37.2" },
    copilotApi: { ...version, version: "2.5.1", commit: "c".repeat(40) } },
  ...values,
});
const defaults = [
  node("zhn-a100"),
  node("bob-machine", { owner: bob, status: "stale", lastSeen: now - 120000,
    components: { codey: { ...version, commit: "b".repeat(40) } } }),
  node("first-start", { owner: bob, status: "unreported", lastSeen: null, components: { codey: null } }),
  node("local", { status: "not_enrolled", lastSeen: null, components: { codey: null } }),
];

function inventory(nodes, generatedAt = now) {
  const online = nodes.filter((item) => ["online", "workspace_online"].includes(item.status)).length;
  const stale = nodes.filter((item) => item.status === "stale").length;
  return {
    generatedAt, heartbeatTimeoutMs: 90000, telemetryAvailable: true,
    workspaceHealthAvailable: nodes.some((item) => item.workspaceHealth),
    summary: { total: nodes.length, owners: new Set(nodes.map((item) => item.owner.id)).size,
      online, stale, unknown: nodes.length - online - stale },
    nodes,
  };
}

async function page({ role = "admin", active = true, nodes = defaults, respond } = {}) {
  const dom = settingsDom();
  const get = (id) => dom.document.getElementById(id);
  get("admin-tab").hidden = role !== "admin";
  get("admin-section").hidden = !active;
  get("admin-nodes-panel").hidden = !active;
  const requests = [];
  const timers = [];
  const redirects = [];
  const state = { nodes: structuredClone(nodes), generatedAt: now };
  const dispatch = (type) => dom.document.dispatchEvent({ type });
  runInNewContext(source, {
    document: dom.document,
    window: {
      setInterval: (callback, ms) => { timers.push({ callback, ms }); },
      location: { replace: (url) => redirects.push(url) },
    },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const override = await respond?.({ url, options, call: requests.length });
      return {
        status: override?.status ?? 200, ok: (override?.status ?? 200) < 400,
        json: async () => structuredClone(override?.value ?? inventory(state.nodes, state.generatedAt)),
      };
    },
  });
  await tick();
  return {
    ...dom, get, requests, timers, redirects, state, dispatch,
    rows: () => get("admin-node-list").querySelectorAll("tr").filter((item) => item.dataset.nodeId),
    async refresh() { get("admin-node-refresh").click(); await tick(); },
    show() {
      get("admin-section").hidden = get("admin-nodes-panel").hidden = false;
      dispatch("settings-panel-change");
    },
    hide() { get("admin-nodes-panel").hidden = true; dispatch("admin-panel-change"); },
    setRole(nextRole) { get("admin-tab").hidden = nextRole !== "admin"; dispatch("settings-role-change"); },
    filter(id, value, event = "change") { get(id).value = value; get(id).dispatch(event); },
  };
}

test("inventory loads only for an admin viewing its panel and uses read-only, uncached requests", async () => {
  const member = await page({ role: "user" });
  member.get("admin-node-refresh").click();
  member.timers[0].callback();
  member.show();
  await tick();
  assert.equal(member.requests.length, 0);
  const admin = await page({ active: false });
  assert.equal(admin.requests.length, 0);
  admin.show(); await tick();
  assert.equal(admin.requests.length, 1);
  assert.deepEqual(admin.requests[0], { url: "/api/admin/nodes", method: "GET", credentials: "same-origin", cache: "no-store" });
  const beforeRole = await page({ role: "user" });
  beforeRole.setRole("admin"); await tick();
  assert.equal(beforeRole.requests.length, 1, "A role response arriving after module initialization triggers loading");
});

test("inventory renders all-owner counts, node versions and explicit unknown states with no connection controls", async () => {
  const p = await page();
  assert.equal(p.get("admin-node-owner").value, "");
  assert.equal(p.get("admin-node-status").value, "");
  for (const [key, value] of Object.entries({ total: "4", owners: "2", online: "1", stale: "1", unknown: "2" })) {
    assert.equal(p.get(`admin-node-${key}`).textContent, value);
  }
  assert.equal(p.rows().length, 4);
  const known = p.rows().find((row) => row.dataset.nodeId === "zhn-a100");
  assert.match(known.textContent, /zhn.*心跳在线.*0\.1\.0.*aaaaaaaa · Node 24/s);
  assert.match(known.children[2].querySelector("span").title, /仅表示升级器.*不代表数据接口/);
  assert.equal(known.children.length, 4);
  assert.doesNotMatch(known.textContent, /1\.37\.2|2\.5\.1/);
  assert.match(known.children[3].title, new RegExp("Commit: " + "a".repeat(40)));
  assert.match(known.children[3].title, /installed-release/);
  const local = p.rows().find((row) => row.dataset.nodeId === "local");
  assert.match(local.textContent, /未接入升级器.*尚无心跳记录.*未上报 Codey 版本/);
  assert.ok(!local.textContent.includes("1.37.2"), "Never fill unknown installed versions from a target release");
  assert.match(p.get("admin-node-message").textContent, /90 秒.*30 秒/);
  assert.match(p.get("admin-node-help").textContent, /不代表模型或服务健康/);
  assert.equal(p.get("admin-node-list").querySelectorAll("a").length, 0);
  assert.equal(p.get("admin-node-list").querySelectorAll("button").length, 0);
  assert.equal(p.get("admin-node-list").querySelectorAll("input").length, 0);
  assert.equal(p.get("admin-node-search").disabled, false);
  assert.equal(p.get("admin-nodes-panel").getAttribute("aria-busy"), "false");
});

test("node names, owner labels and version metadata are inserted as text, not executable markup", async () => {
  const attack = '<img src=x onerror="window.compromised=true">';
  const p = await page({ nodes: [node("unsafe-label", { name: attack, owner: { ...owner, username: attack } })] });
  assert.ok(p.rows()[0].textContent.includes(attack));
  assert.ok(p.get("admin-node-owner").textContent.includes(attack));
  assert.equal(p.get("admin-node-list").querySelectorAll("img").length, 0);
});

test("Windows Workspace health counts as online without claiming an updater heartbeat or unknown component version", async () => {
  const p = await page({ nodes: [node("local", {
    name: "windows-devbox", status: "workspace_online", updaterStatus: "not_enrolled", lastSeen: null, releaseId: null,
    workspaceHealth: { reachable: true, checkedAt: now, version: "1.37.2" },
    components: { cloudcli: { version: "1.37.2", commit: null, nodeMajor: null, source: "workspace_health" }, copilotApi: null },
  })] });
  assert.equal(p.get("admin-node-online").textContent, "1");
  assert.equal(p.get("admin-node-unknown").textContent, "0");
  const row = p.rows()[0];
  assert.match(row.textContent, /windows-devbox.*兼容 ID: local.*Workspace 在线.*健康检查.*未接入升级器/s);
  assert.ok(!row.textContent.includes("心跳在线"));
  assert.match(row.children[3].textContent, /未上报 Codey 版本/);
  assert.doesNotMatch(row.textContent, /1\.37\.2/);
  assert.equal(row.children.length, 4);
  p.filter("admin-node-status", "online");
  assert.equal(p.rows().length, 1);
  p.filter("admin-node-status", "unknown");
  assert.equal(p.rows().length, 0);
});

test("the overview displays and searches only the actual Codey package, not retained legacy component metadata", async () => {
  const p = await page({ nodes: [
    node("codey-only", { components: { codey: version } }),
    node("old-node", { components: { cloudcli: { ...version, version: "8.8.8" }, copilotApi: { ...version, version: "9.9.9" } } }),
  ] });
  assert.match(p.rows()[0].textContent, /0\.1\.0/);
  assert.match(p.rows()[1].textContent, /未上报 Codey 版本/);
  assert.doesNotMatch(p.get("admin-node-list").textContent, /8\.8\.8|9\.9\.9/);
  p.filter("admin-node-search", "8.8.8", "input");
  assert.equal(p.rows().length, 0);
  assert.equal(p.get("admin-node-list").querySelector("td").getAttribute("colspan"), "4");
  p.filter("admin-node-search", "0.1.0", "input");
  assert.deepEqual(p.rows().map(row => row.dataset.nodeId), ["codey-only"]);
});

test("search, owner and status filters combine without changing global totals", async () => {
  const p = await page();
  p.filter("admin-node-owner", bob.id);
  assert.deepEqual(p.rows().map((row) => row.dataset.nodeId), ["bob-machine", "first-start"]);
  p.filter("admin-node-status", "stale");
  assert.deepEqual(p.rows().map((row) => row.dataset.nodeId), ["bob-machine"]);
  p.filter("admin-node-search", "BOB-MACHINE", "input");
  assert.equal(p.rows().length, 1);
  p.filter("admin-node-search", "no-such-node", "input");
  assert.equal(p.rows().length, 0);
  assert.match(p.get("admin-node-list").textContent, /没有匹配/);
  p.filter("admin-node-status", "");
  p.filter("admin-node-search", "bbbbbbbb", "input");
  assert.deepEqual(p.rows().map((row) => row.dataset.nodeId), ["bob-machine"]);
  p.filter("admin-node-search", "installed-release", "input");
  assert.equal(p.rows().length, 2);
  assert.equal(p.get("admin-node-total").textContent, "4");
  assert.equal(p.get("admin-node-owners").textContent, "2");
  assert.equal(p.requests.length, 1, "Filtering is local and cannot start node probes");
});

test("unknown filter includes never-enrolled, first-heartbeat, revoked, disabled and unavailable nodes", async () => {
  const nodes = ["online", "stale", "not_enrolled", "unreported", "revoked", "owner_disabled", "unavailable", "unknown"]
    .map((status) => node(status, { status, ...(status === "owner_disabled" ? { owner: { ...bob, enabled: false } } : {}) }));
  const p = await page({ nodes });
  p.filter("admin-node-status", "unknown");
  assert.equal(p.rows().length, 6);
  assert.ok(p.rows().every((row) => !["online", "stale"].includes(row.dataset.nodeId)));
  assert.match(p.get("admin-node-list").textContent, /账号已停用/);
  assert.match(p.get("admin-node-owner").textContent, /bob（已停用）/);
  p.filter("admin-node-owner", bob.id);
  assert.deepEqual(p.rows().map((row) => row.dataset.nodeId), ["owner_disabled"]);
  const missingOwner = await page({ nodes: [node("orphan", { owner: { id: "missing-owner", username: null, enabled: false }, status: "unknown" })] });
  assert.match(missingOwner.rows()[0].textContent, /missing-owner归属账号不可用/);
  assert.match(missingOwner.get("admin-node-owner").textContent, /missing-owner（账号不可用）/);
});

test("large inventories paginate, reset on filtering and clamp the page after a refresh removes nodes", async () => {
  const nodes = Array.from({ length: 43 }, (_, index) => node(`node-${String(index).padStart(2, "0")}`));
  const p = await page({ nodes });
  assert.equal(p.rows().length, 20);
  assert.equal(p.get("admin-node-total").textContent, "43");
  assert.equal(p.get("admin-node-page").textContent, "1 / 3");
  p.get("admin-node-next").click();
  assert.equal(p.rows()[0].dataset.nodeId, "node-20");
  p.get("admin-node-next").click();
  assert.equal(p.rows().length, 3);
  assert.equal(p.get("admin-node-next").disabled, true);
  assert.equal(p.get("admin-node-results").textContent, "显示 41–43 / 43 台");
  p.filter("admin-node-search", "node-42", "input");
  assert.equal(p.get("admin-node-page").textContent, "1 / 1");
  assert.equal(p.rows()[0].dataset.nodeId, "node-42");
  p.filter("admin-node-search", "", "input");
  p.get("admin-node-next").click();
  p.get("admin-node-next").click();
  p.state.nodes = p.state.nodes.slice(0, 21);
  await p.refresh();
  assert.equal(p.get("admin-node-page").textContent, "2 / 2");
  assert.deepEqual(p.rows().map((row) => row.dataset.nodeId), ["node-20"]);
  p.get("admin-node-prev").click();
  assert.equal(p.get("admin-node-page").textContent, "1 / 2");
});

test("refresh preserves matching filters, drops vanished owner options, and never duplicates an in-flight read", async () => {
  let release;
  const wait = new Promise((done) => { release = done; });
  const p = await page({ respond: async ({ call }) => { if (call === 2) await wait; } });
  p.filter("admin-node-owner", bob.id);
  p.filter("admin-node-search", "bob-machine", "input");
  p.get("admin-node-refresh").click();
  p.get("admin-node-refresh").click();
  p.timers[0].callback();
  await tick();
  assert.equal(p.requests.length, 2);
  assert.equal(p.get("admin-node-refresh").disabled, true);
  release(); await tick();
  assert.equal(p.get("admin-node-owner").value, bob.id);
  assert.equal(p.get("admin-node-search").value, "bob-machine");
  assert.deepEqual(p.rows().map((row) => row.dataset.nodeId), ["bob-machine"]);
  p.filter("admin-node-search", "", "input");
  p.state.nodes = p.state.nodes.filter((item) => item.owner.id !== bob.id);
  await p.refresh();
  assert.equal(p.get("admin-node-owner").value, "");
  assert.ok(!p.get("admin-node-owner").textContent.includes("bob"));
  assert.equal(p.rows().length, 2);
});

test("automatic refresh pauses in hidden tabs, other settings and user management", async () => {
  const p = await page();
  assert.equal(p.timers[0].ms, 30000);
  p.document.hidden = true;
  p.timers[0].callback(); await tick();
  assert.equal(p.requests.length, 1);
  p.document.hidden = false;
  p.dispatch("visibilitychange"); await tick();
  assert.equal(p.requests.length, 2);
  p.hide();
  p.timers[0].callback();
  p.dispatch("admin-users-change"); await tick();
  assert.equal(p.requests.length, 2);
  p.show(); await tick();
  assert.equal(p.requests.length, 3);
  p.get("admin-section").hidden = true;
  p.timers[0].callback(); await tick();
  assert.equal(p.requests.length, 3);
});

test("transient failures retain an explicitly old snapshot and recover on retry; initial failures are not zero nodes", async () => {
  const p = await page({ respond: ({ call }) => call === 2 ? { status: 503, value: { error: "状态存储暂不可用" } } : null });
  await p.refresh();
  assert.equal(p.rows().length, 4);
  assert.equal(p.get("admin-node-total").textContent, "4");
  assert.match(p.get("admin-node-message").textContent, /刷新失败.*状态存储暂不可用.*旧快照/);
  assert.equal(p.get("admin-node-message").classList.contains("error"), true);
  assert.equal(p.get("admin-node-refresh").disabled, false);
  p.state.nodes = [];
  await p.refresh();
  assert.equal(p.get("admin-node-message").classList.contains("error"), false);
  assert.equal(p.get("admin-node-total").textContent, "0");
  assert.match(p.get("admin-node-list").textContent, /还没有用户添加节点/);
  const first = await page({ respond: () => ({ status: 503, value: { error: "稍后再试" } }) });
  assert.equal(first.get("admin-node-total").textContent, "—");
  assert.equal(first.get("admin-node-search").disabled, true);
  assert.match(first.get("admin-node-list").textContent, /无法读取/);
});

test("expired admin privileges erase cached metadata and stop polling; login expiration redirects", async () => {
  for (const status of [401, 403]) {
    const p = await page({ respond: ({ call }) => call >= 2 ? { status, value: { error: "denied" } } : null });
    await p.refresh();
    assert.equal(p.rows().length, 0);
    assert.equal(p.get("admin-node-total").textContent, "—");
    assert.ok(!p.get("admin-node-owner").textContent.includes("bob"));
    assert.equal(p.get("admin-node-refresh").disabled, true);
    assert.match(p.get("admin-node-message").textContent, /权限已失效/);
    p.timers[0].callback(); await tick();
    assert.equal(p.requests.length, 2);
    assert.deepEqual(p.redirects, status === 401 ? ["/portal-auth/login"] : []);
  }
});

test("a role change discards both cached inventory and a late successful response", async () => {
  let release;
  const wait = new Promise((done) => { release = done; });
  const p = await page({ respond: async ({ call }) => { if (call === 2) await wait; } });
  p.get("admin-node-refresh").click();
  p.setRole("user");
  assert.equal(p.rows().length, 0);
  assert.equal(p.get("admin-node-total").textContent, "—");
  release(); await tick();
  assert.equal(p.rows().length, 0);
  assert.equal(p.get("admin-node-search").disabled, true);
  assert.equal(p.get("admin-node-refresh").disabled, true);
  p.setRole("admin"); await tick();
  assert.equal(p.requests.length, 3);
  assert.equal(p.rows().length, 4);
});

test("an unavailable telemetry service or malformed response is explicit rather than fabricated status", async () => {
  const missing = await page({ respond: () => ({ value: { ...inventory(defaults), telemetryAvailable: false, heartbeatTimeoutMs: null } }) });
  assert.match(missing.get("admin-node-message").textContent, /尚未配置上报服务/);
  const malformed = await page({ respond: () => ({ value: { nodes: [], summary: { total: 99 }, generatedAt: now } }) });
  assert.match(malformed.get("admin-node-message").textContent, /响应无效/);
  assert.equal(malformed.get("admin-node-total").textContent, "—");
});
