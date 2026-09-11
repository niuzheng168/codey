---
name: config-new-codey-machine
description: "在 Linux x64 上一键覆盖安装 Codey 节点：安装唯一 codey npm 包，从官方源安装 DevTunnel、Node 和最新版 Codex，并创建 systemd 守护。"
---

# Linux 一键安装 Codey 节点

交付物是完整的 `config-new-codey-machine.zip` Skill，包含本文件、
`agents/openai.yaml`、安装脚本和 `assets/codey-<version>.tgz`。
**Skill 是安装流程的载体，npm 包才是应用运行包**：解压 Skill 不等于手工解压安装应用。
包内只有一个由 `npm pack` 生成的应用，主 manifest 的 `name` 是 `codey`，
不是把两个 npm 包放进同一个 tar。

- 一份主 `package.json`、一份 `npm-shrinkwrap.json` 和一个 `codey` CLI。
- Workspace 和网关的编译产物直接进入包，共用一棵 npm 运行依赖树。
- 更新器和 `codey setup` 部署入口也在包内；两个后端可独立运行，但只能整包更新。

安装器校验后，在私有 release 目录中执行一次 npm 安装，准备目标平台的原生依赖，
并在停止旧服务前检查整个包。Node、Codex、DevTunnel runtime 不进入包；
Codex SDK 的纯 JS 模块随包构建，不通过 npm 再安装第二份 Codex native runtime。

公共 npm 的 `codey` 名称被其他项目占用；使用下载的 `.tgz`、明确的 HTTPS npm
包 URL，或固定版本配合显式私有 registry。不要从公共 registry 安装同名项目。
使用本 Skill 时，先定位包含本文件的 Skill 根目录，确认 `assets/` 中只有一个
`codey-*.tgz`。在目标普通用户下，从 Skill 根目录执行：

```bash
bash scripts/install-npm.sh --package assets/codey-*.tgz
```

此命令直接使用 Skill 自带的 npm 包，无需重新下载另一份安装 ZIP，也不要手工
解压 `.tgz`。仅检查、不部署时，在命令末尾追加 `--check`。
发布的 Skill 已包含 `scripts/install-npm.sh`；如果脚本或应用包缺失，应报告包不完整，
不要改装公共 npm 的同名项目。

脚本也接受明确的 `.tgz` 路径或 HTTPS URL；
npm 先安装并准备原生依赖，再调用包内 `codey setup`。已有 npm 安装可直接运行
`codey setup --check` 和 `codey setup`，不会复制或搬动 npm 管理的应用。
使用当前用户 HOME 下的 prefix，例如 `npm install --global --prefix "$HOME/.local" ./codey-版本.tgz`。
不要用 root 所有的系统级 prefix，或带空白和 systemd 特殊字符的安装路径。

机器构建内置 `onboarding/setup.json`，只含公开 Portal 配置；通用构建需要
`codey setup --config <公开配置.json>`。禁止加入节点凭据或 owner。
`codey setup --check` 不部署、不停止进程、不做模型请求；一键脚本的 `--check`
会安装并验证 npm 包，但不执行配置。仅 npm 安装绝不自动运行六步部署。
`scripts/install.sh` 保留兼容配置逻辑，本 Skill 的入口是上面的 `scripts/install-npm.sh`。
单独分发的 `install-codey-linux.sh` 加 `.tgz` 也是可用方式，但不能替代完整 Skill 的交付。

部署时会创建 `~/.local/bin/codey`，并在 `.profile`、`.bashrc` 和已存在的
`.bash_profile` / `.bash_login` 中幂等配置 PATH，保留其他 shell 设置。
新 Bash 终端可直接运行 `codey`；安装子进程不能修改已打开终端的环境，
需要在原终端立即使用时执行 `export PATH="$HOME/.local/bin:$PATH"`。
仅 npm 安装或 `--check` 不修改 shell 启动配置。

脚本在需要时使用 `sudo`，直接停止并覆盖旧 Codey 服务；保留整个 Home、
`~/.codex/auth.json`、`~/.codex/sessions/` 和其他用户文件。
生成新模型 key 前会先停止旧 CloudCLI 守护，再停止当前用户的全部 Codex 进程，
防止守护进程用旧环境重新拉起 app-server；不兼容旧 key，不恢复旧进程。

## 1. 安装并配置 DevTunnel

- **准备检查**：Linux x64、Python 3.12+、出站 HTTPS 和 npm registry 可用，
  当前用户已执行 `sudo -v`。
- **目标**：从 Microsoft 官方地址下载并校验 DevTunnel，以 GitHub device code 登录，
  创建私有隧道，只转发 HTTPS `3001` 和 `8443`。
- **执行脚本**：一键脚本调用已安装的 `codey setup`，共用包内 Linux 配置脚本。
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
