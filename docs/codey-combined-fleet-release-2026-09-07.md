# 合并修复与四节点升级：2026-09-07

本批次按用户授权包含：

1. Foundry `gpt-5.6-luna` 输入补全、桌面/手机采纳和撤销。
2. 实时消息快照按稳定 ID 更新，避免同一回复重复显示。
3. Codex 每轮开始时同步用户明确选择的权限；不修改正在运行的 turn，
   不自动回答桌面审批，也不在权限被拒绝时回退执行。

## 源码与产物

- CloudCLI：`a9bded2982592297cdbca986d5819b3b83e5ae12`，
  包含前置修复 `bf5ef68`、`2a7a2c8`；已推送到原有 public fork。
- 主仓库功能提交：`2f1a3b356452f5096a84a2079af60bbfd6e0937b`，已推送。
- 共享 UI：`ui-20260907t031424z-combined`，2026-09-07 `03:44:48 UTC`
  发布一次，四节点使用同一个包。
- UI manifest SHA-256：
  `1e100c2c2c4418254b0ce165d1137ed830b3729c45d8a821d9a0b35c37955e14`。
- 节点后端 release：`20260907-031424-completion-permissions`。
- 后端补丁 manifest SHA-256：
  `cb64c4255223e347b982e5010d485a311d75d6651c64eec2f526fe37ebf6e8cb`。

Portal 补全代码已经与本批次一致，因此保留健康修订
`codey--completion-3s-0907023744`，不重复重建或重启 Portal。
没有更新无关的 Copilot 网关、Codex 二进制、依赖或用户凭据。

## 升级与回滚机制

四台机器都先从自己的现有 release 建立候选，保留已安装依赖、TLS/SSO、
服务单元和旧静态资源。实际后端差异仅两个 TypeScript 文件及对应 JS/source map，
共六个文件；同时验证完整的 804 个后端源文件和编译文件，而非仅检查补丁。

每台候选都通过本机 Node/依赖组合的 26 项 daemon interop 回归。
真实 daemon 探测只请求模型元数据，不读用户线程、不提交模型任务；
探测进程使用独立的内存数据库。

激活前核对运行版本、配置哈希、空闲状态并在线备份 Codey 的 SQLite 数据库，
原子切换 `current`，只重启 `codey-cloudcli.service`。
失败时恢复之前的 release；不编辑 Codex 数据库或其 writer locks。
备份保留在各节点：

```text
~/.local/share/codey-cloudcli/backups/20260907-031424-completion-permissions/
```

## 自托管节点的安全收尾

jpe2 作为 canary，验证通过后升级 A100、jpe3。
westus2 正在运行提出本次升级请求的会话，因此不能用“没有 OS 子进程”
就推断服务空闲。候选已准备并验证，但必须等该 Codey turn 结束。

独立用户单元 `codey-combined-finish-20260907-031424.service` 使用已认证的
运行状态接口等待 westus2 空闲，连续安静至少 12 秒后才切换。
它不强制终止任务；30 分钟仍不空闲或反复验证失败时，保留原服务并报告需要处理。
完成后再次验证四节点 HTTP/SSO/WebSocket、共享资源和临时会话清理。

**最终状态以运维记录为准，不因候选准备完成就声称四节点均已升级：**

```text
artifacts/combined-fleet-release-current.txt
  → deployment-summary.json
```

- `awaiting-westus2`：三个远端已更新，本机等待请求会话结束。
- `activating-westus2` / `verifying-all-nodes`：正在切换或最终验证。
- `complete`：四节点均已升级且最终检查通过。
- `needs-attention`：安全检查或收尾失败，需要查看记录，不能盲目重跑。

## 验证范围

- Portal：129 项测试通过。
- 前端：489 项测试通过。
- 完整后端：436 项通过、1 项既有 legacy fixture 跳过，0 失败。
- Codex 专项：68 项通过、1 项既有跳过；认证/WebSocket 专项 8 项通过。
- 前后端构建、类型检查、Lint 通过；不关闭原检查规则。
- 发布探测不读取真实聊天内容或修改真实草稿、偏好。
  浏览器使用合成业务数据；手机验证为触屏模拟，不代替实机软键盘验收。

临时私有传输 Blob 在候选分发完成后撤销，旧 release 与数据库备份继续保留。
所有构建、运行状态和回滚记录位于忽略目录，不将凭据或临时授权加入 Git。
