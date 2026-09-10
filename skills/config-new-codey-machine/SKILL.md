---
name: config-new-codey-machine
description: "在 Linux x64 上一键覆盖安装 Codey 节点：安装唯一 codey npm 包，从官方源安装 DevTunnel、Node 和最新版 Codex，并创建 systemd 守护。"
---

# Linux 一键安装 Codey 节点

安装包只有一个应用 npm 包 `assets/codey-<version>.tgz`，由 `npm pack`
生成；主 manifest 的 `name` 是 `codey`，不是把两个 npm 包放进同一个 tar。

- 一份主 `package.json`、一份 `npm-shrinkwrap.json` 和一个 `codey` CLI。
- Workspace 和网关的编译产物直接进入包，共用一棵 npm 运行依赖树。
- 更新器也在包内；两个后端可独立运行，但只能作为一个 Codey 包更新。

安装器校验后，在私有 release 目录中执行一次 npm 安装，准备目标平台的原生依赖，
并在停止旧服务前检查整个包。Node、Codex、DevTunnel runtime 不进入包；
Codex SDK 的纯 JS 模块随包构建，不通过 npm 再安装第二份 Codex native runtime。

公共 npm 的 `codey` 名称被其他项目占用；只安装包内 `.tgz`，不要将安装命令
改成从公共 registry 安装 `codey`。
在目标普通用户下执行一条命令：

```bash
bash scripts/install.sh
```

脚本在需要时使用 `sudo`，直接停止并覆盖旧 Codey 服务；保留整个 Home、
`~/.codex/auth.json`、`~/.codex/sessions/` 和其他用户文件。
生成新模型 key 前会先停止旧 CloudCLI 守护，再停止当前用户的全部 Codex 进程，
防止守护进程用旧环境重新拉起 app-server；不兼容旧 key，不恢复旧进程。

## 1. 安装并配置 DevTunnel

- **准备检查**：Linux x64、Python 3.12+、出站 HTTPS 和 npm registry 可用，
  当前用户已执行 `sudo -v`。
- **目标**：从 Microsoft 官方地址下载并校验 DevTunnel，以 GitHub device code 登录，
  创建私有隧道，只转发 HTTPS `3001` 和 `8443`。
- **执行脚本**：`bash scripts/install.sh`。
- **验收标准**：登录 provider 为 GitHub；隧道无匿名访问；两个端口均为 HTTPS。

## 2. 配置并启动 Codey 网关

- **准备检查**：先停止旧 CloudCLI/Codey Workspace 守护及全部旧 Codex 进程，
  再停止用户级和系统级 copilot-api 服务，释放 `4141/8443`。
- **目标**：启动统一 Codey 包内的 copilot-api，重新生成本机 API key。
  `useResponsesApiWebSocket` 已在 Codey 网关中默认关闭，安装器不再额外写入此项；
  普通启动时已有配置中的显式 `true` / `false` 仍优先。
- **执行脚本**：同一安装脚本通过 `codey auth` 登录 GitHub Copilot，
  用 `codey gateway start` 启动并检查 `/models`。
- **验收标准**：新 API key 返回 HTTP 200；旧进程已退出。

## 3. 覆盖安装 Codex

- **准备检查**：再次确认当前用户的旧 Codex、app-server、proxy、exec 进程均已退出。
- **目标**：已有 Codex 就在原 bin 目录更新，否则安装到 `~/.local/bin`；始终使用
  OpenAI 官方 latest installer，不在包内携带第二份 Codex。
- **执行脚本**：覆盖写入 `~/.codex/config.toml` 和 `~/.codex/models.json`，
  但不删除 auth、sessions。
- **验收标准**：旧 Codex PID 均已退出；`codex --version` 成功；真实模型请求返回
  `CODEY_CODEX_OK`。原会话文件保留，但交互进程不自动恢复；安装后从新终端启动 Codex。

## 4. 启动 Codey Workspace

- **准备检查**：停止旧 CloudCLI，释放 `3001`。
- **目标**：启动统一 Codey 包内的 CloudCLI，并强制使用第 3 步的官方 Codex 路径。
- **执行脚本**：创建并启动 `codey-cloudcli.service`，入口为同一 npm 包的 `codey workspace`。
- **验收标准**：匿名访问被拒绝；CloudCLI 自带的 Codex SDK 真实请求返回
  `CODEY_CLOUDCLI_OK`；包内不存在 Codex native runtime。

## 5. 安装更新器

- **准备检查**：copilot-api、Codex、CloudCLI 均已通过真实检查。
- **目标**：安装包内签名更新器，不从旧 updater 恢复状态。
- **执行脚本**：生成当前节点独立配置并安装 `codey-node-updater.service`。
- **验收标准**：更新器服务 active，报告 `npm` 布局；只接受 Portal 签名的
  `codey` 整包发布，拒绝旧的 CloudCLI/copilot-api 分组件发布。

## 6. 创建并启动守护进程

- **准备检查**：前五步成功。
- **目标**：异常退出自动恢复，SSH 退出和机器重启后自动启动。
- **执行脚本**：启用用户 linger，并启用 copilot-api、CloudCLI、DevTunnel、
  DevTunnel token renew timer 和 updater。
- **验收标准**：所有 unit 均 enabled/active；生成权限为 `0600` 的
  `~/codey-machine-registration.json`，只上传该文件到 Portal。

Windows PowerShell 版本在 Linux 流程实机通过后再实现；不要在 Windows 上运行本脚本。
