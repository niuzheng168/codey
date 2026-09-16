---
name: codey-node-onboarding
description: "说明 Codey 新节点的注册边界，并引导使用可重复分发的静态无密钥 Skill；用于新增节点流程审阅，不直接替代平台安装脚本。"
metadata:
  version: "2.0.0"
---

# Codey Node Onboarding

新增 Linux 节点直接下载 Codey npm 包及小型一键脚本，不必解压 Skill ZIP，
也不为每台机器从 Portal 下载带私密 token 的个性化安装包。

## 1. 分发 Linux npm 包

- 同一 npm 包支持 Linux/Windows x64 和 macOS arm64/x64；完整 Skill 按原生平台选择入口。
- 只有一个 `codey-<version>.tgz` 应用 npm 包，包含 Workspace、网关和 `codey setup`；
  不含更新器，不嵌套两个应用 npm 包。
- `install-codey-linux.sh` 是单独的小型启动脚本，不内嵌 Base64 应用；允许 npm
  从明确的 HTTPS `.tgz` URL 安装。不自动安装公共 registry 的同名项目。
- Node、Codex 和 DevTunnel 必须由目标机从官方源下载安装，不进入包。
- 不得包含 `assets/enrollment.json` 或 `assets/codey-updater/config.json`。
- 同一个平台/发行版包可以安全复制到多台机器并行执行。

## 2. 在目标 Linux 机器执行

- 把 npm 包和一键脚本放在同一目录，确认机名后运行 `bash install-codey-linux.sh --expected-computer "实际机名"`；
  已完成 npm 安装时运行 `codey setup --expected-computer "实际机名"`。
- `codey setup --check` 只验证，不触发模型请求、停进程或服务变更。
- 使用原用户 HOME 下的私有 npm prefix；不得在 Windows 或 macOS 回退执行 Linux 脚本。
- 先检查 `3001/4141/8443`：空闲或通过系统 PID/用户/安装路径确认来自本用户 Codey 才继续；其他/未知监听立即停止，不强杀。
- 同版本完成节点保留身份、证书、密钥和配置，继续验收/导出；未完成节点或旧升级器布局须单独评审。
- 新节点在本机生成 node ID、Workspace subject、模型 key 和三把用途隔离的接入密钥。
- DevTunnel 只使用当前用户的 GitHub 登录；不配置 VNet、路由或入站防火墙。
- 完整流程含应用、身份/自签名证书、私有 DevTunnel、模型/Workspace、原生守护、验收和注册文件；
  覆盖现有 Codex 配置需 `--replace-existing`，先备份且保留 auth/sessions，不安装更新器。

## 3. 上传注册文件

安装和本地验收完成后，每台机器产生私密的
owner Home 下的 `codey-machine-registration.json`。文件包含注册凭据和
connect-only JWT，
必须按密钥材料处理：只上传到经过认证的 Codey 页面，不进 Git、不贴到聊天，
绑定完成后删除传输副本。
Skill 目录内禁止输出注册文件，运行前后应保持可安全重复分发。

Portal 应以当前登录账号作为 owner，不信任客户端自报的 Portal 用户身份；导入时
验证 schema、节点证明、DevTunnel 绑定、TLS 和凭据唯一性，再以可重试的一致性流程
写入节点与 tunnel renewal 记录；不注册升级代理。Portal 服务端实现不属于本 Skill。

## 4. 隔离边界

- `clientSigningKey`、`workspaceSsoKey`、`tunnelUpdateKey` 必须互不相同，不与模型 key 混用。
- Portal Cookie、密码、master key 和发布私钥不进入目标机器或注册文件。
- 只暴露 DevTunnel HTTPS `3001/8443`；`4141` 保持 loopback。
- `workspaceUsername` 必须匹配 `^[a-z][a-z0-9_-]{0,31}$`。
- 验收必须包含真实 Codex 模型响应、Workspace SSO、Usage/History 和匿名拒绝，
  不能只看 PID、端口或健康页。
- Copilot 配额不是聊天健康检查；真实模型请求必须单独通过。
