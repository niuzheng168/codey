---
name: config-new-codey-machine
description: "在用户自己的 Linux、Windows 或 macOS 机器上接入 Codey；Linux 用一条命令配置 GitHub DevTunnel，覆盖安装 copilot-api、最新版 Codex CLI 和 CloudCLI，并创建守护进程和完成真实验收。"
---

# 配置新的 Codey 机器

Linux 完整包在解压后的目录中直接执行：

```bash
bash scripts/setup-linux.sh --apply
```

以目标普通用户运行，不使用 root。脚本自动处理已有 Codey，不需要先运行普通计划，
也不需要 `--replace-existing`。需要 GitHub DevTunnel 或 GitHub Copilot 登录时，
按终端显示的 device code 由用户完成授权，然后脚本继续执行。

脚本可以停止并覆盖当前用户的 Codey 服务，但始终保留整个 Home、`.codex`、
Codex auth 和 sessions。旧 Codey runtime、配置和 systemd unit 会移动到
`~/.local/state/codey-service-backups/`，不恢复旧 key 或旧服务。

## 1. 配置 DevTunnel

- **准备检查**：Linux x64、Python 3.12+、OpenSSL、构建工具和至少 8 GiB 空间；
  只要求出站 HTTPS/WebSocket，不修改 VNet、路由或入站防火墙。
- **目标**：使用当前用户的 GitHub 登录创建或复用本节点私有 DevTunnel，
  只转发 HTTPS 端口 `3001` 和 `8443`，不暴露模型端口 `4141`。
- **执行脚本**：由同一个 `setup-linux.sh --apply` 自动下载校验后的 DevTunnel CLI；
  未登录时自动运行 GitHub device-code 登录。
- **验收标准**：provider 为 `github`，隧道属于当前节点，没有 Anonymous 访问，
  两个 HTTPS 端口配置正确。

## 2. 覆盖安装 copilot-api

- **准备检查**：识别当前用户的 Codey/copilot-api systemd unit、runtime、配置和监听。
- **目标**：停止并 disable 现有守护进程，归档旧文件，使用安装包内的新源码重新构建。
- **执行脚本**：
  1. 停止现有 copilot-api、updater、CloudCLI 和 DevTunnel Codey units。
  2. 安装包内固定 Node/Bun 和最新构建的 copilot-api 源码。
  3. 生成新的本机 API key，写入 `provider.env`。
  4. 写入模型配置，并设置 `"useResponsesApiWebSocket": false`。
  5. 创建并启动 `codey-copilot-api.service`。
  6. 没有有效 provider 登录时运行 GitHub Copilot device-code 登录，然后重启服务。
- **验收标准**：systemd unit enabled/active，`Restart=always`；
  带新 key 请求 `http://127.0.0.1:4141/models` 返回 200，旧 key 不被兼容。

## 3. 更新或安装 Codex CLI

- **准备检查**：记录当前用户现有 Codex 命令和 app-server 进程，不删除 `.codex`。
- **目标**：停止旧 Codex 进程；已有 CLI 就在该用户的 bin 目录更新，没有就安装。
- **执行脚本**：调用 OpenAI 官方 Linux installer 安装 `latest`，
  默认目标为 `~/.local/bin/codex`；若现有用户安装位于 `~/.npm-global/bin`，
  继续使用该 bin 目录，不再创建隔离的固定版本副本。
  随后写入 `~/.codex/models.json`、合并 `~/.codex/config.toml`，
  并让新登录 shell 加载当前 `CODEY_MODEL_API_KEY`。
- **验收标准**：`codex --version` 成功，CloudCLI 使用同一 Codex 路径；
  通过本机 copilot-api 发起真实 Codex 请求并得到 `CODEY_INSTALL_OK`。

## 4. 覆盖安装 CloudCLI

- **准备检查**：copilot-api 和 Codex 的测试已经通过。
- **目标**：使用安装包内的新 CloudCLI 源码构建 Workspace，创建新的用户级守护进程。
- **执行脚本**：写入并启动 `codey-cloudcli.service`，然后创建并启动：
  `codey-devtunnel.service`、`codey-devtunnel-renew.timer` 和
  `codey-node-updater.service`。脚本自动启用当前用户 linger，保证退出 SSH 和重启后继续运行。
- **验收标准**：CloudCLI 本机 TLS、认证、Usage/History、Workspace SSO 和匿名拒绝通过；
  所有长期服务 enabled/active，最终生成 `output/codey-machine.json`。
  Copilot 配额不是聊天健康检查；真实模型请求必须单独通过。

## 失败与重跑

失败后直接重新运行同一条命令：

```bash
bash scripts/setup-linux.sh --apply
```

脚本会再次停止并归档它识别到的当前用户 Codey 安装，然后重新安装。
只有停止已识别服务后 `3001`、`8443` 或 `4141` 仍被其他未知程序占用时才停止，
不会为抢端口杀死无关程序。

Windows 和 macOS 仍使用各自的 `setup-windows.ps1` / `setup-macos.sh` 原生入口；
不得在这些平台回退运行 Linux 安装器。
