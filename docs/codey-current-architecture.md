# Codey 当前架构

> 快照日期：2026-09-06（UTC+08:00）  
> 22:16 更新：已完成工作区前端统一托管迁移；四节点共用同一份前端包，
> API/WebSocket 与数据仍按节点隔离，未部署或重启 VM。线上资源、认证、
> 越权拒绝及宽窄屏浏览器验证通过，见
> [统一发布记录](./codey-shared-workspace-ui.md#生产迁移记录2026-09-06utc)。
> 前次 18:31 更新：四个 Workspace 已发布“恢复上次润色 / 重新生成”菜单及快捷恢复，
> 仅更新静态资源，线上入口与关键 JS/CSS 校验通过；Portal 与节点服务未变。见
> [恢复/重新生成发布记录](./codey-voice-rewrite.md#恢复重新生成更新发布2026-09-06utc)。
> 更早 17:33 更新：Portal 与四个 Workspace 已发布手动 GPT-5.6 Terra 语音润色、
> 原文查看和撤销；生产接口与节点入口校验通过，节点服务未重启。见
> [发布与验证记录](./codey-voice-rewrite.md#生产发布2026-09-06utc)。
> 更早 12:03 更新：四个远程节点已发布简化后的输入工具栏，仅更新静态资源，
> 没有重启 CloudCLI、copilot-api 或 VM；仓库和配置边界见
> [源码仓库说明](./repository-layout.md)。
> Azure Container App：`codey`  
> FQDN：`codey.ambitiouspond-a4ecfeb2.japaneast.azurecontainerapps.io`  
> Revision：`codey--shared-ui-0906140800`  
> Portal image：`codey:20260906-shared-ui-135826`  
> Workspace UI：`ui-20260906t133855z-20bb3a16`  
> CloudCLI nodes：`zhn-a100`、`jpe2`、`jpe3`、`westus2`

工作区前端现由 Portal 统一托管，一次构建/发布即可更新各 Workspace；
运行时节点配置、API/终端和浏览器缓存保持节点隔离。首次迁移已经完成，
后续纯 UI 发布不再更新 ACA 镜像或四个节点，操作说明见
[Workspace 前端统一发布](./codey-shared-workspace-ui.md)。

## 1. 总览

Codey 是一个 ACA 托管的多节点 Codex 门户，目前包含四类功能：

1. Usage 和节点 Session History。
2. Shared Session History 与 Session Share MCP。
3. 节点上的完整 CloudCLI Web IDE。
4. CloudCLI 语音输入：浏览器录音，ACA 认证转写代理；Azure Speech 和
   MAI-Transcribe-1.5 均已在用户提供的 West US Speech 资源上实测启用。
   转写后可手动点击纸笔按钮，由同一 Foundry 资源的 `gpt-5.6-terra`
   结合有限最近对话润色；支持查看原文、撤销及本地恢复上次结果。
   已有结果时，纸笔菜单可选择恢复或重新生成，不自动发送聊天消息。

```text
Browser
  │
  ├── Codey password login (zhn)
  ▼
Codey ACA
  ├── portal container
  │     ├── Usage/History：默认 browser ticket 直连，可选 ACA/VNet 私网 HTTPS
  │     ├── per-principal node list
  │     ├── /cloudcli/<node>/api/voice/codey/* → authenticated Azure Speech/MAI broker
  │     ├── /cloudcli/<node>/ UI + runtime → shared Azure Files UI release
  │     ├── /cloudcli-ui/<release>/ → authenticated immutable static assets
  │     └── /cloudcli/<node>/api, ws, shell → node HTTP + WebSocket reverse proxy
  │
  └── mcp container
        ├── Session Share MCP
        ├── Azure Files
        └── Azure AI Search

Codey ACA VNet
  ├── zhn-a100 HTTPS 10.0.0.7:3001    (same VNet)
  ├── jpe2 HTTPS 172.18.0.4:3001      (peering)
  ├── jpe3 HTTPS 172.16.0.4:3001      (peering)
  └── westus2 HTTPS 10.0.2.4:3001     (Private Endpoint → PLS → ILB)
        └── complete CloudCLI server on each VM
              ├── Codex SDK/CLI and ~/.codex
              ├── project files
              ├── Git
              ├── Skills and MCP configuration
              └── PTY terminal
```

CloudCLI 源码来自用户 fork：

```text
https://github.com/niuzheng168/claudecodeui
Q:\codex_manager\cloudcli
commit c1be241bc41586478f3d15f4dc6a5a6399d40aa1
version 1.37.2
license AGPL-3.0-or-later
```

## 2. 用户登录

### 2.1 Codey 登录

门户支持多个用户名密码账号；原 `zhn` 为初始管理员，其他账号由管理员创建，
没有公开注册。密码仅保存 scrypt verifier；
Cookie 为 HttpOnly / Secure / SameSite=Strict 的可撤销 opaque session。
旧 AAD Cookie、用户头或 Basic Authorization 都不能替代当前登录。

zhn 的内部数据 owner 仍为 `9e7a208d-62e7-459d-a5be-f74e4b726a5a`，保留旧 namespace
以维持原有节点与历史记录，不代表继续接受 AAD 登录。节点配置仍存放在：

```text
/data/portal-users-vnet
```

账号与节点归属存入 `/data/portal-auth/accounts.json` 和 `node-registry.json`，
由签名、原子写入和排他锁保护。旧配置保留，但不再是可修改的 ACL 真源。
新账号使用不同的不可变 account ID，默认没有节点。

节点列表由 Codey 按已验证的 principal 加载。CloudCLI gateway 只返回同时满足以下条件的节点：

1. 节点存在于服务端 `cloudcli-nodes.aca.json` allowlist。
2. 节点在签名归属表中属于当前 principal 且未移除；管理员也没有跨用户例外。

所有读取、票据签发、HTTP/SSE/WebSocket/终端以及节点设置接口都验证同一归属。
Shared 只读对普通用户开放，管理操作仅管理员可用。详见
`Q:\codex_manager\docs\codey-multiuser-design.md`。

“添加机器”旁及 `/settings#add-node` 提供受登录保护的节点接入 Skill 下载，
包含 HTTPS、VNet、Workspace 和隔离验收步骤，不包含任何真实接入凭据。
注册、获取本节点 enrollment、配置私网网关仍是分别授权的步骤；下载不会自动部署。
实现与维护见 `Q:\codex_manager\docs\codey-node-onboarding-skill.md`。

### 2.2 CloudCLI 单点登录

进入 Workspace 后，浏览器加载：

```text
/cloudcli/zhn-a100/
```

不再显示 CloudCLI 的独立登录/注册。身份链路为：

```text
Password session → Codey node ACL → node-bound signed assertion over HTTPS
```

各节点数据库仍独立。A100 保留既有 user ID 与数据；空节点由首次有效 SSO
请求创建内部身份，无需用户创建账号。节点只接受 Codey 短期签名，不接受旧 JWT。
节点数据保存在：

```text
/home/zhn/.local/share/codey-cloudcli/data/auth.db
```

门户密码、Cookie 和 master key 不发送给 VM。每个节点只持有自己的 SSO key；
断言有效期 20 秒，绑定身份、节点、HTTP method/path 并防重放。浏览器不保存
CloudCLI JWT。退出门户会撤销 session 并断开 Workspace 连接。

完整安全设计、Azure Files 兼容性、只读票据的注销边界和验证工具见
`Q:\codex_manager\docs\codey-password-sso-design.md`。

## 3. Workspace 数据路径

Workspace 使用同源 iframe，浏览器仍只访问 Codey FQDN：

```text
Browser
  → https://codey.../cloudcli/zhn-a100/
  → Codey verifies password session and node assignment
      ├─ UI / runtime / PWA → Portal shared UI store
      └─ API / SSE / WebSocket → ACA VNet
                               → https://10.0.0.7:3001/ + per-request signed assertion
```

页面由 Portal 提供；仅转发给节点的端点移除 `/cloudcli/zhn-a100`：

```text
/cloudcli/zhn-a100/                  → shared UI page (no VM request)
/cloudcli/zhn-a100/_ui/runtime.js    → node-specific runtime configuration
/cloudcli-ui/<release>/assets/...    → shared immutable assets
/cloudcli/zhn-a100/api/projects      → /api/projects
/cloudcli/zhn-a100/ws                → /ws
/cloudcli/zhn-a100/shell             → /shell
```

节点 API 的 HTTP、SSE 和 WebSocket 仍走同一条 VNet 链路；
共享页面和资源不再访问 VM。浏览器不会看到 A100 私网 IP。

为避免把 Codey 登录凭据发送给节点，gateway 会删除请求中的 Portal `Cookie`
header，并删除客户端 Authorization 与身份头。节点依赖 Codey 签名而不是该
Cookie；TLS 使用固定 CA 和节点 hostname 验证，不跳过证书校验。

## 4. CloudCLI fork 的 Codey 适配

fork 保留原有 CloudCLI 后端和 UI，Codey 适配包括：

- 共享构建使用 `VITE_BASE_PATH=/cloudcli-ui/<release>/`；
  运行时从各节点页面设置 `/cloudcli/<node>/` API 前缀和 Router basename。
- API、SSE、chat WebSocket 和 shell WebSocket 自动加 deployment prefix。
- JS/CSS/favicon 等静态资源使用共享前缀；manifest、service worker 和 PWA scope
  仍按节点限定，草稿和用户偏好的浏览器副本也按节点分区。
- CloudCLI auth token 按 deployment path 命名。
- Codey-managed build 禁用 CloudCLI 原生 in-place updater，避免覆盖 fork 适配。
- Codey-managed UI 只显示节点已经配置的 Codex provider；Claude、Cursor 和
  OpenCode 不出现在 onboarding、model picker 或 Agent Settings 中。
- Codex model picker 只显示 `gpt-6-astra`，标签明确显示 `872K context`，默认
  reasoning effort 为 `max`；托管模式隐藏 `Add model`，避免本地自定义项重新造成混乱。
- 旧会话若保存了其他 Codex model override，打开或恢复时会自动改为托管默认模型，
  防止历史 `gpt-5.6-sol` 继续覆盖节点配置。
- UI 中的源码和 issue 链接指向 `niuzheng168/claudecodeui`。
- 根路径部署保持原行为，不影响普通 self-hosted CloudCLI。

没有重新实现 CloudCLI 的聊天、文件、Git、Skill、MCP、会话或终端功能。

## 5. VM 节点

### 5.1 服务与部署

本次不升级节点后端。下表保留此前的节点部署记录；当前工作区 UI 已改为
Portal 统一发布，不再为各节点分别编译和分发。后端/API 升级仍需单独验证并部署。

| Node | VM listener | ACA upstream | Release | CloudCLI Node runtime |
| --- | --- | --- | --- | --- |
| zhn-a100 | HTTPS `10.0.0.7:3001` | HTTPS `10.0.0.7:3001` | `20260905-075657` | 原 Snap Node |
| jpe2 | HTTPS `172.18.0.4:3001` | HTTPS `172.18.0.4:3001` | `20260905-075656` | 现有 Node `22.22.0` |
| jpe3 | HTTPS `172.16.0.4:3001` | HTTPS `172.16.0.4:3001` | `20260905-075656` | 独立 Node `22.22.0` |
| westus2 | HTTPS `172.16.0.4:3001` | HTTPS `10.0.2.4:3001` | `20260905-075658` | 现有 Node `24.18.0` |

A100 示例：

```text
codey-cloudcli.service
bind: 10.0.0.7:3001
user: zhn
HOME: /home/zhn
current release: 20260905-075657
```

安装布局：

```text
~/.local/share/codey-cloudcli/
  current -> releases/<timestamp>
  releases/<timestamp>/
  data/auth.db

~/.config/systemd/user/codey-cloudcli.service
```

安装脚本：

```text
scripts/linux/install-codey-cloudcli.sh
```

脚本使用独立 release 目录构建并原子切换 `current` symlink，不修改系统 Node，不
修改或重启 `copilot-api`。节点使用 Snap Node 时，systemd `ExecStart` 直接指向
`/snap/node/current/bin/node`，避免 Snap launcher 与 `NoNewPrivileges=true`
冲突。

jpe3 原有 nvm Node `26.5.0` 不在锁定版 `better-sqlite3` 支持范围内。
只为 CloudCLI 安装了官方 Node `22.22.0`，下载后验证官方 SHA-256：

```text
~/.local/share/codey-cloudcli/runtime/node-v22.22.0-linux-x64/bin
```

安装器的 `--runtime-bin` 显式选择该目录，systemd PATH 同时保留节点的 Codex
安装路径。没有修改全局 Node/npm、nvm default、`.bashrc` 或已有服务。
构建使用 `nice -n 15` 和 idle I/O priority；服务设置 `Nice=5`、`CPUWeight=50`、
`MemoryHigh=4G`、`MemoryMax=8G`、`TasksMax=1024`。

westus2 同时存在较旧 `/usr/bin/codex` 和现有 `~/.local/bin/codex 0.147.0`。
CloudCLI 通过 release-local `.codey-bin` shim 选用后者，不替换全局文件。
安装器支持 `--codex-bin`，并分别固定 Node/Codex，避免 PATH 中的旧 CLI 或
nvm Node 覆盖所选版本；三个新服务实测均使用 Codex `0.147.0`。

A100 的 `~/.codex/config.toml` 使用：

```text
model = "gpt-6-astra"
model_provider = "copilot_api"
model_reasoning_effort = "max"
model_context_window = 872000
requires_openai_auth = false
env_key = "GITHUB_COPILOT_API_KEY"
```

2026-09-05 从本机和全部 4 个远端节点的 `copilot-api /v1/models` 验证
`gpt-6-astra` 的 `max_context_window_tokens=1000000`、
`max_prompt_tokens=872000`，支持 `low/medium/high/xhigh/max` reasoning effort。
Codex 配置按用户要求使用 `872000`。context window 的运行时来源是
Codex 配置和 Codex session event，不使用 CloudCLI 的 Claude
`CONTEXT_WINDOW` fallback。

安装脚本优先读取调用 shell 已导出的 provider 变量（包括 `.bashrc` 配置），
再尝试 login shell；已有文件中的有效值不会因为非交互环境缺失而被清空。
只在节点本地写入权限为 `0600` 的：

```text
~/.config/codey-cloudcli/provider.env
```

CloudCLI service 只加载变量，不把值写入日志或 Portal。fork 的 Codex auth detection
能够识别 `requires_openai_auth=false` 的 custom provider，因此 A100 不需要再次执行
OpenAI OAuth login。对于确实需要 OpenAI auth 的远程节点，登录按钮改用
`codex login --device-auth`，并会替换残留的旧 login PTY。

### 5.2 节点服务

| 服务 | 端口 | 用途 |
| --- | ---: | --- |
| `copilot-api.service` | `4141` | Codex API |
| copilot-api read-only HTTPS | `8443` | CorpNet 直连或 ACA/VNet Usage/History |
| `codey-cloudcli.service` | `3001` | 完整 CloudCLI |

旧的自研 `codey-agent :8444`、HMAC capability ticket 和 read-only Workspace
已经被完整 CloudCLI 替代；A100 service、运行目录、配置和 ACA signing secret
均已删除，`:8444` 不再监听。

### 5.3 新节点的私网入口

- jpe2/jpe3 复用已有 peering，只允许 ACA infrastructure subnet
  `10.0.1.0/27` 访问目标 VM 的 TCP `3001`。
- westus2 复用 `codey-westus2-pe`（`10.0.2.4`）、
  `codey-westus2-pls` 和 `codey-westus2-ilb`。ILB 的独立 `cloudcli-3001`
  probe 在 TLS/SSO 切换时改为 TCP 3001，保留原 `copilot-proxy-4141` rule。
- westus2 的 `3001` 仅放行 PLS NAT `172.16.1.5/32` 和 Azure LB IPv4 probe
  `168.63.129.16/32`。
- 三个 VM 的 NIC NSG 使用 priority `100` 精确放行，priority `102` 拒绝其他
  来源的 `3001`；A100 在其现有 subnet NSG 中增加仅针对 `10.0.0.7:3001` 的
  同等规则。规则先于既有 CorpNet 全端口规则；private IP binding 本身并不能
  阻止 VM public-IP NAT。
- 不修改其他端口、路由、VNet peering、public IP 或 OS firewall；没有重启 VM。

网络变更前快照及部署验证记录位于：

```text
Q:\codex_manager\artifacts\codey-cloudcli-fleet-20260905
```

## 6. Usage 与 Session History

Usage/History 不经过 CloudCLI。默认保持浏览器直连；刷新按钮旁勾选
**VNet** 后，改为经 ACA 私网 HTTPS 读取，
无需客户端位于 CorpNet。不会自动切换，选择保存在当前浏览器。

```text
默认：Codey page JavaScript
  ├── local: https://127.0.0.1:8443
  └── remote VM: https://<corpnet-dns>:8443

可选：Codey page JavaScript
  └── /api/node-data/<node>/... + Portal session
        └── ACA VNet → https://<private-IP>:8443
```

Codey 为每个节点签发短期、node-bound、scope-limited browser ticket。VM 的
`8443` 只开放只读 Usage 和 Session History 路径，不开放模型调用或管理接口。
VNet gateway 复用同一节点 handler，在 ACA 生成 ticket、验证 TLS，并只接受
服务端白名单及当前用户已分配的节点。浏览器 Cookie 不会发送到节点。

“本机”指当前浏览器电脑，仅在直连模式访问。VNet 模式不显示本机，
四个远程节点计为 `4/4`，而不是把一个没有安装服务的访问端计为 VM 离线。
West US 2 在原 ILB 新增独立 `codey-data-8443` TCP probe/rule，
保留现有 `4141` / `3001` 规则。详细设计见
`Q:\codex_manager\docs\codey-node-connection-modes.md`。

当前节点：

| Node | Browser endpoint |
| --- | --- |
| local | `https://127.0.0.1:8443` |
| westus2 | `https://zhn-usw2.westus2.cloudapp.azure.com:8443` |
| jpe2 | `https://zhn-jpe-2.japaneast.cloudapp.azure.com:8443` |
| jpe3 | `https://zhn-jpe3.japaneast.cloudapp.azure.com:8443` |
| zhn-a100 | `https://zhn-a100.japaneast.cloudapp.azure.com:8443` |

### 6.1 本机统一为内置 HTTPS

2026-09-05 经用户明确授权，本机从独立 `codey-node-relay :4242` 迁移到与 VM
相同的 copilot-api 内置 browser handler：

- 同一个 Node 进程提供原有 `4141` 和回环 HTTPS `127.0.0.1:8443`。
- 原有 `~/.local/share/copilot-api` 配置、GitHub 凭据和用量 SQLite 数据继续使用。
- `auth.sessionHistoryApiKey` 只在进程内部使用；浏览器仍仅持有 Codey 短期票据。
- 专用 Windows 登录任务 `Codey Local Copilot API` 直接启动固定 release，不再
  依赖 npx 临时缓存。进程异常退出后由任务计划程序重试。
- 旧 `Codey Node Relay` 任务在 HTTPS 浏览器验证通过后停用；保留文件用于回滚，
  正常运行时不再监听 `4242`。
- `~/.config/codey-local-https/runtime.json` 保存路径和端口；私钥及 signing key
  保存在当前用户受限目录，不进入仓库或 ACA 镜像。
- 使用已有受信任的 `Codey A100 Canary Root 2026-09-04`，新证书 SAN 包含
  `localhost`、`127.0.0.1`、`::1`，到期日为 2026-12-04；到期前需续签。
- 不新增防火墙入站放行，不把本机 HTTPS 绑定到 LAN，不跳过 TLS 校验。

“重试本机节点”只重新发起浏览器连接，不能启动操作系统进程。页面提示同时说明
服务、TLS 信任和浏览器权限三类前提，不再把所有不可达情况误报成权限问题。

运行维护：

```powershell
Get-ScheduledTask -TaskName "Codey Local Copilot API"
Start-ScheduledTask -TaskName "Codey Local Copilot API"
Invoke-RestMethod https://127.0.0.1:8443/healthz
```

备份保存在本机 `~/.local/share/copilot-api/codey-migration-20260905`。切换工具
按 PID、完整命令行和可执行文件验证旧进程，再切换并检查 HTTP/HTTPS；失败则
恢复旧配置和旧版本。Windows PowerShell 5.1 的 JSON 读取显式使用 UTF-8，避免
破坏已有非 ASCII prompt。

## 7. Session Share MCP

MCP 仍作为 `codey` ACA 的第二个 container 运行，保持原始数据和 API：

- session upload/download/rename/trash/restore/purge。
- Codex config upload/download。
- Azure Files 持久化。
- Azure AI Search 索引。
- Entra service/user token validation。

CloudCLI 替换不会删除或迁移 Session Share 数据。

## 8. ACA 组件

| Container | 主要职责 |
| --- | --- |
| `portal` | Codey 页面、认证、per-user nodes、Usage/History、共享 Workspace UI、CloudCLI VNet proxy、MCP proxy |
| `mcp` | Session Share MCP、Azure Files、Search 和 embedding |

Portal 的 CloudCLI allowlist：

```text
config/cloudcli-nodes.aca.json
```

当前内容：

```text
zhn-a100 → https://10.0.0.7:3001
jpe2     → https://172.18.0.4:3001
jpe3     → https://172.16.0.4:3001
westus2  → https://10.0.2.4:3001
```

## 9. 用户隔离边界

当前隔离分两层：

1. Codey 按已认证账号映射的 owner ID 控制可见和可访问的节点。
2. 每节点独立数据库与 SSO key，验证 Codey 的节点专属断言。

但是 CloudCLI 进程在各 VM 上以 Linux 用户 `zhn` 运行，因此它可以操作 `zhn`
能够访问的文件。多个互不信任用户不能通过共享一个 CloudCLI 实例获得强隔离。

多人使用时必须选择一种：

- 一个节点只分配给一个 Codey principal。
- 每个 principal 使用独立 Linux user、HOME 和 CloudCLI service。
- 每个 principal/workspace 使用独立容器。

## 10. 安全控制

- CloudCLI 只绑定 VM private IP，不绑定 public DNS。
- Workspace 页面通过经过密码会话检查的 Codey 路径访问；四节点 `3001`
  通过 NSG 禁止公网/CorpNet 直接访问，只允许 ACA 私网链路。
- gateway upstream 来自服务端 allowlist，浏览器不能提交 URL。
- 每次 HTTP 和 WebSocket 连接都校验当前用户是否拥有该节点。
- Portal cookie 不转发到 CloudCLI。
- Codey 节点专属短期签名 + TLS 提供节点侧认证；没有独立登录/旧 JWT fallback。
- 常规 Portal/CloudCLI 部署不修改 `copilot-api :4141` 或 CorpNet HTTPS `:8443`；
  本次本机迁移是用户明确授权的独立操作。
- CloudCLI 的高权限模式、文件写入、Git mutation 和 terminal 与上游一致。
  当前服务于同一 AAD 用户的个人节点；推广到不互信的共享用户前仍需要额外
  permission policy、workspace isolation 和审计。

## 11. 已知限制

- MAI 由服务端固定为 `MAI-Transcribe-1.5`；沿用的客户端/镜像显示名称仍为
  `MAI Transcribe`，不表示自动选择其他模型。浏览器不能通过 query 覆盖模型。
  早先 East US 2 资源不可用的问题已通过用户提供的 West US 资源解决，
  不需要新建 Speech 资源或迁移 ACA/VM。
- A100 首次静态发布误载主目录同名 `copy.py`，触发向既有 `/data/g` 的复制。
  已停止该发布进程并加入强制 Python 隔离保护；检查时 `/data` 已满。
  无容量/目标文件的事前基线，不能声称目标数据未变，未擅自清理。
  详细时间、证据和恢复边界见
  `Q:\codex_manager\artifacts\codey-voice-20260906\a100-installer-incident.md`。
- 本机 `local` 仍提供 Usage/History；本次 CloudCLI rollout 仅覆盖四台远端 VM，
  没有把 Windows 本机文件或终端暴露给 ACA。
- CloudCLI OSS 仍是单用户账号模型。
- 门户与 Workspace 统一登录。退出无法收回已经下载的数据，也不能即时撤销
  仍在最多 60 秒有效期内的只读 Usage/History bearer ticket；该票据没有写入、
  聊天或终端权限，见统一认证设计的边界说明。
- fork 使用 AGPL-3.0-or-later，正式公司推广前需要完成开源合规确认。
- 2026-09-05 的生产依赖审计报告为 40 个 findings；没有自动执行可能破坏兼容性的
  `npm audit fix --force`。
- 上游构建产生 CSS minifier warning，但构建、类型检查和运行不受阻。

## 12. 主要文件

| 内容 | 文件 |
| --- | --- |
| CloudCLI fork | `cloudcli/` |
| ACA CloudCLI gateway | `src/cloudcli-gateway.mjs` |
| Authenticated voice broker / providers | `src/voice-gateway.mjs`, `src/voice-service.mjs` |
| Voice design, configuration and acceptance | `docs/codey-voice-input-design.md` |
| CloudCLI node allowlist | `config/cloudcli-nodes.aca.json` |
| Codey Workspace shell | `public/index.html`, `public/app.js`, `public/styles.css` |
| Linux node installer | `scripts/linux/install-codey-cloudcli.sh` |
| Isolated, no-restart static asset publisher | `scripts/linux/update-codey-cloudcli-assets.py` |
| Windows local HTTPS launcher | `scripts/windows/start-codey-local-copilot.ps1` |
| Windows verified cutover/rollback | `scripts/windows/switch-codey-local-copilot.ps1` |
| GPT-6 Codex config updater | `scripts/update-codex-gpt6-astra.py` |
| GPT-6 ephemeral smoke test | `scripts/linux/test-codex-gpt6-astra.sh` |
| Portal server | `src/server.mjs` |
| MCP server | `codex-session-share-mcp/` |

## 13. 验证结果

### 13.1 2026-09-06 MAI 1.5 配置更新（UTC+08:00）

- 用户更新 `.env` 为 West US 资源 `va-dev-usw-resource`；部署 helper 兼容
  `FOUNDRY_KEY` / `SPEECH_ENDPOINT` 别名，原 `.env` SHA-256 保持不变。
- 对资源直接调用以及通过生产 ACA 的真实转写均成功。MAI-Transcribe-1.5
  在 `auto` 和 `en-US` 下均 200；生产 ACA 两次耗时 1236/1303 ms，
  使用 5.435 秒合成录音，未采集用户麦克风。Azure Speech 回归亦成功。
- 仅更新 portal 的五个语音环境变量绑定，新增版本化 secret：
  `codey-voice-foundry-api-key-mai15-0906110539`。
  旧 secret 留存，旧 revision 的 endpoint/key 配对不受替换影响。
- 逐字段比较确认 portal/MCP 镜像、其余容器配置、认证、网络、存储挂载不变。
  当前 revision 两个容器 ready、restart count 0。
- 没有在 VM 执行部署、文件复制、配置修改或服务重启；
  四个 Workspace HTML SHA 仍匹配前一轮静态包。
- 浏览器确认 Azure Speech / MAI Transcribe 均“已配置”，MAI 选项不再禁用；
  保留原 Azure Speech 选择，不擅自开启麦克风。
- 102 portal tests、6 个纯离线 secret-helper tests 通过。未登录/伪造 Cookie
  401、未知节点 404、跨 Origin 403、endpoint/model 注入 400，测试登录已单独注销。

本次记录：`Q:\codex_manager\artifacts\codey-mai15-20260906\verification-summary.json`。

### 13.2 2026-09-06 首次语音输入发布（UTC+08:00）

- Portal 100 tests、CloudCLI 399 client tests、类型检查和四节点静态构建通过。
  语音修改的定向 lint 无错误；全量 lint 被此前已有的
  `server/modules/auth/auth.middleware.ts:5` boundaries 检查错误阻止。
- 通过生产 ACA 使用合成音频，Azure Speech 在 `en-US` 和 `auto` 下均返回 200
  与预期测试句。未采集用户麦克风、未向 Codex 发送测试聊天。
- 未登录/伪造 Cookie 401，不属于账号的节点 404，跨 Origin 403，客户端 endpoint
  注入 400，未配置 MAI 503；只注销了测试自身的新登录 session。
- 四节点经 ACA 返回的 HTML SHA-256 均匹配新静态包。A100 浏览器验证服务/语言
  选择、MAI 未配置状态及聊天麦克风入口；开关本身不会触发录音。
- 仅增量发布 hashed assets 和原子替换 index，保留旧 assets/index 备份。
  四节点 CloudCLI/copilot-api PID、boot ID、运行目录未变；
  本机 copilot-api 仍为 PID `12972`，`4310`、`4242`、`3001` 无监听。
- ACA 模板逐字段比较仅有预期 portal 镜像/revision、两个语音环境绑定和一个
  SecretRef 的变化；MCP 镜像、其他配置、网络和存储挂载未变。
  新 revision 两个容器 ready、restart count 0。
- 上述服务验证不代表 A100 意外复制没有数据影响；事故与磁盘告警单独记录，
  不包含未经核实的数据完整性保证。

完整结果：`Q:\codex_manager\artifacts\codey-voice-20260906\verification-summary.json`。
实现说明：`Q:\codex_manager\docs\codey-voice-input-design.md`。

### 13.3 早先发布的验证记录

早先的 canary/fleet 与本机 HTTPS 验证记录（下面的二次登录条目已被统一 SSO
取代；统一认证的最新验证记录见 `codey-password-sso-design.md`）：

- 四个 VM 的 `codey-cloudcli.service` active，监听各自 private IP 的 `3001`。
- `/health` 返回 CloudCLI `1.37.2`。
- 从 ACA portal container 对四个节点的 `/health`、`/api/auth/status`、静态页面
  base path 和原有 `4141/usage` 验证均通过；匿名 `/api/projects` 均为 `401`。
- 新节点 `needsSetup=true`，已有 A100 `needsSetup=false`。
- 新 revision 上浏览器逐一切换 jpe2/jpe3/westus2，均显示相应节点“已连接”
  和其独立的 CloudCLI Create Account 表单；Workspace selector 包含四个 VM。
  未输入用户名/密码或创建账号。Usage 页面仍显示 `5/5` 节点有响应。
- Codey HTTP proxy、WebSocket upgrade、node ACL 和 Portal cookie stripping 测试通过。
- Portal `npm run check` 通过。
- Portal 52 tests 通过，包括本机 endpoint 迁移和四节点 allowlist/Private Link
  路由、用户节点过滤回归测试。
- 三个新节点分别通过 8 个 client tests、35 个 server tests、typecheck 和 build。
- 使用正在运行的服务实际 Node/cwd/environment 验证：Codex 已认证、托管模型为
  `gpt-6-astra / max`、Git 可用、`node-pty` 能创建并正常退出终端进程。
- 三节点临时真实请求分别返回 `CLOUDCLI_JPE2_OK`、`CLOUDCLI_JPE3_OK`、
  `CLOUDCLI_WESTUS2_OK`；确认 reasoning `max`、context `872000`。该 smoke
  使用隔离临时 `CODEX_HOME`，不加载用户 MCP 配置、不修改用户 workspace。
- 三个新节点的公网 DNS `:3001` 从本机均无法直连；同端口由 ACA 私网可达。
- 本次 rollout 原有 copilot-api PID 未变：jpe2 `3618629`、jpe3 `3863297`、
  westus2 `3016591`；A100 与 Windows 本机 copilot-api 未更新或重启。
- 新 revision 的 `portal`/`mcp` 均 ready、restart count `0`，100% traffic
  指向最新 revision。三个 NIC NSG 的原有规则与快照逐字段一致，westus2 原
  `copilot-proxy-4141` LB rule 也未改变。
- CloudCLI deployment/provider-policy 5 tests 通过。
- CloudCLI Codey-managed update policy 6 tests 通过。
- CloudCLI custom Codex provider auth 3 tests 通过。
- CloudCLI Codey-managed Codex catalog 2 tests 通过。
- CloudCLI provider-model service 18 tests 通过，其中 2 个覆盖旧 session model
  override 的读取和 resume 迁移。
- CloudCLI remote login command 3 tests 和 shell/login lifecycle tests 通过。
- CloudCLI client/server TypeScript typecheck 通过。
- CloudCLI lint 为 0 errors；上游已有 warnings 保留。
- ACA Workspace 浏览器验证：新会话 model selector 只有 `OpenAI / Codex` 一个
  group、只有 `GPT-6 Astra (872K context)` 一个 option、没有 `Add model`；
  历史会话也会自动归一到 `GPT-6 Astra (872K context) · max`。
- 本机、westus2、jpe2、jpe3、zhn-a100 均完成不保存 history 的临时真实请求；
  copilot-api usage event 均记录 `model=gpt-6-astra`、
  `reasoning_effort=max`，Codex `task_started.model_context_window=872000`。
- 五台机器的 `config.toml` 和 `models.json` 均在原目录保留 timestamped backup。
- A100 `copilot-api.service`、`:4141` 和 `:8443` 在部署过程中保持运行。
- 本机 copilot-api `2.3.12` 的 794 tests、typecheck 和 build 通过；
  browser handler/ticket/TLS 配置 18 项定向测试通过，相关源文件行覆盖率均超过 90%。
- 本机隔离端口与正式端口的真实 Codex 调用均通过，正式返回
  `CODEY_LOCAL_HTTPS_LIVE_OK`。
- 本机 HTTPS 的 Usage/History、证书校验、CORS 和票据验证通过；无票据 401、
  非允许 origin 403、写请求 405、模型接口 404。
- 关闭并禁用独立 relay 后，ACA 浏览器刷新确认 `5/5` 节点正常；本机 endpoint
  为 `https://127.0.0.1:8443`，`4141/8443` 同 PID、`4242` 无监听。
- 原始 copilot-api 配置逐字段校验，仅新增内部 `auth.sessionHistoryApiKey`；
  SQLite `quick_check` 返回 `ok`。AAD 配置和 MCP 镜像保持不变。
