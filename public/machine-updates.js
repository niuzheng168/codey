const root = document.querySelector("#machine-updates");
const element = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text != null) item.textContent = text;
  if (className) item.className = className;
  return item;
};
const terminal = new Set(["succeeded", "failed", "rolled_back", "needs_action", "needs_migration", "cancelled"]);
const codeyRelease = (release) => Boolean(release?.components?.codey) && Object.keys(release.components).length === 1;
const packageKey = release => ["version", "file", "size", "sha256", "commit", "entrySha256", "lockSha256"]
  .map(key => release.components.codey[key] ?? "").join(":");
const platformLabel = platform => ({ "windows-x64": "Windows x64", "linux-x64": "Linux x64",
  "macos-arm64": "macOS Apple Silicon", "macos-x64": "macOS Intel" })[platform] ?? platform;
const labels = {
  queued: "已排队", claimed: "已领取", downloading: "下载校验中", staging: "准备候选版本",
  waiting_idle: "等待任务空闲", applying: "切换中", verifying: "验收中", succeeded: "升级成功",
  failed: "升级失败", rolled_back: "已恢复旧版本", needs_action: "需要人工处理",
  needs_migration: "需要配置迁移", cancelled: "已取消",
  needs_setup: "尚未接入升级器", protected_local: "受保护节点", no_release: "暂无 Codey 发行版",
  needs_codey_migration: "需先迁移到 Codey npm 包", updater_unavailable: "升级服务尚未配置",
  up_to_date: "已是目标版本", unsupported_platform: "平台不支持", runtime_incompatible: "Node 运行时不兼容",
  release_platform_unavailable: "此版本尚未向该平台开放",
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
  let refreshing = null;
  let authenticated = true;
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
    if (response.status === 401) { authenticated = false; window.location.replace("/portal-auth/login"); throw new Error("请重新登录"); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  const target = () => current?.releases.find((release) => release.id === $("release").value);
  const targetFor = node => target()?.variants.find(release => release.platform === (node.platform ?? node.report?.platform));
  function eligibilityReason(node) {
    const release = targetFor(node);
    if (node.protected) return "protected_local";
    if (node.updaterSupported === false) return "unsupported_platform";
    if (!node.enrolled || !node.report) return "needs_setup";
    if (node.activeJob) return "job_active";
    if (node.report.blockedReason) return node.report.blockedReason;
    if (node.report.layout === "unsupported") return "configuration_changed";
    if (node.report.layout !== "npm" || !node.report.components?.codey) return "needs_codey_migration";
    if (!current?.enabled) return "updater_unavailable";
    if (!target()) return "no_release";
    if (!release) return "release_platform_unavailable";
    if (node.report.platform !== release.platform) return "configuration_changed";
    if (node.report.highestSequence > release.sequence) return "downgrade_blocked";
    if (release.migrations.some((id) => !node.report.readyMigrations.includes(id))) return "model_auth_migration_required";
    if (!release.components.codey.nodeMajors.includes(node.report.components.codey.nodeMajor)) return "runtime_incompatible";
    const installed = node.report.components.codey;
    const wanted = release.components.codey;
    return node.report.highestSequence < release.sequence || node.report.currentRelease !== release.id ||
      installed.entrySha256 !== wanted.entrySha256 || installed.commit !== wanted.commit || installed.version !== wanted.version
      ? null : "up_to_date";
  }
  const eligibility = (node) => eligibilityReason(node) === null;
  function controls() {
    const eligible = current?.nodes.filter(eligibility) || [];
    for (const id of selected) if (!eligible.some((node) => node.id === id)) selected.delete(id);
    $("selected").disabled = working || !selected.size;
    $("all").disabled = working || !eligible.length;
    $("release").disabled = working || !current?.releases.length;
    $("download").disabled = working || !target();
    const component = target()?.components.codey;
    $("download-info").textContent = component?.file
      ? `${component.file} · ${(component.size / 1024 / 1024).toFixed(2)} MiB · 已开放：${target().variants.map(release => platformLabel(release.platform)).join("、")} · SHA-256: ${component.sha256}` : "";
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
  $("download").addEventListener("click", async () => {
    const release = target();
    if (working || !release) return;
    const component = release.components.codey;
    working = true; controls();
    try {
      const response = await fetch(`/api/settings/updates/releases/${encodeURIComponent(release.id)}/codey.tgz`, {
        credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store",
        referrerPolicy: "same-origin",
      });
      if (response.status === 401) { authenticated = false; clearTimeout(timer); window.location.replace("/portal-auth/login"); throw new Error("请重新登录"); }
      if (!response.ok) throw new Error((await response.json()).error || "下载失败");
      if (response.headers.get("content-type") !== "application/gzip" ||
          response.headers.get("content-disposition") !== `attachment; filename="${component.file}"`) {
        throw new Error("更新包响应与所选发行版不一致");
      }
      const bytes = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        byte => byte.toString(16).padStart(2, "0")).join("");
      if (bytes.byteLength !== component.size || digest !== component.sha256) throw new Error("更新包大小或 SHA-256 不匹配");
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/gzip" }));
      const link = element("a");
      link.href = url; link.download = component.file;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      notice(`${component.file} 已下载并通过 SHA-256 校验；未提交任何节点升级任务。`);
    } catch (error) { notice(error.message, true); }
    finally { working = false; controls(); }
  });
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
      if (response.status === 401) { authenticated = false; clearTimeout(timer); window.location.replace("/portal-auth/login"); throw new Error("请重新登录"); }
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
      notice(node.platform === "windows-x64"
        ? "安装包已下载。在对应 Windows 的原用户、非管理员 PowerShell 中阅读 UPGRADE.md，先运行 install.ps1 检查，再加 -Apply 接入；不会重装 Codey。"
        : node.platform?.startsWith("macos-")
          ? "安装包已下载。在对应 Mac 的原登录用户终端中阅读 UPGRADE.md，使用原安装器的 Python 运行 install.py 检查，再加 --apply 接入；不要 sudo，也不要重装或重新注册节点。"
        : "安装包已下载。在对应机器上阅读 UPGRADE.md 并运行 install.py；不要重新运行新机器 enrollment。");
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
      info.append(element("span", components?.codey?.version
        ? `Codey ${components.codey.version}` : "Codey 版本未上报", "muted"));
      const status = element("span", null, "update-status");
      status.append(element("span", node.connected ? "升级器在线" : node.enrolled ? "离线/等待首次连接" : "未接入", "muted"));
      const lastJob = current.jobs.findLast(job => job.nodeId === node.id);
      if (lastJob && terminal.has(lastJob.state)) {
        status.append(element("span", `${labels[lastJob.state] || lastJob.state}${lastJob.code && !["ok", "up_to_date"].includes(lastJob.code) ? ` · ${labels[lastJob.code] || lastJob.code}` : ""}`,
          lastJob.state === "succeeded" ? "muted" : "update-warning"));
      }
      if (lastJob && terminal.has(lastJob.state) && (!node.lastSeen || node.lastSeen <= lastJob.updatedAt)) {
        status.append(element("span", "任务已结束，等待版本心跳刷新", "muted"));
      }
      if (node.lastSeen) info.append(element("span", `最近联系：${new Date(node.lastSeen).toLocaleTimeString()}`, "muted"));
      const reason = eligibilityReason(node);
      if (reason) status.append(element("span", labels[reason] || reason, "muted"));
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
  function scheduleRefresh() {
    clearTimeout(timer);
    if (!document.hidden && authenticated) {
      const active = current?.jobs.some(job => !terminal.has(job.state));
      timer = window.setTimeout(() => refresh(false), active ? 5000 : 10000);
    }
  }
  async function refresh(showMessage = true) {
    if (refreshing) return refreshing;
    clearTimeout(timer);
    if (working || $("confirm").open) { scheduleRefresh(); return; }
    refreshing = load(showMessage);
    try { await refreshing; } finally { refreshing = null; scheduleRefresh(); }
  }
  async function load(showMessage) {
    try {
      const value = $("release").value;
      const previousKey = target() && packageKey(target());
      const snapshot = await api("/api/settings/updates");
      if (working || $("confirm").open) return;
      // Legacy releases remain in the service catalog, but are not UI update targets.
      const groups = new Map();
      for (const release of snapshot.releases.filter(codeyRelease).sort((a, b) => b.sequence - a.sequence)) {
        const key = packageKey(release);
        if (!groups.has(key)) groups.set(key, { ...release, variants: [] });
        const variants = groups.get(key).variants;
        if (!variants.some(row => row.platform === release.platform)) variants.push(release);
      }
      current = { ...snapshot, releases: [...groups.values()] };
      $("release").replaceChildren();
      for (const release of current.releases) {
        const collision = current.releases.some(row => row !== release &&
          row.components.codey.version === release.components.codey.version);
        const option = element("option", `Codey ${release.components.codey.version}${collision ? ` · ${release.components.codey.sha256.slice(0, 12)}` : ""}`);
        option.value = release.id; $("release").append(option);
      }
      if (!current.releases.length) {
        const option = element("option", "暂无 Codey 发行版");
        option.value = ""; $("release").append(option);
      }
      const retained = current.releases.find(release => packageKey(release) === previousKey || release.id === value);
      if (retained) $("release").value = retained.id;
      render();
      if (showMessage) notice(current.reason || (current.releases.length
        ? "仅更新 Codey 整包。先预览版本与目标机器，再确认升级；离线节点可以等待上线。"
        : "尚未发布 Codey npm 整包发行版；旧版组件发行版不会作为更新目标。"));
    } catch (error) { notice(error.message, true); }
  }
  async function preview(nodeIds) {
    if (working || !target()) return;
    const release = target();
    plan = null;
    working = true; controls();
    try {
      const result = await api("/api/settings/updates/plans", { nodeIds, releaseId: release.id });
      if (!codeyRelease(result) || result.releaseId !== release.id) throw new Error("更新计划与 Codey 整包发行版不一致，请刷新后重新预览");
      plan = result;
      $("plan-note").textContent = `Codey ${plan.components.codey.version}：按各机器平台匹配同一应用包。\n${plan.warning}`;
      $("plan-targets").replaceChildren();
      for (const node of plan.targets) $("plan-targets").append(element("p",
        `${node.name}${node.platform ? ` · ${platformLabel(node.platform)}` : ""}：${node.eligible ? `${node.verificationOnly ? "Codey 包未变化，仅验收模型，不重启" : "更新 Codey 整包"}${node.deferred ? "（等待上线）" : ""}` : labels[node.reason] || node.reason}${node.notes ? ` · ${node.notes}` : ""}`));
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
      working = false;
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
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer);
    else void refresh(false);
  });
  void refresh();
}
