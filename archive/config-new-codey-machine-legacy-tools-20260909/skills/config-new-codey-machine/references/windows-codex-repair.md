---
name: repair-windows-codey-codex
description: "修复已接入 Windows Codey 节点因原生 Codex 缓存路径失效而不能聊天的问题。复用原节点、隧道和 runtime；不是首次安装、pre-task Resume 或模型代理升级。"
---

# 修复已接入节点的原生 Codex 路径

适用错误：`The configured native Codex executable is unavailable; no PATH fallback was started.`
这发生在模型请求之前；不是 DevTunnel 登录错误。不要重新登录、重建节点/隧道、
删除历史/锁文件、重跑首次安装、`-Resume`、npm build 或发布 ACA。

## 原机、原 owner 执行

如果包内有 `LOCAL-CODEX-REPAIR.json`，先读其中的 `nodeId`、`expectedComputerName`
和 `releaseId`；脚本也会强制核对这些字段。否则从本 owner 现有
`~/.config/codey-machine-windows/<nodeId>/installation.json` 确认准确节点。
仅支持已完成 (`ready: true`) 的 Windows DevTunnel 安装；不使用别人的 enrollment。
不要展示配置、密钥、环境变量全集或模型代理 token。

必须在该节点原 Windows owner 的**非管理员普通 PowerShell**，或本机独立的 Copilot/Codex
执行环境运行，**不能在 Codey 自己的终端运行 Apply**：重启 Workspace 会结束那个终端及
其修复子进程，导致无法完成。无管理员权限、无新的网络权限要求，不修改执行策略。
有 Mark-of-the-Web 阻止脚本时先核对来源/摘要；只对用户认可的本包脚本使用 `Unblock-File`。

1. 用 `[Environment]::MachineName` 核对目标，检查现有 Python 3.12+。
2. 在原用户 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` 中发现仍存在的 native CLI。
   优先核对报错中旧绝对路径是否已消失，以及当前 Desktop 版本的实际路径。
   将选定的**完整绝对路径**传给 `-CodexExe`；不要改用裸 `codex`、npm shim、WSL 或 PATH fallback。
   包内记录的诊断路径只是一份快照；Desktop 再次更新时重新检查实际文件，不硬编码旧缓存目录。
3. 在本包根目录，按实际身份/路径先运行只读计划：

   ```powershell
   .\scripts\repair-windows-codex.ps1 `
     -NodeId '<现有 n-...>' `
     -ExpectedComputerName '<原计算机名>' `
     -CodexExe '<当前原生 codex.exe 绝对路径>'
   ```

   需要时用 `-PythonExe` 指定已有 Python 的绝对路径。计划验证 owner、ready state、
   node/tunnel/release、原受保护 runtime 的 SHA-256、owner-only ACL、四个既有任务的精确
   身份/动作/权限、模型代理 PID/路径/启动时间、以及带 TLS/本节点 SSO 的空闲会话检查。
   空闲状态未知、任何聊天在运行、任务/原文件身份不符时停止，不“强制继续”。
4. 计划只涉及本次已授权的路径修复时，使用相同参数加 `-Apply`。
   复制并验证原生 Codex 及存在的同目录允许列表辅助程序到本节点
   `~/.local/share/codey-machine-windows/<nodeId>/native-codex/<sha256>/`；
   不复制 auth/config、任意 DLL 或其他文件，不依赖原缓存继续存在。
   先在同一 `CODEX_HOME`/provider 环境验证明确指定二进制的 `--version`、原生 stdio
   `initialize` 与 `model/list`，**不创建/续聊真实会话**，不接管 Desktop 进程。
   只有这些检查成功后才备份 runtime/installation，更新本节点私有配置和伴随文件摘要，
   重启精确的 `Codey Node <nodeId> workspace` 与 `... renew` 两个既有任务。
   正在运行的数据服务/隧道、4141 代理、Desktop、任务定义、机器身份、网络和密钥均不更改。

## 验收与边界

查看脚本 JSON 及 owner-only 的 `codex-repair-report.json`：
- `nativeStdio: true`、`modelCatalog: true`，新绝对路径在 `native-codex` 私有目录。
- TLS/SSO/History、匿名拒绝通过；Copilot `/usage` 失败仍按独立 token-usage 检查报告警告，
  不伪称外部配额已经恢复。
- 原模型代理 PID/路径/启动时间、enrollment/ticket/TLS、原 Node/CloudCLI 和 Codex auth/config
  与修复前一致；原节点 ID/隧道坐标不变。
- **这仍不是聊天验收**：`realModelCallsTested: false` 是刻意保留的事实。
  回到 Codey 的该 Windows 节点，用用户认可的会话验证实际回复；再验证原 Desktop
  session ID 续聊与图片附件。不要用“端口/模型列表正常”替代实际回复。
- 修复后的私有副本不随 Desktop cache 清理消失。不要为了测试而手动删除 Desktop 文件。
  日后要更新原生 Codex，仍使用本入口选择当前明确路径；不是自动跟随 Desktop 最新版。

备份为安装配置目录中的 `runtime.before-codex-repair-<id>.json` 和
`installation.before-codex-repair-<id>.json`。复制/协议预检失败不停止任务；停止后验证失败
保留新有效 pin 和审计备份，不自动恢复到已不存在的旧路径，也不重装或删除节点。
报告失败阶段后继续窄范围诊断；新的权限/身份异常必须停止。不能把测试控制机上的通过
冒充新 Dev Box 的实际聊天已通过。
