---
name: codey-deploy
description: 快速发布 Codey 的 ACA Portal/MCP、共享 Workspace UI 和 jpe2/jpe3/zhn-a100/westus2 四个既有远程节点，计时并验证 Codey/Codex 真实模型调用。用于全量更新、部署提速和发布验收；不用于新节点接入、认证迁移或本地 copilot-api 升级。
---

# Codey deploy

使用随 Skill 保存的发布器，不再为每次发布临时编写脚本。常规目标为 **端到端小于 600 秒**，实际时间以 `report.json` 为准，不能把准备、构建、传输或失败重试排除后宣称达标。

## 授权和边界

- 用户明确要求部署/更新或 E2E 实际发布后，才使用 `--apply`。只要求审计、估时或编写方案时，不执行发布。
- **Windows 本地 copilot-api 受保护**：不安装、更新、停止或重启。发布器前后核对本地 4141 的 PID、进程路径和启动时间。
- 仅更新四个既有远程节点的 CloudCLI 和 copilot-api 包；保留 Node/Codex 安装、认证、TLS、SSO、systemd 配置和用户数据。不自动升级全局 CLI。
- 独立模型 API key 必须已迁移完成。缺少 key、调用方未加载 key 或节点正在运行任务时，停止并报告具体前置条件；不取消任务，不放宽鉴权。
- 默认拉取 `origin/main`、CloudCLI `origin/main`、copilot-api `origin/dev` 到发布专用 ref，从 Git archive 构建。**不 checkout/reset/stash/clean 开发工作树，不替用户提交或推送。** 未提交改动默认不发布；明确授权的根仓库冻结快照模式允许例外。
- MCP 测试套件按用户要求**暂时跳过**，不删除测试。MCP 镜像构建、ACA 容器就绪和实际侧车 HTTP 健康探测仍必需。

## 一条发布命令

控制机：Windows，默认工作区 `Q:\codex_manager`。现有 SSH 别名必须能以 `zhn` 连接四个节点。

构建机：`westus2`，已有 checkout `/home/zhn/g/codey`、Azure CLI 登录以及 `/opt/az/bin/python3` 的 Azure Files SDK。目标来自该 checkout 的 `config/workspace-ui-publish.json`；不创建云资源或更改订阅/网络/身份。

先运行离线发布器检查，再执行实际发布：

```powershell
python <skill-dir>/scripts/test_deploy.py
python <skill-dir>/scripts/deploy.py --workspace Q:\codex_manager --apply --target-seconds 600
```

用户要求跳过忙碌机器时显式选择，例如 `--nodes zhn-a100 jpe3 westus2`。
被跳过的 jpe2 不安装/更新升级器，不排队升级或运行模型验收；不要因“全量”默认值覆盖
用户的新指示。共享 ACA/UI 仍正常发布，报告会分别列出 selectedNodes / skippedNodes。

默认使用 `--node-transport updater`：签名发行包一次发布到私有共享存储，由独立节点
升级器拉取。首次显式全量部署会为本人拥有的四台节点安装升级器，不重启两个应用；
以后只发布并确认任务，无需逐台 SSH 更新应用。只有尚未接入升级器的旧机器才能显式
使用 `--node-transport ssh`；已接入后禁止旧切换器覆盖新指针。
发布器也比较已冻结源码中的升级器实现：相同则不重启升级器，已审核的补丁则通过
SSH 只更新独立升级器并复用该节点本地凭据；有未结束的升级事务时拒绝覆盖。
这不是由页面任意下发代码的自升级接口，两个应用的服务和模型配置保持不变。

首次使用可通过 `--seed <构建机上已全测通过的发布目录>` 导入**相同 lockfile、Node 24 ABI** 的旧构建依赖缓存。这只复用依赖，不复用测试结论，也不跳过本轮镜像构建和验收。后续自动使用 `artifacts/codey-deploy-cache`，不必继续传 seed。不同 lockfile/ABI 走冷安装。

### 只更新 ACA Portal

用户只要求更新门户/ACA 时，**不要运行默认四节点全量模式**：

```powershell
python <skill-dir>/scripts/deploy.py --scope portal --apply --target-seconds 600
```

仅更新 Portal 镜像，保留 MCP 镜像、共享 UI、远程节点的包和进程。验证生产静态文件、
导航开关、Workspace SSO/Usage、实际 MCP 侧车健康，以及本地/远程进程未变。
该模式不重新执行模型推理；不能把上次模型测试计为本轮测试。

### 只更新 Workspace 前端及所选节点 CloudCLI

CloudCLI 前后端功能更新、不涉及 Portal/MCP 或 copilot-api 时，使用最小组件范围：

```powershell
python <skill-dir>/scripts/deploy.py --scope workspace --nodes zhn-a100 --apply --verify-steering
```

- 只签名/分发 `cloudcli` 组件，共享 UI 发布一次；不构建或部署 ACA/MCP 镜像，
  不更新 copilot-api、Node、Codex，默认也不更换独立升级器。
- 仅支持已经接入升级器的节点。必须同时核对 Codey running sessions 和原生
  Codex daemon 已加载任务；忙碌或未知状态不确认升级。
- `--verify-steering` 仅用于同轮插话功能，追加一次独立合成会话的真实插话验证：
  一次 `chat.send`、一次带旧轮次 token 的 `chat.steer`、原轮次返回新 marker。
  不重复通用 Codey/Codex 连通性验收；该额外功能验证单独记录。
- 可用 `--expected-cloudcli-commit <完整 SHA>`、`--expected-portal-commit <完整 SHA>`
  锁定已审核的远端源码，远端变化即停止，不夹带工作树改动。
- 保留未选择节点及所有 copilot-api 的 PID/启动时间，核对 ACA 修订不变；
  共享 UI 成功发布不代表其它节点的后端也已更新。
- 失败事务已回滚且无未完成 job 后，可明确使用 `--resume-release <原 release>`
  重试同一已验证、已签名的应用包，不重复构建/签名或启动整个发布。
  若根因是已审查并测试的升级器缺陷，再附加 `--refresh-updater`：
  只安装所选节点的升级器代码，复用本地凭据，核对应用 PID 不变。
  旧失败报告、job 记录和诊断间隔均保留在同一发布的总耗时内。
  并行 ACA 重启导致修订号变化时，先确认其已就绪；只有镜像、配置及共享 UI
  完全相同才可加 `--reconcile-aca` 接受纯 `revisionSuffix` 变化。
  原始基线另存留档；真实配置变化或未就绪的发布仍拒绝，不回退另一发布者。

当用户明确要求“修改本地代码并部署”，且提交尚未获准或明确要求部署后才提交时，先审阅全部本地变更；
仅确认这些改动都属于本次授权范围后，附加 `--reviewed-working-tree`。它使用独立临时
Git index 生成不可变 tree/archive，不改真实 index、不创建 commit、不 push。
报告记录 Git 基线、tree SHA、压缩包 SHA-256 和文件清单；远端 main 若已前进则停止。
此模式支持 Portal-only 和新版 updater 全量部署；仅冻结根仓库，子模块仍取明确的远程 ref。
不要用这个选项夹带无关的 dirty 文件，也不要把工作树快照描述为已提交的源码。
已上线的快照尚未提交时，下次常规 origin 发布可能回退这些功能；必须先提醒用户提交/
推送，或取得明确的回退授权，不能默默覆盖该快照。

## 固定执行流程

1. 记录完整开始时间及本地受保护进程；并行获取干净源码快照、ACA 基线、节点基线和已认证的任务空闲状态。
2. Portal、CloudCLI、copilot-api 的检查/测试各做一次；CloudCLI 后端只编译一次。Portal/MCP 镜像并行构建，用唯一 tag 解析不可变 digest，不依赖 `az acr build --no-wait` 返回 run ID。
3. 对两个预编译包签名，校验后发布到已有 `session-data/node-updates`，最后原子更新 catalog。签名私钥只存在构建机 `~/.config/codey-node-release-signing/`，不进 ACA/Git/节点。当前四节点已验证的矩阵是 CloudCLI Node 22/24、gateway Node 22/24/26；新版本需重新核对，不能盲目扩大支持矩阵。
4. 并行更新 ACA 与共享 UI。首次启用只额外添加两个 `PORTAL_NODE_UPDATE_*` 路径，复用既有 `/data` 挂载，不改网络/身份/其他配置；后续保留。未绑定的既有节点通过 owner API 下载私密引导包，SSH 只安装独立 Python 升级器，并核对两个应用 PID 未变。使用健康的既有 Python 3.12+，`-I -S` 排除 CWD/PYTHONPATH/site 定制；诊断脚本也必须隔离并只加入已审核的模块目录，不从用户 HOME 隐式导入 `copy.py` 等文件。不修补/升级全局解释器。
5. 用与页面相同的 owner API 预览并确认四台。第一台空闲上线者作为 canary；成功才放行其余，最多三台并发。只更新变化的组件；相同 lockfile/安装指纹复用依赖，否则锁定生产安装。包完全相同时不重启，但新签名发行版仍执行 Codey/Codex 真调用。失败只回退本次代码和版本标记，未知/API key 迁移不硬闯。
6. 最后统一验收：ACA 指定修订和实际 MCP 健康、四节点 UI/SSO/Usage/鉴权与本地进程未变。正常新发行版共 **4 次 Codey + 4 次 Codex**，由节点升级器执行并归档合成会话；不要再额外重复调用。已验收的相同发行版 no-op 不算本轮新模型测试。
7. 撤销临时门户登录会话、归档合成 Codey 测试会话、释放自己持有的发布锁，然后**立即报告结果**，不追加与验收无关的审计。

真实模型探测只使用独立测试目录，禁止工具和文件操作；Codex CLI 使用 `--ephemeral`、只读沙箱和无审批模式。门户凭据只在构建机进程内存中使用，不传回控制机、不写日志。

## 结果和异常处理

- 控制机的 `Q:\codex_manager\artifacts\codey-deploy-current.txt` 指向本次目录；其中 `report.json` 包含总耗时、逐阶段耗时、源码 SHA、镜像 digest、节点结果和 E2E。
- 构建机对应目录：`/home/zhn/g/codey/artifacts/<release>`。
- 每节点升级事务：`~/.local/share/codey-updater/jobs/<jobId>`，私密状态在 `~/.config/codey-updater`。控制端 `node-update-*.json` / 构建端 progress 记录计划、状态和时长；页面同样可跟进。旧 SSH 部署记录仍保留在 `/home/zhn/.local/share/codey-deploy/<release>`。
- 节点副作用的前提是新鲜认证空闲证明、无模型连接和基线未漂移。若报 busy/concurrent change，不改保护条件硬闯；查明后重新生成基线并重新计时。
- ACA PATCH 后可能短暂读到旧修订；等待目标修订，不把旧读取误判为模板漂移，不重复 PATCH。超时检查当前/就绪修订与该 run 的 `aca-rollback.json`，不得覆盖另一发布者的更新。
- 发布器返回非零可能表示功能失败，也可能是已经成功但超过 600 秒。分别查看 `status`、`withinTarget` 和 `totalSeconds`，如实报告。恢复/收尾的时间同样计入，不能为了计时强杀事务。
- 不自动重试整个发布。先定位失败阶段；若新的 E2E 尝试，必须保留上一次失败和耗时，不能只汇报最快的一次。
- 已创建的升级任务必须先按原 job ID 收尾，不重复提交。超时不能为了 600 秒强杀独立事务；忙碌任务需用户完成，模型失败需定位凭据/兼容性后显式重试。
- 不偷锁、不清缓存、不删除旧版本。特别是 `node_modules` 可能指向旧 release；只有确认没有依赖引用并另外获得清理授权，才能清理。

有关已实测的结果和优化边界，参见 [references/validation.md](references/validation.md)。
