---
name: config-new-codey-machine
description: "用可重复分发的无密钥静态包在 Linux、Windows 或 macOS 配置 Codey 节点：本机生成独立注册凭据，配置 GitHub DevTunnel 和原生服务，最后输出私密注册文件。"
---

# 配置新的 Codey 机器

同一个平台/发行版 Skill 文件夹可以复制到多台机器并行执行。包内没有节点
token，也不绑定 Portal 用户；每台机器只上传自己在本机生成的注册文件。

```bash
# Linux
bash scripts/setup-linux.sh --apply

# macOS
bash scripts/setup-macos.sh --apply
```

```powershell
# Windows：普通、非管理员 PowerShell
.\scripts\setup-windows.ps1 -Apply -NetworkApproved
```

不加 `--apply` / `-Apply` 时只显示计划。需要 DevTunnel 或 GitHub Copilot 登录时，
按终端提示完成 GitHub 授权。不要使用 root、sudo 或管理员 PowerShell。

## 1. 配置 GitHub DevTunnel

- **准备检查**：确认目标平台/架构、Python 3.12+、OpenSSL、构建工具和磁盘空间。
  `assets/setup.json` 必须匹配当前平台、manifest 和 `releaseId`；包内不得存在
  `assets/enrollment.json`、`assets/codey-updater/config.json` 或注册结果。
  当前 OS 用户必须匹配 `^[a-z][a-z0-9_-]{0,31}$`。
- **目标**：在目标机独立生成身份，并创建只转发 HTTPS `3001/8443` 的私有
  GitHub DevTunnel；不开放匿名访问，不暴露 `4141`。
- **执行脚本**：apply 使用 Python `secrets` 生成 `nodeId=n-24hex`、
  `workspaceSubject=m-24hex` 和四个互不相同的 32-byte base64url key：
  `clientSigningKey`、`workspaceSsoKey`、`tunnelUpdateKey`、
  `updaterCredential`。身份先保存到 owner Home 的私密 bootstrap 状态，再由
  DevTunnel CLI 使用当前 owner 的 GitHub 登录创建或复用本节点 tunnel。
- **验收标准**：计划显示 `package=static-no-secrets`；同一机器失败重跑复用同一
  身份，不同机器生成不同身份；provider 为 `github`，两个端口均为 HTTPS。
  安装阶段不向 Codey Portal 注册或预先续期。

## 2. 配置 copilot-api

- **准备检查**：识别当前 owner 的模型代理、Codey 守护进程和 `4141` 监听；
  不操作无关用户或未知进程。
- **目标**：Linux 停止并归档已识别的旧 Codey/coproxy 服务，安装包内的新
  copilot-api；Windows/macOS 保留并固定当前 owner 已有的本机模型代理。
- **执行脚本**：Linux 构建包内源码、生成新的模型 API key，写入
  `useResponsesApiWebSocket=false`，完成 GitHub Copilot 登录后创建
  `codey-copilot-api.service`。Windows/macOS 只验证显式配置的 loopback 代理和 key。
- **验收标准**：Linux unit enabled/active 且 `Restart=always`，带新 key 的
  `/models` 返回 200，旧 key 不兼容；Windows/macOS 不重启或替换现有代理。

## 3. 配置 Codex

- **准备检查**：记录现有 Codex 路径和 app-server；保留 `.codex`、auth、
  sessions 及其他配置。
- **目标**：Linux 使用当前 owner 的正式 Codex CLI；Windows/macOS 固定已审核的
  owner CLI，不创建第二套日常 PATH 入口。
- **执行脚本**：Linux 停止旧 app-server；已有 CLI 就原位更新，没有则用官方
  installer 安装 latest；写入模型目录与 provider 配置。Windows/macOS 只为节点
  服务固定现有 executable。
- **验收标准**：`codex --version` 成功；三平台都通过本机模型代理发起真实 Codex
  请求并返回 `CODEY_INSTALL_OK`。**Copilot 配额不是聊天健康检查；真实模型请求必须单独通过。**

## 4. 配置 CloudCLI

- **准备检查**：copilot-api/Codex 路径和本机模型 key 已验证，`3001/8443`
  未被未知程序占用。
- **目标**：安装本节点 Workspace 和只读数据入口，并使用本机随机生成的
  `workspaceSubject`、`workspaceUsername`、`workspaceSsoKey` 做 Portal SSO。
- **执行脚本**：构建包内 CloudCLI；Linux 创建 systemd 用户服务，macOS 创建
  owner LaunchAgents，Windows 创建 owner 登录任务；TLS 证书绑定本机 `nodeId`。
- **验收标准**：TLS、Usage/History、Workspace SSO、WebSocket 和匿名拒绝通过；
  CloudCLI 使用已经通过真实模型请求的预期 Codex 与模型代理，不能用 Usage 或
  配额成功代替聊天验收。

## 5. 安装更新器、守护进程并生成注册文件

- **准备检查**：前四步通过；connect-only JWT 仍有效；输出路径位于 owner Home
  或其他私密目录，且不在 Skill 文件夹内。
- **目标**：服务退出 SSH/终端后继续运行，并只通过一份最终文件完成 Portal 添加。
- **执行脚本**：Linux 在本机用 `workspaceSubject`、`workspaceUsername`、
  `updaterCredential` 和 setup 发布公钥生成 updater config，启用 systemd user
  services、renew timer 和 linger；macOS/Windows 启用各自 owner 守护。
  最后从 DevTunnel CLI 取得 connect-only JWT，默认写入
  `~/codey-machine-registration.json`（Windows 为
  `$HOME\codey-machine-registration.json`）。顶层精确为 `schema`、`package`、
  `machine`、`credentials`、`devTunnelConnectToken`。
- **验收标准**：Linux copilot-api、CloudCLI、DevTunnel、renew timer 和 updater
  均 enabled/active；macOS/Windows 原生守护已安装。Unix 注册文件为 0600，
  Windows 为 owner-only ACL；终端不打印凭据；Skill 文件夹运行前后无私密输出，
  可继续原样分发。只把注册文件上传到当前 HTTPS Codey Portal，绑定成功后删除副本。

## 失败与重跑

重复当前平台的同一条 apply 命令。脚本复用 bootstrap 身份并重新取得 connect-only
token。Linux 会归档识别到的旧 Codey runtime、配置和 systemd unit，但保留整个
Home、`.codex`、auth 和 sessions。三平台都拒绝 `enrollment.json` 旧个性化格式。
