# Codey

多用户 Codex 节点管理、用量与会话历史门户，集成 CloudCLI Workspace 和语音输入。

## 获取源码

```sh
git clone --recurse-submodules https://github.com/niuzheng168/codey.git
cd codey
```

主仓库公开；`cloudcli` 和 `copilot-api` 分别复用原有公开 fork
`niuzheng168/claudecodeui`、`niuzheng168/copilot-api`，保留 upstream 同步关系。
不使用的 starter 统计插件示例已移除；现在递归 clone 不需要私有子仓库权限。
主仓库只保存 submodule 指针，不重复提交 CloudCLI 或 copilot-api 源码。
仓库结构、上游许可和提交顺序见 [源码仓库说明](./docs/repository-layout.md)。

## Codey npm 包

节点应用定义在 `packages/codey/`：一份主 `package.json`、统一依赖锁和一个
`codey` CLI，直接包含 CloudCLI 与 copilot-api 的构建产物，不依赖两个应用 npm 包。
源码仍保留为 submodule，构建、安装和升级产物统一为 Codey。

```sh
npm run codey:build -- --output artifacts/codey-npm
npm install --global ./artifacts/codey-npm/codey-0.1.0.tgz
codey --version
codey start
```

**公共 npm 的 `codey` 名称已被其他项目占用**；当前使用本地 `.tgz` 或私有
registry，不要从公共源安装同名包。构建不会自动发布或部署。
完整的一键安装与整包升级见 [节点接入说明](./docs/codey-machine-setup.md)。

Linux 节点现在直接下载标准 npm 包和 `install-codey-linux.sh`，不必解压 ZIP。
将两者放在同一目录后运行 `bash install-codey-linux.sh`；也可以从仓库执行：

```sh
bash scripts/linux/install-codey.sh --package ./codey-0.1.0.tgz
```

一键脚本先用 npm 在新的私有 prefix 安装，再调用包内的 `codey setup`。
已通过 npm 安装的机器可直接执行 `codey setup --check` / `codey setup`，
不会再次安装或搬动应用目录。`machine:build` 会内置公开的 Portal 配置；
普通 `codey:build` 需要用 `codey setup --config <公开配置.json>` 指定配置。
安装 npm 包本身不会启动服务或覆盖模型配置。

## Portal 本地检查

实际机器配置、`.env`、证书、账号/会话数据及构建产物不在 Git 中。新 clone 先按
[配置说明](./config/README.md) 复制示例；本地只读运行可复制
`config/nodes.example.json` 为 `config/nodes.json`，然后执行：

```sh
npm run skill:build
npm run check
npm test
```

以下设计文档保留项目演进记录；其中旧部署实例不是新用户的默认节点或凭据。

## 设计文档

- [新机器自动配置 Skill：按平台配置 → 页面验通后添加](./docs/codey-machine-setup.md)
- [macOS 私有 DevTunnel 节点、原生后端与无 Azure 权限续期](./docs/codey-macos-nodes.md)
- [Codey 当前架构](./docs/codey-current-architecture.md)
- [Codey VNet + CloudCLI 目标架构](./docs/codey-vnet-cloudcli-design.md)
- [用户名密码与 Workspace SSO](./docs/codey-password-sso-design.md)
- [浏览器直连 / ACA VNet 连接选项](./docs/codey-node-connection-modes.md)
- [多用户与节点隔离](./docs/codey-multiuser-design.md)
- [手动语音润色、撤销与恢复](./docs/codey-voice-rewrite.md)
- [Workspace 前端统一发布（已上线）](./docs/codey-shared-workspace-ui.md)

**当前 ACA 部署（2026-09-06）：** Codey 支持多个用户名密码账号；原 `zhn`
为管理员，在“账号与节点 → 用户管理”创建账号。节点设置按不可变 owner ID
保存，新账号不继承任何节点；知道别人的节点名称也不能获得 Usage、未共享的
Session History 或 Workspace 访问权。Shared 为所有登录用户可读的公共区。
进入自己的 Workspace 无需二次登录。Usage / 节点 Session History 默认浏览器直连，
可在刷新按钮旁勾选 **VNet**，供非 CorpNet 机器访问。
选择只影响当前浏览器，不自动切换；本机节点仅在直连模式显示。
Workspace 前端已统一托管：纯 UI 更新构建、发布一次即可，API、终端及用户数据仍按节点隔离。
下文部分 AAD / 独立 CloudCLI 登录步骤为早期或本地部署记录，以设计文档为准。

把本机和多台远程机器上的 `copilot-api` 用量汇总到一个页面。本地部署模式由
Portal 后端并发读取每个节点；ACA 托管的 Codey 使用浏览器直连模式，由页面
JavaScript 通过当前电脑的网络访问每个 AAD 用户自己的节点列表。页面会显示最近
请求的 reasoning effort、每台机器的 Copilot API / Codex CLI 版本、可选择日构建
版本的受控更新按钮，以及新机器的一键部署入口。

顶部 **Workspace** 标签直接复用用户 fork
[`niuzheng168/claudecodeui`](https://github.com/niuzheng168/claudecodeui) 的完整
CloudCLI 源码。CloudCLI server 运行在目标 VM；浏览器仍只访问 Codey ACA，Portal
完成 AAD 和节点权限检查后，通过 Azure VNet 反向代理 HTTP、SSE 和 WebSocket。

当前 A100 canary：

```text
Browser
  → Codey AAD
  → /cloudcli/zhn-a100/
  → ACA VNet
  → 10.0.0.7:3001 CloudCLI
```

用户进入 CloudCLI 后需要使用节点自己的 username/password 二次登录。聊天、会话、
文件编辑、Git、Skill、MCP 和 terminal 均由 CloudCLI 原生实现。fork 源码位于
[`cloudcli/`](./cloudcli)，Codey 只增加子路径适配和 VNet reverse proxy。

`codex-session-share-mcp/` 源码继续保留供本地或独立部署使用。自
**2026-09-10** 起，生产 ACA 不再部署该 sidecar，Portal 也不再配置 MCP proxy 或
Session Share upstream；当前 **Session History** 入口保持关闭。若以后独立启用，
该服务支持搜索共享会话、查看 metadata/handoff/transcript、
下载 archive，以及管理员重命名、移入回收站、恢复、直接永久删除和批量操作。All
sources 会按 source session ID 合并节点与 Shared 副本并优先显示 Shared；回收站
条目固定排在非回收站条目之后，也可单独筛选全部回收站内容。Portal 使用当前
Azure CLI 登录获取短期 Entra token；token 不会发送到浏览器。

同一标签也会通过本机文件系统和配置中的 SSH 白名单读取每个节点的原生
`~/.codex/state_5.sqlite` 与 rollout JSONL。来源分类包括 **Shared**、
**Local**、**westus2**、**jpe2**、**jpe3** 和 **zhn-a100**，并区分
Active/Archived。节点原生历史只读；重命名、回收站和永久清除只适用于 Shared
分类。时间范围可切换为全部、最近 24 小时、最近 7 天或最近 30 天；Shared
按上传时间过滤，节点历史按 Codex 会话更新时间过滤。

远程节点优先通过各节点 `copilot-api` 的受保护 `/session-history` API 读取，
避免为每次列表或详情请求重新建立 SSH 会话。该接口使用单独的 session-history
密钥，密钥只保存在 Portal 主机的用户配置目录和节点本地代理配置中；旧版本节点
返回 404 时 Portal 会在滚动升级期间回退到 SSH。本机会话仍直接读取本地文件。

每条节点原生历史会显示 **Uploaded** 或 **Not uploaded**。未上传会话提供
**Upload to Shared** 按钮；Portal 在来源节点创建 history-only portable bundle，
使用与 `upload_session` MCP tool 相同的预约、SHA-256 校验和 Azure Files
原子提交管线，并要求 Azure AI Search 自动索引成功后才显示完成。

当前配置已经包含以下节点：

| 节点 | copilot-api 地址 |
| --- | --- |
| 本机 | `http://localhost:4141` |
| westus2 | `http://zhn-usw2.westus2.cloudapp.azure.com:4141` |
| jpe2 | `http://zhn-jpe-2.japaneast.cloudapp.azure.com:4141` |
| jpe3 | `http://zhn-jpe3.japaneast.cloudapp.azure.com:4141` |
| zhn-a100 | `http://zhn-a100.japaneast.cloudapp.azure.com:4141` |

## 启动

要求 Node.js 22.13 或更高版本。项目没有第三方运行时依赖，不需要 `npm install`。

```powershell
npm start
```

打开 [http://127.0.0.1:4310](http://127.0.0.1:4310)。开发时可使用：

```powershell
npm run dev
```

## Codey 浏览器直连模式

从 ACA 打开 Codey 时，Portal 只返回节点元数据和短期、节点绑定、scope 限制的
ticket。Usage 和节点 Session History 请求由浏览器直接发送，不经过 ACA 后端：

```text
ACA 页面中的 JavaScript
  → 当前电脑的 CorpNet 网络
  → VM HTTPS copilot-api
```

- 不需要运行本地 `127.0.0.1:4310` Portal。
- VM 浏览器入口只允许 `GET`、`HEAD` 和 CORS `OPTIONS`，并且只开放 usage 与
  session-history 路径；模型调用和管理接口不会暴露给 ticket。
- `4141` 可继续提供本机 HTTP 服务；浏览器 HTTPS 使用独立端口，因此不会改变
  Codex 的 `base_url`。
- 每个 AAD 用户的节点配置独立存储；种子用户的内置节点 endpoint 会随部署配置
  更新，用户自己添加的节点不会被覆盖。

当前本机和四台远程 VM 都使用 copilot-api 内置的 HTTPS `:8443` endpoint。
本机为 `https://127.0.0.1:8443`，只监听回环地址；同一个 copilot-api 进程继续
提供 `4141`，不改变 Codex 的 `base_url`。独立的本机 `4242` relay 已停用。
浏览器 CSP 必须显式允许每个节点 origin，节点 CORS 只允许 Codey ACA 的精确
origin。

本机 HTTPS 使用已经信任的 Codey CA 签发的证书。无需跳过证书检查，但浏览器仍
可能要求 Local network access 权限。连接失败时应先检查 copilot-api 是否运行；
网页的“重试”只能重新连接，不能启动 Windows 服务。

## 配置节点

编辑 [`config/nodes.json`](./config/nodes.json)。`endpoint` 应指向该代理的 `/usage` 地址；Portal 会从它推导另外三个 token 用量接口。

```json
{
  "id": "jpe2",
  "name": "Japan East 2",
  "region": "Azure Japan East",
  "endpoint": "http://example:4141/usage",
  "apiKeyEnv": "COPILOT_API_KEY_JPE2",
  "accent": "#34d399",
  "management": {
    "transport": "ssh",
    "sshHost": "jpe2",
    "runtimeBin": "/home/zhn/.local/bin",
    "copilotApi": "systemd-user",
    "codexCli": "npm-global"
  }
}
```

`sshHost` 是本机 `~/.ssh/config` 中可直接无交互连接的别名。管理配置只接受内置枚举；浏览器不能传入命令、主机名或包名。

如果代理启用了 `auth.apiKeys`，把密钥放在 `apiKeyEnv` 指定的环境变量中。密钥不会出现在配置响应或浏览器中：

```powershell
$env:COPILOT_API_KEY_JPE2 = "your-api-key"
npm start
```

可用的全局设置：

| 设置 | 默认值 | 说明 |
| --- | ---: | --- |
| `requestTimeoutMs` | 8000 | 单个上游请求超时 |
| `cacheSeconds` | 10 | 相同筛选结果的服务端缓存 |
| `refreshSeconds` | 60 | 浏览器自动刷新间隔 |
| `eventsPerNode` | 12 | 每个节点读取的最近事件数 |
| `maxRecentEvents` | 60 | 合并后返回的事件上限 |
| `updateTimeoutMs` | 180000 | 单次更新动作超时 |

也可以通过 `PORTAL_CONFIG` 指向另一份 JSON 配置。

## 一键部署新机器

在“版本与更新”区域选择“添加机器”，填写节点 ID、显示名称、区域和 SSH Host。用量地址可留空，Portal 会从 `ssh -G <host>` 解析出的 HostName 自动生成 `http://<hostname>:4141/usage`。

部署流程是固定白名单，不接受任意 shell 命令，依次执行：

1. 检查 SSH 免交互连接、Node.js 20+、npm 和 systemd user manager。
2. 从所选模板节点复制 `copilot-api` 配置、GitHub token、Codex `config.toml` 和模型目录；默认模板为 jpe2。
3. 安装 `artifacts/copilot-api-2.1.6-reasoning-effort.tgz` 与 npm 稳定版 Codex CLI。
4. 创建并启用 `copilot-api.service`、`copilot-api-update.service` 和每日更新 timer；代理异常退出会自动重启。
5. 启动代理，执行一次 `codex exec --ephemeral` 真实调用，并从公开 token event 验证 `reasoning_effort`。
6. 全部验收通过后才把节点写入 `config/nodes.json`，Portal 运行时立即加载新节点。

部署器不会覆盖没有 Portal 管理标记的已有 Copilot API、Codex CLI 或配置。模板中的 project trust、插件市场和需要单独 OAuth 的 `session_share` MCP 配置不会复制到新机器。新登录 shell 会自动取得 npm PATH 和代理环境变量。

### Windows ChatGPT / Codex workstation

[`scripts/windows/install-codex-workstation.ps1`](./scripts/windows/install-codex-workstation.ps1)
用于部署新的 Windows 工作站。脚本从 Microsoft Store 安装官方 ChatGPT
(`9PLM9XGG6VKS`)、按需安装 Node.js LTS、校验并安装本地或 HTTPS 提供的
Copilot API artifact、生成安全的本地 API key、配置 GPT-5.6 Sol model catalog，
并为当前用户注册代理开机启动。GitHub Copilot 登录保持交互式，脚本不会复制或
输出现有机器的 token。

```powershell
.\scripts\windows\install-codex-workstation.ps1 `
  -CopilotApiPackage .\copilot-api-artifacts\copilot-api-2.2.13-2026-08-22-zhn.tgzz `
  -CopilotApiSha256 35dc565170b440d4b1c8d86a15baafcb235bb16892af474db94e1da696d37d01
```

先加 `-ValidateOnly` 可只验证依赖、package 和 SHA-256。目标机已有 Codex 或
Copilot API 配置时，脚本默认停止；显式使用 `-Force` 后会先创建带时间戳的备份。
如果需要从 Portal 网页注册和管理该 Windows 节点，请在管理员 PowerShell 中加
`-EnableOpenSsh -PortalSshPublicKey '<Portal 主机的 OpenSSH 公钥>'`，并在 Portal
主机的 `~/.ssh/config` 中为该 Windows 主机配置免交互 SSH alias。随后从
**节点分布 → 添加机器** 选择 **Windows**，Portal 会注册用量、会话历史和启动管理，
但不会远程复制其他节点的 GitHub token。

“添加机器”窗口也可按所选平台直接下载单个 Windows `.ps1`、Linux `.sh` 或
macOS `.sh`
一键安装脚本。当前最新且已通过 Portal 校验的 Copilot API package 以 Base64
内嵌在脚本中；运行时写入临时目录并再次核对 SHA-256，无需另行下载或配对文件。
Linux 脚本安装 Copilot API、Codex CLI、GPT-6 Astra（872K context）配置和 systemd user
service，不复制其他节点的 token，并保留交互式 GitHub Copilot 登录。
macOS 脚本使用相同配置并创建当前登录用户的 `launchd` LaunchAgent；Node.js
缺失时可通过已安装的 Homebrew 补齐。Codex CLI 通过 OpenAI 官方
`https://chatgpt.com/codex/install.sh` 安装器按 Apple Silicon/Intel 架构选择并校验
release，不依赖可能错误指向 Windows 平台包的 npm dist-tag。Copilot API 的公开
依赖固定从 `https://registry.npmjs.org/` 解析，避免企业 npm mirror 返回的远程
tarball 被 `EALLOWREMOTE` 拒绝；脚本不会关闭 npm 的 remote-package 安全策略。
macOS 当前支持脚本安装，尚未作为 Portal 远程 SSH 管理 transport 注册。

## 对外访问与认证

默认只监听 `127.0.0.1:4310`。若要让其他机器访问：

```powershell
$env:PORTAL_HOST = "0.0.0.0"
$env:PORTAL_USERNAME = "zhn"
$env:PORTAL_PASSWORD = "use-a-strong-password"
npm start
```

设置 `PORTAL_PASSWORD` 后，整个 Portal 使用 HTTP Basic Authentication。由于 Portal 包含远程更新和部署能力，只要不局限于本机访问，就应当设置强密码并置于 HTTPS 反向代理、VPN 或 SSH 隧道后面。当前上游地址使用明文 HTTP；若上游需要 API Key，优先改用 HTTPS 或安全隧道，避免密钥在网络中明文传输。

端口可用 `PORTAL_PORT` 修改。

## 数据口径

- Token 历史由每台 `copilot-api` 本地记录，因此 Portal 会把节点 totals 相加。
- Copilot quota 是账号级数据。同一登录账号出现在多台机器时，Portal 只显示一份配额快照，不会把 entitlement 相加。
- 节点某个接口失败不会拖垮整个页面；该节点会显示“部分可用”及具体失败范围。
- 同一节点多个接口返回相同错误时，状态提示只显示一次并标注受影响的接口数量，避免重复文案。
- 返回浏览器的数据会移除 token、session ID、trace ID、user ID 等不需要的字段。
- 新版 `copilot-api` 会在 token event 的 `reasoning_effort` 字段中直接保存实际转发的 effort，Portal 会优先使用该字段。旧数据或尚未升级的节点仍会在服务端用 event 的 `session_id` 匹配对应机器 `~/.codex/sessions` 中最近的 `turn_context.effort`；匹配不到时显示“未知”。

上游接口及 Node.js 版本要求来自 [`copilot-api` dev README](https://github.com/caozhiyuan/copilot-api/blob/dev/README.md)。Codex 自定义 provider 的 `base_url` 配置见 [OpenAI Codex Configuration Reference](https://developers.openai.com/codex/config-reference)，官方 CLI 安装与更新说明见 [OpenAI Codex CLI](https://developers.openai.com/codex/cli)。

## 版本与更新

- Portal 扫描项目根目录的 `copilot-api-artifacts/`。包名支持 `.tgz` 和 `.tgzz`，格式为 `copilot-api-<version>-<YYYY-MM-DD>-<label>.<ext>`，并要求同目录存在 `<包名去扩展名>-CHANGELOG.md`。
- 构建进入统一的 **Copilot API builds** 面板前会校验 gzip/tar 路径、包名、文件名版本与 `package.json` 版本、源码级加密历史恢复和 `reasoning_effort` 用量记录。构建按新到旧每页显示 3 个，每个构建展示完整 changelog 和当前部署覆盖率；浏览器只提交构建 ID，不能提交文件路径、URL 或 shell 命令。
- 每个构建提供一次 **部署到全部节点** 操作；已运行该构建的节点会跳过，其余本机和远端节点并行部署并分别报告成功或失败。
- Linux 远端的 Copilot API 更新会把所选构建复制到目标机器，校验 SHA-256，备份现有包，安装并重启服务，再执行健康检查、真实 Codex 调用和 reasoning-effort 事件检查。任一步失败都会恢复原包和构建标记。
- 成功部署后，节点会在 `~/.local/share/copilot-api/portal-build.json` 记录构建 ID、版本、日期、标签和 SHA-256；Portal 因此可以区分语义版本相同但日期不同的日构建。
- 存在该构建标记时，每日 npm updater 会保留 Portal 手工选择的构建，后续版本切换继续由 Portal 完成，避免上游包覆盖 fork-only 能力。
- Linux 远端的 Codex CLI 按钮只安装 npm 稳定通道 `@openai/codex@latest`，随后核对版本并执行一次真实代理调用。
- 本机 Copilot API 使用同一份已验证 artifact 切换流程：备份当前 runtime package 和 build marker、重启 4141、验证监听状态，失败时恢复上一份 package。
- 本机 Codex CLI 来自 Codex 桌面应用，页面只显示应用版本并标为系统托管，不会用 npm 覆盖。

所有更新和部署都使用 Portal 内的确认框，不再使用浏览器原生弹窗。服务端只接受同源请求或 `clientOrigins` 明确允许的 Codey origin：更新要求 `X-Portal-Action: update`，部署要求 `X-Portal-Action: provision`。

## API

- `GET /api/health`：Portal 健康状态。
- `GET /api/nodes`：前端可见的节点元数据，不含密钥。
- `GET /api/overview?period=week&nodes=local,jpe2`：聚合数据；`period` 支持 `day`、`week`、`month`。
- `GET /api/management/status`：读取各节点安装版本、稳定版及服务状态。
- `POST /api/nodes/:id/update`：执行白名单更新；JSON body 的 `component` 只能是 `copilot-api` 或 `codex-cli`。更新 Copilot API 时还必须传入状态接口返回的 `artifactId`。
- `POST /api/copilot-api/deploy-all`：将一个已验证的 `artifactId` 部署到全部可管理节点；返回逐节点 deployed/skipped/failed 结果。要求 `X-Portal-Action: update`。
- `POST /api/nodes/:id/copilot-api/start`：启动白名单节点的 Copilot API；远端调用预配置的 systemd user service，本机使用最新的已验证 Portal artifact。要求 `X-Portal-Action: start-copilot-api`。
- `POST /api/nodes/provision`：一键部署并登记新机器；只接受结构化节点、SSH Host 和模板节点字段。
- `GET /bootstrap/windows|linux|macos`：下载内嵌当前最新已校验 package 的平台自解包安装脚本。
- `GET /api/session-history?source=shared|local|NODE_ID|all&range=all|day|week|month`：按来源和时间范围列出、搜索 Shared 或节点原生历史。
- `GET /api/session-history/:source/:state/:name`：读取来源对应的 metadata 和 bounded transcript。
- `GET /api/session-history/shared/:state/:name/archive`：从共享服务流式下载 archive。
- `POST/DELETE /api/session-history/shared/...`：执行重命名、回收站、恢复和永久清除；要求 `X-Portal-Action: session-history`。
- `POST /api/session-history/batch`：对最多 50 个 Shared sessions 批量执行回收站、恢复或永久删除；要求 `X-Portal-Action: session-history`。
- `POST /api/session-history/:node/:state/:name/upload`：将未上传的节点历史上传到 Shared；要求 `X-Portal-Action: session-history`。
- 添加 `refresh=1` 可跳过短时缓存。

Portal 只会访问 `config/nodes.json` 的白名单地址，不接受浏览器传入任意上游 URL。

可通过 `COPILOT_ARTIFACTS_DIR` 指向另一份日构建目录；默认使用项目根目录下的 `copilot-api-artifacts/`。

可选 Session Share 服务的非敏感连接配置位于
[`config/session-share.json`](./config/session-share.json)。可用
`SESSION_SHARE_PORTAL_CONFIG` 指向其他配置；生产 Portal 当前不设置该变量，也不
部署 Session Share MCP。独立运行该功能的用户需要先执行
`az login`；读取需要 `SessionShare.Contributor`，变更操作还需要
`SessionShare.Admin`。

Shared 分类的非空搜索词由 MCP 服务转发到 Azure AI Search，执行 BM25
全文检索与 `text-embedding-3-large` 向量检索的 hybrid query。搜索索引是
下载 archive 的并行投影：原始 Azure Files `.tar.gz` 不会被替换或改写，仍是
下载与恢复的来源。Search Basic、Azure OpenAI embedding account 和 deployment
均位于 `zhn-devbox`，并只通过 Container App managed identity 访问。

## 验证

```powershell
npm run check
npm test
```
