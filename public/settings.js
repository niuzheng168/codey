const message = document.querySelector("#settings-message");
const nodesRoot = document.querySelector("#my-nodes");
const usersRoot = document.querySelector("#users-list");
const adminSection = document.querySelector("#admin-section");
const enrollment = document.querySelector("#enrollment");
const enrollmentValue = document.querySelector("#enrollment-value");
const pendingMachinesRoot = document.querySelector("#pending-machines");
const machineDownloadMessage = document.querySelector("#machine-download-message");
const machineSkillButtons = new Map();
let machineSkillDownloading = false;

function notice(text, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
}

function machineDownloadNotice(text, error = false) {
  machineDownloadMessage.textContent = text;
  machineDownloadMessage.classList.toggle("error", error);
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

async function operation(button, action) {
  button.disabled = true;
  try { await action(); }
  catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
}

function renderNodes(nodes) {
  nodesRoot.replaceChildren();
  if (!nodes.length) nodesRoot.append(element("p", "还没有节点。添加并配置你自己的节点后，才会显示用量、节点会话和可用的 Workspace。", "muted"));
  for (const node of nodes) {
    const card = element("article", null, "node-card");
    card.append(element("h3", node.name), element("code", node.id, "node-id"));
    card.append(element("p", `${node.vnetOnly ? "VNet 专用（无需浏览器证书）" : node.vnetAvailable ? "VNet 已配置" : "浏览器直连"} · ${node.workspaceAvailable ? "Workspace 已配置" : "Workspace 网关尚未配置"}`, "badges"));
    const form = element("form", null, "form-grid");
    form.append(field("名称", "name", node.name), field("HTTPS 地址", "endpoint", node.endpoint, "url"),
      field("区域", "region", node.region), field("颜色", "accent", node.accent, "color"));
    if (node.vnetOnly) form.querySelector('[name="endpoint"]').readOnly = true;
    const actions = element("div", null, "actions");
    const save = element("button", "保存设置");
    save.type = "submit";
    actions.append(save);
    if (!node.managedLegacy) {
      const credentials = element("button", "查看本节点接入资料");
      credentials.type = "button";
      credentials.addEventListener("click", () => operation(credentials, async () => {
        const result = await api(`/api/settings/nodes/${node.id}/enrollment`, "POST");
        enrollmentValue.textContent = JSON.stringify(result, null, 2);
        enrollment.hidden = false;
        enrollment.scrollIntoView({ block: "nearest" });
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
        enrollment.hidden = true;
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
      });
    });
    card.append(form);
    nodesRoot.append(card);
  }
}

async function renderUsers() {
  const { users } = await api("/api/admin/users");
  usersRoot.replaceChildren();
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
    ? `Linux x64 轻量包约 ${Math.ceil(setup.bytes / 1024 / 1024)} MB · 自动安装 Node ${setup.node} · CloudCLI ${setup.cloudcli} · copilot-api ${setup.copilotApi}。每次下载预留一个七天有效的身份，尚不加入节点列表。`
    : setup?.reason || "完整机器配置包尚未发布；旧版说明 ZIP 不能替代依赖包。";
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
      });
    });
    row.append(cancel);
    pendingMachinesRoot.append(row);
  }
  updateMachineSkillButtons();
  adminSection.hidden = result.user.role !== "admin";
  if (!adminSection.hidden) await renderUsers();
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
    notice("正在从门户验证 VNet、HTTPS、Usage/History、Workspace SSO 和 WebSocket…");
    const { node } = await api(`/api/settings/machines/${machine.nodeId}/activate`, "POST", machine);
    form.reset();
    await load();
    notice(`机器已验通并添加：${node.name}。现在可以使用 VNet 用量、History 和 Workspace。模型尚未登录时，请完成本人的 provider 授权。`);
  });
});

document.querySelector("#create-user-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  form.elements.password.value = "";
  void operation(form.querySelector("button"), async () => {
    const { user } = await api("/api/admin/users", "POST", data);
    form.reset();
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
  enrollment.hidden = true;
});

function revealAddNode() {
  if (window.location.hash !== "#add-node") return;
  const section = document.querySelector("#add-node");
  section.open = true;
  section.scrollIntoView({ block: "start" });
}

window.addEventListener("hashchange", revealAddNode);
// The existing node cards are asynchronous. Native fragment scrolling can run
// before they expand the page, leaving the requested form below the viewport.
void load().then(revealAddNode).catch((error) => notice(error.message, true));
