---
name: config-new-codey-machine
description: "用本人 GitHub 登录的私有 DevTunnel 添加 Windows、macOS 或 Linux 节点：检查环境、查看计划、原生安装、自检后回门户添加。不开放入站端口，不接管已有服务。"
---

# 配置新的 Codey 节点

**本人完整包 → GitHub 登录 → 查看计划 → 安装 → 门户验通。**
只用当前登录账号下载的对应平台完整包。源码目录里的说明不能代替个人配置包。
下载仅预留七天有效身份；失败重试复用同一待配置身份，不反复创建节点或隧道。

## 1. 准备与边界

先只读确认目标 OS/owner、Python、OpenSSL、构建工具、磁盘、现有服务和端口。
Python 需 3.12+；有较新的独立 Python 就使用它，不替换系统 Python。
缺少普通工具由助手按官方方式准备，不向用户索要散装源码、证书或私钥。

| 目标 | 原生入口 | 前提 / 服务方式 |
| --- | --- | --- |
| Windows x64 | `scripts/setup-windows.ps1` | 保留已可用的 Codex/本机模型代理；原 owner 登录任务 |
| macOS Apple Silicon / Intel | `scripts/setup-macos.sh` | 保留已可用的 Codex/本机模型代理；本人 launchd |
| Linux x64 | `scripts/setup-linux.sh` | 首次独立安装 copilot-api、CloudCLI、Codex 依赖；systemd 用户服务 |

- 新服务仅监听 `127.0.0.1`；隧道只转发 HTTPS `3001/8443`，不开放 `4141`。
- 不改入站防火墙、IP、路由、全局 Node/Codex，不重启原代理、现有节点或 VM。
- 已有安装、端口或服务冲突即停止，不用首次安装器升级/迁移工作中的节点。
- 目标必须允许 DevTunnel 出站 HTTPS/WebSocket；公司策略阻断时准确报告，不绕过。
- 包中的 `assets/enrollment.json`、源码与 manifest、Linux 升级器凭据必须完整且匹配。
  不伪造身份、不关闭 TLS/摘要验证、不用上游 latest 替换 Codey 锁定版本。

## 2. 只用 GitHub 登录 DevTunnel

复用 **GitHub** 登录，不把其他 provider 的“已登录”当成通过。缺 CLI 时准备官方版本；
Windows 校验微软签名，Linux 下载固定 SHA-256 到独立目录。登录必须由目标 OS owner 完成。

有浏览器的 Windows/macOS/Linux：

```text
devtunnel user login --github --use-browser-auth
```

无图形界面的 Linux，可由本人在正常终端使用 GitHub 设备授权：

```text
devtunnel user login --github --use-device-code-auth
```

用 `devtunnel user show --json` 确认 `status: "Logged in"`、`provider: "github"`。
不自动注销/切换已有 Microsoft 账号，不回退到 Entra。若旧节点依赖当前登录缓存，
先审查迁移或隔离账号；不能让它的续期失效。此登录与 Codey 门户、Copilot/Codex 模型登录不同。
不索要、复制、打印 GitHub/Copilot token，也不把登录凭据放进机器文件。

## 3. 查看计划，再执行

先运行匹配平台的计划命令，向用户说明将新增的私有隧道、本机服务和目录；获得确认后执行。

| 目标 | 计划 | 安装 |
| --- | --- | --- |
| Windows | `.\scripts\setup-windows.ps1` | `.\scripts\setup-windows.ps1 -Apply -NetworkApproved` |
| macOS | `bash scripts/setup-macos.sh` | `bash scripts/setup-macos.sh --apply` |
| Linux | `bash scripts/setup-linux.sh --enable-linger` | `bash scripts/setup-linux.sh --enable-linger --apply` |

Linux 可用 `CODEY_PYTHON=python3.13` 选择现有解释器。开机自启必须有该 owner 的 linger：
说明 `loginctl enable-linger <owner>` 的影响，获准后加 `--enable-linger`；已开启则复用。
应用/隧道由 systemd 守护并自动重启，令牌由 timer 重试。Windows/macOS 是原 owner
**登录后**自启，不等于无人登录开机运行；不能为了自启改为 root/SYSTEM 或存储用户密码。
Linux 遇到 GitHub 登录提示时只完成该授权，再执行同一命令，不重建身份。

安装器校验源码/Node 摘要，在独立目录构建，生成本节点 TLS leaf，配置 SSO/数据认证，
启动本次新建的原生服务。隧道无匿名访问；续期只向绑定门户提交本节点的 connect-only 令牌。
Linux 另安装独立签名升级器；Windows/macOS 不冒充支持 Linux 升级器。

成功重跑只验收，不重启或升级。失败保留日志和同一身份，不能通过删目录/改状态绕过检查。
Linux/macOS 的 `--retry-failed` 只用于已审查的本次未完成安装。
Windows 恢复与已接入 Codex 修复见 [Windows 恢复](references/windows-recovery.md)。

## 4. 验通并添加

本机 TLS、带节点凭据的数据接口、Workspace SSO、匿名拒绝通过后，生成
`output/codey-machine.json`。只把这个**不含密钥**的文件交回同一账号的 Codey 添加页面。
不要上传完整 ZIP、enrollment、TLS 私钥或升级器配置。

门户必须实际通过私有隧道验证 TLS、数据认证、SSO 和 WebSocket，成功后才加入节点列表。
Linux 添加后检查升级器在线；失败留待排查，不放宽鉴权或重新创建身份。

**Copilot 配额不是聊天健康检查。** 配额不可用可单独报告，但认证仍须通过。
**安装/隧道成功不等于模型可调用**：没有模型身份时由本人登录，再做真实 Codey/Codex 请求。
交付分别说明本机自检、门户验通、升级器和模型请求结果；未测项目明确列出。

详细验收和精确回退见 [验收与回退](references/verification.md)。
