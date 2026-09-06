const message = document.querySelector("#settings-message");
const nodesRoot = document.querySelector("#my-nodes");
const usersRoot = document.querySelector("#users-list");
const adminSection = document.querySelector("#admin-section");
const enrollment = document.querySelector("#enrollment");
const enrollmentValue = document.querySelector("#enrollment-value");

function notice(text, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
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
    card.append(element("p", `${node.vnetAvailable ? "VNet 已配置" : "浏览器直连"} · ${node.workspaceAvailable ? "Workspace 已配置" : "Workspace 网关尚未配置"}`, "badges"));
    const form = element("form", null, "form-grid");
    form.append(field("名称", "name", node.name), field("HTTPS 地址", "endpoint", node.endpoint, "url"),
      field("区域", "region", node.region), field("颜色", "accent", node.accent, "color"));
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
  adminSection.hidden = result.user.role !== "admin";
  if (!adminSection.hidden) await renderUsers();
}

document.querySelector("#create-node-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void operation(form.querySelector("button"), async () => {
    const { node } = await api("/api/settings/nodes", "POST", Object.fromEntries(new FormData(form)));
    form.reset();
    notice(`节点已保存：${node.name}。请展开它的接入资料，在你自己的机器上配置。`);
    await load();
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
