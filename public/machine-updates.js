const root = document.querySelector("#machine-updates");
const element = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text != null) item.textContent = text;
  if (className) item.className = className;
  return item;
};
const terminal = new Set(["succeeded", "failed", "rolled_back", "needs_action", "needs_migration", "cancelled"]);
const labels = {
  queued: "已排队", claimed: "已领取", downloading: "下载校验中", staging: "准备候选版本",
  waiting_idle: "等待任务空闲", applying: "切换中", verifying: "验收中", succeeded: "升级成功",
  failed: "升级失败", rolled_back: "已恢复旧版本", needs_action: "需要人工处理",
  needs_migration: "需要配置迁移", cancelled: "已取消",
  needs_setup: "尚未接入升级器", protected_local: "受保护节点", no_release: "暂无发行版",
  up_to_date: "已是目标版本", unsupported_platform: "平台不支持", runtime_incompatible: "Node 运行时不兼容",
  model_auth_migration_required: "需先迁移模型 API key/调用方", migration_unsupported: "升级器尚不支持此迁移",
  model_login_required: "需先完成本人模型登录", configuration_changed: "节点配置已改变，请检查",
  downgrade_blocked: "禁止退回较旧的发行序号", job_active: "已有升级任务", busy: "等待任务空闲",
  canary_failed: "灰度节点未通过，后续机器已暂停", signature_invalid: "签名/摘要验证失败",
  stage_failed: "候选准备失败", health_failed: "健康/鉴权验收失败", model_failed: "模型调用验收失败",
  download_failed: "下载失败", rollback_failed: "回退需人工检查", recovered_rollback: "中断恢复后已回退",
  lease_lost: "授权已失效", operation_failed: "操作失败", waiting_canary: "等待灰度节点",
  release_unavailable: "发行版已过期或被撤下，请重新预览",
};

if (root) {
  const $ = (name) => document.querySelector(`#node-update-${name}`);
  let current = null;
  let plan = null;
  let working = false;
  let timer;
  const selected = new Set();
  const notice = (text, failed = false) => {
    $("message").textContent = text;
    $("message").classList.toggle("error", failed);
  };
  async function api(path, value) {
    const response = await fetch(path, {
      method: value === undefined ? "GET" : "POST", credentials: "same-origin", mode: "same-origin",
      cache: "no-store", redirect: "error", referrerPolicy: "same-origin",
      ...(value === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }),
    });
    if (response.status === 401) { window.location.replace("/portal-auth/login"); throw new Error("请重新登录"); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  const target = () => current?.releases.find((release) => release.id === $("release").value);
  function eligibility(node) {
    const release = target();
    if (!current?.enabled || node.protected || !node.enrolled || !node.report || node.activeJob || !release) return false;
    if (node.report.platform !== release.platform || node.report.highestSequence > release.sequence || node.report.blockedReason) return false;
    if (release.migrations.some((id) => !node.report.readyMigrations.includes(id))) return false;
    if (Object.entries(release.components).some(([name, item]) => !item.nodeMajors.includes(node.report.components[name]?.nodeMajor))) return false;
    return node.report.highestSequence < release.sequence || node.report.currentRelease !== release.id ||
      Object.entries(release.components).some(([name, item]) =>
        node.report.components[name]?.entrySha256 !== item.entrySha256 || node.report.components[name]?.commit !== item.commit ||
        node.report.components[name]?.version !== item.version);
  }
  function controls() {
    const eligible = current?.nodes.filter(eligibility) || [];
    for (const id of selected) if (!eligible.some((node) => node.id === id)) selected.delete(id);
    $("selected").disabled = working || !selected.size;
    $("all").disabled = working || !eligible.length;
    $("release").disabled = working || !current?.releases.length;
    $("refresh").disabled = working;
    $("selected").textContent = selected.size ? `更新选中 (${selected.size})` : "更新选中机器";
    $("apply").disabled = working || !plan?.targets.some((node) => node.eligible);
    const active = current?.jobs.filter((job) => !terminal.has(job.state)).length || 0;
    const latestJobs = new Map((current?.jobs || []).map((job) => [job.nodeId, job]));
    const attention = [...latestJobs.values()].filter((job) =>
      ["failed", "rolled_back", "needs_action", "needs_migration"].includes(job.state)).length;
    $("count").hidden = !active && !attention && !eligible.length;
    $("count-label").textContent = active ? `${active} 进行中` : attention ? `${attention} 待处理` : String(eligible.length);
    $("count-compact").textContent = String(active || attention || eligible.length);
    $("count").title = active ? `${active} 个升级任务进行中` : attention ? `${attention} 台机器需要检查升级记录` : `${eligible.length} 台机器可升级`;
    $("count").classList.toggle("update-warning", Boolean(attention));
    $("job-count").textContent = `${current?.jobs.length || 0} 条${active ? ` · ${active} 进行中` : ""}${attention ? ` · ${attention} 待处理` : ""}`;
  }
  async function bootstrap(node) {
    if (working) return;
    const warning = node.enrolled
      ? "重新接入会撤销该升级器的旧凭据。只在这台机器的 OS owner 下重新安装，不会更新应用。继续？"
      : "下载包含此机器专用的升级器凭据，请勿分享。需在机器上由 OS owner 安装；此操作不会更新应用。继续？";
    if (!window.confirm(warning)) return;
    working = true; controls();
    try {
      const response = await fetch(`/api/settings/updates/bootstrap/${encodeURIComponent(node.id)}`, {
        method: "POST", credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store",
        referrerPolicy: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "enable-node-updater", replace: node.enrolled }),
      });
      if (response.status === 401) { window.location.replace("/portal-auth/login"); throw new Error("请重新登录"); }
      if (!response.ok) throw new Error((await response.json()).error || "下载失败");
      const filename = response.headers.get("content-disposition")?.match(/^attachment;\s*filename="(codey-updater-[a-z0-9_-]+\.zip)"$/)?.[1];
      if (!filename || response.headers.get("content-type") !== "application/zip") throw new Error("无效的升级器安装包");
      const blob = await response.blob();
      if (!blob.size || (response.headers.get("content-length") && Number(response.headers.get("content-length")) !== blob.size)) {
        throw new Error("安装包下载不完整");
      }
      const url = URL.createObjectURL(blob);
      const link = element("a");
      link.href = url; link.download = filename;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      notice("安装包已下载。在对应机器上阅读 UPGRADE.md 并运行 install.py；不要重新运行新机器 enrollment。");
    } catch (error) { notice(error.message, true); }
    finally { working = false; await refresh(false); }
  }
  function render() {
    const focusedId = root.contains(document.activeElement) ? document.activeElement?.id : null;
    const openMenus = new Set([...root.querySelectorAll(".updater-menu[open]")].map((menu) => menu.dataset.nodeId));
    controls();
    $("list").replaceChildren();
    if (!current.nodes.length) $("list").append(element("p", "还没有可管理的机器，请先在“我的节点”中添加。", "empty-state muted"));
    for (const node of current.nodes) {
      const row = element("div", null, "node-update-row");
      const label = element("label", null, "node-update-select");
      const check = element("input"); check.type = "checkbox"; check.checked = selected.has(node.id);
      check.setAttribute("id", `node-update-check-${node.id}`);
      check.disabled = working || !eligibility(node);
      check.setAttribute("aria-label", `选择 ${node.name} 更新`);
      check.addEventListener("change", () => { check.checked ? selected.add(node.id) : selected.delete(node.id); controls(); });
      label.append(check, element("strong", node.name));
      const components = node.report?.components;
      const info = element("div", null, "node-update-info");
      info.append(element("span", `CloudCLI ${components?.cloudcli?.version || "未知"} · copilot-api ${components?.copilotApi?.version || "未知"}`, "muted"));
      const status = element("span", null, "update-status");
      status.append(element("span", node.connected ? "升级器在线" : node.enrolled ? "离线/等待首次连接" : "未接入", "muted"));
      if (node.reason) status.append(element("span", labels[node.reason] || node.reason, "muted"));
      if (node.activeJob) status.append(element("span", labels[node.activeJob.state] || node.activeJob.state, "update-badge"));
      info.append(status);
      row.append(label, info);
      const actions = element("div", null, "update-actions");
      const update = element("button", "更新此机器"); update.type = "button"; update.disabled = working || !eligibility(node);
      update.setAttribute("id", `node-update-button-${node.id}`);
      update.addEventListener("click", () => preview([node.id]));
      actions.append(update);
      if (!node.protected && node.updaterSupported !== false) {
        const menu = element("details", null, "updater-menu");
        menu.dataset.nodeId = node.id;
        menu.open = openMenus.has(node.id);
        const summary = element("summary", "管理");
        summary.setAttribute("id", `node-update-menu-${node.id}`);
        summary.setAttribute("aria-label", `${node.name} 的升级器管理`);
        const items = element("div", null, "updater-menu-items");
        const install = element("button", node.enrolled ? "重新接入升级器" : "接入升级器");
        install.setAttribute("id", `node-update-install-${node.id}`);
        install.type = "button"; install.disabled = working || !current.enabled || Boolean(node.activeJob);
        install.addEventListener("click", () => { menu.open = false; return bootstrap(node); });
        items.append(install);
        if (node.enrolled) {
          const revoke = element("button", "停用升级器", "danger"); revoke.type = "button"; revoke.disabled = working;
          revoke.setAttribute("id", `node-update-revoke-${node.id}`);
          revoke.addEventListener("click", async () => {
            if (working) return;
            if (!window.confirm("撤销此升级器凭据并取消未开始的任务？不会关机或删除服务。正在切换的机器需等本地事务恢复后检查。")) return;
            menu.open = false;
            working = true; controls();
            try {
              await api(`/api/settings/updates/revoke/${encodeURIComponent(node.id)}`, { confirmation: "disable-node-updater" });
              notice("升级器授权已撤销；未停止机器服务。");
            } catch (error) { notice(error.message, true); }
            finally { working = false; await refresh(false); }
          });
          items.append(revoke);
        }
        menu.append(summary, items);
        actions.append(menu);
      }
      row.append(actions); $("list").append(row);
    }
    $("jobs").replaceChildren();
    $("history").hidden = !current.jobs.length;
    for (const job of [...current.jobs].reverse().slice(0, 30)) {
      const row = element("p", `${current.nodes.find((node) => node.id === job.nodeId)?.name || job.nodeId} · ${job.releaseId} · ${labels[job.state] || job.state}${job.code && job.code !== "ok" ? " · " + (labels[job.code] || job.code) : ""}`,
        ["failed", "rolled_back", "needs_action", "needs_migration"].includes(job.state) ? "update-warning" : "muted");
      $("jobs").append(row);
    }
    controls();
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }
  async function refresh(showMessage = true) {
    clearTimeout(timer);
    try {
      const value = $("release").value;
      current = await api("/api/settings/updates");
      $("release").replaceChildren();
      for (const release of current.releases) {
        const option = element("option", `${release.id} · ${Object.entries(release.components).map(([name, item]) => `${name} ${item.version}`).join(" / ")}`);
        option.value = release.id; $("release").append(option);
      }
      if (!current.releases.length) {
        const option = element("option", "暂无可用发行版");
        option.value = ""; $("release").append(option);
      }
      if (current.releases.some((release) => release.id === value)) $("release").value = value;
      render();
      if (showMessage) notice(current.reason || "先预览版本与目标机器，再确认升级。已接入的离线节点可以等待上线。");
    } catch (error) { notice(error.message, true); }
    finally {
      if (current?.jobs.some((job) => !terminal.has(job.state))) timer = window.setTimeout(() => refresh(false), 5000);
    }
  }
  async function preview(nodeIds) {
    if (working || !target()) return;
    working = true; controls();
    try {
      plan = await api("/api/settings/updates/plans", { nodeIds, releaseId: target().id });
      $("plan-note").textContent = `${plan.releaseId}：${plan.notes || ""}\n${plan.warning}`;
      $("plan-targets").replaceChildren();
      for (const node of plan.targets) $("plan-targets").append(element("p",
        `${node.name}：${node.eligible ? `${node.verificationOnly ? "包未变化，仅验收模型，不重启" : "更新 " + node.changed.join("、")}${node.deferred ? "（等待上线）" : ""}` : labels[node.reason] || node.reason}`));
      $("plan-error").textContent = "";
      $("confirm").showModal();
    } catch (error) { notice(error.message, true); }
    finally { working = false; controls(); }
  }
  $("cancel").addEventListener("click", () => { plan = null; $("confirm").close(); controls(); });
  $("apply").addEventListener("click", async () => {
    if (working || !plan) return;
    working = true; controls();
    try {
      const result = await api("/api/settings/updates/jobs", { planId: plan.id, confirmation: "update-reviewed-machines" });
      notice(`已提交 ${result.jobs.length} 台机器的升级任务；这不代表升级已完成。`);
      $("confirm").close(); plan = null;
      await refresh(false);
      $("history").open = true;
    } catch (error) { $("plan-error").textContent = error.message; }
    finally { working = false; controls(); }
  });
  $("selected").addEventListener("click", () => preview([...selected]));
  $("all").addEventListener("click", () => preview(current.nodes.filter(eligibility).map((node) => node.id)));
  $("refresh").addEventListener("click", () => refresh());
  $("release").addEventListener("change", render);
  $("confirm").addEventListener("close", () => { plan = null; controls(); });
  document.addEventListener("settings-panel-change", (event) => {
    if (event.detail === "machine-updates" && !working) void refresh(false);
  });
  document.addEventListener("click", (event) => {
    for (const menu of root.querySelectorAll(".updater-menu[open]")) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const menu of root.querySelectorAll(".updater-menu[open]")) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(false); });
  void refresh();
}
