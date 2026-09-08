const message = document.querySelector("#settings-message");
const nodesRoot = document.querySelector("#my-nodes");
const usersRoot = document.querySelector("#users-list");
const adminTab = document.querySelector("#admin-tab");
const settingsTabs = [...document.querySelectorAll("[data-settings-panel]")];
const addNodeDialog = document.querySelector("#add-node");
const enrollment = document.querySelector("#enrollment");
const enrollmentValue = document.querySelector("#enrollment-value");
const pendingMachinesRoot = document.querySelector("#pending-machines");
const machineDownloadMessage = document.querySelector("#machine-download-message");
const machineSkillButtons = new Map();
let machineSkillDownloading = false;
let settingsReady = false;
let activePanel = "nodes";

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

document.querySelector("#open-add-node").addEventListener("click", openAddNode);
document.querySelector("#close-add-node").addEventListener("click", () => addNodeDialog.close());
document.querySelector("#pending-machines-shortcut").addEventListener("click", () => {
  openAddNode();
  document.querySelector("#pending-machine-details").open = true;
});
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
    const card = element("details", null, "node-card");
    card.dataset.nodeId = node.id;
    card.open = expanded.has(node.id);
    const summary = element("summary", null, "node-summary");
    const identity = element("span", null, "node-identity");
    identity.append(element("strong", node.name), element("span", node.region || "未设置区域", "node-region"));
    const endpoint = element("span", node.endpoint, "node-endpoint");
    endpoint.title = node.endpoint;
    const badges = element("span", null, "badges");
    const connection = element("span", node.vnetOnly ? "VNet 专用" : node.vnetAvailable ? "VNet 已配置" : "浏览器直连", "badge");
    connection.title = node.vnetOnly ? "VNet 专用，无需浏览器证书" : connection.textContent;
    badges.append(connection, element("span", node.workspaceAvailable ? "Workspace 已配置" : "Workspace 未配置",
      `badge ${node.workspaceAvailable ? "configured" : "pending"}`));
    summary.append(identity, endpoint, badges, element("span", "设置", "node-disclosure"));
    card.append(summary);

    const editor = element("div", null, "node-editor");
    editor.append(element("p", `节点 ID · ${node.id}`, "node-id"));
    const form = element("form", null, "node-form");
    form.setAttribute("aria-label", `${node.name} 节点设置`);
    const endpointField = field(node.vnetOnly ? "HTTPS 地址（VNet 专用，由机器配置提供）" : "HTTPS 地址", "endpoint", node.endpoint, "url");
    endpointField.className = "node-endpoint-field";
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
  machineSkillButtons.clear();
  machineSkillButtons.set(document.querySelector("#download-machine-skill"), Boolean(setup?.enabled));
  document.querySelector("#machine-package-status").textContent = setup?.enabled
    ? `约 ${Math.ceil(setup.bytes / 1024 / 1024)} MB · Node ${setup.node} · CloudCLI ${setup.cloudcli} · copilot-api ${setup.copilotApi}`
    : setup?.reason || "完整机器配置包尚未发布；旧版说明 ZIP 不能替代依赖包。";
  const pendingCount = result.pendingMachines?.length || 0;
  document.querySelector("#pending-machine-details").hidden = !pendingCount;
  document.querySelector("#pending-machine-count").textContent = String(pendingCount);
  const pendingShortcut = document.querySelector("#pending-machines-shortcut");
  pendingShortcut.hidden = !pendingCount;
  pendingShortcut.textContent = `${pendingCount} 个待配置身份 · 继续添加或管理`;
  pendingMachinesRoot.textContent = "";
  for (const pending of result.pendingMachines ?? []) {
    const row = element("div", null, "user-row pending-machine");
    row.append(element("span", `${pending.id} · ${pending.expired ? "已过期" : "待配置，尚未添加"}`, "muted"));
    const retryForm = element("form");
    retryForm.action = `/api/settings/machines/${pending.id}/skill`;
    retryForm.method = "post";
    const retry = element("button", "重新下载此身份的 Skill");
    retry.type = "submit";
    machineSkillButtons.set(retry, !pending.expired && Boolean(setup?.enabled));
    retryForm.append(retry);
    retryForm.addEventListener("submit", downloadMachineSkill);
    row.append(retryForm);
    const cancel = element("button", "取消此配置包", "danger");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      if (!window.confirm("取消后，此配置包和已生成的机器文件将无法添加。不会停止目标机上的服务。")) return;
      void operation(cancel, async () => {
        await api(`/api/settings/machines/${pending.id}`, "DELETE");
        await load();
        notice("已取消待配置身份。");
        machineDownloadNotice("已取消待配置身份。");
      }, machineDownloadNotice);
    });
    row.append(cancel);
    pendingMachinesRoot.append(row);
  }
  updateMachineSkillButtons();
  adminTab.hidden = result.user.role !== "admin";
  if (adminTab.hidden && activePanel === "admin-section") activatePanel("nodes", true);
  settingsReady = true;
  followSettingsLocation();
  if (!adminTab.hidden) await renderUsers();
}

async function downloadMachineSkill(event) {
  event.preventDefault();
  if (machineSkillDownloading) return;
  const form = event.currentTarget;
  machineSkillDownloading = true;
  updateMachineSkillButtons();
  machineDownloadNotice("正在下载完整配置包，请稍候。包内含本次机器的专属密钥，请勿分享。");
  let refreshPending = true;
  try {
    // Native POST navigation under no-referrer can have an opaque Origin.
    // Keep strict server-side CSRF checks and limit this request to our origin.
    const response = await fetch(form.action, {
      method: "POST", mode: "same-origin", credentials: "same-origin", cache: "no-store",
      redirect: "error", referrerPolicy: "same-origin", headers: { accept: "application/zip" },
    });
    if (response.status === 401) {
      refreshPending = false;
      window.location.replace("/portal-auth/login");
      throw new Error("请重新登录后下载");
    }
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.error || `HTTP ${response.status}`);
    }
    const filename = response.headers.get("content-disposition")
      ?.match(/^attachment;\s*filename="(config-new-codey-machine-n-[a-f0-9]{24}\.zip)"$/i)?.[1];
    if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/zip" || !filename) {
      throw new Error("服务器未返回有效的 ZIP 配置包，请刷新页面后重试");
    }
    const blob = await response.blob();
    const length = response.headers.get("content-length");
    if (!blob.size || (length !== null && Number(length) !== blob.size)) {
      throw new Error("配置包下载不完整，请重新下载此身份的 Skill");
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
    machineDownloadNotice(`已准备好 ${filename}，请在浏览器的下载列表中查看。包内含专属密钥，请勿分享。`);
  } catch (error) {
    machineDownloadNotice(`下载失败：${error.message}。若下方已有待配置身份，请使用“重新下载此身份的 Skill”重试。`, true);
  } finally {
    machineSkillDownloading = false;
    updateMachineSkillButtons();
    // Even an interrupted transfer may have reserved an identity. Show it so
    // retrying does not silently consume another one of the user's four slots.
    if (refreshPending) {
      await load().catch((error) => machineDownloadNotice(
        `${machineDownloadMessage.textContent} 待配置身份刷新失败：${error.message}，请刷新页面。`, true,
      ));
    }
  }
}

document.querySelector("#machine-skill-form").addEventListener("submit", downloadMachineSkill);

document.querySelector("#add-prepared-machine-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void operation(form.querySelector("button"), async () => {
    const file = document.querySelector("#prepared-machine-file").files?.[0];
    if (!file || file.size > 16384) throw new Error("请选择 Skill 生成的 codey-machine.json（不超过 16 KB）");
    let machine;
    try { machine = JSON.parse(await file.text()); }
    catch { throw new Error("机器文件不是有效 JSON"); }
    if (machine?.schema !== 1 || !/^n-[a-f0-9]{24}$/.test(machine.nodeId ?? "") ||
        typeof machine.tlsCertificate !== "string" || typeof machine.privateIp !== "string" ||
        Object.hasOwn(machine, "clientSigningKey") || Object.hasOwn(machine, "workspaceSsoKey")) {
      throw new Error("请选择配置完成的机器文件，不是 enrollment 或校验值");
    }
    machineActivationNotice("正在从门户验证 VNet、HTTPS、Usage/History、Workspace SSO 和 WebSocket…");
    const { node } = await api(`/api/settings/machines/${machine.nodeId}/activate`, "POST", machine);
    form.reset();
    await load();
    addNodeDialog.close();
    document.querySelector("#machine-activation-message").textContent = "";
    notice(`机器已验通并添加：${node.name}。现在可以使用 VNet 用量、History 和 Workspace。模型尚未登录时，请完成本人的 provider 授权。`);
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
