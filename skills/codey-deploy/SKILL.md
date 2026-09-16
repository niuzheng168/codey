---
name: codey-deploy
description: "从已审查的 main 发布既有 ACA Portal，或显式授权旧 SSH 节点部署，保留来源、权限与验收边界；不安装新节点或升级代理。"
---

# Codey 发布

使用仓库中已有发布器，不为每次发布临时生成另一套脚本。完整计时包括准备、构建、传输、
重试与验收；目标 600 秒，以 `report.json` 为准，不用排除耗时的口径宣称达标。

## 当前支持范围

- **Portal-only**：构建并发布 ACA Portal，不操作个人节点或模型服务。
- **显式旧 SSH 部署**：仅用于原有拆分应用布局和明确选中的既有节点，不接管 npm/Python/升级代理布局。
- Portal 更新代理、本地更新器以及基于代理的 `workspace`/`updater` 发布、修复、恢复流程已移除。
  不运行默认的旧全量命令，也不自动回退 SSH。新节点使用 `config-new-codey-machine` Skill。

## 授权与来源

- 只有用户明确要求实际部署时才用 `--apply`；代码修改、审计、测试不等于允许发布。
- 生产只接受与选定 `origin/main` 一致的干净 checkout；子模块只取根提交记录的 gitlink，不能独立追踪分支最新版。
  不 checkout/reset/stash/clean 开发工作树，不替用户提交、推送、改版本或在导出源码中热修。
- 保留 main 来源证明、发布器校验、并发漂移检查和失败证据；不使用禁用的 `--reviewed-working-tree` / `portalSnapshot`。
- 复用既有订阅、资源、网络、身份与共享存储，不创建云资源。来源门禁见 [main-only 发布说明](../../docs/main-only-releases.md)。
- `codex-session-share-mcp` 只保留本地参考；不构建、发布 sidecar 或添加其 upstream 配置。

## Portal-only

先验证发布器：

```sh
python3 -B <skill-dir>/scripts/test_deploy.py
```

从既有控制机调用：

```sh
python3 <skill-dir>/scripts/deploy.py --scope portal --apply --target-seconds 600
```

若已经在 Linux 构建 checkout 内，使用本机 worker，不 SSH/SCP 到自己：

```sh
python3 skills/codey-deploy/scripts/deploy.py --workspace /home/zhn/g/codey \
  --remote-root /home/zhn/g/codey --local-builder --scope portal --apply
```

`--local-builder` 仅允许 Portal-only 且两处根目录相同。按顺序完成：固定主分支源码 →
隔离测试与镜像构建 → 检查 ACA 并发漂移 → 单次发布 → 核对指定修订、登录、静态文件和 `/api/version` SHA。

Portal-only 不 SSH、枚举或探测节点，不检查 Workspace/Usage、节点进程或本机 `4141`，
不发模型请求。节点离线不能阻塞 Portal 发布；不把过去的模型测试算成本轮验收。

## 显式旧 SSH 范围

只有用户指定该范围，且目标仍为发布器识别的旧拆分布局时使用：

```sh
python3 <skill-dir>/scripts/deploy.py --scope fleet --node-transport ssh \
  --nodes <已确认的节点别名> --apply --target-seconds 600
```

既有别名为 `zhn-a100`、`jpe2`、`jpe3`、`westus2`；只选择用户确认的节点，不用默认集合扩大范围。
缺少认证、API key、空闲证明或出现未知布局时停止，不取消用户任务、不绕过鉴权。
保留 Node/Codex、TLS、SSO、系统服务配置和数据；Windows 本地 copilot-api 与未选节点受保护。
先预检和暂存，再按原发布器执行灰度、其余节点及经授权的模型验收；不向 npm 节点套用拆分包切换。

## 交付

报告来源提交、实际范围、测试结果、总耗时和 `artifacts/<release>/report.json` 的绝对路径。
失败保留日志、旧包与回滚证据，停止说明具体阻塞；不清理旧事务、恢复旧密钥或自动重跑已退役的代理流程。
开发者发布工具所需 Python/Bun 不代表用户安装 Skill 需要它们。
