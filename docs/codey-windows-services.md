# Windows 既有安装器与后台守护

这些脚本用于此前发放的 Windows 完整 ZIP 及既有节点维护。
新的 Linux/Windows 共用 npm 包与 Skill 入口以 `codey-machine-setup.md` 为准，
本次不修改共享应用构建器、公共依赖锁或新安装入口。
旧 PowerShell 安装器要求旧版 Windows manifest；不要把共享 npm 包伪装成旧格式。
它的守护、命令入口和修复实现供后续统一 Windows 节点部署时复用。


Windows 包与 Linux 新布局相同：只有一个由 `npm pack` 生成的
`assets/codey-<version>.tgz`。目标机使用官方 Node 自带的 npm，在私有 release
目录执行一次本地包安装；不再携带或解压 `cloudcli.zip`、`copilot-api.zip`。

```powershell
.\scripts\install.ps1
.\scripts\install.ps1 -Apply -NetworkApproved `
  -ExpectedComputerName $env:COMPUTERNAME
```

第一条命令只输出计划。Apply 在停止旧服务前完成 npm 安装并验证统一 manifest、
shrinkwrap、SQLite、PTY、bcrypt 和 CLI；随后以一个 `codey start` 登录任务运行
Workspace 与网关。DevTunnel host/renew 使用另外两个登录任务。Windows 不安装
Linux/systemd signed updater，不修改防火墙或路由。

安装成功会创建稳定的 `~\.local\share\codey-machine-windows\bin\codey.ps1`，
并幂等加入当前用户 PATH。入口从 `runtime.json` 获取当前 release 的固定 Node、
应用入口和环境，不依赖系统 Node 或 PowerShell profile。之后可直接运行
`codey --version` 或 `codey gateway start --headless --host 127.0.0.1 --port 4141`。
已有成功安装只需重跑同一包的 Apply 命令（不要加 `-ReplaceExisting`），即可补齐
命令入口/PATH，不重装或重启服务。若新窗口仍继承旧环境，完全退出终端程序后重开。

修复已安装节点的后台窗口和退出恢复问题，不要用全量覆盖安装：

```powershell
.\scripts\install.ps1 -RepairServices
.\scripts\install.ps1 -RepairServices -Apply -NetworkApproved `
  -ExpectedComputerName $env:COMPUTERNAME
```

第一条仍为只读计划；第二条先用 npm 暂存新应用并验证，再重启本节点的三个任务。
GitHub 登录凭据、模型 key、TLS、注册文件和 Codex 配置保持不变，不重新登录；
本节点的活动请求会短暂中断，请从独立终端在空闲时执行。
GUI 任务入口、无控制台的 PowerShell/服务及 `windowsHide` 子进程避免出现后台终端窗口。
应用退出约 5 秒后重启；任务本身有每分钟恢复触发和失败重试，且不会重复启动。
正常停用需先 `Disable-ScheduledTask` 再 `Stop-ScheduledTask`，否则恢复触发会再次启动。
这仍是原 owner 登录后自启，不是无人登录时的系统服务。

`state\codey.stdout.log` / `codey.stderr.log` 持续写入并跨重启保留，
`codey.status.json` 提供不含密钥的进程/重试状态。网关自行刷新短期 Copilot token；
`renew` 任务仅负责 DevTunnel。保存 `copilot-home\github_token` 并不保证上游授权永远有效，
但一般重启不应清空它或强制重新认证。请勿分享 token 文件、完整 runtime.json 或未经检查的日志。
