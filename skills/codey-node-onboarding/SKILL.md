---
name: codey-node-onboarding
description: "说明 Codey 新节点的注册边界，并引导使用可重复分发的静态无密钥 Skill；用于新增节点流程审阅，不直接替代平台安装脚本。"
metadata:
  version: "2.0.0"
---

# Codey Node Onboarding

新增节点使用 `config-new-codey-machine` 静态包，不再为每台机器从 Portal 下载带
私密 token 的个性化安装包。

## 1. 分发 Linux 静态包

- 当前只发布 Linux x64 包；Windows PowerShell 和 macOS 版本待 Linux 流程稳定后迁移。
- 包内只有公开元数据、安装脚本和 CloudCLI、copilot-api、updater 三个 payload。
- Node、Codex 和 DevTunnel 必须由目标机从官方源下载安装，不进入包。
- 不得包含 `assets/enrollment.json` 或 `assets/codey-updater/config.json`。
- 同一个平台/发行版包可以安全复制到多台机器并行执行。

## 2. 在目标 Linux 机器执行

- 运行 `bash scripts/install.sh`；不得在 Windows 或 macOS 回退执行本脚本。
- 本机生成 node ID、Workspace subject 和四把用途隔离的随机 key，并在失败重跑时
  安全复用。
- DevTunnel 只使用当前用户的 GitHub 登录；不配置 VNet、路由或入站防火墙。
- 脚本按 DevTunnel、copilot-api、Codex、CloudCLI、updater、守护进程六步直接覆盖。

## 3. 上传注册文件

安装和本地验收完成后，每台机器产生私密的
owner Home 下的 `codey-machine-registration.json`。文件包含注册凭据和
connect-only JWT，
必须按密钥材料处理：只上传到经过认证的 Codey 页面，不进 Git、不贴到聊天，
绑定完成后删除传输副本。
Skill 目录内禁止输出注册文件，运行前后应保持可安全重复分发。

Portal 应以当前登录账号作为 owner，不信任客户端自报的 Portal 用户身份；导入时
验证 schema、节点证明、DevTunnel 绑定、TLS 和凭据唯一性，再以可重试的一致性流程
写入节点、tunnel renewal 和 updater 记录。Portal 服务端实现不属于本 Skill。

## 4. 隔离边界

- `clientSigningKey`、`workspaceSsoKey`、`tunnelUpdateKey`、
  `updaterCredential` 必须互不相同，不与模型 key 混用。
- Portal Cookie、密码、master key 和发布私钥不进入目标机器或注册文件。
- 只暴露 DevTunnel HTTPS `3001/8443`；`4141` 保持 loopback。
- `workspaceUsername` 必须匹配 `^[a-z][a-z0-9_-]{0,31}$`。
- 验收必须包含真实 Codex 模型响应、Workspace SSO、Usage/History 和匿名拒绝，
  不能只看 PID、端口或健康页。
- Copilot 配额不是聊天健康检查；真实模型请求必须单独通过。
