const adminTab = document.querySelector("#admin-tab");
const adminPanel = document.querySelector("#admin-section");
const panel = document.querySelector("#admin-nodes-panel");
const rows = document.querySelector("#admin-node-list");
const message = document.querySelector("#admin-node-message");
const refreshButton = document.querySelector("#admin-node-refresh");
const search = document.querySelector("#admin-node-search");
const ownerFilter = document.querySelector("#admin-node-owner");
const statusFilter = document.querySelector("#admin-node-status");
const previous = document.querySelector("#admin-node-prev");
const next = document.querySelector("#admin-node-next");
const PAGE_SIZE = 20;
const statusLabels = {
  online: "心跳在线", stale: "心跳超时", not_enrolled: "未接入升级器",
  unreported: "等待首次心跳", revoked: "升级器已停用", owner_disabled: "账号已停用",
  unavailable: "上报服务未配置", unknown: "状态未知",
};
let snapshot = null;
let page = 1;
let loading = false;
let denied = false;
let requestId = 0;

const permitted = () => !adminTab.hidden && !denied;
const visible = () => permitted() && !document.hidden && !adminPanel.hidden && !panel.hidden;
const statusGroup = (status) => ["online", "stale"].includes(status) ? status : "unknown";

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function date(value) {
  return Number.isFinite(value) && value > 0
    ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "时间未知";
}

function notice(text, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
}

function empty(text) {
  const row = element("tr");
  const cell = element("td", text, "inventory-empty");
  cell.setAttribute("colspan", "5");
  row.append(cell);
  rows.replaceChildren(row);
}

function clear() {
  requestId++;
  loading = false;
  snapshot = null;
  page = 1;
  rows.replaceChildren();
  for (const key of ["total", "owners", "online", "stale", "unknown"]) {
    document.querySelector(`#admin-node-${key}`).textContent = "—";
  }
  search.value = statusFilter.value = "";
  const all = element("option", "全部用户");
  all.value = "";
  ownerFilter.replaceChildren(all);
  ownerFilter.value = "";
  for (const control of [search, ownerFilter, statusFilter, previous, next]) control.disabled = true;
  document.querySelector("#admin-node-results").textContent = "";
  document.querySelector("#admin-node-page").textContent = "";
  panel.setAttribute("aria-busy", "false");
  refreshButton.disabled = !permitted();
}

function renderOwners() {
  const selected = ownerFilter.value;
  const owners = new Map(snapshot.nodes.map((node) => [node.owner.id, node.owner]));
  const all = element("option", "全部用户");
  all.value = "";
  ownerFilter.replaceChildren(all);
  for (const owner of [...owners.values()].sort((a, b) => (a.username || a.id).localeCompare(b.username || b.id))) {
    const suffix = !owner.username ? "（账号不可用）" : owner.enabled ? "" : "（已停用）";
    const option = element("option", `${owner.username || owner.id}${suffix}`);
    option.value = owner.id;
    ownerFilter.append(option);
  }
  ownerFilter.value = owners.has(selected) ? selected : "";
}

function versionCell(component, node) {
  const cell = element("td");
  if (!component) {
    cell.append(element("span", "未上报", "muted"));
    return cell;
  }
  cell.append(element("strong", component.version, "inventory-version"));
  const detail = [component.commit?.slice(0, 8), component.nodeMajor && `Node ${component.nodeMajor}`].filter(Boolean);
  cell.append(element("code", detail.join(" · ")));
  cell.title = [
    component.commit && `Commit: ${component.commit}`,
    node.releaseId && `节点发行版：${node.releaseId}`,
    `最近上报：${date(node.lastSeen)}`,
  ].filter(Boolean).join("\n");
  return cell;
}

function renderRow(node) {
  const row = element("tr");
  row.dataset.nodeId = node.id;
  const identity = element("td");
  identity.title = [node.name, node.id, node.region].filter(Boolean).join("\n");
  identity.append(element("strong", node.name, "inventory-ellipsis"), element("code", node.id, "inventory-ellipsis"));
  const owner = element("td");
  owner.append(element("strong", node.owner.username || node.owner.id));
  if (!node.owner.username) owner.append(element("span", "归属账号不可用", "muted"));
  else if (!node.owner.enabled) owner.append(element("span", "账号已停用", "muted"));
  const state = element("td");
  state.append(element("span", statusLabels[node.status] || statusLabels.unknown, `inventory-status ${statusGroup(node.status)}`));
  state.append(element("span", node.lastSeen ? date(node.lastSeen) : "尚无心跳记录", "muted"));
  row.append(identity, owner, state,
    versionCell(node.components.cloudcli, node), versionCell(node.components.copilotApi, node));
  return row;
}

function render() {
  if (!snapshot || !permitted()) return;
  for (const key of ["total", "owners", "online", "stale", "unknown"]) {
    document.querySelector(`#admin-node-${key}`).textContent = String(snapshot.summary[key]);
  }
  const query = search.value.trim().toLowerCase();
  const matches = snapshot.nodes.filter((node) => {
    if (ownerFilter.value && node.owner.id !== ownerFilter.value) return false;
    if (statusFilter.value && statusGroup(node.status) !== statusFilter.value) return false;
    const terms = [node.name, node.id, node.region, node.owner.username, node.releaseId,
      ...Object.values(node.components).flatMap((component) => [component?.version, component?.commit])];
    return !query || terms.filter(Boolean).join(" ").toLowerCase().includes(query);
  }).sort((a, b) => (a.owner.username || a.owner.id).localeCompare(b.owner.username || b.owner.id)
    || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  page = Math.min(page, pages);
  const start = (page - 1) * PAGE_SIZE;
  rows.replaceChildren(...matches.slice(start, start + PAGE_SIZE).map(renderRow));
  if (!matches.length) empty(snapshot.nodes.length ? "没有匹配的节点，请调整筛选。" : "还没有用户添加节点。");
  previous.disabled = page <= 1;
  next.disabled = page >= pages;
  document.querySelector("#admin-node-page").textContent = `${page} / ${pages}`;
  document.querySelector("#admin-node-results").textContent = matches.length
    ? `显示 ${start + 1}–${Math.min(start + PAGE_SIZE, matches.length)} / ${matches.length} 台`
    : "0 台匹配节点";
}

async function refresh() {
  if (!visible() || loading) return;
  const current = ++requestId;
  loading = true;
  refreshButton.disabled = true;
  panel.setAttribute("aria-busy", "true");
  notice(snapshot ? `正在刷新 · 上次快照 ${date(snapshot.generatedAt)}` : "正在读取全局节点…");
  try {
    const response = await fetch("/api/admin/nodes", { method: "GET", credentials: "same-origin", cache: "no-store" });
    if (current !== requestId || !permitted()) return;
    if (response.status === 401 || response.status === 403) {
      denied = true;
      clear();
      notice("节点总览权限已失效，请重新登录。", true);
      if (response.status === 401) window.location.replace("/portal-auth/login");
      return;
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (!Array.isArray(result.nodes) || !Number.isFinite(result.generatedAt) ||
        !["total", "owners", "online", "stale", "unknown"].every((key) => Number.isSafeInteger(result.summary?.[key]) && result.summary[key] >= 0) ||
        result.summary.total !== result.nodes.length) throw new Error("节点总览响应无效，请重试");
    if (current !== requestId || !permitted()) return;
    snapshot = result;
    renderOwners();
    render();
    for (const control of [search, ownerFilter, statusFilter]) control.disabled = false;
    notice(`快照 ${date(snapshot.generatedAt)} · ${snapshot.telemetryAvailable
      ? `心跳超时阈值 ${snapshot.heartbeatTimeoutMs / 1000} 秒 · 本页可见时每 30 秒刷新`
      : "门户尚未配置上报服务，节点状态与版本未知"}`);
  } catch (error) {
    if (current !== requestId || !permitted()) return;
    if (!snapshot) empty("无法读取节点总览，请点击刷新重试。");
    notice(`刷新失败：${error.message}${snapshot ? ` · 仍显示 ${date(snapshot.generatedAt)} 的旧快照` : ""}`, true);
  } finally {
    if (current === requestId) {
      loading = false;
      panel.setAttribute("aria-busy", "false");
      refreshButton.disabled = !permitted();
    }
  }
}

refreshButton.addEventListener("click", () => { void refresh(); });
for (const [control, event] of [[search, "input"], [ownerFilter, "change"], [statusFilter, "change"]]) {
  control.addEventListener(event, () => { page = 1; render(); });
}
previous.addEventListener("click", () => { page = Math.max(1, page - 1); render(); });
next.addEventListener("click", () => { page++; render(); });
for (const event of ["settings-panel-change", "admin-panel-change", "admin-users-change", "visibilitychange"]) {
  document.addEventListener(event, () => { void refresh(); });
}
document.addEventListener("settings-role-change", () => {
  if (adminTab.hidden) {
    clear();
    notice("仅管理员可以查看全局节点。");
  } else {
    denied = false;
    void refresh();
  }
});
window.setInterval(() => { void refresh(); }, 30_000);
void refresh();
