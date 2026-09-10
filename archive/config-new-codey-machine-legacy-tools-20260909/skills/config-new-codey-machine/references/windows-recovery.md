# Windows：仅在需要时恢复

首次安装按主 Skill 操作。已经工作的节点不要再次首次安装，也不要重建身份。

## GitHub 登录

在原 owner 的普通、可见、非管理员 PowerShell 中运行：

```powershell
devtunnel user login --github --use-browser-auth
devtunnel user show --json
```

必须确认 provider 是 GitHub。助手不自动 logout，不切换正在为旧节点续期的账号，
不启动 Entra/device-code fallback，不改变 Windows 执行策略。

## 构建完成、隧道绑定阶段失败

只有安装器的恢复预检确认以下条件才可继续：

- 同一 owner、预留身份、release、原始凭据及 TLS 文件。
- 完整的已有构建和隧道 journal；尚未生成 runtime、登录任务或机器激活文件。
- 依赖、Node、后端和原生模块的摘要/ABI 检查通过；没有占用端口或未知 worker。

从同一待配置身份下载修正版完整包，解压到新目录，不取消节点、不删隧道、不改 journal。

```powershell
.\scripts\setup-windows.ps1 -Resume
.\scripts\setup-windows.ps1 -Resume -Apply -NetworkApproved
```

第二条只在用户确认后执行。预期复用已有 build 和原隧道，不新建隧道或重跑构建。
需要继续登录时，仍使用本人 GitHub 账号；旧登录迁移不属于自动恢复范围。
已有 runtime/任务/已成功安装不在这个恢复窗口内；遇到不匹配立即停止。

## 已添加节点的原生 Codex 不可用

不要重跑首次安装或 Resume。按
[独立 Codex 修复](windows-codex-repair.md) 先计划，再审核应用范围。
只处理已验证归属、空闲的 Workspace 任务；保留原代理、Desktop、身份、隧道和构建。
恢复后还需真实回复/原会话续聊验收，不能用状态文件代替。
