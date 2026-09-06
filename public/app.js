import { collectClientOverview } from "./client-aggregator.js";
import {
  fetchClientHistoryDetail,
  fetchClientHistoryList,
} from "./client-history.js";
import { nodesForConnection, readConnectionMode, saveConnectionMode } from "./node-transport.js";

const PERIOD_LABELS = Object.freeze({
  day: "今日",
  week: "近 7 天",
  month: "近 30 天",
});

const QUOTA_LABELS = Object.freeze({
  chat: "Chat",
  completions: "Completions",
  premium_interactions: "Premium interactions",
});

const COMPONENT_LABELS = Object.freeze({
  "copilot-api": "Copilot API",
  "codex-cli": "Codex CLI",
});

const EFFORT_LABELS = Object.freeze({
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra",
});
const ARTIFACTS_PER_PAGE = 3;

const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const compactFormatter = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const elements = {
  confirmAccept: document.querySelector("#confirm-accept"),
  confirmDialog: document.querySelector("#confirm-dialog"),
  confirmMessage: document.querySelector("#confirm-message"),
  confirmTitle: document.querySelector("#confirm-title"),
  connectionLabel: document.querySelector("#connection-label"),
  connectionOptions: document.querySelectorAll("[data-node-connection-option]"),
  vnetToggles: document.querySelectorAll("[data-vnet-connection-toggle]"),
  cloudCliEmpty: document.querySelector("#cloudcli-empty"),
  cloudCliFrame: document.querySelector("#cloudcli-frame"),
  cloudCliNode: document.querySelector("#cloudcli-node"),
  cloudCliOpen: document.querySelector("#cloudcli-open"),
  cloudCliReload: document.querySelector("#cloudcli-reload"),
  dashboard: document.querySelector("#dashboard"),
  historyConnection: document.querySelector("#history-connection"),
  historyBatchToolbar: document.querySelector("#history-batch-toolbar"),
  historyClear: document.querySelector("#history-clear"),
  historyControls: document.querySelector("#history-controls"),
  historyCount: document.querySelector("#history-count"),
  historyDetail: document.querySelector("#history-detail"),
  historyList: document.querySelector("#history-list"),
  historyNext: document.querySelector("#history-next"),
  historyPageLabel: document.querySelector("#history-page-label"),
  historyPrevious: document.querySelector("#history-previous"),
  historyQuery: document.querySelector("#history-query"),
  historyRange: document.querySelector("#history-range"),
  historyRefresh: document.querySelector("#history-refresh"),
  historySearchHelp: document.querySelector("#history-search-help"),
  historySourceTabs: document.querySelector("#history-source-tabs"),
  historyState: document.querySelector("#history-state"),
  historyStatus: document.querySelector("#history-status"),
  lastUpdated: document.querySelector("#last-updated"),
  loadingState: document.querySelector("#loading-state"),
  localConnectButton: document.querySelector("#local-connect-button"),
  nodeFilters: document.querySelector("#node-filters"),
  periodSwitcher: document.querySelector("#period-switcher"),
  provisionCancel: document.querySelector("#provision-cancel"),
  provisionDialog: document.querySelector("#provision-dialog"),
  provisionError: document.querySelector("#provision-error"),
  provisionDescription: document.querySelector("#provision-description"),
  provisionForm: document.querySelector("#provision-form"),
  provisionNote: document.querySelector("#provision-note"),
  provisionSubmit: document.querySelector("#provision-submit"),
  bootstrapBundleDownload: document.querySelector(
    "#bootstrap-bundle-download",
  ),
  renameCancel: document.querySelector("#rename-cancel"),
  renameDialog: document.querySelector("#rename-dialog"),
  renameError: document.querySelector("#rename-error"),
  renameForm: document.querySelector("#rename-form"),
  renameMessage: document.querySelector("#rename-message"),
  refreshButton: document.querySelector("#refresh-button"),
  refreshCountdown: document.querySelector("#refresh-countdown"),
  statusRegion: document.querySelector("#status-region"),
  sessionHistoryView: document.querySelector("#session-history-view"),
  usageView: document.querySelector("#usage-view"),
  workspaceView: document.querySelector("#workspace-view"),
  workspaceConnection: document.querySelector("#workspace-connection"),
  workspaceStatus: document.querySelector("#workspace-status"),
};

const params = new URLSearchParams(window.location.search);
const requestedView = params.get("view");
let preferenceStorage;
try { preferenceStorage = window.localStorage; } catch { /* Direct is the default without storage. */ }
const state = {
  activeView: ["sessions", "workspace"].includes(requestedView)
    ? requestedView
    : "usage",
  clientConfig: null,
  clientTicketExpiresAt: 0,
  // Routing is an explicit, browser-local preference. Never auto-fallback.
  connectionMode: readConnectionMode(preferenceStorage),
  cloudCli: {
    loading: false,
    nodes: null,
    selectedId: params.get("workspace_node") || "",
  },
  data: null,
  directMode: false,
  eventLimit: 20,
  isLoading: false,
  overviewRequestId: 0,
  management: null,
  managementError: "",
  managementExpanded: window.location.hash === "#management-section",
  managementLoading: false,
  nextRefreshAt: 0,
  nodes: [],
  period: Object.hasOwn(PERIOD_LABELS, params.get("period")) ? params.get("period") : "week",
  provisioning: false,
  refreshSeconds: 60,
  selectedNodes: new Set(),
  deployingArtifact: "",
  artifactPage: Math.max(
    0,
    Number.parseInt(params.get("build_page") || "1", 10) - 1 || 0,
  ),
  starting: new Set(),
  history: {
    canManage: false,
    detail: null,
    detailLoading: false,
    detailRequestId: 0,
    error: "",
    filter: "all",
    items: null,
    limit: 30,
    listRequestId: 0,
    loading: false,
    offset: 0,
    operation: false,
    query: "",
    range: ["all", "day", "week", "month"].includes(
      params.get("history_range"),
    )
      ? params.get("history_range")
      : "all",
    renameTarget: null,
    selectedKey: "",
    selectedItems: new Map(),
    source: "all",
    sourceCounts: {},
    sourceErrors: [],
    searchMode: "browse",
    sources: [
      {
        id: "all",
        name: "All sources",
        type: "aggregate",
        states: ["all"],
      },
      {
        id: "shared",
        name: "Shared",
        type: "shared",
        states: ["active", "trash", "all"],
      },
    ],
    total: 0,
  },
  operationNotice: null,
  updating: new Set(),
};

function connectionModeSuffix() {
  if (state.activeView === "workspace") return " · ACA → VNet";
  return state.directMode
    ? state.connectionMode === "vnet" ? " · ACA → VNet" : " · 浏览器直连"
    : " · ACA";
}

function connectionNodes() {
  return state.directMode ? nodesForConnection(state.nodes, state.connectionMode) : state.nodes;
}

function renderConnectionOptions() {
  const available = state.directMode && state.clientConfig?.connectionModes?.includes("vnet");
  for (const option of elements.connectionOptions) {
    option.hidden = !available;
    option.classList.toggle("is-active", state.connectionMode === "vnet");
  }
  for (const toggle of elements.vnetToggles) {
    toggle.checked = state.connectionMode === "vnet";
  }
}

function setConnectionLabel(value) {
  elements.connectionLabel.textContent = `${value}${connectionModeSuffix()}`;
}

async function refreshClientNodes(force = false) {
  if (
    !force &&
    state.clientConfig &&
    state.clientTicketExpiresAt > Date.now() + 10000
  ) {
    return state.clientConfig;
  }
  const config = await fetchJson("/api/client-nodes");
  state.clientConfig = config;
  state.directMode = Boolean(config.directMode);
  if (!config.connectionModes?.includes("vnet")) state.connectionMode = "direct";
  state.nodes = config.nodes ?? [];
  state.refreshSeconds = config.refreshSeconds ?? 60;
  state.clientTicketExpiresAt = state.nodes.length
    ? Math.min(...state.nodes.map((node) => Number(node.ticketExpiresAt || 0)))
    : Date.now() + 30000;
  document.documentElement.dataset.connectionMode = state.directMode
    ? state.connectionMode
    : "cloud";
  renderConnectionOptions();
  return config;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatExact(value) {
  return numberFormatter.format(finiteNumber(value));
}

function formatCompact(value) {
  const number = finiteNumber(value);
  return Math.abs(number) < 1000 ? formatExact(number) : compactFormatter.format(number);
}

function formatPercent(value) {
  return `${finiteNumber(value).toFixed(1).replace(/\.0$/, "")}%`;
}

function formatCurrency(amount, currency = "USD") {
  const value = finiteNumber(amount);
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency,
      maximumFractionDigits: value < 1 ? 4 : 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function formatCosts(costs) {
  if (!Array.isArray(costs) || costs.length === 0) return "—";
  return costs.map((cost) => formatCurrency(cost.amount, cost.currency)).join(" + ");
}

function formatBytes(value) {
  const bytes = finiteNumber(value);
  if (bytes < 1024) return `${formatExact(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = "B";
  for (const candidate of units) {
    amount /= 1024;
    unit = candidate;
    if (amount < 1024) break;
  }
  return `${amount.toFixed(amount < 10 ? 2 : 1)} ${unit}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : dateTimeFormatter.format(date);
}

function formatEffort(value) {
  return EFFORT_LABELS[value] || "未知";
}

function requestConfirmation({ title, message, confirmLabel = "确认" }) {
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmAccept.textContent = confirmLabel;
  elements.confirmDialog.returnValue = "";
  return new Promise((resolve) => {
    elements.confirmDialog.addEventListener(
      "close",
      () => resolve(elements.confirmDialog.returnValue === "confirm"),
      { once: true },
    );
    elements.confirmDialog.showModal();
  });
}

function updateUrl() {
  const next = new URL(window.location.href);
  next.searchParams.set("view", state.activeView);
  next.searchParams.set("history_range", state.history.range);
  next.searchParams.set("period", state.period);
  next.searchParams.set("nodes", [...state.selectedNodes].join(","));
  if (state.cloudCli.selectedId) {
    next.searchParams.set("workspace_node", state.cloudCli.selectedId);
  } else {
    next.searchParams.delete("workspace_node");
  }
  if (state.artifactPage > 0) {
    next.searchParams.set("build_page", String(state.artifactPage + 1));
  } else {
    next.searchParams.delete("build_page");
  }
  window.history.replaceState({}, "", next);
}

function renderActiveView() {
  elements.usageView.hidden = state.activeView !== "usage";
  elements.sessionHistoryView.hidden = state.activeView !== "sessions";
  elements.workspaceView.hidden = state.activeView !== "workspace";
  for (const button of document.querySelectorAll("[data-portal-view]")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.portalView === state.activeView),
    );
  }
  if (state.activeView === "workspace") {
    setConnectionLabel("CloudCLI");
    loadCloudCliNodes();
  } else if (state.activeView === "sessions") {
    setConnectionLabel(
      state.history.loading
        ? "正在读取共享会话"
        : `${state.history.total} 个共享会话`,
    );
  } else if (state.data) {
    const responding = state.data.status.online + state.data.status.partial;
    setConnectionLabel(`${responding}/${state.data.nodes.length} 节点有响应`);
  }
}

function selectedCloudCliNode() {
  return state.cloudCli.nodes?.find(
    (node) => node.id === state.cloudCli.selectedId,
  );
}

function renderCloudCliNode() {
  const node = selectedCloudCliNode();
  elements.cloudCliNode.innerHTML = "";
  for (const item of state.cloudCli.nodes ?? []) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.name} · ${item.region}`;
    option.selected = item.id === state.cloudCli.selectedId;
    elements.cloudCliNode.append(option);
  }
  elements.cloudCliNode.disabled = !node;
  elements.cloudCliReload.disabled = !node;
  elements.cloudCliOpen.href = node?.path || "#";
  elements.cloudCliOpen.setAttribute("aria-disabled", String(!node));
  if (!node) {
    elements.cloudCliFrame.hidden = true;
    elements.cloudCliEmpty.hidden = false;
    elements.cloudCliEmpty.textContent = "当前账号没有可用的 CloudCLI 节点。";
    elements.workspaceConnection.textContent = "无可用节点";
  }
}

function openCloudCliNode({ reload = false } = {}) {
  const node = selectedCloudCliNode();
  if (!node) return;
  const target = new URL(node.path, window.location.origin).href;
  if (reload || elements.cloudCliFrame.src !== target) {
    elements.cloudCliFrame.src = reload
      ? `${target}${target.includes("?") ? "&" : "?"}_=${Date.now()}`
      : target;
  }
  elements.cloudCliFrame.hidden = false;
  elements.cloudCliEmpty.hidden = true;
  elements.workspaceConnection.textContent = `${node.name} · 正在连接`;
}

async function loadCloudCliNodes(force = false) {
  if (state.cloudCli.loading || (!force && state.cloudCli.nodes)) return;
  state.cloudCli.loading = true;
  elements.workspaceStatus.innerHTML =
    '<div class="notice">正在通过 Codey 读取 CloudCLI 节点…</div>';
  try {
    const data = await fetchJson("/api/cloudcli/nodes");
    state.cloudCli.nodes = Array.isArray(data.nodes) ? data.nodes : [];
    if (
      !state.cloudCli.selectedId ||
      !state.cloudCli.nodes.some((node) => node.id === state.cloudCli.selectedId)
    ) {
      state.cloudCli.selectedId = state.cloudCli.nodes[0]?.id || "";
    }
    renderCloudCliNode();
    updateUrl();
    elements.workspaceStatus.innerHTML = "";
    openCloudCliNode();
  } catch (error) {
    state.cloudCli.nodes = [];
    renderCloudCliNode();
    elements.workspaceStatus.innerHTML = `<div class="notice notice-error">CloudCLI 节点读取失败：${escapeHtml(error.message)}</div>`;
  } finally {
    state.cloudCli.loading = false;
  }
}

function nodeColorClass(nodeId) {
  const index = Math.max(0, state.nodes.findIndex((node) => node.id === nodeId));
  return `node-color-${index % 8}`;
}

function setLoading(isLoading) {
  state.isLoading = isLoading;
  elements.refreshButton.disabled = isLoading;
  elements.refreshButton.classList.toggle("is-loading", isLoading);
  elements.refreshButton.querySelector("span").textContent = isLoading ? "刷新中" : "刷新";
  if (!state.data) {
    elements.loadingState.hidden = !isLoading;
    elements.dashboard.hidden = true;
  }
}

function renderControls() {
  for (const button of elements.periodSwitcher.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.period === state.period));
  }

  elements.nodeFilters.innerHTML = connectionNodes()
    .map(
      (node) => `
        <button
          type="button"
          class="node-filter ${nodeColorClass(node.id)}"
          data-node-id="${escapeHtml(node.id)}"
          aria-pressed="${state.selectedNodes.has(node.id)}"
          title="${escapeHtml(node.endpoint)}"
        >
          <span class="node-dot" aria-hidden="true"></span>
          <span>${escapeHtml(node.name)}</span>
        </button>
      `,
    )
    .join("");

  for (const button of elements.nodeFilters.querySelectorAll("button")) {
    button.addEventListener("click", () => {
      const nodeId = button.dataset.nodeId;
      if (state.selectedNodes.has(nodeId)) {
        if (state.selectedNodes.size === 1) {
          elements.statusRegion.innerHTML = '<div class="notice">至少保留一个节点。</div>';
          return;
        }
        state.selectedNodes.delete(nodeId);
      } else {
        state.selectedNodes.add(nodeId);
      }
      state.eventLimit = 20;
      updateUrl();
      renderControls();
      fetchOverview(false);
    });
  }
}

function renderMetricCard(label, value, note) {
  return `
    <article class="kpi-card">
      <span class="kpi-label">${escapeHtml(label)}</span>
      <strong class="kpi-value" title="${escapeHtml(note)}">${escapeHtml(value)}</strong>
      <span class="kpi-note">${escapeHtml(note)}</span>
    </article>
  `;
}

function renderKpis(data) {
  const totals = data.aggregate.totals;
  const cacheShare = totals.total_tokens
    ? (totals.cache_read_input_tokens / totals.total_tokens) * 100
    : 0;
  const responding = data.status.online + data.status.partial;
  return `
    <section class="kpi-grid" aria-label="汇总指标">
      ${renderMetricCard("Token 总量", formatCompact(totals.total_tokens), `${formatExact(totals.total_tokens)} tokens`)}
      ${renderMetricCard("请求数", formatCompact(totals.request_count), `${formatExact(totals.request_count)} 次请求`)}
      ${renderMetricCard("估算成本", formatCosts(totals.costs), "由 copilot-api AIU 记录估算")}
      ${renderMetricCard("缓存读取占比", formatPercent(cacheShare), `${formatExact(totals.cache_read_input_tokens)} cache-read tokens`)}
      ${renderMetricCard("可响应节点", `${responding} / ${data.nodes.length}`, `${data.status.online} 正常 · ${data.status.partial} 部分可用`)}
    </section>
  `;
}

function renderTrendChart(days) {
  if (!Array.isArray(days) || days.length === 0) {
    return '<div class="empty-state">所选范围内还没有 token 记录。</div>';
  }

  const width = 900;
  const height = 260;
  const padding = { top: 18, right: 20, bottom: 38, left: 64 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maximum = Math.max(...days.map((day) => finiteNumber(day.totals?.total_tokens)), 1);
  const slotWidth = plotWidth / days.length;
  const barWidth = clamp(slotWidth * 0.58, 7, 42);
  const labelEvery = Math.max(1, Math.ceil(days.length / 8));

  const ticks = [maximum, maximum / 2, 0]
    .map((value, index) => {
      const y = padding.top + (plotHeight / 2) * index;
      return `
        <line class="chart-grid-line" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" />
        <text class="chart-axis-label" x="${padding.left - 10}" y="${y + 3}" text-anchor="end">${escapeHtml(formatCompact(value))}</text>
      `;
    })
    .join("");

  const bars = days
    .map((day, index) => {
      const value = finiteNumber(day.totals?.total_tokens);
      const renderedHeight = Math.max(2, (value / maximum) * plotHeight);
      const x = padding.left + index * slotWidth + (slotWidth - barWidth) / 2;
      const y = padding.top + plotHeight - renderedHeight;
      const showLabel = index % labelEvery === 0 || index === days.length - 1;
      return `
        <rect class="chart-bar" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${renderedHeight.toFixed(2)}" rx="${Math.min(5, barWidth / 3).toFixed(2)}">
          <title>${escapeHtml(day.date)} · ${escapeHtml(formatExact(value))} tokens · ${escapeHtml(formatExact(day.totals?.request_count))} requests</title>
        </rect>
        ${showLabel ? `<text class="chart-axis-label" x="${(x + barWidth / 2).toFixed(2)}" y="${height - 13}" text-anchor="middle">${escapeHtml(day.date.slice(5))}</text>` : ""}
      `;
    })
    .join("");

  return `
    <div class="chart-wrap">
      <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="每日 token 用量柱状图">
        <defs>
          <linearGradient id="bar-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#22d3ee" />
            <stop offset="1" stop-color="#8b5cf6" />
          </linearGradient>
        </defs>
        ${ticks}
        ${bars}
      </svg>
    </div>
  `;
}

function renderQuota(quota) {
  const label = QUOTA_LABELS[quota.id] || quota.id;
  const usedPercent = quota.unlimited ? 0 : clamp(100 - quota.percentRemaining, 0, 100);
  let value = quota.unlimited ? "无限" : `${formatPercent(quota.percentRemaining)} 剩余`;
  if (!quota.unlimited && quota.entitlement > 0) {
    value = `${formatCompact(quota.remaining)} / ${formatCompact(quota.entitlement)}`;
  }
  return `
    <div class="quota-item">
      <div class="quota-line">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
      <progress value="${usedPercent}" max="100" aria-label="${escapeHtml(label)} 已用 ${escapeHtml(formatPercent(usedPercent))}"></progress>
    </div>
  `;
}

function renderAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return '<div class="empty-state">未取得账号配额信息。</div>';
  }
  return accounts
    .map(
      (account) => `
        <article class="account-card">
          <div class="account-header">
            <div>
              <div class="account-login">${escapeHtml(account.login)}</div>
              <div class="account-plan">${escapeHtml(account.plan)} · ${account.nodeIds.length} 个节点</div>
            </div>
            <span class="consistency ${account.consistent ? "" : "warning"}">
              ${account.consistent ? "节点数据一致" : "节点快照不同"}
            </span>
          </div>
          ${account.quotas.length ? account.quotas.map(renderQuota).join("") : '<div class="empty-state">无配额快照</div>'}
          ${account.quotaResetAt ? `<p class="quota-reset">重置：${escapeHtml(formatDateTime(account.quotaResetAt))}</p>` : ""}
        </article>
      `,
    )
    .join("");
}

function renderOverviewPanels(data) {
  return `
    <div class="content-grid">
      <section class="section">
        <div class="section-inner">
          <div class="section-header">
            <div>
              <h2 class="section-heading">每日趋势</h2>
              <p class="section-subtitle">${escapeHtml(PERIOD_LABELS[data.period])} · 所选节点 token 总量</p>
            </div>
            <span class="section-badge">${data.aggregate.days.length} 个数据点</span>
          </div>
          ${renderTrendChart(data.aggregate.days)}
        </div>
      </section>

      <section class="section">
        <div class="section-inner">
          <div class="section-header">
            <div>
              <h2 class="section-heading">账号配额</h2>
              <p class="section-subtitle">账号级配额仅展示一次，不跨机器累加</p>
            </div>
          </div>
          ${renderAccounts(data.accounts)}
        </div>
      </section>
    </div>
  `;
}

function statusLabel(status) {
  return { online: "正常", partial: "部分可用", offline: "离线" }[status] || status;
}

function groupedNodeErrors(errors) {
  const grouped = new Map();
  for (const error of errors ?? []) {
    const message = String(error?.message ?? "未知错误").trim() || "未知错误";
    const scope = String(error?.scope ?? "").trim();
    const current = grouped.get(message) ?? {
      message,
      scopes: new Set(),
      count: 0,
    };
    current.count += 1;
    if (scope) current.scopes.add(scope);
    grouped.set(message, current);
  }
  return [...grouped.values()].map((value) => ({
    message: value.message,
    scopes: [...value.scopes],
    count: value.count,
  }));
}

function nodeErrorLabel(error, includeScopes = false) {
  const count = error.count > 1 ? `（${error.count} 个接口）` : "";
  const scopes =
    includeScopes && error.scopes.length
      ? `${error.scopes.join("、")} · `
      : "";
  return `${scopes}${error.message}${count}`;
}

function renderNodeCard(node, aggregateTotal) {
  const share = aggregateTotal > 0 ? (node.totals.total_tokens / aggregateTotal) * 100 : 0;
  const groupedErrors = groupedNodeErrors(node.errors);
  const errorMarkup = groupedErrors.length
    ? `<div class="error-list">${groupedErrors
        .map(
          (error) =>
            `<span class="error-chip">${escapeHtml(nodeErrorLabel(error, true))}</span>`,
        )
        .join("")}</div>`
    : "";
  const managedNode = state.management?.nodes?.find(
    (item) => item.id === node.id,
  );
  const canStart = Boolean(managedNode?.copilotApi?.canStart);
  const serviceActive = managedNode?.copilotApi?.service === "active";
  const starting =
    state.starting.has(node.id) || Boolean(state.deployingArtifact);
  const startMarkup = canStart
    ? `
      <button
        type="button"
        class="node-start-button"
        data-start-copilot-node="${escapeHtml(node.id)}"
        ${serviceActive || starting ? "disabled" : ""}
      >${
        starting
          ? "启动中…"
          : serviceActive
            ? "Copilot API 运行中"
            : "启动 Copilot API"
      }</button>
    `
    : "";
  return `
    <article class="node-card ${nodeColorClass(node.id)}">
      <div class="node-card-header">
        <div>
          <div class="node-name">${escapeHtml(node.name)}</div>
          <span class="node-region">${escapeHtml(node.region)}</span>
          <span class="node-endpoint">${escapeHtml(node.endpoint)}</span>
        </div>
        <span class="status-pill ${escapeHtml(node.status)}">${escapeHtml(node.id === "local" && node.status === "offline" ? "未连接" : statusLabel(node.status))}</span>
      </div>
      <strong class="node-token-value">${node.tokenUsageAvailable ? escapeHtml(formatCompact(node.totals.total_tokens)) : "—"}</strong>
      <span class="node-token-label">tokens · ${escapeHtml(PERIOD_LABELS[state.period])}</span>
      <div class="node-share">
        <div class="node-share-label"><span>占所选节点</span><span>${escapeHtml(formatPercent(share))}</span></div>
        <progress value="${clamp(share, 0, 100)}" max="100" aria-label="${escapeHtml(node.name)} 用量占比"></progress>
      </div>
      <div class="node-stat-row">
        <div class="node-stat"><span>请求</span><strong>${escapeHtml(formatCompact(node.totals.request_count))}</strong></div>
        <div class="node-stat"><span>成本</span><strong>${escapeHtml(formatCosts(node.totals.costs))}</strong></div>
        <div class="node-stat"><span>响应</span><strong>${escapeHtml(`${node.latencyMs} ms`)}</strong></div>
      </div>
      ${errorMarkup}
      ${startMarkup}
    </article>
  `;
}

function renderNodes(data) {
  return `
    <section class="section">
      <div class="section-inner">
        <div class="section-header">
          <div>
            <h2 class="section-heading">节点分布</h2>
            <p class="section-subtitle">每个 copilot-api 实例独立记录本机经过的请求</p>
          </div>
          <div class="section-actions node-onboarding-actions">
            <span class="section-badge">${data.nodes.length} 个已选节点</span>
            <button
              type="button"
              class="secondary-button"
              data-open-provision
              ${state.provisioning ? "disabled" : ""}
            >${state.provisioning ? "部署中…" : "添加机器"}</button>
            <a class="node-skill-download" href="/downloads/codey-node-onboarding.zip" download="codey-node-onboarding.zip" title="节点注册、HTTPS、VNet 和 Workspace 的配置与验收步骤">↓ 下载接入 Skill</a>
          </div>
        </div>
        <div class="node-grid">
          ${data.nodes.map((node) => renderNodeCard(node, data.aggregate.totals.total_tokens)).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderVersion(value) {
  return value ? `v${value}` : "未检测到";
}

function availableArtifacts() {
  return Array.isArray(state.management?.artifacts) ? state.management.artifacts : [];
}

function artifactLabel(artifact) {
  if (!artifact) return "没有可用构建";
  return `v${artifact.version} · ${artifact.buildDate} · ${artifact.label}`;
}

function renderArtifactCatalog() {
  const artifacts = availableArtifacts();
  if (!artifacts.length) {
    return '<div class="empty-state fleet-artifact-empty">没有通过校验的 Copilot API 构建。</div>';
  }
  const nodes = (state.management?.nodes ?? []).filter(
    (node) => node.copilotApi?.canDeploy,
  );
  const anyDeploying = Boolean(state.deployingArtifact);
  const pageCount = Math.max(
    1,
    Math.ceil(artifacts.length / ARTIFACTS_PER_PAGE),
  );
  state.artifactPage = clamp(state.artifactPage, 0, pageCount - 1);
  const pageStart = state.artifactPage * ARTIFACTS_PER_PAGE;
  const pageEnd = Math.min(pageStart + ARTIFACTS_PER_PAGE, artifacts.length);
  const visibleArtifacts = artifacts.slice(pageStart, pageEnd);
  return `
    <section class="fleet-artifact-panel">
      <div class="fleet-artifact-heading">
        <div>
          <h3>Copilot API builds</h3>
          <p>选择一个经过校验的构建，一次部署到全部 ${formatExact(nodes.length)} 个节点。</p>
        </div>
        <div class="fleet-artifact-summary">
          <span class="section-badge">${formatExact(artifacts.length)} versions</span>
          <span>${formatExact(pageStart + 1)}–${formatExact(pageEnd)} of ${formatExact(artifacts.length)}</span>
        </div>
      </div>
      <div class="fleet-artifact-list">
        ${visibleArtifacts
          .map((artifact, index) => {
            const deployedNodes = nodes.filter(
              (node) =>
                node.copilotApi?.currentBuildId === artifact.id &&
                node.copilotApi?.service === "active",
            );
            const allCurrent =
              nodes.length > 0 && deployedNodes.length === nodes.length;
            const deploying = state.deployingArtifact === artifact.id;
            return `
              <article class="fleet-artifact-card ${pageStart + index === 0 ? "recommended" : ""}">
                <div class="fleet-artifact-card-main">
                  <div>
                    <span class="fleet-artifact-version">${escapeHtml(renderVersion(artifact.version))}</span>
                    <strong>${escapeHtml(artifact.label)}</strong>
                    <small>${escapeHtml(artifact.buildDate)} · ${escapeHtml(formatBytes(artifact.sizeBytes))}</small>
                    <code>${escapeHtml(artifact.id)}</code>
                  </div>
                  <div class="fleet-artifact-actions">
                    <span class="managed-badge ${allCurrent ? "success" : ""}">
                      ${formatExact(deployedNodes.length)}/${formatExact(nodes.length)} active
                    </span>
                    <button
                      type="button"
                      class="update-button"
                      data-deploy-artifact-all="${escapeHtml(artifact.id)}"
                      ${anyDeploying || allCurrent || !nodes.length ? "disabled" : ""}
                    >${
                      deploying
                        ? "部署中…"
                        : allCurrent
                          ? "全部节点已部署"
                          : "部署到全部节点"
                    }</button>
                  </div>
                </div>
                <details class="artifact-changelog" ${pageStart + index === 0 ? "open" : ""}>
                  <summary>查看 ${escapeHtml(artifactLabel(artifact))} 变更日志</summary>
                  <pre>${escapeHtml(artifact.changelog || "没有变更日志。")}</pre>
                </details>
              </article>
            `;
          })
          .join("")}
      </div>
      <nav class="fleet-artifact-pagination" aria-label="Copilot API build pages">
        <button
          type="button"
          class="secondary-button"
          data-artifact-page="previous"
          ${state.artifactPage === 0 ? "disabled" : ""}
        >上一页</button>
        <span>第 ${formatExact(state.artifactPage + 1)} / ${formatExact(pageCount)} 页</span>
        <button
          type="button"
          class="secondary-button"
          data-artifact-page="next"
          ${state.artifactPage + 1 >= pageCount ? "disabled" : ""}
        >下一页</button>
      </nav>
    </section>
  `;
}

function renderManagedComponent(node, componentKey, component) {
  const label = COMPONENT_LABELS[componentKey];
  const updateKey = `${node.id}:${componentKey}`;
  const updating = state.updating.has(updateKey);
  const starting = componentKey === "copilot-api" && state.starting.has(node.id);
  const busy =
    updating ||
    starting ||
    (componentKey === "copilot-api" && Boolean(state.deployingArtifact));
  const latestText = component.latestVersion
    ? `最新 ${renderVersion(component.latestVersion)}${component.latestBuildId ? ` · ${component.latestBuildId}` : ""}`
    : component.mode === "desktop-managed"
      ? "桌面应用托管"
      : "最新版本未知";
  const currentBuildText = component.currentBuildId
    ? ` · 当前构建 ${component.currentBuildId}`
    : "";
  let actionMarkup;
  if (componentKey === "copilot-api") {
    actionMarkup = `
      <span class="managed-badge ${
        component.service === "active" ? "success" : "warning"
      }">${component.service === "active" ? "运行中" : "未运行"}</span>
    `;
  } else if (!component.canUpdate) {
    actionMarkup = '<span class="managed-badge">系统托管</span>';
  } else {
    const buttonText = updating
      ? "更新中…"
      : component.updateAvailable
        ? `更新到 ${renderVersion(component.latestVersion)}`
        : "检查并更新";
    actionMarkup = `
      <button
        type="button"
        class="update-button"
        data-update-node="${escapeHtml(node.id)}"
        data-update-component="${escapeHtml(componentKey)}"
        ${busy ? "disabled" : ""}
      >${escapeHtml(buttonText)}</button>
    `;
  }
  return `
    <div class="managed-component">
      <div class="managed-component-main">
        <div class="managed-component-copy">
          <span class="managed-component-name">${escapeHtml(label)}</span>
          <strong>${escapeHtml(renderVersion(component.currentVersion))}</strong>
          <small>${escapeHtml(latestText)}${escapeHtml(currentBuildText)}${component.note ? ` · ${escapeHtml(component.note)}` : ""}</small>
        </div>
        ${actionMarkup}
      </div>
    </div>
  `;
}

function renderManagement() {
  let body;
  if (state.managementLoading && !state.management) {
    body = '<div class="empty-state management-empty">正在读取各机器版本…</div>';
  } else if (state.managementError && !state.management) {
    body = `<div class="empty-state management-empty">版本状态读取失败：${escapeHtml(state.managementError)}</div>`;
  } else {
    const nodes = state.management?.nodes ?? [];
    body = nodes.length
      ? `<div class="management-grid">${nodes.map((node) => `
          <article class="management-card ${nodeColorClass(node.id)}">
            <div class="management-card-header">
              <div>
                <h3>${escapeHtml(node.name)}</h3>
                <span>${escapeHtml(node.region)}</span>
              </div>
              <span class="status-pill ${node.reachable ? "online" : "offline"}">${node.reachable ? "管理通道正常" : "管理通道不可用"}</span>
            </div>
            ${node.error ? `<div class="management-error">${escapeHtml(node.error)}</div>` : ""}
            ${renderManagedComponent(node, "copilot-api", node.copilotApi)}
            ${renderManagedComponent(node, "codex-cli", node.codexCli)}
          </article>
        `).join("")}</div>`
      : '<div class="empty-state management-empty">没有可管理的节点。</div>';
  }

  return `
    <section id="management-section" class="section management-section">
      <details class="management-disclosure" ${state.managementExpanded ? "open" : ""}>
        <summary class="management-summary">
          <div>
            <h2 class="section-heading">版本与更新</h2>
            <p class="section-subtitle">Copilot API 构建集中管理并一次部署到全部节点；Codex CLI 仍按节点独立更新</p>
          </div>
          <div class="management-summary-meta">
            ${state.management?.checkedAt ? `<span class="section-badge">检查于 ${escapeHtml(formatDateTime(state.management.checkedAt))}</span>` : ""}
            <span class="management-chevron" aria-hidden="true"></span>
          </div>
        </summary>
        <div class="section-inner management-section-body">
          ${(state.management?.artifactErrors ?? []).length ? `
            <div class="management-error">
              ${state.management.artifactErrors
                .map((error) => `${escapeHtml(error.fileName)}：${escapeHtml(error.message)}`)
                .join("<br />")}
            </div>
          ` : ""}
          ${renderArtifactCatalog()}
          ${body}
        </div>
      </details>
    </section>
  `;
}

function renderModels(data) {
  const models = data.aggregate.byModel;
  if (!models.length) {
    return `
      <section class="section table-section">
        <div class="section-header"><div><h2 class="section-heading">模型用量</h2></div></div>
        <div class="empty-state">所选范围内没有模型记录。</div>
      </section>
    `;
  }
  const total = data.aggregate.totals.total_tokens || 1;
  const rows = models
    .map((model) => {
      const share = (model.total_tokens / total) * 100;
      return `
        <tr>
          <td class="model-cell" title="${escapeHtml(model.model)}">${escapeHtml(model.model)}</td>
          <td class="share-cell"><progress value="${clamp(share, 0, 100)}" max="100"></progress>${escapeHtml(formatPercent(share))}</td>
          <td>${escapeHtml(formatExact(model.request_count))}</td>
          <td>${escapeHtml(formatCompact(model.total_tokens))}</td>
          <td>${escapeHtml(formatCompact(model.cache_read_input_tokens))}</td>
          <td>${escapeHtml(formatCompact(model.output_tokens))}</td>
          <td>${escapeHtml(formatCosts(model.costs))}</td>
        </tr>
      `;
    })
    .join("");
  return `
    <section class="section table-section">
      <div class="section-header">
        <div>
          <h2 class="section-heading">模型用量</h2>
          <p class="section-subtitle">跨节点合并相同模型</p>
        </div>
        <span class="section-badge">${models.length} 个模型</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>模型</th><th>占比</th><th>请求</th><th>总 Token</th><th>缓存读取</th><th>输出</th><th>成本</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderEvents(data) {
  const events = data.aggregate.recentEvents;
  const visible = events.slice(0, state.eventLimit);
  const rows = visible
    .map((event) => {
      const cost = event.cost?.currency
        ? formatCurrency(event.cost.amount, event.cost.currency)
        : "—";
      return `
        <tr>
          <td>${escapeHtml(formatDateTime(event.created_at_ms))}</td>
          <td><span class="event-node ${nodeColorClass(event.nodeId)}"><span class="event-node-dot"></span>${escapeHtml(event.nodeName)}</span></td>
          <td class="model-cell" title="${escapeHtml(event.model)}">${escapeHtml(event.model)}</td>
          <td><span class="effort-pill effort-${escapeHtml(event.reasoningEffort || "unknown")}" title="${escapeHtml(event.effortSource === "copilot-api" ? "由 copilot-api 用量事件直接记录" : event.effortSource === "codex-session" ? "从对应 Codex session 的 turn_context 按时间匹配" : "没有可用的 reasoning effort")}">${escapeHtml(formatEffort(event.reasoningEffort))}</span></td>
          <td><span>${escapeHtml(event.endpoint || "—")}</span><br /><span class="event-detail">${escapeHtml(event.source || "")}</span></td>
          <td>${escapeHtml(formatExact(event.total_tokens))}</td>
          <td>${escapeHtml(formatCompact(event.cache_read_input_tokens))}</td>
          <td>${escapeHtml(formatExact(event.output_tokens))}</td>
          <td>${escapeHtml(cost)}</td>
        </tr>
      `;
    })
    .join("");
  return `
    <section class="section table-section">
      <div class="section-header">
        <div>
          <h2 class="section-heading">最近请求</h2>
          <p class="section-subtitle">各节点最新事件按时间合并；推理强度优先由 copilot-api 直接记录，旧事件回退匹配 Codex session</p>
        </div>
        <span class="section-badge">${events.length} 条已聚合</span>
      </div>
      ${events.length ? `
        <div class="table-scroll">
          <table>
            <thead><tr><th>时间</th><th>节点</th><th>模型</th><th>推理强度</th><th>接口</th><th>总 Token</th><th>缓存读取</th><th>输出</th><th>成本</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${state.eventLimit < events.length ? '<button type="button" class="load-more" id="load-more-events">显示更多</button>' : ""}
      ` : '<div class="empty-state">所选范围内还没有请求事件。</div>'}
    </section>
  `;
}

function renderStatus(data) {
  const affected = data.nodes.filter((node) => node.status !== "online");
  const notices = [];
  const localNode = data.nodes.find((node) => node.id === "local");
  const localUnavailable =
    state.directMode && state.connectionMode !== "vnet" && localNode && localNode.status !== "online";
  elements.localConnectButton.hidden = !localUnavailable;
  elements.localConnectButton.disabled = false;
  elements.localConnectButton.textContent = "重试本机节点";
  if (localUnavailable) {
    notices.push(
      '<div class="notice">“本机”是当前打开浏览器的电脑，不是其他电脑。需在这台电脑运行 copilot-api HTTPS :8443、信任证书并允许 Local network access。“重试”不会安装或启动服务。非 corpnet 访问远程节点，请勾选刷新按钮旁的 VNet。</div>',
    );
  }
  if (state.operationNotice) {
    notices.push(
      `<div class="notice ${state.operationNotice.error ? "notice-error" : "notice-success"}">${escapeHtml(state.operationNotice.message)}</div>`,
    );
  }
  if (affected.length > 0) {
    const summary = affected
      .map((node) => {
        const errors = groupedNodeErrors(node.errors);
        return `${node.name}：${errors
          .map((error) => nodeErrorLabel(error))
          .join("、")}`;
      })
      .join("；");
    notices.push(`<div class="notice">部分节点数据不完整。${escapeHtml(summary)}</div>`);
  }
  elements.statusRegion.innerHTML = notices.join("");
}

function renderDashboard() {
  const data = state.data;
  if (!data) return;
  const responding = data.status.online + data.status.partial;
  setConnectionLabel(`${responding}/${data.nodes.length} 节点有响应`);
  elements.lastUpdated.textContent = formatDateTime(data.generatedAt);
  renderStatus(data);
  elements.dashboard.innerHTML = [
    renderKpis(data),
    renderOverviewPanels(data),
    renderNodes(data),
    state.directMode ? "" : renderManagement(),
    renderModels(data),
    renderEvents(data),
  ].join("");
  document
    .querySelector(".management-disclosure")
    ?.addEventListener("toggle", (event) => {
      state.managementExpanded = event.currentTarget.open;
    });
  elements.loadingState.hidden = true;
  elements.dashboard.hidden = false;
  renderActiveView();

  document.querySelector("#load-more-events")?.addEventListener("click", () => {
    state.eventLimit += 20;
    renderDashboard();
  });
}

function historyKey(item) {
  return `${item.source_id}:${item.state}:${item.session_name}`;
}

function clearHistorySelection() {
  state.history.selectedItems.clear();
}

function selectedHistoryItems() {
  return [...state.history.selectedItems.values()];
}

function renderHistoryFilters() {
  const sources = state.history.sources.length
    ? state.history.sources
    : [{ id: "shared", name: "Shared", states: ["active", "trash", "all"] }];
  if (!sources.some((source) => source.id === state.history.source)) {
    state.history.source = sources[0].id;
  }
  elements.historySourceTabs.innerHTML = sources
    .map(
      (source) => `
        <button
          type="button"
          role="tab"
          data-history-source-filter="${escapeHtml(source.id)}"
          aria-selected="${source.id === state.history.source}"
        >
          <span>${escapeHtml(source.name)}</span>
          ${
            Number.isFinite(state.history.sourceCounts[source.id])
              ? `<strong>${escapeHtml(formatExact(state.history.sourceCounts[source.id]))}</strong>`
              : ""
          }
        </button>
      `,
    )
    .join("");
  const source = sources.find((item) => item.id === state.history.source);
  const labels = {
    active: "Active",
    archived: "Archived",
    trash: "Recycle Bin",
    all: "All items",
  };
  const states = source?.states ?? ["all"];
  if (!states.includes(state.history.filter)) {
    state.history.filter = states[0];
  }
  elements.historyState.innerHTML = states
    .map(
      (value) =>
        `<option value="${escapeHtml(value)}" ${
          value === state.history.filter ? "selected" : ""
        }>${escapeHtml(labels[value] || value)}</option>`,
    )
    .join("");
  elements.historyRange.value = state.history.range;
  elements.historyClear.disabled =
    !state.history.query &&
    state.history.range === "all" &&
    state.history.filter === states[0];
  elements.historySearchHelp.textContent =
    source?.type === "shared"
      ? "Searches full Shared transcripts with Azure AI hybrid keyword + vector search."
      : source?.type === "node"
        ? "Matches session ID, title, and workspace on this node."
        : "Combines Shared hybrid search with node ID, title, and workspace matching; duplicates prefer Shared.";
}

function renderHistoryList() {
  const history = state.history;
  elements.historyCount.textContent = `${formatExact(history.total)} sessions`;
  const start = history.total ? history.offset + 1 : 0;
  const end = Math.min(history.offset + history.limit, history.total);
  elements.historyPageLabel.textContent = `${start}–${end}`;
  elements.historyPrevious.disabled = history.loading || history.offset === 0;
  elements.historyNext.disabled =
    history.loading || history.offset + history.limit >= history.total;

  const manageableItems = (history.items ?? []).filter(
    (item) => item.source_type === "shared",
  );
  const selected = selectedHistoryItems();
  const activeSelected = selected.filter((item) => item.state === "active");
  const trashSelected = selected.filter((item) => item.state === "trash");
  if (history.canManage && (manageableItems.length || selected.length)) {
    const allPageSelected =
      manageableItems.length > 0 &&
      manageableItems.every((item) =>
        history.selectedItems.has(historyKey(item)),
      );
    elements.historyBatchToolbar.hidden = false;
    elements.historyBatchToolbar.innerHTML = `
      <label>
        <input
          type="checkbox"
          data-history-select-page
          ${allPageSelected ? "checked" : ""}
          ${history.operation || !manageableItems.length ? "disabled" : ""}
        />
        <span>选择当前页</span>
      </label>
      <strong>${formatExact(selected.length)} selected</strong>
      ${
        activeSelected.length
          ? `<button type="button" class="secondary-button" data-history-batch-action="trash">移入回收站 (${formatExact(activeSelected.length)})</button>`
          : ""
      }
      ${
        trashSelected.length
          ? `<button type="button" class="secondary-button" data-history-batch-action="restore">恢复 (${formatExact(trashSelected.length)})</button>`
          : ""
      }
      ${
        selected.length
          ? `<button type="button" class="danger-button" data-history-batch-action="purge">永久删除 (${formatExact(selected.length)})</button>`
          : ""
      }
    `;
  } else {
    elements.historyBatchToolbar.hidden = true;
    elements.historyBatchToolbar.innerHTML = "";
  }

  if (history.loading && history.items === null) {
    elements.historyList.innerHTML =
      '<div class="empty-state history-empty">正在读取共享会话…</div>';
    return;
  }
  if (!history.items?.length) {
    elements.historyList.innerHTML =
      '<div class="empty-state history-empty">没有匹配的共享会话。</div>';
    return;
  }
  elements.historyList.innerHTML = history.items
    .map((item) => {
      const selected = history.selectedKey === historyKey(item);
      const batchSelected = history.selectedItems.has(historyKey(item));
      const manageable =
        history.canManage && item.source_type === "shared";
      const semanticMatch = item.matches?.[0]?.content;
      const summary = String(semanticMatch || item.handoff_summary || "")
        .replace(/\s+/g, " ")
        .slice(0, 180);
      return `
        <div class="history-item ${selected ? "selected" : ""} ${batchSelected ? "batch-selected" : ""}">
          ${
            manageable
              ? `
                <label class="history-item-select">
                  <input
                    type="checkbox"
                    data-history-select
                    data-history-source="${escapeHtml(item.source_id)}"
                    data-history-state="${escapeHtml(item.state)}"
                    data-history-name="${escapeHtml(item.session_name)}"
                    ${batchSelected ? "checked" : ""}
                    ${history.operation ? "disabled" : ""}
                  />
                  <span class="sr-only">选择 ${escapeHtml(item.session_name)}</span>
                </label>
              `
              : '<span aria-hidden="true"></span>'
          }
          <button
            type="button"
            class="history-item-open"
            data-history-source="${escapeHtml(item.source_id)}"
            data-history-state="${escapeHtml(item.state)}"
            data-history-name="${escapeHtml(item.session_name)}"
            aria-pressed="${selected}"
          >
            <span class="history-item-heading">
              <strong>${escapeHtml(item.session_name)}</strong>
              <span class="history-item-badges">
                ${
                  item.source_type === "node"
                    ? `<span class="history-upload-status ${
                        item.uploaded ? "uploaded" : "not-uploaded"
                      }">${item.uploaded ? "Uploaded" : "Not uploaded"}</span>`
                    : ""
                }
                <span class="history-state ${escapeHtml(item.state)}">${escapeHtml(item.state === "trash" ? "recycle bin" : item.state)}</span>
              </span>
            </span>
            <span class="history-source-badge">${escapeHtml(item.source_name || item.source_id)}</span>
            <span class="history-item-meta">
              ${escapeHtml(formatDateTime(item.timestamp_ms || (item.deleted_at || item.uploaded_at || 0) * 1000))}
              · ${escapeHtml(formatBytes(item.archive_size_bytes))}
            </span>
            <span class="history-item-summary">${escapeHtml(summary || "No handoff summary")}</span>
            ${
              item.search_score
                ? `<span class="history-search-score">Vector score ${escapeHtml(
                    Number(item.search_score).toFixed(3),
                  )}</span>`
                : ""
            }
            <span class="history-item-uploader">${escapeHtml(
              item.source_type === "node"
                ? item.cwd || item.title || "node-native Codex history"
                : item.uploaded_by_email || item.uploaded_by || "unknown uploader",
            )}</span>
          </button>
        </div>
      `;
    })
    .join("");
}

function historyMetadataRow(label, value, monospace = false) {
  return `
    <div class="history-metadata-row">
      <dt>${escapeHtml(label)}</dt>
      <dd class="${monospace ? "mono" : ""}">${escapeHtml(value ?? "—")}</dd>
    </div>
  `;
}

function renderHistoryDetail() {
  const history = state.history;
  if (history.detailLoading) {
    elements.historyDetail.innerHTML =
      '<div class="empty-state">正在读取 metadata 和 transcript…</div>';
    return;
  }
  if (!history.detail) {
    elements.historyDetail.innerHTML =
      '<div class="empty-state">选择一个会话查看 metadata 和 transcript。</div>';
    return;
  }

  const { session, transcript, transcript_error: transcriptError } = history.detail;
  const messages = transcript?.messages ?? [];
  const active = session.state === "active";
  const sharedSession = session.source_type === "shared";
  const actionMarkup = !sharedSession
    ? `
      <span class="managed-badge">Node history · read only</span>
      ${
        session.uploaded
          ? '<button type="button" class="secondary-button" data-history-action="view-shared">查看 Shared copy</button>'
          : state.directMode
            ? '<span class="managed-badge">Direct mode · upload unavailable</span>'
            : '<button type="button" class="update-button" data-history-action="upload">Upload to Shared</button>'
      }
    `
    : !state.history.canManage
    ? '<span class="managed-badge">Contributor · read only</span>'
    : active
    ? `
      <button type="button" class="secondary-button" data-history-action="rename">重命名</button>
      <button type="button" class="danger-button" data-history-action="trash">移入回收站</button>
      <button type="button" class="danger-button" data-history-action="purge">直接永久删除</button>
    `
    : `
      <button type="button" class="secondary-button" data-history-action="restore">恢复</button>
      <button type="button" class="danger-button" data-history-action="purge">永久清除</button>
    `;
  const transcriptMarkup = messages.length
    ? messages
        .map(
          (message) => `
            <article class="transcript-message ${escapeHtml(message.role)}">
              <header>
                <strong>${message.role === "user" ? "User" : "Assistant"}</strong>
                <span>${escapeHtml(formatDateTime(message.timestamp))}</span>
              </header>
              <pre>${escapeHtml(message.text)}</pre>
            </article>
          `,
        )
        .join("")
    : `<div class="empty-state history-empty">${
        transcriptError
          ? `Transcript unavailable: ${escapeHtml(transcriptError)}`
          : "This archive has no user/assistant transcript messages."
      }</div>`;

  elements.historyDetail.innerHTML = `
    <div class="history-detail-header">
      <div>
        <span class="history-state ${escapeHtml(session.state)}">${escapeHtml(session.state === "trash" ? "recycle bin" : session.state)}</span>
        <span class="history-source-badge">${escapeHtml(session.source_name || session.source_id)}</span>
        <h2>${escapeHtml(session.session_name || session.session_id)}</h2>
        <p>${escapeHtml(session.handoff_summary || "No handoff summary was captured.")}</p>
      </div>
      <div class="history-detail-actions">
        ${sharedSession ? '<button type="button" class="update-button" data-history-action="download">下载 archive</button>' : ""}
        ${actionMarkup}
      </div>
    </div>

    <section class="history-metadata">
      <h3>Metadata</h3>
      <dl>
        ${historyMetadataRow("Source session", session.source_session_id, true)}
        ${historyMetadataRow("Category", session.source_name || session.source_id)}
        ${historyMetadataRow(
          sharedSession ? "Uploaded" : "Updated",
          formatDateTime(
            session.timestamp_ms || (session.uploaded_at || 0) * 1000,
          ),
        )}
        ${
          sharedSession
            ? historyMetadataRow("Uploader", session.uploaded_by_email || session.uploaded_by)
            : historyMetadataRow("Workspace", session.cwd)
        }
        ${historyMetadataRow(sharedSession ? "Archive size" : "Rollout size", formatBytes(session.archive_size_bytes))}
        ${sharedSession ? historyMetadataRow("SHA-256", session.archive_sha256, true) : ""}
        ${session.title ? historyMetadataRow("Title", session.title) : ""}
        ${session.cli_version ? historyMetadataRow("CLI version", session.cli_version, true) : ""}
        ${session.model_provider ? historyMetadataRow("Model provider", session.model_provider, true) : ""}
        ${session.deleted_at ? historyMetadataRow("Deleted", formatDateTime(session.deleted_at * 1000)) : ""}
        ${session.deleted_by ? historyMetadataRow("Deleted by", session.deleted_by, true) : ""}
      </dl>
      <details class="history-json">
        <summary>完整 metadata JSON</summary>
        <pre>${escapeHtml(JSON.stringify(session, null, 2))}</pre>
      </details>
    </section>

    <section class="history-transcript">
      <div class="history-section-heading">
        <h3>Transcript</h3>
        <span>${formatExact(messages.length)} messages${transcript?.truncated ? " · truncated" : ""}</span>
      </div>
      <div class="transcript-list">${transcriptMarkup}</div>
    </section>
  `;
}

function renderHistory() {
  renderActiveView();
  renderHistoryFilters();
  renderHistoryList();
  renderHistoryDetail();
  const selectedSource = state.history.sources.find(
    (item) => item.id === state.history.source,
  );
  elements.historyConnection.textContent = state.history.error
    ? "连接失败"
    : state.history.searchMode === "azure_ai_search_hybrid_vector"
      ? "Azure AI Search · hybrid vector"
      : state.history.searchMode === "hybrid_sources"
        ? "Azure AI Search + node substring"
    : selectedSource?.type === "shared"
      ? "Shared · Entra via Azure CLI"
      : selectedSource?.name || "All sources";
  const notices = [];
  if (state.history.error) {
    notices.push(
      `<div class="notice notice-error">${escapeHtml(state.history.error)}</div>`,
    );
  }
  if (state.history.operation) {
    notices.push('<div class="notice">正在执行会话管理操作…</div>');
  }
  for (const error of state.history.sourceErrors) {
    notices.push(
      `<div class="notice">来源 ${escapeHtml(error.source_name || error.source_id)} 暂不可用：${escapeHtml(error.message)}</div>`,
    );
  }
  elements.historyStatus.innerHTML = notices.join("");
}

async function fetchHistoryDetail(sourceId, historyState, sessionName) {
  const key = `${sourceId}:${historyState}:${sessionName}`;
  const requestId = ++state.history.detailRequestId;
  state.history.selectedKey = key;
  state.history.detailLoading = true;
  state.history.detail = null;
  renderHistory();
  try {
    let detail;
    if (state.directMode) {
      await refreshClientNodes(false);
      if (requestId !== state.history.detailRequestId) return;
      detail = await fetchClientHistoryDetail({
        nodes: state.nodes,
        connectionMode: state.connectionMode,
        sourceId,
        state: historyState,
        sessionName,
        serverFetch: fetchJson,
      });
      const listed = state.history.items?.find(
        (item) =>
          item.source_id === sourceId &&
          item.state === historyState &&
          item.session_name === sessionName,
      );
      if (listed && detail?.session) {
        detail.session = {
          ...detail.session,
          uploaded: listed.uploaded,
          shared_name: listed.shared_name,
        };
      }
    } else {
      detail = await fetchJson(
        `/api/session-history/${encodeURIComponent(sourceId)}/${encodeURIComponent(historyState)}/${encodeURIComponent(sessionName)}`,
      );
    }
    if (
      requestId !== state.history.detailRequestId ||
      state.history.selectedKey !== key
    ) {
      return;
    }
    state.history.detail = detail;
    state.history.error = "";
  } catch (error) {
    if (requestId !== state.history.detailRequestId) return;
    state.history.error = `会话详情读取失败：${error.message}`;
  } finally {
    if (requestId !== state.history.detailRequestId) return;
    state.history.detailLoading = false;
    renderHistory();
  }
}

async function fetchHistoryList({ resetOffset = false, preserveSelection = true } = {}) {
  const requestId = ++state.history.listRequestId;
  state.history.detailRequestId += 1;
  if (resetOffset) state.history.offset = 0;
  const request = {
    source: state.history.source,
    filter: state.history.filter,
    query: state.history.query,
    limit: state.history.limit,
    offset: state.history.offset,
    range: state.history.range,
  };
  state.history.loading = true;
  state.history.error = "";
  renderHistory();
  try {
    const query = new URLSearchParams({
      source: request.source,
      state: request.filter,
      q: request.query,
      limit: String(request.limit),
      offset: String(request.offset),
      range: request.range,
    });
    const result = state.directMode
      ? await (async () => {
          await refreshClientNodes(false);
          if (requestId !== state.history.listRequestId) return;
          return fetchClientHistoryList({
            nodes: state.nodes,
            connectionMode: state.connectionMode,
            source: request.source,
            state: request.filter,
            query: request.query,
            limit: request.limit,
            offset: request.offset,
            range: request.range,
            serverFetch: fetchJson,
          });
        })()
      : await fetchJson(`/api/session-history?${query}`);
    if (requestId !== state.history.listRequestId) return;
    state.history.items = result.items ?? [];
    state.history.total = result.total ?? 0;
    state.history.canManage = Boolean(result.permissions?.can_manage);
    state.history.sources = result.sources ?? state.history.sources;
    state.history.sourceCounts = {
      ...state.history.sourceCounts,
      ...(result.source_counts ?? {}),
    };
    state.history.sourceErrors = result.source_errors ?? [];
    state.history.searchMode = result.search_mode ?? "browse";
    const selected = preserveSelection
      ? state.history.items.find(
          (item) => historyKey(item) === state.history.selectedKey,
        )
      : null;
    const next = selected ?? state.history.items[0] ?? null;
    if (next) {
      await fetchHistoryDetail(next.source_id, next.state, next.session_name);
    } else {
      state.history.selectedKey = "";
      state.history.detail = null;
    }
  } catch (error) {
    if (requestId !== state.history.listRequestId) return;
    state.history.error = `Session History 读取失败：${error.message}`;
    state.history.items = [];
    state.history.total = 0;
    state.history.detail = null;
    state.history.sourceErrors = [];
  } finally {
    if (requestId !== state.history.listRequestId) return;
    state.history.loading = false;
    renderHistory();
  }
}

function selectedHistorySession() {
  return state.history.detail?.session ?? null;
}

function openRenameDialog(session) {
  state.history.renameTarget = session;
  elements.renameForm.reset();
  elements.renameForm.elements.newName.value =
    session.session_name || session.session_id || "";
  elements.renameMessage.textContent =
    `将 “${session.session_name || session.session_id}” 重命名为新的共享会话名称。`;
  elements.renameError.hidden = true;
  elements.renameError.textContent = "";
  elements.renameDialog.showModal();
}

async function uploadHistorySession() {
  const session = selectedHistorySession();
  if (
    !session ||
    session.source_type !== "node" ||
    session.uploaded ||
    state.history.operation
  ) {
    return;
  }
  const sessionName = session.session_name || session.session_id;
  const confirmed = await requestConfirmation({
    title: "Upload to Shared",
    message:
      `将 ${session.source_name} 的 “${sessionName}” 作为 history-only bundle 上传到 Shared？` +
      " 上传完成后会自动加入 Azure AI Search。",
    confirmLabel: "开始上传",
  });
  if (!confirmed) return;
  state.history.operation = true;
  state.history.error = "";
  renderHistory();
  try {
    const result = await fetchJson(
      `/api/session-history/${encodeURIComponent(session.source_id)}/${encodeURIComponent(session.state)}/${encodeURIComponent(sessionName)}/upload`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-portal-action": "session-history",
        },
        body: "{}",
      },
    );
    state.history.error = "";
    state.history.selectedKey = `${session.source_id}:${session.state}:${sessionName}`;
    await fetchHistoryList({ preserveSelection: true });
    if (state.history.detail?.session) {
      state.history.detail.session.uploaded = true;
      state.history.detail.session.shared_name = result.sharedName;
    }
  } catch (error) {
    state.history.error = `Upload to Shared 失败：${error.message}`;
  } finally {
    state.history.operation = false;
    renderHistory();
  }
}

function viewSharedCopy(session) {
  if (!session.shared_name) return;
  state.history.source = "shared";
  state.history.filter = "all";
  state.history.query = session.shared_name;
  state.history.offset = 0;
  state.history.selectedKey = "";
  clearHistorySelection();
  elements.historyQuery.value = session.shared_name;
  fetchHistoryList({ resetOffset: true, preserveSelection: false });
}

async function performHistoryAction(action, options = {}) {
  const session = selectedHistorySession();
  if (!session || state.history.operation) return;
  const sessionName = session.session_name || session.session_id;
  if (session.source_id !== "shared") return;
  const sourcePath = encodeURIComponent(session.source_id);
  const definitions = {
    trash: {
      title: "移入回收站",
      message: `将共享会话 “${sessionName}” 移入可恢复回收站？`,
      method: "DELETE",
      path: `/api/session-history/${sourcePath}/active/${encodeURIComponent(sessionName)}`,
      label: "移入回收站",
    },
    restore: {
      title: "恢复共享会话",
      message: `将 “${sessionName}” 恢复到 Active sessions？`,
      method: "POST",
      path: `/api/session-history/${sourcePath}/trash/${encodeURIComponent(sessionName)}/restore`,
      label: "恢复",
    },
    purge: {
      title: "永久清除共享会话",
      message:
        session.state === "active"
          ? `直接永久删除 Active 会话 “${sessionName}” 的 metadata、archive 和搜索索引？此操作不会进入回收站，且无法撤销。`
          : `永久删除回收站中的 “${sessionName}” 的 metadata、archive 和搜索索引？此操作无法撤销。`,
      method: "DELETE",
      path: `/api/session-history/${sourcePath}/${encodeURIComponent(session.state)}/${encodeURIComponent(sessionName)}/purge`,
      label: "永久删除",
    },
    rename: {
      method: "POST",
      path: `/api/session-history/${sourcePath}/active/${encodeURIComponent(sessionName)}/rename`,
    },
  };
  const definition = definitions[action];
  if (!definition) return;
  if (action !== "rename") {
    const confirmed = await requestConfirmation({
      title: definition.title,
      message: definition.message,
      confirmLabel: definition.label,
    });
    if (!confirmed) return;
  }
  state.history.operation = true;
  renderHistory();
  try {
    const response = await fetchJson(definition.path, {
      method: definition.method,
      headers: {
        "content-type": "application/json",
        "x-portal-action": "session-history",
      },
      ...(action === "rename"
        ? { body: JSON.stringify({ newName: options.newName }) }
        : {}),
    });
    state.history.error = "";
    if (action === "rename") {
      const renamed = response.session?.session_name || options.newName;
      state.history.selectedKey = `shared:active:${renamed}`;
    } else {
      state.history.selectedKey = "";
    }
    await fetchHistoryList({ preserveSelection: action === "rename" });
  } catch (error) {
    state.history.error = `${definition.title || "会话操作"}失败：${error.message}`;
  } finally {
    state.history.operation = false;
    renderHistory();
  }
}

function eligibleHistoryBatchItems(action) {
  return selectedHistoryItems().filter(
    (item) =>
      item.source_id === "shared" &&
      ((action === "trash" && item.state === "active") ||
        (action === "restore" && item.state === "trash") ||
        (action === "purge" &&
          (item.state === "active" || item.state === "trash"))),
  );
}

async function performHistoryBatch(action) {
  if (state.history.operation) return;
  const items = eligibleHistoryBatchItems(action);
  if (!items.length) return;
  const definitions = {
    trash: {
      title: "批量移入回收站",
      message: `将选中的 ${formatExact(items.length)} 个 Active Shared sessions 移入可恢复回收站？`,
      label: "移入回收站",
    },
    restore: {
      title: "批量恢复",
      message: `将选中的 ${formatExact(items.length)} 个回收站 sessions 恢复为 Active？`,
      label: "恢复",
    },
    purge: {
      title: "批量永久删除",
      message: `永久删除选中的 ${formatExact(items.length)} 个 Shared sessions、archives 和搜索索引？Active sessions 不会进入回收站。此操作无法撤销。`,
      label: "永久删除",
    },
  };
  const definition = definitions[action];
  if (!definition) return;
  const confirmed = await requestConfirmation({
    title: definition.title,
    message: definition.message,
    confirmLabel: definition.label,
  });
  if (!confirmed) return;

  state.history.operation = true;
  state.history.error = "";
  renderHistory();
  try {
    const result = await fetchJson("/api/session-history/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-portal-action": "session-history",
      },
      body: JSON.stringify({
        action,
        items: items.map((item) => ({
          sourceId: item.source_id,
          state: item.state,
          sessionName: item.session_name,
        })),
      }),
    });
    for (const item of result.results ?? []) {
      if (item.ok) {
        state.history.selectedItems.delete(
          `shared:${item.state}:${item.sessionName}`,
        );
      }
    }
    state.history.selectedKey = "";
    if (result.failed) {
      const failures = (result.results ?? [])
        .filter((item) => !item.ok)
        .slice(0, 3)
        .map((item) => `${item.sessionName}: ${item.error}`)
        .join("；");
      state.history.error =
        `${formatExact(result.succeeded)} succeeded, ${formatExact(result.failed)} failed.` +
        (failures ? ` ${failures}` : "");
    }
    await fetchHistoryList({ preserveSelection: false });
  } catch (error) {
    state.history.error = `${definition.title}失败：${error.message}`;
  } finally {
    state.history.operation = false;
    renderHistory();
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) window.location.replace("/portal-auth/login");
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function fetchManagementStatus() {
  if (state.directMode) {
    state.management = { nodes: [], artifacts: [], checkedAt: null };
    state.managementError = "";
    state.managementLoading = false;
    return;
  }
  if (state.managementLoading) return;
  state.managementLoading = true;
  state.managementError = "";
  if (state.data) renderDashboard();
  try {
    state.management = await fetchJson("/api/management/status");
  } catch (error) {
    state.managementError = error.message;
  } finally {
    state.managementLoading = false;
    if (state.data) renderDashboard();
  }
}

async function updateComponent(nodeId, component, artifactId = "") {
  const updateKey = `${nodeId}:${component}`;
  if (state.updating.has(updateKey)) return;
  const node = state.nodes.find((item) => item.id === nodeId);
  const componentLabel = COMPONENT_LABELS[component] || component;
  const artifact = component === "copilot-api"
    ? availableArtifacts().find((item) => item.id === artifactId)
    : null;
  if (component === "copilot-api" && !artifact) {
    state.operationNotice = { message: "请选择一个有效的 Copilot API 构建。", error: true };
    renderDashboard();
    return;
  }
  const restartNote = component === "copilot-api" ? "，代理服务会短暂重启" : "";
  const targetNote = artifact ? ` 到 ${artifactLabel(artifact)}` : "";
  const confirmed = await requestConfirmation({
    title: `更新 ${componentLabel}`,
    message: `确认更新 ${node?.name || nodeId} 的 ${componentLabel}${targetNote}${restartNote}？失败时会恢复原版本，成功后会执行一次真实 Codex 调用验证。`,
    confirmLabel: "确认更新",
  });
  if (!confirmed) return;

  state.updating.add(updateKey);
  state.operationNotice = { message: `正在更新 ${node?.name || nodeId} 的 ${componentLabel}…`, error: false };
  renderDashboard();
  try {
    const result = await fetchJson(`/api/nodes/${encodeURIComponent(nodeId)}/update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-portal-action": "update",
      },
      body: JSON.stringify({
        component,
        ...(artifact ? { artifactId: artifact.id } : {}),
      }),
    });
    state.operationNotice = {
      message: `${node?.name || nodeId} 的 ${componentLabel} 更新完成。${result.message || ""}`,
      error: false,
    };
    await Promise.all([fetchManagementStatus(), fetchOverview(true)]);
  } catch (error) {
    state.operationNotice = {
      message: `${node?.name || nodeId} 的 ${componentLabel} 更新失败：${error.message}`,
      error: true,
    };
  } finally {
    state.updating.delete(updateKey);
    if (state.data) renderDashboard();
  }
}

async function deployArtifactToAll(artifactId) {
  if (state.deployingArtifact) return;
  const artifact = availableArtifacts().find((item) => item.id === artifactId);
  if (!artifact) {
    state.operationNotice = {
      message: "所选 Copilot API 构建不存在或未通过校验。",
      error: true,
    };
    renderDashboard();
    return;
  }
  const nodes = (state.management?.nodes ?? []).filter(
    (node) => node.copilotApi?.canStart,
  );
  const confirmed = await requestConfirmation({
    title: "部署 Copilot API 到全部节点",
    message:
      `将 ${artifactLabel(artifact)} 部署到 ${formatExact(nodes.length)} 个节点（${nodes
        .map((node) => node.name)
        .join("、")}）？` +
      " 已是该构建且服务正常的节点会跳过，其余节点会重启并独立验证。",
    confirmLabel: "部署到全部节点",
  });
  if (!confirmed) return;

  state.deployingArtifact = artifact.id;
  state.operationNotice = {
    message: `正在将 ${artifactLabel(artifact)} 部署到全部节点…`,
    error: false,
  };
  renderDashboard();
  try {
    const result = await fetchJson("/api/copilot-api/deploy-all", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-portal-action": "update",
      },
      body: JSON.stringify({ artifactId: artifact.id }),
    });
    const failures = (result.results ?? [])
      .filter((item) => !item.ok)
      .map((item) => `${item.nodeName || item.nodeId}: ${item.error}`)
      .join("；");
    state.operationNotice = {
      message:
        `${artifactLabel(artifact)} fleet deployment: ` +
        `${formatExact(result.deployed)} deployed, ` +
        `${formatExact(result.skipped)} skipped, ` +
        `${formatExact(result.failed)} failed.` +
        (failures ? ` ${failures}` : ""),
      error: result.failed > 0,
    };
    await Promise.all([fetchManagementStatus(), fetchOverview(true)]);
  } catch (error) {
    state.operationNotice = {
      message: `Fleet deployment 失败：${error.message}`,
      error: true,
    };
  } finally {
    state.deployingArtifact = "";
    if (state.data) renderDashboard();
  }
}

async function startCopilotApi(nodeId) {
  if (state.starting.has(nodeId)) return;
  const node = state.nodes.find((item) => item.id === nodeId);
  const confirmed = await requestConfirmation({
    title: "启动 Copilot API",
    message: `启动 ${node?.name || nodeId} 的 Copilot API？Portal 只会使用该节点预配置的服务或已验证本机构建。`,
    confirmLabel: "启动",
  });
  if (!confirmed) return;

  state.starting.add(nodeId);
  state.operationNotice = {
    message: `正在启动 ${node?.name || nodeId} 的 Copilot API…`,
    error: false,
  };
  renderDashboard();
  try {
    const result = await fetchJson(
      `/api/nodes/${encodeURIComponent(nodeId)}/copilot-api/start`,
      {
        method: "POST",
        headers: {
          "x-portal-action": "start-copilot-api",
        },
      },
    );
    state.operationNotice = {
      message: `${node?.name || nodeId} 的 Copilot API 已启动。${result.message || ""}`,
      error: false,
    };
    await Promise.all([fetchManagementStatus(), fetchOverview(true)]);
  } catch (error) {
    state.operationNotice = {
      message: `${node?.name || nodeId} 的 Copilot API 启动失败：${error.message}`,
      error: true,
    };
  } finally {
    state.starting.delete(nodeId);
    if (state.data) renderDashboard();
  }
}

function provisionTemplateNodes() {
  const managedNodes = state.management?.nodes ?? [];
  const remoteIds = new Set(
    managedNodes
      .filter((node) => node.copilotApi?.mode === "systemd-user")
      .map((node) => node.id),
  );
  return state.nodes.filter((node) => remoteIds.has(node.id));
}

function openProvisionDialog({ preserveValues = false, errorMessage = "" } = {}) {
  if (state.clientConfig?.managedAccounts) {
    window.location.assign("/settings#add-node");
    return;
  }
  if (!preserveValues) elements.provisionForm.reset();
  const select = elements.provisionForm.elements.templateNodeId;
  const previous = select.value;
  const templates = provisionTemplateNodes();
  select.innerHTML = templates
    .map((node) => `<option value="${escapeHtml(node.id)}">${escapeHtml(node.name)}</option>`)
    .join("");
  if (templates.some((node) => node.id === previous)) {
    select.value = previous;
  } else if (templates.some((node) => node.id === "jpe2")) {
    select.value = "jpe2";
  }
  elements.provisionError.hidden = !errorMessage;
  elements.provisionError.textContent = errorMessage;
  renderProvisionPlatform();
  elements.provisionDialog.showModal();
}

function renderProvisionPlatform() {
  const platform =
    elements.provisionForm.elements.platform.value || "linux";
  const windows = platform === "windows";
  const macos = platform === "macos";
  const template = elements.provisionForm.elements.templateNodeId;
  template.required = !windows && !macos;
  document
    .querySelectorAll("[data-linux-provision-field]")
    .forEach((element) => {
      element.hidden = windows || macos;
    });
  elements.provisionDescription.textContent = macos
    ? "下载 macOS 自解包脚本，安装 copilot-api、Codex CLI 并注册 launchd LaunchAgent。"
    : windows
      ? "注册已运行 Windows bootstrap 的工作站；Portal 不复制其他机器的 token。"
      : "通过 SSH 安装 copilot-api、Codex CLI、systemd 自动更新，并执行真实 Codex 验收。";
  elements.provisionNote.textContent = macos
    ? "单个 macOS Shell 脚本已内嵌并校验 package；请在登录用户的 Terminal 中运行，不要使用 sudo。"
    : windows
      ? "单个 PowerShell 脚本已内嵌并校验 package；下载后直接运行。如需 Portal 管理，再启用 OpenSSH Server。"
      : "单个 Shell 脚本已内嵌并校验 package；下载后直接运行，或继续通过 SSH 在线部署。";
  elements.bootstrapBundleDownload.href = `/bootstrap/${platform}`;
  elements.bootstrapBundleDownload.removeAttribute("download");
  elements.bootstrapBundleDownload.textContent = macos
    ? "下载 macOS 一键安装脚本（含 package）"
    : windows
      ? "下载 Windows 一键安装脚本（含 package）"
      : "下载 Linux 一键安装脚本（含 package）";
  elements.provisionSubmit.disabled = macos;
  elements.provisionSubmit.textContent = macos
    ? "macOS 暂仅支持脚本安装"
    : windows
      ? "连接并注册"
      : "连接并部署";
}

async function reloadNodes(newNodeId) {
  const config = state.directMode
    ? await refreshClientNodes(true)
    : await fetchJson("/api/nodes");
  state.nodes = config.nodes;
  state.refreshSeconds = config.refreshSeconds;
  const availableIds = new Set(connectionNodes().map((node) => node.id));
  state.selectedNodes = new Set([...state.selectedNodes].filter((id) => availableIds.has(id)));
  if (newNodeId && availableIds.has(newNodeId)) state.selectedNodes.add(newNodeId);
  if (state.selectedNodes.size === 0) state.selectedNodes = availableIds;
  renderControls();
  updateUrl();
}

async function provisionNode(payload) {
  elements.provisionDialog.close();
  const confirmed = await requestConfirmation({
    title: `部署 ${payload.name}`,
    message:
      payload.platform === "windows"
        ? `将通过 Windows OpenSSH Host “${payload.sshHost}” 注册已 bootstrap 的工作站，并在 Portal 主机保存权限受限的节点 API key。确认继续？`
        : `将通过 SSH Host “${payload.sshHost}” 安装 copilot-api 与 Codex CLI，复制 ${payload.templateNodeId} 的代理配置，启用 systemd 自动更新，并执行真实 Codex 验证。确认继续？`,
    confirmLabel: payload.platform === "windows" ? "注册 Windows 节点" : "开始部署",
  });
  if (!confirmed) {
    openProvisionDialog({ preserveValues: true });
    return;
  }

  state.provisioning = true;
  state.operationNotice = {
    message: `正在连接 ${payload.name}，安装代理、Codex CLI 并执行验收…`,
    error: false,
  };
  if (state.data) renderDashboard();
  try {
    const result = await fetchJson("/api/nodes/provision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-portal-action": "provision",
      },
      body: JSON.stringify(payload),
    });
    await reloadNodes(result.node?.id);
    state.operationNotice = {
      message: `${result.node?.name || payload.name} 一键部署完成：${result.message || "Codex 已可用"}`,
      error: false,
    };
    await Promise.all([fetchManagementStatus(), fetchOverview(true)]);
  } catch (error) {
    state.operationNotice = {
      message: `${payload.name} 部署失败：${error.message}`,
      error: true,
    };
    openProvisionDialog({ preserveValues: true, errorMessage: error.message });
  } finally {
    state.provisioning = false;
    if (state.data) renderDashboard();
  }
}

async function fetchOverview(forceRefresh, { interactiveLocal = false, connectionChanged = false } = {}) {
  if (state.selectedNodes.size === 0) {
    setLoading(false);
    elements.loadingState.hidden = true;
    elements.dashboard.hidden = false;
    elements.dashboard.innerHTML = '<section class="empty-state">你还没有可访问的节点。<a href="/settings#add-node">添加并配置自己的节点</a> · <a href="/downloads/codey-node-onboarding.zip" download="codey-node-onboarding.zip">下载接入 Skill</a></section>';
    setConnectionLabel("暂无节点");
    return;
  }
  if (state.isLoading && !connectionChanged) return;
  const requestId = ++state.overviewRequestId;
  const connectionMode = state.connectionMode;
  setLoading(true);
  elements.statusRegion.innerHTML = "";
  try {
    let data;
    if (state.directMode) {
      await refreshClientNodes(false);
      if (requestId !== state.overviewRequestId) return;
      data = await collectClientOverview(
        state.nodes,
        state.clientConfig,
        state.period,
        {
          nodeIds: [...state.selectedNodes],
          interactiveLocal,
          connectionMode,
        },
      );
    } else {
      const query = new URLSearchParams({
        period: state.period,
        nodes: [...state.selectedNodes].join(","),
      });
      if (forceRefresh) query.set("refresh", "1");
      data = await fetchJson(`/api/overview?${query}`);
    }
    if (requestId !== state.overviewRequestId) return;
    state.data = data;
    state.nextRefreshAt = Date.now() + state.refreshSeconds * 1000;
    renderDashboard();
  } catch (error) {
    if (requestId !== state.overviewRequestId) return;
    elements.statusRegion.innerHTML = `<div class="notice notice-error">刷新失败：${escapeHtml(error.message)}</div>`;
    setConnectionLabel("Portal 连接失败");
    elements.loadingState.hidden = true;
    if (!state.data) elements.dashboard.hidden = true;
  } finally {
    if (requestId === state.overviewRequestId) setLoading(false);
  }
}

async function initialize() {
  try {
    let config;
    try {
      config = await refreshClientNodes(true);
    } catch (error) {
      config = await fetchJson("/api/nodes");
      state.nodes = config.nodes;
      state.refreshSeconds = config.refreshSeconds;
      state.directMode = false;
      document.documentElement.dataset.connectionMode = "cloud";
    }
    const requestedNodes = new Set(
      (params.get("nodes") || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    );
    const availableIds = new Set(connectionNodes().map((node) => node.id));
    const validRequested = [...requestedNodes].filter((id) => availableIds.has(id));
    if (
      state.directMode &&
      state.connectionMode === "direct" &&
      availableIds.has("local") &&
      !requestedNodes.has("local")
    ) {
      const nonLocalIds = [...availableIds].filter((id) => id !== "local");
      if (
        nonLocalIds.length > 0 &&
        validRequested.length === nonLocalIds.length &&
        nonLocalIds.every((id) => requestedNodes.has(id))
      ) {
        validRequested.push("local");
      }
    }
    state.selectedNodes = new Set(validRequested.length ? validRequested : availableIds);
    renderControls();
    updateUrl();
    renderActiveView();
    await Promise.all([
      fetchOverview(false),
      ...(state.directMode ? [] : [fetchManagementStatus()]),
      ...(state.activeView === "sessions" ? [fetchHistoryList()] : []),
    ]);
  } catch (error) {
    elements.loadingState.hidden = true;
    setConnectionLabel("Portal 启动失败");
    elements.statusRegion.innerHTML = `<div class="notice notice-error">无法载入 Portal 配置：${escapeHtml(error.message)}</div>`;
  }
}

async function onConnectionModeChange(event) {
  const selectedAll = connectionNodes().every((node) => state.selectedNodes.has(node.id));
  state.connectionMode = event.currentTarget.checked ? "vnet" : "direct";
  saveConnectionMode(preferenceStorage, state.connectionMode);
  document.documentElement.dataset.connectionMode = state.connectionMode;
  const available = new Set(connectionNodes().map((node) => node.id));
  state.selectedNodes = selectedAll
    ? available
    : new Set([...state.selectedNodes].filter((id) => available.has(id)));
  if (!state.selectedNodes.size) state.selectedNodes = available;
  // Ignore results from the previous route, including an in-flight history detail.
  state.overviewRequestId++;
  state.history.listRequestId++;
  state.history.detailRequestId++;
  state.history.sources = state.history.sources.filter(
    (source) => ["all", "shared"].includes(source.id) || available.has(source.id),
  );
  state.history.sourceCounts = {};
  state.history.sourceErrors = [];
  state.history.items = null;
  state.history.total = 0;
  state.history.offset = 0;
  state.history.detail = null;
  state.history.detailLoading = false;
  state.history.loading = false;
  state.history.selectedKey = "";
  state.history.error = "";
  if (!["all", "shared"].includes(state.history.source) && !available.has(state.history.source)) {
    state.history.source = "all";
    state.history.filter = "all";
  }
  clearHistorySelection();
  state.data = null;
  setLoading(false);
  elements.localConnectButton.hidden = true;
  renderConnectionOptions();
  renderControls();
  updateUrl();
  setConnectionLabel("正在连接节点");
  await Promise.all([
    fetchOverview(true, { connectionChanged: true }),
    ...(state.activeView === "sessions" ? [fetchHistoryList({ resetOffset: true })] : []),
  ]);
}

for (const toggle of elements.vnetToggles) {
  toggle.addEventListener("change", onConnectionModeChange);
}

for (const button of document.querySelectorAll("[data-portal-view]")) {
  button.addEventListener("click", () => {
    const nextView = button.dataset.portalView;
    if (
      !["usage", "sessions", "workspace"].includes(nextView) ||
      state.activeView === nextView
    ) {
      return;
    }
    state.activeView = nextView;
    updateUrl();
    renderActiveView();
    if (nextView === "sessions" && state.history.items === null) {
      fetchHistoryList();
    }
  });
}

elements.cloudCliNode.addEventListener("change", () => {
  state.cloudCli.selectedId = elements.cloudCliNode.value;
  updateUrl();
  renderCloudCliNode();
  openCloudCliNode();
});
elements.cloudCliReload.addEventListener("click", () =>
  openCloudCliNode({ reload: true }),
);
elements.cloudCliFrame.addEventListener("load", () => {
  const node = selectedCloudCliNode();
  if (node) elements.workspaceConnection.textContent = `${node.name} · 已连接`;
});

elements.periodSwitcher.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-period]");
  if (!button || button.dataset.period === state.period) return;
  state.period = button.dataset.period;
  state.eventLimit = 20;
  updateUrl();
  renderControls();
  fetchOverview(false);
});

elements.refreshButton.addEventListener("click", () => fetchOverview(true));
elements.localConnectButton.addEventListener("click", async () => {
  elements.localConnectButton.disabled = true;
  elements.localConnectButton.textContent = "正在连接本机…";
  await fetchOverview(true, { interactiveLocal: true });
});

elements.dashboard.addEventListener("click", (event) => {
  const provisionButton = event.target.closest("button[data-open-provision]");
  if (provisionButton) {
    openProvisionDialog();
    return;
  }
  const artifactPageButton = event.target.closest("button[data-artifact-page]");
  if (artifactPageButton) {
    const direction = artifactPageButton.dataset.artifactPage;
    state.artifactPage = Math.max(
      0,
      state.artifactPage + (direction === "next" ? 1 : -1),
    );
    updateUrl();
    renderDashboard();
    document
      .querySelector(".fleet-artifact-panel")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const startButton = event.target.closest("button[data-start-copilot-node]");
  if (startButton) {
    startCopilotApi(startButton.dataset.startCopilotNode);
    return;
  }
  const fleetDeployButton = event.target.closest(
    "button[data-deploy-artifact-all]",
  );
  if (fleetDeployButton) {
    deployArtifactToAll(fleetDeployButton.dataset.deployArtifactAll);
    return;
  }
  const button = event.target.closest("button[data-update-node][data-update-component]");
  if (!button) return;
  updateComponent(
    button.dataset.updateNode,
    button.dataset.updateComponent,
    button.dataset.updateArtifact || "",
  );
});

elements.historyControls.addEventListener("submit", (event) => {
  event.preventDefault();
  state.history.query = elements.historyQuery.value.trim();
  state.history.filter = elements.historyState.value;
  state.history.range = elements.historyRange.value;
  clearHistorySelection();
  updateUrl();
  fetchHistoryList({ resetOffset: true, preserveSelection: false });
});

elements.historyClear.addEventListener("click", () => {
  const source = state.history.sources.find(
    (item) => item.id === state.history.source,
  );
  state.history.query = "";
  state.history.filter = source?.states?.[0] ?? "all";
  state.history.range = "all";
  state.history.selectedKey = "";
  state.history.detail = null;
  clearHistorySelection();
  elements.historyQuery.value = "";
  updateUrl();
  fetchHistoryList({ resetOffset: true, preserveSelection: false });
});

elements.historyRefresh.addEventListener("click", () => {
  state.history.query = elements.historyQuery.value.trim();
  state.history.filter = elements.historyState.value;
  state.history.range = elements.historyRange.value;
  updateUrl();
  fetchHistoryList({ preserveSelection: true });
});

elements.historySourceTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-history-source-filter]");
  if (!button || button.dataset.historySourceFilter === state.history.source) {
    return;
  }
  state.history.source = button.dataset.historySourceFilter;
  const source = state.history.sources.find(
    (item) => item.id === state.history.source,
  );
  state.history.filter = source?.states?.[0] ?? "all";
  state.history.selectedKey = "";
  state.history.detail = null;
  clearHistorySelection();
  fetchHistoryList({ resetOffset: true, preserveSelection: false });
});

elements.historyState.addEventListener("change", () => {
  state.history.filter = elements.historyState.value;
  state.history.selectedKey = "";
  state.history.detail = null;
  clearHistorySelection();
  fetchHistoryList({ resetOffset: true, preserveSelection: false });
});

elements.historyRange.addEventListener("change", () => {
  state.history.range = elements.historyRange.value;
  state.history.sourceCounts = {};
  state.history.selectedKey = "";
  state.history.detail = null;
  clearHistorySelection();
  updateUrl();
  fetchHistoryList({ resetOffset: true, preserveSelection: false });
});

elements.historyList.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-history-select]");
  if (!checkbox) return;
  const item = (state.history.items ?? []).find(
    (value) =>
      value.source_id === checkbox.dataset.historySource &&
      value.state === checkbox.dataset.historyState &&
      value.session_name === checkbox.dataset.historyName,
  );
  if (!item || item.source_type !== "shared") return;
  if (checkbox.checked) {
    state.history.selectedItems.set(historyKey(item), item);
  } else {
    state.history.selectedItems.delete(historyKey(item));
  }
  renderHistoryList();
});

elements.historyList.addEventListener("click", (event) => {
  const item = event.target.closest(
    "button[data-history-source][data-history-state][data-history-name]",
  );
  if (!item) return;
  fetchHistoryDetail(
    item.dataset.historySource,
    item.dataset.historyState,
    item.dataset.historyName,
  );
});

elements.historyBatchToolbar.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-history-select-page]");
  if (!checkbox) return;
  for (const item of state.history.items ?? []) {
    if (item.source_type !== "shared") continue;
    if (checkbox.checked) {
      state.history.selectedItems.set(historyKey(item), item);
    } else {
      state.history.selectedItems.delete(historyKey(item));
    }
  }
  renderHistoryList();
});

elements.historyBatchToolbar.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-history-batch-action]");
  if (!button) return;
  performHistoryBatch(button.dataset.historyBatchAction);
});

elements.historyDetail.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-history-action]");
  if (!button) return;
  const session = selectedHistorySession();
  if (!session) return;
  const action = button.dataset.historyAction;
  if (action === "download") {
    const link = document.createElement("a");
    link.href =
      `/api/session-history/${encodeURIComponent(session.source_id)}/${encodeURIComponent(session.state)}/` +
      `${encodeURIComponent(session.session_name || session.session_id)}/archive`;
    link.download = "";
    document.body.append(link);
    link.click();
    link.remove();
    return;
  }
  if (action === "upload") {
    uploadHistorySession();
    return;
  }
  if (action === "view-shared") {
    viewSharedCopy(session);
    return;
  }
  if (action === "rename") {
    openRenameDialog(session);
    return;
  }
  performHistoryAction(action);
});

document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    state.activeView === "sessions" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)
  ) {
    event.preventDefault();
    elements.historyQuery.focus();
    elements.historyQuery.select();
  }
  if (event.key === "Escape" && document.activeElement === elements.historyQuery) {
    if (!elements.historyQuery.value && !state.history.query) return;
    elements.historyQuery.value = "";
    state.history.query = "";
    clearHistorySelection();
    fetchHistoryList({ resetOffset: true, preserveSelection: false });
  }
});

elements.historyPrevious.addEventListener("click", () => {
  state.history.offset = Math.max(0, state.history.offset - state.history.limit);
  fetchHistoryList({ preserveSelection: false });
});

elements.historyNext.addEventListener("click", () => {
  if (state.history.offset + state.history.limit >= state.history.total) return;
  state.history.offset += state.history.limit;
  fetchHistoryList({ preserveSelection: false });
});

elements.renameCancel.addEventListener("click", () => elements.renameDialog.close());

elements.renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!elements.renameForm.reportValidity() || state.history.operation) return;
  const newName = String(
    new FormData(elements.renameForm).get("newName") || "",
  ).trim();
  elements.renameDialog.close();
  await performHistoryAction("rename", { newName });
});

elements.provisionCancel.addEventListener("click", () => elements.provisionDialog.close());

elements.provisionForm.elements.platform.addEventListener(
  "change",
  renderProvisionPlatform,
);

elements.provisionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!elements.provisionForm.reportValidity() || state.provisioning) return;
  const formData = new FormData(elements.provisionForm);
  provisionNode({
    platform: String(formData.get("platform") || "linux"),
    id: String(formData.get("id") || "").trim().toLowerCase(),
    name: String(formData.get("name") || "").trim(),
    region: String(formData.get("region") || "").trim(),
    sshHost: String(formData.get("sshHost") || "").trim(),
    endpoint: String(formData.get("endpoint") || "").trim(),
    templateNodeId: String(formData.get("templateNodeId") || "").trim(),
    accent: String(formData.get("accent") || "#60a5fa"),
  });
});

setInterval(() => {
  if (!state.nextRefreshAt) return;
  const seconds = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  elements.refreshCountdown.textContent = seconds
    ? `${seconds}s 后自动刷新`
    : "正在自动刷新";
  if (seconds === 0 && !state.isLoading) fetchOverview(true);
}, 1000);

initialize();
