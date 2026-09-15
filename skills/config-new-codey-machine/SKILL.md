---
name: config-new-codey-machine
description: "在 Linux x64、Windows x64、macOS arm64/x64 一键安装 Codey 节点，自动接入升级器并生成 Portal 注册 JSON。"
---

# 一键安装 Codey

目标：安装运行中的 Codey 节点和签名升级器，交付本机生成的
`codey-machine-registration.json`。只执行当前系统的入口，不逐个运行辅助脚本，
不自行补装 SSH/WSL 或重写安装流程。

## 执行

先定位包含本文件及 `assets/codey-<version>.tgz` 的 Skill 根目录。
应用包只有一份，三个系统共用；缺少脚本或包时报错，不改装公共 npm 的同名项目。
使用原登录用户的外部终端，不从 Codey/Codex 自己的进程树内安装。

### Windows x64

在非管理员 PowerShell 中，确认目标机器和联网授权后运行：

```powershell
powershell -NoProfile -File .\scripts\install.ps1 -Apply -NetworkApproved -ExpectedComputerName $env:COMPUTERNAME
```

不带参数时只显示计划。证书由系统 .NET 生成，**不需要为此安装 Git/OpenSSL**。
Node、DevTunnel 和官方 Codex 由安装器准备；耗时步骤显示进度和用时。
同版本已安装时会校验并补齐注册文件，未变化且运行正常的升级器不重新安装。

### macOS arm64 / x64

在原生 GUI 登录终端中使用 Python 3.12+，不使用 root 或 Rosetta：

```bash
python3 -I -B scripts/install-macos.py --apply --network-approved --expected-computer "$(hostname)"
```

去掉三个授权参数可查看只读计划。

### Linux x64

使用普通用户，确认联网、服务/配置替换范围并准备好所需 sudo 授权：

```bash
bash scripts/install-npm.sh --package assets/codey-*.tgz
```

加 `--check` 只安装并检查应用包，不配置节点。完整安装会替换托管服务/模型配置、
停止旧 Codey 和当前用户的旧 Codex 进程；保留 auth/sessions。

## 已有安装或失败

- Windows/macOS 覆盖已有 Codex 配置需要单独授权，再加
  `-ReplaceExisting` / `--replace-existing`；不删除 auth/sessions、不接管无关服务。
- 若提示退出 Codex/Desktop，交由用户从外部终端处理，不强杀、不绕过检查。
- 已完成节点可重跑原命令，保留身份和凭据；仅升级器/导出失败时无需重装应用。
  macOS 的未完成失败事务需要先检查状态，再按提示使用 `--retry-failed`。
- `scripts/install-runtime.mjs`、`codey doctor` 或仅安装 npm 包不是完整节点安装，
  不能以这些步骤代替注册文件和升级器。

## 完成条件

安装器必须验通服务、TLS/SSO、模型及原生守护，自动配置升级器，再导出有效的
schema-2 注册 JSON。Windows/macOS 的后台任务在原用户登录后运行，不是无人登录服务。

只报告原用户 Home 下 **`codey-machine-registration.json` 的绝对路径**，
不显示内容。文件包含本机真实平台、身份和私密凭据；不得用空文件或模板代替。
Unix 权限为 `0600`，Windows 为原用户/SYSTEM 私有 ACL。

用户只需把这个 JSON 上传到自己的 Portal，节点与升级器同时绑定，验收后删除文件。
上传前升级器等待激活是正常状态；缺少文件、登录未完成或任一验证失败都不能报告成功。
