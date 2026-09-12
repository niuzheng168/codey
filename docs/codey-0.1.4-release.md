# Codey 0.1.4

## 更新内容

- 以已安装的 Codey 0.1.3 为兼容基线，提供 Linux/Windows x64 的独立本地
  Codey、Codex、DevTunnel 更新入口。原有 `codey update PACKAGE.tgz` 保持包级更新。
- Codex 更新完整 CLI/app-server 发行目录，不更新桌面 App；候选使用隔离 HOME
  检查精确版本和 JSONL 协议，不创建会话或调用模型。
- DevTunnel 更新保留隧道、登录和续期配置，必须显式确认短暂断线。
- 工具包采用逐文件校验和独立 manifest SHA-256；各组件共用互斥、失败回退和
  `codey update --recover`。不覆盖并发部署，不恢复旧密钥或数据库。
- 修复 Windows 更新器的 `$HOME` 只读变量冲突、官方 Codex junction 识别和
  生成回退记录时的配置漂移检查。
- Linux 签名升级验收优先使用 Workspace 明确配置的 `CODEY_CODEX_EXECUTABLE`，
  无效的显式路径不会回退到另一份 CLI。
- 包含已提交的 Workspace `/goal`、`/plan` 原生命令功能，参见
  [命令说明](codey-goal-plan.md)。旧节点未声明支持时明确提示，不当作普通提示词发送。

## 发布与升级边界

一个共享 `codey-0.1.4.tgz` 供 Linux/Windows 使用；安装下载和 Linux 签名 feed
使用同一份包，0.1.3 保留不变。Portal 与共享 Workspace UI 单独发布，不因此
重启或升级节点后端。

现有机器仍需 owner 预览并确认 Codey 升级，或使用外部终端执行本地更新。新版
前端不等于旧节点后端已经具备 `/goal`、`/plan` 或新工具更新器。
Codex/DevTunnel 目前使用本地受审查的工具包，不在 Portal protocol 1 的发行版
选择器中；Windows 拉取 agent 未新增，Windows 更新器仍需目标机器实机验收。

详细操作、工具包制作和恢复步骤见 [本地更新器](codey-local-update.md)。
