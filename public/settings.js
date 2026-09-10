const message = document.querySelector("#settings-message");
const nodesRoot = document.querySelector("#my-nodes");
const usersRoot = document.querySelector("#users-list");
const adminTab = document.querySelector("#admin-tab");
const settingsTabs = [...document.querySelectorAll("[data-settings-panel]")];
const adminTabs = [...document.querySelectorAll("[data-admin-panel]")];
const addNodeDialog = document.querySelector("#add-node");
const enrollment = document.querySelector("#enrollment");
const enrollmentValue = document.querySelector("#enrollment-value");
const machineDownloadMessage = document.querySelector("#machine-download-message");
const machineSkillButtons = new Map();
const machineSkillFilenames = Object.freeze({
  "linux-x64": "config-new-codey-machine.zip",
  "windows-x64": "config-new-codey-machine-windows.zip",
  "macos-arm64": "config-new-codey-machine-macos-arm64.zip",
  "macos-x64": "config-new-codey-machine-macos-x64.zip",
});
let machineSkillDownloading = false;
let settingsReady = false;
let activePanel = "nodes";
let activeAdminPanel = "admin-nodes-panel";

function syncAdminPanels() {
  for (const tab of adminTabs) {
    const selected = tab.dataset.adminPanel === activeAdminPanel;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.dataset.adminPanel).hidden = !selected || adminTab.hidden || activePanel !== "admin-section";
  }
}

function activateAdminPanel(id) {
  if (adminTab.hidden || activePanel !== "admin-section" || !adminTabs.some((tab) => tab.dataset.adminPanel === id)) return;
  activeAdminPanel = id;
  syncAdminPanels();
  document.dispatchEvent(new CustomEvent("admin-panel-change", { detail: id }));
}

function activatePanel(id, updateHistory = false) {
  const next = settingsTabs.find((tab) => tab.dataset.settingsPanel === id && !tab.hidden)
    || settingsTabs.find((tab) => tab.dataset.settingsPanel === "nodes");
  if (!next) return;
  const changed = activePanel !== next.dataset.settingsPanel;
  activePanel = next.dataset.settingsPanel;
  for (const tab of settingsTabs) {
    const selected = tab === next;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.dataset.settingsPanel).hidden = !selected;
  }
  syncAdminPanels();
  if (updateHistory && window.location.hash !== `#${activePanel}`) {
    window.history.pushState(null, "", `#${activePanel}`);
  }
  if (changed) document.dispatchEvent(new CustomEvent("settings-panel-change", { detail: activePanel }));
}

function followSettingsLocation() {
  const id = window.location.hash.slice(1);
  activatePanel(id === "add-node" ? "nodes" : id);
  if (id === "add-node") {
    // Preserve /settings#add-node without opening an empty, still-loading flow.
    if (settingsReady && !addNodeDialog.open) addNodeDialog.showModal();
  } else if (addNodeDialog.open) {
    addNodeDialog.close();
  }
}

function openAddNode() {
  activatePanel("nodes");
  if (window.location.hash !== "#add-node") window.history.pushState(null, "", "#add-node");
  if (!addNodeDialog.open) addNodeDialog.showModal();
}

for (const tab of settingsTabs) {
  tab.addEventListener("click", () => activatePanel(tab.dataset.settingsPanel, true));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const visible = settingsTabs.filter((item) => !item.hidden);
    const index = visible.indexOf(tab);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + visible.length) % visible.length;
    const next = visible[nextIndex];
    activatePanel(next.dataset.settingsPanel, true);
    next.focus();
  });
}

for (const tab of adminTabs) {
  tab.addEventListener("click", () => activateAdminPanel(tab.dataset.adminPanel));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || adminTab.hidden) return;
    event.preventDefault();
    const index = adminTabs.indexOf(tab);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? adminTabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + adminTabs.length) % adminTabs.length;
    const next = adminTabs[nextIndex];
    activateAdminPanel(next.dataset.adminPanel);
    next.focus();
  });
}

document.querySelector("#open-add-node").addEventListener("click", openAddNode);
document.querySelector("#close-add-node").addEventListener("click", () => addNodeDialog.close());
addNodeDialog.addEventListener("close", () => {
  if (window.location.hash === "#add-node") window.history.replaceState(null, "", "#nodes");
  if (activePanel === "nodes") document.querySelector("#open-add-node").focus({ preventScroll: true });
});

function notice(text, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
}

function machineDownloadNotice(text, error = false) {
  machineDownloadMessage.textContent = text;
  machineDownloadMessage.classList.toggle("error", error);
}

function machineActivationNotice(text, error = false) {
  const status = document.querySelector("#machine-activation-message");
  status.textContent = text;
  status.classList.toggle("error", error);
  notice(text, error);
}

function updateMachineSkillButtons() {
  for (const [button, available] of machineSkillButtons) {
    button.disabled = machineSkillDownloading || !available;
  }
}

async function api(url, method = "GET", data) {
  const response = await fetch(url, {
    method, credentials: "same-origin", cache: "no-store",
    ...(data !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(data) } : {}),
  });
  if (response.status === 401) { window.location.replace("/portal-auth/login"); throw new Error("请重新登录"); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function field(label, name, value, type = "text") {
  const node = element("label", label);
  const input = element("input");
  input.name = name;
  input.type = type;
  input.value = value ?? "";
  input.maxLength = name === "endpoint" ? 2048 : name === "region" ? 120 : 80;
  input.required = ["name", "endpoint"].includes(name);
  node.append(input);
  return node;
}

function nodeServiceOrigin(endpoint) {
  // Older records use the usage URL as their endpoint. Settings describe the
  // node's service origin, not one API; the existing PUT accepts either form.
  try { return new URL(endpoint).origin; }
  catch { return endpoint || ""; }
}

async function operation(button, action, report = notice) {
  if (button.disabled) return;
  button.disabled = true;
  try { await action(); }
  catch (error) { report(error.message, true); }
  finally { button.disabled = false; }
}

function renderNodes(nodes) {
  const expanded = new Set([...nodesRoot.querySelectorAll(".node-card[open]")].map((card) => card.dataset.nodeId));
  nodesRoot.replaceChildren();
  document.querySelector("#nodes-count").textContent = String(nodes.length);
  if (!nodes.length) {
    const empty = element("div", null, "empty-state");
    empty.append(element("strong", "还没有节点"), element("p", "点击“添加节点”配置自己的机器，即可使用用量、节点会话和 Workspace。", "muted"));
    nodesRoot.append(empty);
  }
  for (const node of nodes) {
    const origin = nodeServiceOrigin(node.endpoint);
    const card = element("details", null, "node-card");
    card.dataset.nodeId = node.id;
    card.open = expanded.has(node.id);
    const summary = element("summary", null, "node-summary");
    const identity = element("span", null, "node-identity");
    identity.append(element("strong", node.name), element("span", node.region || "未设置区域", "node-region"));
    const endpoint = element("span", origin, "node-endpoint");
    endpoint.title = origin;
    const badges = element("span", null, "badges");
    const connection = element("span", node.networkMode === "devtunnel" ? "DevTunnel 专用"
      : node.vnetOnly ? "VNet 专用" : node.vnetAvailable ? "VNet 已配置" : "浏览器直连", "badge");
    connection.title = node.vnetOnly ? "VNet 专用，无需浏览器证书" : connection.textContent;
    badges.append(connection, element("span", node.workspaceAvailable ? "Workspace 已配置" : "Workspace 未配置",
      `badge ${node.workspaceAvailable ? "configured" : "pending"}`));
    summary.append(identity, endpoint, badges, element("span", "设置", "node-disclosure"));
    card.append(summary);

    const editor = element("div", null, "node-editor");
    editor.append(element("p", `${node.id === "local" ? "兼容节点 ID" : "节点 ID"} · ${node.id}`, "node-id"));
    if (node.id === "local") {
      editor.append(element("p", "保留旧 ID 以兼容现有会话与 SSO；它不是机器名称。此节点的 Workspace 是远程机器，Usage/History 的回环地址仍指向当前浏览器设备，不代表已开通远程 Windows 用量。", "muted"));
    }
    const form = element("form", null, "node-form");
    form.setAttribute("aria-label", `${node.name} 节点设置`);
    const endpointField = field(node.vnetOnly ? "HTTPS 服务入口（VNet 专用，由机器配置提供）" : "HTTPS 服务入口", "endpoint", origin, "url");
    endpointField.className = "node-endpoint-field";
    endpointField.querySelector("input").placeholder = "https://host:8443";
    if (node.vnetOnly) endpointField.querySelector("input").readOnly = true;
    form.append(field("名称", "name", node.name), field("区域", "region", node.region),
      field("颜色", "accent", node.accent, "color"), endpointField);
    const actions = element("div", null, "actions");
    const save = element("button", "保存设置", "primary");
    save.type = "submit";
    actions.append(save);
    if (!node.managedLegacy) {
      const credentials = element("button", "查看本节点接入资料");
      credentials.type = "button";
      credentials.addEventListener("click", () => operation(credentials, async () => {
        const result = await api(`/api/settings/nodes/${node.id}/enrollment`, "POST");
        enrollmentValue.textContent = JSON.stringify(result, null, 2);
        enrollment.showModal();
      }));
      actions.append(credentials);
    }
    const remove = element("button", "移除节点", "danger");
    remove.type = "button";
    remove.addEventListener("click", () => {
      if (!window.confirm(`从你的账号移除“${node.name}”？不会删除 VM 文件或停止服务，但该节点的门户访问会被撤销。`)) return;
      void operation(remove, async () => {
        await api(`/api/settings/nodes/${node.id}`, "DELETE");
        enrollmentValue.textContent = "";
        if (enrollment.open) enrollment.close();
        notice("已移除节点。");
        await load();
      });
    });
    actions.append(remove);
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void operation(save, async () => {
        const values = Object.fromEntries(new FormData(form));
        await api(`/api/settings/nodes/${node.id}`, "PUT", values);
        notice("你的节点设置已保存。");
        await load();
        nodesRoot.querySelectorAll(".node-card").forEach((item) => {
          if (item.dataset.nodeId === node.id) item.querySelector("summary").focus();
        });
      });
    });
    editor.append(form);
    card.append(editor);
    nodesRoot.append(card);
  }
}

async function renderUsers() {
  const { users } = await api("/api/admin/users");
  usersRoot.replaceChildren();
  document.querySelector("#users-count").textContent = String(users.length);
  for (const user of users) {
    const row = element("div", null, "user-row");
    row.append(element("span", `${user.username} · ${user.role === "admin" ? "管理员" : "用户"} · ${user.enabled ? "已启用" : "已停用"}`));
    if (user.role !== "admin") {
      const toggle = element("button", user.enabled ? "停用" : "启用");
      toggle.type = "button";
      toggle.addEventListener("click", () => {
        if (!window.confirm(`${user.enabled ? "停用" : "启用"}账号 ${user.username}？该账号的旧登录会话会失效。`)) return;
        void operation(toggle, async () => {
          await api(`/api/admin/users/${user.id}`, "PATCH", { enabled: !user.enabled });
          await renderUsers();
          document.dispatchEvent(new CustomEvent("admin-users-change"));
          notice("账号状态已更新。");
        });
      });
      row.append(toggle);
    }
    usersRoot.append(row);
  }
}

async function load() {
  const result = await api("/api/settings");
  renderNodes(result.nodes);
  const setup = result.machineSetup;
  const linuxSetup = setup?.platforms?.find((item) => item.platform === "linux-x64")
    ?? (setup?.platform !== "windows-x64" ? setup : null);
  const windowsSetup = setup?.platforms?.find((item) => item.platform === "windows-x64");
  const macSetup = setup?.platforms?.find((item) => item.platform === "macos-arm64");
  const intelSetup = setup?.platforms?.find((item) => item.platform === "macos-x64");
  machineSkillButtons.clear();
  machineSkillButtons.set(document.querySelector("#download-machine-skill"), Boolean(linuxSetup?.enabled));
  machineSkillButtons.set(document.querySelector("#download-machine-windows-skill"), Boolean(windowsSetup?.enabled));
  machineSkillButtons.set(document.querySelector("#download-machine-macos-skill"), Boolean(macSetup?.enabled));
  machineSkillButtons.set(document.querySelector("#download-machine-macos-intel-skill"), Boolean(intelSetup?.enabled));
  for (const [id, entry, label] of [
    ["machine-package-status", linuxSetup, "Linux"],
    ["machine-windows-package-status", windowsSetup, "Windows"],
    ["machine-macos-status", macSetup, "macOS · Apple Silicon"],
    ["machine-macos-intel-status", intelSetup, "macOS · Intel"],
  ]) {
    document.querySelector(`#${id}`).textContent = entry?.enabled
      ? `${label}${entry.preview ? `【验收版，仅限 ${entry.expectedComputerName}】` : ""} · 约 ${
        Math.ceil(entry.bytes / 1024 / 1024)} MB · Node ${entry.node} · CloudCLI ${entry.cloudcli} · ${
        String(entry.platform).startsWith("macos-") || entry.platform === "windows-x64"
          ? "复用本机模型代理" : `copilot-api ${entry.copilotApi}`}`
      : entry?.reason || `${label} 完整机器配置包尚未发布；不会使用其他平台的包代替。`;
  }
  updateMachineSkillButtons();
  adminTab.hidden = result.user.role !== "admin";
  if (adminTab.hidden && activePanel === "admin-section") activatePanel("nodes", true);
  settingsReady = true;
  followSettingsLocation();
  document.dispatchEvent(new CustomEvent("settings-role-change", { detail: result.user.role }));
  if (!adminTab.hidden) await renderUsers();
  else usersRoot.replaceChildren();
}

async function downloadMachineSkill(event) {
  event.preventDefault();
  if (machineSkillDownloading) return;
  const form = event.currentTarget;
  machineSkillDownloading = true;
  updateMachineSkillButtons();
  machineDownloadNotice("正在下载可复用 Skill 包。包内不含 token，可分发到多台同平台机器。");
  try {
    // Native POST navigation under no-referrer can have an opaque Origin.
    // Keep strict server-side CSRF checks and limit this request to our origin.
    const response = await fetch(form.action, {
      method: "POST", mode: "same-origin", credentials: "same-origin", cache: "no-store",
      redirect: "error", referrerPolicy: "same-origin", headers: { accept: "application/zip" },
    });
    if (response.status === 401) {
      window.location.replace("/portal-auth/login");
      throw new Error("请重新登录后下载");
    }
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.error || `HTTP ${response.status}`);
    }
    const selectedPlatform = form.dataset.machinePlatform || "linux-x64";
    const filename = machineSkillFilenames[selectedPlatform];
    const responseFilename = response.headers.get("content-disposition")
      ?.match(/^attachment;\s*filename="([^"]+)"$/i)?.[1];
    if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/zip" || !filename ||
        !responseFilename) {
      throw new Error("服务器未返回有效的 ZIP 配置包，请刷新页面后重试");
    }
    if (responseFilename !== filename) {
      throw new Error("服务器返回的配置包平台或文件名与所选系统不一致");
    }
    const blob = await response.blob();
    const length = response.headers.get("content-length");
    if (!blob.size || (length !== null && Number(length) !== blob.size)) {
      throw new Error("配置包下载不完整，请重新下载 Skill");
    }
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = filename;
    try {
      document.body.append(link);
      link.click();
    } finally {
      link.remove();
      // Give the browser time to consume the Blob before releasing its memory.
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    machineDownloadNotice(`已准备好 ${filename}。包内不含 token，可复用并分发到多台同平台机器。`);
  } catch (error) {
    machineDownloadNotice(`下载失败：${error.message}。请重试。`, true);
  } finally {
    machineSkillDownloading = false;
    updateMachineSkillButtons();
  }
}

document.querySelector("#machine-skill-form").addEventListener("submit", downloadMachineSkill);
document.querySelector("#machine-windows-skill-form").addEventListener("submit", downloadMachineSkill);
document.querySelector("#machine-macos-skill-form").addEventListener("submit", downloadMachineSkill);
document.querySelector("#machine-macos-intel-skill-form").addEventListener("submit", downloadMachineSkill);

document.querySelector("#add-prepared-machine-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void operation(form.querySelector("button"), async () => {
    const file = document.querySelector("#prepared-machine-file").files?.[0];
    if (!file || file.size > 32 * 1024) {
      throw new Error("请选择 Skill 生成的机器注册 JSON（不超过 32 KB）");
    }
    let registration;
    try { registration = JSON.parse(await file.text()); }
    catch { throw new Error("注册文件不是有效 JSON"); }
    const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    if (registration?.schema !== 2 || !isRecord(registration.package) || !isRecord(registration.machine) ||
        !isRecord(registration.credentials) || typeof registration.devTunnelConnectToken !== "string" ||
        !registration.devTunnelConnectToken.trim()) {
      throw new Error("请选择结构完整的 schema 2 机器注册文件");
    }
    machineActivationNotice("正在通过 HTTPS Portal 验证并添加机器。请勿关闭此页面…");
    const { node, verification } = await api("/api/settings/machines/activate", "POST", registration);
    form.reset();
    await load();
    addNodeDialog.close();
    document.querySelector("#machine-activation-message").textContent = "";
    const usageMessage = verification?.usage === false
      ? "Copilot 配额暂不可用；本地 Token 统计、History、Workspace SSO 已验通。"
      : "用量、History、Workspace SSO 已验通。";
    notice(`机器已验通并添加：${node.name}。${usageMessage}模型推理仍需单独验收；保留本人现有 provider 登录。请立即删除 codey-machine-registration.json。`);
  }, machineActivationNotice);
});

document.querySelector("#create-user-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  form.elements.password.value = "";
  void operation(form.querySelector("button"), async () => {
    const { user } = await api("/api/admin/users", "POST", data);
    form.reset();
    const details = document.querySelector("#create-user");
    details.open = false;
    details.querySelector("summary").focus();
    notice(`用户 ${user.username} 已创建，初始节点列表为空。`);
    await renderUsers();
    document.dispatchEvent(new CustomEvent("admin-users-change"));
  });
});

document.querySelector("#password-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  form.reset();
  void operation(form.querySelector("button"), async () => {
    await api("/api/settings/password", "POST", data);
    if (typeof BroadcastChannel === "function") {
      const channel = new BroadcastChannel("codey-auth");
      channel.postMessage("logout");
      channel.close();
    }
    window.location.replace("/portal-auth/login");
  });
});

document.querySelector("#hide-enrollment").addEventListener("click", () => {
  enrollmentValue.textContent = "";
  enrollment.close();
});
// Escape and the explicit close button must both remove credentials from the DOM.
enrollment.addEventListener("close", () => { enrollmentValue.textContent = ""; });

window.addEventListener("hashchange", followSettingsLocation);
window.addEventListener("popstate", followSettingsLocation);
followSettingsLocation();
void load().catch((error) => notice(error.message, true));
