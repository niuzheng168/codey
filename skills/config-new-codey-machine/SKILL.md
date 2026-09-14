---
name: config-new-codey-machine
description: "在 Linux x64、Windows x64、macOS arm64/x64 一键安装 Codey 节点，配置私有 DevTunnel 和原生守护，验通后生成 Portal 注册 JSON。"
---

# 安装 Codey 节点并生成 Portal 注册文件

交付物是完整的 `config-new-codey-machine.zip` Skill，包含本文件、
`agents/openai.yaml`、安装脚本和 `assets/codey-<version>.tgz`。
**Skill 是安装流程的载体，npm 包才是应用运行包**：解压 Skill 不等于手工解压安装应用。
包内只有一个由 `npm pack` 生成的应用，主 manifest 的 `name` 是 `codey`，
不是把两个 npm 包放进同一个 tar。

- 一份主 `package.json`、一份 `npm-shrinkwrap.json` 和一个 `codey` CLI。
- Workspace 和网关的编译产物直接进入包，共用一棵 npm 运行依赖树。
- 更新器和 `codey setup` 部署入口也在包内；两个后端可独立运行，但只能整包更新。

## 三个平台统一的完成条件

Linux、Windows、macOS 使用同一份 `assets/codey-<version>.tgz` 和 SHA-256，
按目标系统执行下面的**完整节点入口**。不要重新构建平台专用应用包或依赖锁。
先定位包含本文件的 Skill 根目录；脚本、平台依赖文件或唯一 `.tgz` 缺失时，
报告 Skill 不完整，不改装公共 npm 的同名项目。

完整安装成功必须同时满足：

- 本机网关、Workspace、私有 DevTunnel、原生守护和真实模型检查成功。
- 三个平台均自动配置、安装并启动各自的签名升级器；不能让用户在注册后再手动接入。
- owner Home 下存在有效的 **`codey-machine-registration.json`**：
  Linux/macOS 为 `~/codey-machine-registration.json`；Windows 为原始登录用户的
  `%USERPROFILE%\codey-machine-registration.json`，不是 Skill 解压目录。
- 文件为 schema 2，`package.platform` 和 `machine.platform` 均为本机真实平台：
  `linux-x64`、`windows-x64`、`macos-arm64` 或 `macos-x64`；身份、独立凭据、
  非 CA TLS 证书和新签发的 connect-only token 来自这台实际运行的节点。
- Unix 权限 `0600`；Windows 使用原用户/SYSTEM 的私有 ACL。

安装器会严格校验注册文件，**不是生成空 JSON、模板、其他机器的配置或伪造平台字段**。
只向用户报告文件绝对路径，不打印凭据；用户只上传该文件到自己的 Portal，验收后删除。
本机安装完成不代表 Portal 已验收。缺少文件、设备登录未完成或检查失败时，不得宣称安装完成。
上传这一个 JSON 时，Portal 同时绑定本机升级器凭据；无需第二次下载升级器或点击接入。
上传前升级器等待机器激活是正常状态。Portal 必须配置签名公钥；升级器安装失败时不导出
注册文件、不报告完整安装成功。重复执行保留已接入升级器的凭据及防降级序号。
`--check` / 默认计划模式不配置节点、不生成凭据或注册文件。

## Windows 原生完整安装

使用原登录用户的非管理员、外部 PowerShell 终端；不要从 Codex/Desktop 或
Codey Workspace 自己的进程树内执行，也不要用 WSL/Linux/systemd 入口。
需要 OpenSSL 3（例如 Git for Windows 提供的版本）；Node、DevTunnel 和官方 Codex
由完整安装器准备。从 Skill 根目录先查看只读计划：

```powershell
powershell -NoProfile -File .\scripts\install.ps1
```

确认目标机器、联网和配置替换范围后执行：

```powershell
powershell -NoProfile -File .\scripts\install.ps1 -Apply -NetworkApproved -ExpectedComputerName $env:COMPUTERNAME
```

已有 Codex 配置或需要替换旧节点时，先获准再加 `-ReplaceExisting`；
可用 `-CodexHome` / `-OpenSslExe` 指定实际绝对路径。安装器拒绝占用端口的无关服务，
不会自动终止未托管的 Codex/Desktop。需要用户关闭应用时说明原因，保留待执行命令，
不要退回仅安装运行包并报告成功。

完整流程安装同一 npm 包，配置私有隧道、TLS、SSO 和原生 Task Scheduler watchdog，
真实验证后以私有 ACL 导出注册文件。任务在原用户登录后运行，不冒充无人登录开机服务。
已完成安装的同版本节点重跑此命令会验证、确保升级器接入并重新导出注册文件，
不旋转身份或重启应用服务。使用独立的原生更新任务，不运行 Linux updater。

## macOS 原生完整安装

在原用户已登录 GUI 的原生终端使用 Python 3.12+；支持 Apple Silicon 与 Intel，
拒绝 root 和 Rosetta。保留 Codex auth/sessions，不接管无关 LaunchAgent 或占用端口的服务。
从 Skill 根目录先查看只读计划：

```bash
python3 -I -B scripts/install-macos.py
```

确认目标、联网和配置范围，关闭仍在运行的 Codex/Desktop 后执行：

```bash
python3 -I -B scripts/install-macos.py --apply --network-approved --expected-computer "$(hostname)"
```

已有 Codex 配置需明确批准后加 `--replace-existing`，只备份和替换 config/models，
不删除 auth/sessions。失败重试需先检查私有状态，再加 `--retry-failed`。
安装器下载并校验本机架构的 Node/DevTunnel，通过 npm 安装共享应用、准备官方 Codex，
配置 `codey`、`tunnel`、`renew` 用户 LaunchAgents。模型、TLS、SSO、匿名拒绝和守护
检查通过后才写入注册 JSON；重新运行已完成节点会用现有身份刷新导出，不重装节点。
稳定 CLI PATH 覆盖 Bash 和 macOS 默认 Zsh。原生 Portal 升级代理随安装自动配置、
启动；与应用共用的安装锁先释放再接入，避免死锁。仅升级器阶段失败时，保留已验通
应用，直接重跑即可补齐，不需要重装应用或再次做模型请求。

## 仅安装运行包（不是一键节点安装）

仅当用户明确只要应用运行包或自检时，才使用
`node scripts/install-runtime.mjs --package <assets 中的唯一 tgz>`。
该入口在已有 Node.js 22.13+（含 npm）时安装并自检，**不配置服务/隧道、不会生成注册
JSON**；`--check` 还跳过 PATH 修改。不得把此命令作为 Windows/macOS 完整安装的终点。

## Linux 托管部署

安装器校验后，在私有 release 目录中执行一次 npm 安装，准备目标平台的原生依赖，
并在停止旧服务前检查整个包。Node、Codex、DevTunnel runtime 不进入包；
Codex SDK 的纯 JS 模块随包构建，不通过 npm 再安装第二份 Codex native runtime。

公共 npm 的 `codey` 名称被其他项目占用；使用下载的 `.tgz`、明确的 HTTPS npm
包 URL，或固定版本配合显式私有 registry。不要从公共 registry 安装同名项目。
使用本 Skill 时，先定位包含本文件的 Skill 根目录，确认 `assets/` 中只有一个
`codey-*.tgz`。在目标 Linux 普通用户下，从 Skill 根目录执行：

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

机器构建内置 `onboarding/setup.json`，只含公开 Portal 配置并使用 `platform: auto`；
Linux 托管部署按本机解析为 `linux-x64`。通用构建需要
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

上述六步是 Linux/systemd 流程；Windows/macOS 使用本文件前面的原生完整入口，
三个系统最终交付相同文件名、按真实平台生成的私有注册 JSON。
