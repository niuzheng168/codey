import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { settingsDom } from "./helpers/settings-dom.mjs";

const source = await readFile(new URL("../public/settings.js", import.meta.url), "utf8");
const tick = () => new Promise(setImmediate);
const ownedNode = {
  id: "alpha", name: "Alpha", region: "Japan East", endpoint: "https://alpha.example.test:8443/usage",
  accent: "#60a5fa", vnetAvailable: true, workspaceAvailable: true, managedLegacy: false,
};
const machineId = `n-${"a".repeat(24)}`;

async function page({ role = "user", hash = "", nodes = [ownedNode], pending = [], respond, waitForSettings } = {}) {
  const dom = settingsDom();
  const requests = [];
  const redirects = [];
  const confirmations = [];
  const history = [];
  const broadcasts = [];
  const windowListeners = new Map();
  const state = {
    user: { role }, nodes: structuredClone(nodes), pendingMachines: pending,
    machineSetup: { enabled: true, npmAvailable: true, npmFile: "codey-0.1.0.tgz",
      bytes: 4194304, node: "24.20.0", cloudcli: "1.37.2", copilotApi: "2.5.1" },
  };
  const users = [{ id: "owner", username: "demo", role: "admin", enabled: true },
    { id: "member", username: "alice", role: "user", enabled: true }];
  const window = {
    location: { hash, replace: (url) => redirects.push(url) },
    history: Object.fromEntries(["pushState", "replaceState"].map((method) => [method, (_, __, value) => {
      history.push({ method, value }); window.location.hash = value;
    }])),
    addEventListener: (name, handler) => windowListeners.set(name, handler),
    confirm: (text) => { confirmations.push(text); return window.confirmResult; },
    confirmResult: true, setTimeout() {},
  };
  runInNewContext(source, {
    document: dom.document, window, FormData: dom.FormData, CustomEvent, URL,
    BroadcastChannel: class {
      constructor(name) { this.name = name; }
      postMessage(value) { broadcasts.push([this.name, value]); }
      close() {}
    },
    fetch: async (url, options) => {
      const request = { url, ...options, data: options.body && JSON.parse(options.body) };
      requests.push(request);
      const override = await respond?.(request);
      if (override) return { status: override.status || 200, ok: !override.status || override.status < 400, json: async () => override.value };
      let value = { ok: true };
      if (url === "/api/settings") {
        if (waitForSettings) await waitForSettings;
        value = state;
      } else if (url === "/api/admin/users") {
        if (options.method === "POST") {
          const user = { id: "created", username: request.data.username, role: "user", enabled: true };
          users.push(user); value = { user };
        } else value = { users };
      } else if (url.startsWith("/api/admin/users/")) {
        const user = users.find((item) => item.id === url.split("/").at(-1));
        user.enabled = request.data.enabled;
      } else if (url.endsWith("/enrollment")) value = { nodeId: "alpha", fixtureKey: "synthetic-secret" };
      else if (url.startsWith("/api/settings/nodes/")) {
        if (options.method === "DELETE") state.nodes = state.nodes.filter((node) => node.id !== url.split("/").at(-1));
        else Object.assign(state.nodes.find((node) => node.id === url.split("/").at(-1)), request.data);
      } else if (url.endsWith("/activate")) {
        const node = { ...ownedNode, id: machineId, name: "New machine" };
        state.nodes.push(node); state.pendingMachines = []; value = { node };
      } else if (url.startsWith("/api/settings/machines/") && options.method === "DELETE") {
        state.pendingMachines = [];
      } else if (url !== "/api/settings/password") throw new Error(`Unexpected request: ${url}`);
      return { status: 200, ok: true, json: async () => value };
    },
  });
  await tick();
  return { ...dom, requests, redirects, confirmations, history, broadcasts, window, state, users,
    get: (id) => dom.document.getElementById(id),
    navigate(value, event = "hashchange") { window.location.hash = value; windowListeners.get(event)(); },
    async submit(form) { form.dispatch("submit"); await tick(); await tick(); },
  };
}

test("settings starts with one compact panel, closed dialogs and a hidden administrator entry", async () => {
  const p = await page();
  const tabs = p.document.querySelectorAll("[data-settings-panel]");
  const panels = p.document.querySelectorAll('[role="tabpanel"]');
  assert.equal(tabs.length, 4);
  assert.deepEqual(panels.filter((panel) => !panel.hidden).map((panel) => panel.id), ["nodes"]);
  assert.equal(p.get("admin-tab").hidden, true);
  assert.equal(p.get("nodes-count").textContent, "1");
  assert.equal(p.get("add-node").open, false);
  assert.equal(p.get("enrollment").open, false);
  assert.equal(p.get("create-user").open, false);
  assert.equal(p.get("my-nodes").children[0].tag, "details");
  assert.equal(p.get("my-nodes").children[0].open, false);
});

test("tabs and back navigation retain node drafts and maintain one selected, keyboard-focusable tab", async () => {
  const p = await page();
  const node = p.get("my-nodes").children[0];
  node.open = true;
  const input = node.querySelector('[name="name"]');
  input.value = "Unsaved name";
  await p.get("account-tab").click();
  assert.equal(p.get("account").hidden, false);
  assert.equal(p.get("nodes").hidden, true);
  assert.equal(p.window.location.hash, "#account");
  p.navigate("#nodes", "popstate");
  assert.equal(p.get("nodes").hidden, false);
  assert.equal(node.open, true);
  assert.equal(input.value, "Unsaved name");
  const tabs = p.document.querySelectorAll("[data-settings-panel]");
  assert.deepEqual(tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.id), ["nodes-tab"]);
  assert.deepEqual(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").map((tab) => tab.id), ["nodes-tab"]);
  assert.equal(p.requests.filter((request) => request.url === "/api/settings").length, 1, "Navigation must not rebuild node forms");
});

test("Left/Right, Home and End navigate only the visible settings tabs", async () => {
  const p = await page();
  p.get("nodes-tab").dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(p.document.activeElement, p.get("account-tab"));
  assert.equal(p.get("account").hidden, false);
  p.get("account-tab").dispatch("keydown", { key: "Home" });
  assert.equal(p.document.activeElement, p.get("nodes-tab"));
  p.get("nodes-tab").dispatch("keydown", { key: "ArrowRight" });
  assert.equal(p.document.activeElement, p.get("updates-tab"));
  p.get("updates-tab").dispatch("keydown", { key: "End" });
  assert.equal(p.document.activeElement, p.get("account-tab"));
});

test("administrator deep links resolve after role loading; members never request the user directory", async () => {
  const admin = await page({ role: "admin", hash: "#admin-section" });
  assert.equal(admin.get("admin-tab").hidden, false);
  assert.equal(admin.get("admin-section").hidden, false);
  assert.equal(admin.get("nodes").hidden, true);
  assert.equal(admin.get("admin-nodes-panel").hidden, false);
  assert.equal(admin.get("admin-users-panel").hidden, true);
  assert.equal(admin.get("users-count").textContent, "2");
  const member = await page({ hash: "#admin-section" });
  await member.get("admin-tab").click();
  assert.equal(member.get("admin-section").hidden, true);
  assert.equal(member.get("nodes").hidden, false);
  assert.equal(member.requests.some((request) => request.url.startsWith("/api/admin")), false);
});

test("global nodes and user management share one administrator tab with keyboard-accessible subpanels", async () => {
  const p = await page({ role: "admin", hash: "#admin-section" });
  assert.equal(p.get("admin-tab").textContent, "全局管理");
  p.get("admin-nodes-tab").dispatch("keydown", { key: "ArrowRight" });
  assert.equal(p.document.activeElement, p.get("admin-users-tab"));
  assert.equal(p.get("admin-users-panel").hidden, false);
  assert.equal(p.get("admin-nodes-panel").hidden, true);
  assert.equal(p.get("admin-users-tab").getAttribute("aria-selected"), "true");
  p.get("account-tab").click();
  assert.equal(p.get("admin-users-panel").hidden, true);
  p.get("admin-tab").click();
  assert.equal(p.get("admin-users-panel").hidden, false, "Returning retains the chosen administration subpanel");
  p.get("admin-users-tab").dispatch("keydown", { key: "Home" });
  assert.equal(p.get("admin-nodes-panel").hidden, false);
  assert.equal(p.get("admin-users-panel").hidden, true);
  p.get("admin-nodes-tab").dispatch("keydown", { key: "End" });
  assert.equal(p.get("admin-users-panel").hidden, false);
  p.get("admin-users-tab").dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(p.get("admin-nodes-tab").tabIndex, 0);
  assert.equal(p.get("admin-users-tab").tabIndex, -1);
  const member = await page();
  member.get("admin-users-tab").click();
  assert.equal(member.get("admin-users-panel").hidden, true);
  assert.equal(member.requests.some((request) => request.url.startsWith("/api/admin")), false);
});

test("onboarding deep links wait for settings, do not reopen an existing dialog, and close back to nodes", async () => {
  let resolve;
  const ready = new Promise((done) => { resolve = done; });
  const p = await page({ hash: "#add-node", waitForSettings: ready });
  assert.equal(p.get("add-node").open, false);
  resolve(); await tick();
  assert.equal(p.get("add-node").open, true);
  p.navigate("#add-node");
  assert.equal(p.get("add-node").openCount, 1);
  p.get("add-node").close(); // Native Escape also emits close.
  assert.equal(p.window.location.hash, "#nodes");
  assert.equal(p.document.activeElement, p.get("open-add-node"));
  p.navigate("#account");
  await p.get("open-add-node").click();
  assert.equal(p.get("nodes").hidden, false);
  assert.equal(p.get("add-node").open, true);
  p.navigate("#account", "popstate");
  assert.equal(p.get("add-node").open, false);
  assert.equal(p.get("account").hidden, false);
});

test("legacy pending identities are ignored because static Skill downloads do not reserve identities", async () => {
  const p = await page({ pending: [{ id: machineId, expired: false }] });
  assert.equal(p.get("pending-machines-shortcut"), null);
  assert.equal(p.get("pending-machine-details"), null);
  assert.equal(p.get("pending-machines"), null);
  assert.equal(p.requests.some((request) => request.url.includes(machineId)), false);
  await p.get("open-add-node").click();
  assert.match(p.get("add-node").textContent, /不含 token 或机器身份.*分发到多台机器/);
  assert.match(p.get("add-node").textContent, /无需解压 ZIP/);
});

test("collapsed nodes preserve all editable fields, VNet address restrictions and text-only rendering", async () => {
  const p = await page({ nodes: [{ ...ownedNode, name: "<img src=x onerror=evil()>", vnetOnly: true }] });
  const row = p.get("my-nodes").children[0];
  assert.match(row.querySelector("summary").textContent, /<img src=x onerror=evil\(\)>/);
  assert.match(row.querySelector("summary").textContent, /VNet 专用.*Workspace 已配置/);
  assert.deepEqual(row.querySelectorAll("input").map((input) => input.name), ["name", "region", "accent", "endpoint"]);
  assert.equal(row.querySelector('[name="endpoint"]').readOnly, true);
  assert.equal(row.querySelector('[name="endpoint"]').value, "https://alpha.example.test:8443");
  assert.equal(row.querySelector('[name="name"]').maxLength, 80);
  assert.equal(row.querySelector('[name="endpoint"]').maxLength, 2048);
  assert.equal(row.querySelectorAll("button").some((button) => button.textContent === "移除节点"), true);
});

test("saving a node uses the original owner-scoped API, keeps its editor open and restores keyboard focus", async () => {
  const p = await page();
  const row = p.get("my-nodes").children[0];
  row.open = true;
  row.querySelector('[name="name"]').value = "Renamed";
  await p.submit(row.querySelector("form"));
  const save = p.requests.find((request) => request.method === "PUT");
  assert.equal(save.url, "/api/settings/nodes/alpha");
  assert.deepEqual(save.data, { name: "Renamed", region: ownedNode.region, accent: ownedNode.accent, endpoint: "https://alpha.example.test:8443" });
  assert.equal(p.get("my-nodes").children[0].open, true);
  assert.equal(p.document.activeElement, p.get("my-nodes").children[0].querySelector("summary"));
  assert.match(p.get("settings-message").textContent, /已保存/);
});

test("node summaries, hover text and editors show the service origin rather than an API path", async () => {
  for (const [endpoint, origin] of [
    ["https://alpha.example.test:8443/usage", "https://alpha.example.test:8443"],
    ["https://alpha.example.test:8443/", "https://alpha.example.test:8443"],
    ["https://alpha.example.test:8443", "https://alpha.example.test:8443"],
    ["https://alpha.example.test:8443/v1/models", "https://alpha.example.test:8443"],
    ["https://[::1]:8443/usage", "https://[::1]:8443"],
  ]) {
    const p = await page({ nodes: [{ ...ownedNode, endpoint }] });
    const row = p.get("my-nodes").children[0];
    assert.equal(row.querySelector(".node-endpoint").textContent, origin);
    assert.equal(row.querySelector(".node-endpoint").title, origin);
    assert.equal(row.querySelector('[name="endpoint"]').value, origin);
    assert.match(row.querySelector(".node-endpoint-field").textContent, /HTTPS 服务入口/);
    assert.equal(p.requests.filter((request) => request.method !== "GET").length, 0, "Displaying a legacy record must not migrate or rewrite it");
  }
});

test("one malformed legacy address remains editable without hiding the rest of the node list", async () => {
  const p = await page({ nodes: [{ ...ownedNode, endpoint: "invalid-address" }, { ...ownedNode, id: "beta" }] });
  assert.equal(p.get("my-nodes").children.length, 2);
  assert.equal(p.get("my-nodes").children[0].querySelector('[name="endpoint"]').value, "invalid-address");
  assert.equal(p.get("my-nodes").children[1].querySelector(".node-endpoint").textContent, "https://alpha.example.test:8443");
});

test("node removal still requires confirmation and never sends a service lifecycle request", async () => {
  const p = await page();
  const remove = p.get("my-nodes").children[0].querySelectorAll("button").find((button) => button.textContent === "移除节点");
  p.window.confirmResult = false;
  await remove.click(); await tick();
  assert.equal(p.requests.some((request) => request.method === "DELETE"), false);
  p.window.confirmResult = true;
  await remove.click(); await tick();
  assert.equal(p.requests.filter((request) => request.method === "DELETE").length, 1);
  assert.equal(p.requests.find((request) => request.method === "DELETE").url, "/api/settings/nodes/alpha");
  assert.match(p.confirmations[0], /不会删除 VM 文件或停止服务/);
  assert.equal(p.get("nodes-count").textContent, "0");
  assert.match(p.get("my-nodes").textContent, /还没有节点/);
});

test("enrollment credentials are fetched only on demand and are erased for every dialog close path", async () => {
  const p = await page();
  assert.equal(p.requests.some((request) => request.url.endsWith("/enrollment")), false);
  const credentials = p.get("my-nodes").children[0].querySelectorAll("button").find((button) => button.textContent === "查看本节点接入资料");
  await credentials.click();
  assert.equal(p.get("enrollment").open, true);
  assert.match(p.get("enrollment-value").textContent, /synthetic-secret/);
  p.get("enrollment").close();
  assert.equal(p.get("enrollment-value").textContent, "");
  await credentials.click();
  await p.get("hide-enrollment").click();
  assert.equal(p.get("enrollment").open, false);
  assert.equal(p.get("enrollment-value").textContent, "");
  const legacy = await page({ nodes: [{ ...ownedNode, managedLegacy: true }] });
  assert.equal(legacy.get("my-nodes").querySelectorAll("button").some((button) => button.textContent.includes("接入资料")), false);
});

test("machine-file validation and activation failures are visible inside the modal", async () => {
  const p = await page({ hash: "#add-node", respond: (request) => request.url.endsWith("/activate")
    ? { status: 400, value: { error: "Workspace 验证失败" } } : null });
  await p.submit(p.get("add-prepared-machine-form"));
  assert.match(p.get("machine-activation-message").textContent, /请选择/);
  assert.equal(p.get("machine-activation-message").classList.contains("error"), true);
  assert.equal(p.get("add-node").open, true);
  const machine = {
    schema: 2,
    package: { platform: "linux-x64" },
    machine: { nodeId: machineId },
    credentials: { clientSigningKey: "private-signing-key" },
    devTunnelConnectToken: "private-connect-token",
  };
  p.get("prepared-machine-file").files = [{
    name: "codey-machine-registration.json", size: 300, text: async () => JSON.stringify(machine),
  }];
  await p.submit(p.get("add-prepared-machine-form"));
  assert.equal(p.get("machine-activation-message").textContent, "Workspace 验证失败");
  assert.equal(p.get("add-node").open, true);
  assert.equal(p.get("add-prepared-machine-form").querySelector("button").disabled, false);
});

test("private registration upload allows transferred filenames but enforces size and schema 2 structure", async () => {
  const p = await page({ hash: "#add-node" });
  const input = p.get("prepared-machine-file");
  const form = p.get("add-prepared-machine-form");
  const valid = {
    schema: 2,
    package: { platform: "linux-x64" },
    machine: { nodeId: machineId },
    credentials: { clientSigningKey: "private-signing-key" },
    devTunnelConnectToken: "private-connect-token",
  };
  for (const [file, expected] of [
    [{ name: "codey-machine-registration.json", size: 32 * 1024 + 1, text: async () => JSON.stringify(valid) }, /32 KB/],
    [{ name: "codey-machine-registration.json", size: 300, text: async () => JSON.stringify({ ...valid, schema: 1 }) }, /schema 2/],
    [{ name: "codey-machine-registration.json", size: 300, text: async () => JSON.stringify({ ...valid, credentials: [] }) }, /schema 2/],
    [{ name: "codey-machine-registration.json", size: 300, text: async () => JSON.stringify({ ...valid, devTunnelConnectToken: "" }) }, /schema 2/],
  ]) {
    input.files = [file];
    await p.submit(form);
    assert.match(p.get("machine-activation-message").textContent, expected);
  }
  assert.equal(p.requests.some((request) => request.url === "/api/settings/machines/activate"), false);
});

test("successful activation refreshes the list and returns from the modal to the compact node view", async () => {
  const p = await page({ hash: "#add-node" });
  const machine = {
    schema: 2,
    package: { platform: "linux-x64" },
    machine: { nodeId: machineId },
    credentials: { clientSigningKey: "private-signing-key" },
    devTunnelConnectToken: "private-connect-token",
  };
  p.get("prepared-machine-file").files = [{
    name: "codey-machine-registration (1).json", size: 300, text: async () => JSON.stringify(machine),
  }];
  await p.submit(p.get("add-prepared-machine-form"));
  const activation = p.requests.find((request) => request.url.endsWith("/activate"));
  assert.equal(activation.url, "/api/settings/machines/activate");
  assert.deepEqual(activation.data, machine);
  assert.equal(p.get("add-node").open, false);
  assert.equal(p.window.location.hash, "#nodes");
  assert.equal(p.get("nodes-count").textContent, "2");
  assert.match(p.get("settings-message").textContent, /已验通并添加/);
  assert.match(p.get("settings-message").textContent, /立即删除 codey-machine-registration\.json/);
  assert.doesNotMatch(p.get("settings-message").textContent, /private-connect-token/);
  assert.deepEqual(p.get("prepared-machine-file").files, []);
});

test("administrator creation and enable/disable controls retain their APIs and confirmations", async () => {
  const p = await page({ role: "admin", hash: "#admin-section" });
  p.get("admin-users-tab").click();
  p.get("create-user").open = true;
  const form = p.get("create-user-form");
  form.elements.username.value = "bob";
  form.elements.password.value = "test-password-only";
  await p.submit(form);
  assert.equal(p.get("create-user").open, false);
  assert.equal(form.elements.password.value, "");
  assert.equal(p.get("users-count").textContent, "3");
  const post = p.requests.find((request) => request.url === "/api/admin/users" && request.method === "POST");
  assert.deepEqual(post.data, { username: "bob", password: "test-password-only" });
  await p.get("users-list").children[1].querySelector("button").click(); await tick();
  const patch = p.requests.find((request) => request.method === "PATCH");
  assert.equal(patch.url, "/api/admin/users/member");
  assert.deepEqual(patch.data, { enabled: false });
  assert.match(p.confirmations[0], /旧登录会话会失效/);
  assert.equal(p.get("users-list").children[1].querySelector("button").textContent, "启用");
});

test("password changes still clear credentials, invalidate other tabs and redirect to login", async () => {
  const p = await page({ hash: "#account" });
  const form = p.get("password-form");
  form.elements.currentPassword.value = "old-test-password";
  form.elements.newPassword.value = "new-test-password";
  await p.submit(form);
  const request = p.requests.find((item) => item.url === "/api/settings/password");
  assert.deepEqual(request.data, { currentPassword: "old-test-password", newPassword: "new-test-password" });
  assert.equal(form.elements.currentPassword.value, "");
  assert.equal(form.elements.newPassword.value, "");
  assert.deepEqual(p.broadcasts, [["codey-auth", "logout"]]);
  assert.deepEqual(p.redirects, ["/portal-auth/login"]);
});
