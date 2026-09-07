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
- 拉取 `origin/main`、CloudCLI `origin/main`、copilot-api `origin/dev` 到发布专用 ref，从 Git archive 构建。**不 checkout/reset/stash/clean 开发工作树，不发布未提交改动，不替用户提交或推送。**
- MCP 测试套件按用户要求**暂时跳过**，不删除测试。MCP 镜像构建、ACA 容器就绪和实际侧车 HTTP 健康探测仍必需。

## 一条发布命令

控制机：Windows，默认工作区 `Q:\codex_manager`。现有 SSH 别名必须能以 `zhn` 连接四个节点。

构建机：`westus2`，已有 checkout `/home/zhn/g/codey`、Azure CLI 登录以及 `/opt/az/bin/python3` 的 Azure Files SDK。目标来自该 checkout 的 `config/workspace-ui-publish.json`；不创建云资源或更改订阅/网络/身份。

先运行离线发布器检查，再执行实际发布：

```powershell
python <skill-dir>/scripts/test_deploy.py
python <skill-dir>/scripts/deploy.py --workspace Q:\codex_manager --apply --target-seconds 600
```

首次使用可通过 `--seed <构建机上已全测通过的发布目录>` 导入**相同 lockfile、Node 24 ABI** 的旧构建依赖缓存。这只复用依赖，不复用测试结论，也不跳过本轮镜像构建或节点切换。后续自动使用 `artifacts/codey-deploy-cache`，不必继续传 seed。不同 lockfile/ABI 走冷安装。

## 固定执行流程

1. 记录完整开始时间及本地受保护进程；并行获取干净源码快照、ACA 基线、节点基线和已认证的任务空闲状态。
2. Portal、CloudCLI、copilot-api 的检查/测试各做一次；CloudCLI 后端只编译一次。Portal/MCP 镜像并行构建，用唯一 tag 解析不可变 digest，不依赖 `az acr build --no-wait` 返回 run ID。
3. 单次下载两个带 SHA-256 的包，再并行分发/暂存四台节点。节点不重复编译或全测。相同 lockfile 且复用原运行时的节点复用本机已工作的依赖；否则只安装锁定的生产依赖。
4. `zhn-a100` 作为 canary：重新确认空闲、在线备份数据库、切换包、验证 TLS/鉴权，再各做一次原生 Codex CLI 和 Codey WebSocket 真实模型调用。
5. canary 通过后，并行更新 ACA、发布共享 UI，以及激活另外三个节点。ACA 只改两个容器的 image 和 revision suffix；共享 UI 使用已有发布器的锁、校验和原子 active 指针，保留旧资源。
6. 最后一次统一验收：ACA 指定修订就绪、实际 MCP 容器健康、四节点 UI/SSO/Usage/鉴权、另外三台的 Codey/Codex 真调用、本地进程未变。总计 **4 次 Codey + 4 次 Codex**，不重复 canary 的模型探测。
7. 撤销临时门户登录会话、归档合成 Codey 测试会话、释放自己持有的发布锁，然后**立即报告结果**，不追加与验收无关的审计。

真实模型探测只使用独立测试目录，禁止工具和文件操作；Codex CLI 使用 `--ephemeral`、只读沙箱和无审批模式。门户凭据只在构建机进程内存中使用，不传回控制机、不写日志。

## 结果和异常处理

- 控制机的 `Q:\codex_manager\artifacts\codey-deploy-current.txt` 指向本次目录；其中 `report.json` 包含总耗时、逐阶段耗时、源码 SHA、镜像 digest、节点结果和 E2E。
- 构建机对应目录：`/home/zhn/g/codey/artifacts/<release>`。
- 每节点：`/home/zhn/.local/share/codey-deploy/<release>`；包切换失败自动回滚**本次**代码和版本标记，不恢复旧数据库或凭据。
- 节点副作用的前提是新鲜认证空闲证明、无模型连接和基线未漂移。若报 busy/concurrent change，不改保护条件硬闯；查明后重新生成基线并重新计时。
- ACA PATCH 后可能短暂读到旧修订；等待目标修订，不把旧读取误判为模板漂移，不重复 PATCH。超时检查当前/就绪修订与该 run 的 `aca-rollback.json`，不得覆盖另一发布者的更新。
- 发布器返回非零可能表示功能失败，也可能是已经成功但超过 600 秒。分别查看 `status`、`withinTarget` 和 `totalSeconds`，如实报告。恢复/收尾的时间同样计入，不能为了计时强杀事务。
- 不自动重试整个发布。先定位失败阶段；若新的 E2E 尝试，必须保留上一次失败和耗时，不能只汇报最快的一次。
- 不偷锁、不清缓存、不删除旧版本。特别是 `node_modules` 可能指向旧 release；只有确认没有依赖引用并另外获得清理授权，才能清理。

有关已实测的结果和优化边界，参见 [references/validation.md](references/validation.md)。
