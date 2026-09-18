# Windows 安装入口与后台守护

完整流程以 `codey-machine-setup.md` 和安装 Skill 为准。原生守护仍保留，
Portal/常驻本地更新器及 `-RepairServices` 暂存重装分支均已移除；旧未完成修复须单独评审。

Windows 包与 Linux 新布局相同：只有一个由 `npm pack` 生成的
`assets/codey-<version>.tgz`。目标机使用官方 Node 自带的 npm，在私有 release
目录执行一次本地包安装；不再携带或解压 `cloudcli.zip`、`copilot-api.zip`。

```powershell
.\scripts\install.ps1
.\scripts\install.ps1 -Apply -NetworkApproved `
  -ExpectedComputerName $env:COMPUTERNAME
```

第一条命令只读，不下载或写文件。`install.ps1` 引导 Node 后调用公共 `install-machine.mjs`；
PowerShell 适配仅保留 ACL、证书、端口/PID、计划任务和 Job Object 操作。
首次 Apply 准备 npm 依赖、身份、证书、登录和 Codex 配置，再以一个 `codey start --foreground` 登录任务运行
Workspace 与网关。DevTunnel host/renew 使用另外两个登录任务。Windows 不安装
任何更新代理，不修改防火墙或路由。完成后仅导出私有 JSON，不自动注册 Portal。

安装成功会创建稳定的 `~\.local\share\codey-machine-windows\bin\codey.ps1`，
并幂等加入当前用户 PATH。入口从 `runtime.json` 获取当前 release 的固定 Node、
应用入口和环境，不依赖系统 Node 或 PowerShell profile。之后可直接运行
`codey --version`、`codey status` 或 `codey doctor`；后台已运行时不额外启动一个网关。
已有成功安装只需重跑同一版本的 Apply 命令，即可补齐
命令入口/PATH，不重装或重启服务。若新窗口仍继承旧环境，完全退出终端程序后重开。

重复验收保留 GitHub 登录凭据、模型 key、TLS、注册文件和 Codex 配置，不重新登录或切换应用。
遇到服务不健康时报告诊断，不自动升级或覆盖重装。
GUI 任务入口、无控制台的 PowerShell/服务及 `windowsHide` 子进程避免出现后台终端窗口。
应用退出约 5 秒后重启；任务本身有每分钟恢复触发和失败重试，且不会重复启动。
正常停用用 `codey stop`，内部先禁用任务再停止，避免恢复触发再次启动。
`codey start/restart` 管整个节点，`codey devtunnel start/stop` 只管隧道与续期。
这仍是原 owner 登录后自启，不是无人登录时的系统服务。

`state\codey.stdout.log` / `codey.stderr.log` 持续写入并跨重启保留，
`codey.status.json` 提供不含密钥的进程/重试状态。网关自行刷新短期 Copilot token；
`renew` 任务仅负责 DevTunnel。保存 `copilot-home\github_token` 并不保证上游授权永远有效，
但一般重启不应清空它或强制重新认证。请勿分享 token 文件、完整 runtime.json 或未经检查的日志。

`codey copilot login`、`codey devtunnel login` 分别完成两个登录。
`codey export FILE.gz` / `import FILE.gz` 用原用户/SYSTEM 私有 ACL 保护二进制压缩备份；
Windows Credential Manager 登录缓存不迁移。`codey update FILE.tgz` 在新目录准备应用，
保留当前工具/身份/证书，切换后恢复原任务启停状态；不新增服务或自动注册 Portal。

`~\.config\codey-machine-windows\resources.json` 记录本安装的程序、服务、CLI/PATH 与保留目录。
这不是卸载命令或事务恢复工具；删除前仍须重新核对归属，默认保留数据和凭据。
