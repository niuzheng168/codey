# Codey VNet + CloudCLI 设计

> 状态：A100 canary 与三节点 fleet rollout 已实现  
> 日期：2026-09-05  
> CloudCLI fork：`niuzheng168/claudecodeui`  
> 节点：`zhn-a100`、`jpe2`、`jpe3`、`westus2`

> **认证方案已更新（2026-09-05）：** 当前改为 Codey 用户名密码登录与
> Workspace SSO，ACA→VM 使用 HTTPS；不再要求 AAD 和节点二次登录。
> 最新实现与安全边界见 `Q:\codex_manager\docs\codey-password-sso-design.md`。
> 下文的“两次登录 / HTTP upstream / 首次账号待创建”保留为 canary 演进记录，
> 不应再按旧步骤部署或关闭新的认证 guard。
>
> **Usage/History 补充（2026-09-05）：** 现在默认浏览器直连，也可手动勾选
> ACA/VNet，供非 CorpNet 客户端使用。Workspace 的 VNet 路径保持不变。
> 见 `Q:\codex_manager\docs\codey-node-connection-modes.md`。

## 1. 目标

用户登录 Codey 后，选择自己有权限的 VM，并直接使用完整 CloudCLI：

- Codex chat；Codey 托管模式不暴露未配置的 Claude/OpenCode/Cursor。
- 会话发现、恢复和搜索。
- 文件浏览、预览、编辑、创建、上传和删除。
- Git status、diff、history、stage、commit、branch 和 worktree。
- Skill 与 MCP 配置。
- Web terminal。
- 移动端和桌面浏览器。

Codey 继续负责：

- Microsoft Entra ID 登录。
- 每个用户独立的节点列表。
- VNet 路由和节点授权。
- Usage、Session History 和 Session Share MCP。

Usage/History 的浏览器直连与本设计的 Workspace VNet 链路独立。2026-09-05 本机
已统一使用 copilot-api 内置 `https://127.0.0.1:8443`，不再运行独立 `4242`
relay；远端 VM 仍使用各自的 CorpNet HTTPS `8443`。Workspace 继续走 ACA → VNet
→ CloudCLI `3001`，不受这次本机迁移影响。

CloudCLI 继续负责它原生实现的 workspace 功能，不在 Codey 中重复实现。

## 2. 核心架构决策

### 2.1 每台 VM 运行完整 CloudCLI

CloudCLI 的文件、Git、PTY、Skill 和 Codex provider 都操作 server 所在机器，因此
完整 server 必须运行在被管理的 VM：

```text
Browser
  → Codey ACA
  → Azure VNet
  → VM CloudCLI
  → local files/Git/Codex/PTY
```

不把 CloudCLI server 放在 ACA 的原因不是它不能远程访问，而是 ACA 中运行的
server 只能直接看到 ACA 文件系统。CloudCLI 运行在 VM 后，浏览器可以通过 Codey
远程使用该 VM。

### 2.2 直接复用 fork

源码目录：

```text
Q:\codex_manager\cloudcli
```

基线：

| 项目 | 值 |
| --- | --- |
| Repository | `https://github.com/niuzheng168/claudecodeui` |
| Commit | `c1be241bc41586478f3d15f4dc6a5a6399d40aa1` |
| Package | `@cloudcli-ai/cloudcli` |
| Version | `1.37.2` |
| License | `AGPL-3.0-or-later` |

Codey 不再维护自研的 chat/file/Git/Skill UI 或 Codex app-server adapter。fork 只增加
部署适配，业务功能继续来自 CloudCLI。

### 2.3 两次登录

登录流程：

```text
1. Microsoft Entra ID login to Codey
2. Codey checks node assignment
3. CloudCLI username/password login on the selected node
```

这样无需把 CloudCLI 本地账号系统改造成 AAD，也无需在当前部署中重写其
project/session database。

## 3. 组件

### 3.1 Codey Portal

职责：

- Entra OIDC 登录和 allowlisted principal。
- 加载 per-principal Codey node list。
- 返回当前用户可使用的 CloudCLI 节点。
- 将 `/cloudcli/<node>/` HTTP/SSE/WebSocket 代理到节点。
- 不保存 CloudCLI 密码或 JWT。

实现：

```text
src/cloudcli-gateway.mjs
config/cloudcli-nodes.aca.json
```

### 3.2 VM CloudCLI

每个节点运行：

```text
codey-cloudcli.service
```

CloudCLI 使用该 Linux identity 的：

- `HOME`。
- `~/.codex`。
- Codex CLI 和 provider credentials。
- Git credentials。
- workspace 文件。
- Skills 和 MCP 配置。

如果 active Codex model provider 声明：

```text
requires_openai_auth = false
```

CloudCLI 应验证 provider 的 `env_key`，而不是要求创建 OpenAI `auth.json`。安装器把
调用 shell 或 login shell 中已有的 allowlisted provider environment keys
保存到节点本地 `provider.env`，权限为 `0600`。调用者应初始化 `.bashrc`/nvm；
安装器保留已有有效值，缺失凭据时在切换 release 前失败，而不是清空运行配置。

真正需要 OpenAI OAuth 的远程/headless 节点统一运行：

```text
codex login --device-auth
```

不能使用会监听远端 `localhost:1455` 的普通 `codex login`。

### 3.3 Session Share MCP

Session Share MCP 保持独立，继续由 Codey ACA 的 `mcp` sidecar 托管。CloudCLI
部署不替换或迁移已有 archive/config 数据。

## 4. 路由设计

每个节点使用独立 path namespace：

```text
/cloudcli/zhn-a100/
/cloudcli/jpe2/
/cloudcli/jpe3/
/cloudcli/westus2/
```

代理规则：

```text
/cloudcli/<node>/... → http://<private-node>:3001/...
```

例子：

```text
/cloudcli/zhn-a100/api/projects → http://10.0.0.7:3001/api/projects
/cloudcli/zhn-a100/ws           → ws://10.0.0.7:3001/ws
/cloudcli/zhn-a100/shell        → ws://10.0.0.7:3001/shell
```

CloudCLI 前端使用：

```text
VITE_BASE_PATH=/cloudcli/<node>/
```

fork 中所有 CloudCLI-owned HTTP、SSE、chat WebSocket、shell WebSocket、PWA 和
静态资源路径都会带该 prefix。

Codey build 还设置：

```text
CODEY_MANAGED=true
VITE_CODEY_MANAGED=true
```

CloudCLI 的原生 in-place updater 因此被禁用；更新必须从用户 fork 构建和部署，
避免自动安装上游 npm package 后丢失 Codey 适配。

Codey 托管模式还应用 provider/model policy：

```text
enabled provider: codex
default model: gpt-6-astra
context window: 872,000 tokens
default reasoning effort: max
```

onboarding、model picker 和 Agent Settings 只显示 Codex。托管 model catalog 只
暴露上述模型并隐藏 `Add model`；普通根路径 CloudCLI 构建仍保留全部 provider 和
原有 model catalog。

历史 session row 中不属于托管 catalog 的 Codex model override 会在读取或 resume
时归一到 `gpt-6-astra`，并写回 session database；因此旧对话不会继续绕过
节点的托管模型策略。

实际 context window 由节点 `~/.codex/config.toml` 与 Codex session event 提供。
CloudCLI UI 中显示 `872K context`；provider 元数据另行声明总 context 上限
`1,000,000` 和 max prompt `872,000`，不通过 Claude 专用的 `CONTEXT_WINDOW`
环境变量伪造。

## 5. 身份和授权

### 5.1 Codey node ACL

服务端维护可代理的 CloudCLI upstream allowlist。浏览器只能获得：

```json
{
  "id": "zhn-a100",
  "name": "ZHN A100",
  "region": "Azure Japan East",
  "path": "/cloudcli/zhn-a100/"
}
```

不会返回 private IP 或 upstream URL。

每个请求同时要求：

1. 有效 Codey AAD session。
2. 当前 principal 的 Codey node list 中包含该 node。
3. node 存在于 server-side CloudCLI allowlist。

HTTP 和 WebSocket 都执行该检查。

### 5.2 CloudCLI 登录

CloudCLI OSS 模式使用本地 username/password 和 JWT。每个节点有独立：

```text
~/.local/share/codey-cloudcli/data/auth.db
```

当前上游只允许创建一个用户。适合：

- 单人专用 VM。
- 多人明确共享同一个 OS identity 和 CloudCLI account 的节点。

不适合多个互不信任用户共享同一实例。

### 5.3 Browser token isolation

多个 CloudCLI 节点位于同一 Codey origin，仅靠 path 不能自动隔离
`localStorage`。fork 将 auth token key 改为：

```text
auth-token:cloudcli/<node>
```

因此 A100、jpe2 等节点可以各自保持登录。

### 5.4 Credential boundary

Codey gateway 删除发送给 CloudCLI 的 `Cookie` header，避免把 Codey Portal
session cookie 暴露给 VM。CloudCLI JWT 通过 Authorization header 或 WebSocket
query parameter 传输。

## 6. 网络

### 6.1 A100

```text
ACA VNet → 10.0.0.7:3001
```

CloudCLI 只绑定 A100 private IP。无需 public DNS、浏览器直连、VPN 或本地端口
转发。

### 6.2 Fleet

2026-09-05 已复用现有 Codey VNet/peering/Private Link：

| Node | ACA CloudCLI target | 网络路径 |
| --- | --- | --- |
| zhn-a100 | `10.0.0.7:3001` | 同 VNet，保留 canary |
| jpe2 | `172.18.0.4:3001` | 原有 peering + NIC NSG |
| jpe3 | `172.16.0.4:3001` | 原有 peering + NIC NSG |
| westus2 | `10.0.2.4:3001` | 原有 Private Endpoint → PLS → ILB 新增 3001 probe/rule |

westus2 VM 自身监听 `172.16.0.4:3001`，与 jpe3 地址重叠，不能将这个地址
直接填为 ACA upstream。必须使用既有 Private Endpoint 的 `10.0.2.4`。

没有修改 VM public IP，不需要 reboot，也没有重启 `copilot-api`。

### 6.3 NSG

三个新节点已实施：

- CloudCLI 只绑定 private IP。
- NIC NSG priority `100` 只放行 ACA infrastructure subnet `10.0.1.0/27`
  （jpe2/jpe3）；westus2 放行 PLS NAT `172.16.1.5/32` 和 LB probe
  `168.63.129.16/32`。
- priority `102` 拒绝其他来源访问 `3001`，先于原有 CorpNet 全端口放行规则，
  防止经 VM public-IP NAT 绕开 Codey AAD。
- 不修改 4141/8443 的现有规则。
- westus2 ILB 新增 `cloudcli-3001` probe（HTTP `/health`）和 TCP rule；
  只对新 rule 设置 30-minute idle timeout，原 4141 rule 不变。

A100 的既有 canary 网络和 CloudCLI 服务没有在本次 rollout 中修改。

## 7. 节点安装

安装脚本：

```text
scripts/linux/install-codey-cloudcli.sh
```

示例：

```bash
install-codey-cloudcli.sh \
  --archive /tmp/cloudcli-source.tar.gz \
  --node-id zhn-a100 \
  --host 10.0.0.7 \
  --port 3001 \
  --base-path /cloudcli/zhn-a100/
```

安装流程：

1. 校验本 lockfile 支持的 Node.js 22–25、npm 和 Codex CLI。可用
   `--runtime-bin` 为此服务指定独立 runtime，不改系统默认 Node。
2. 解压到新的 timestamped release。
3. `npm ci`。
4. 使用 node-specific `VITE_BASE_PATH` 和 `VITE_CODEY_MANAGED=true` 构建
   client/server。
5. 移除 dev dependencies。
6. 先准备 provider environment 和 systemd user service，保留已有配置备份。
7. 原子切换 `current` symlink，用户数据库独立保留。
8. 只重启 `codey-cloudcli.service`。
9. 验证 `/health`。

若 Node 来自 Snap，installer 会让 systemd 直接运行
`/snap/node/current/bin/node`；`/snap/bin/node` 是 Snap launcher，在
`NoNewPrivileges=true` 下会启动失败。

systemd PATH 由实际 Node/Codex 路径生成，兼容 `.local/bin`、`.npm-global/bin`
和 nvm；release-local `.codey-bin` shim 分别固定所选 Node 和 Codex。
westus2 使用 `--codex-bin /home/zhn/.local/bin/codex` 的对应配置，避免误用
较旧 `/usr/bin/codex`，但不升级或替换任何全局 CLI。
jpe3 的默认 Node `26.5.0` 不受当前原生依赖支持，因此单独下载并校验
官方 Node `22.22.0` 到：

```text
~/.local/share/codey-cloudcli/runtime/node-v22.22.0-linux-x64/bin
```

仅该服务和构建使用 Node 22；既有 Node 26、npm、Codex 与 copilot-api 不变。
jpe3 构建仅在进程级使用 official npm registry 和 `replace-registry-host=always`，
保留 lockfile integrity，不修改用户 `.npmrc`。不下载 Electron desktop binary。
三个节点的安装均以 `nice -n 15`、idle I/O priority 运行；服务保留独立资源限制。

不执行：

- VM reboot。
- `copilot-api` restart。
- Codex CLI update。
- Git workspace modification。
- `~/.codex` credential copy。

## 8. 数据存储

每个节点分别保存：

| 数据 | 位置 |
| --- | --- |
| CloudCLI account/database | `~/.local/share/codey-cloudcli/data/auth.db` |
| CloudCLI assets | `~/.cloudcli/assets` |
| Codex sessions/config | `~/.codex` |
| project files | 节点本地 workspace |

Codey ACA 只保存：

- AAD principal session。
- per-principal node list。
- CloudCLI node allowlist。
- Session Share MCP/Azure Files 数据。

CloudCLI project/session 数据不会集中复制到 ACA。

## 9. 多用户策略

Codey 能保证不同 AAD 用户看到不同节点列表，但 CloudCLI 进程最终仍使用节点上的
OS identity。

正式多人方案三选一：

1. **Dedicated node**：一个 VM 只分配给一个 principal。
2. **OS-user isolation**：每个 principal 独立 Linux user、HOME、port 和 CloudCLI。
3. **Container isolation**：每个 principal/workspace 独立容器。

仅让多个用户二次登录同一个 CloudCLI 账号不构成隔离，只适用于明确共享环境。

如果需要同一 CloudCLI instance 内的多账号，还必须 fork 并修改：

- user registration。
- projects/session ownership。
- filesystem roots。
- provider credentials。
- terminal identity。
- Git credentials。
- audit。

## 10. 权限和风险

完整 CloudCLI 包含文件写入、Git mutation、终端和可选 bypass permission 模式。
A100 是实验节点，因此 canary 保留上游功能。

当前四个 VM 仍是同一 AAD 用户的个人节点，保留上游功能，不把此部署等同于
多租户沙箱。未来推广到不互信的共享用户前至少需要：

- 确定允许的 CloudCLI permission modes。
- 禁止或审计 `danger-full-access + approvalPolicy=never`。
- 限制 workspace roots。
- 增加命令、Git mutation 和文件删除审计。
- 设置 CPU/memory/process limits。
- 完成依赖漏洞和 AGPL 合规评审。

## 11. 旧架构移除

以下自研组件已由完整 CloudCLI 替代：

```text
codey-agent/
src/codey-agent-ticket.mjs
src/codey-agent-gateway.mjs
public/codey-workspace.js
scripts/linux/install-codey-agent.sh
config/codey-agent-ca.pem
```

旧架构的 private TLS `:8444`、HMAC capability ticket、read-only file/Git adapter 和
Codex app-server WebSocket proxy不再使用。

## 12. A100 canary 验收

已完成：

- fork 同步到 `Q:\codex_manager\cloudcli`。
- CloudCLI 在 A100 `10.0.0.7:3001` 运行。
- Codey 同源 iframe 加载完整 CloudCLI。
- CloudCLI Create Account 二次登录页面可见。
- `/health` 和 `/api/auth/status` 通过 ACA/VNet 链路工作。
- API prefix、SSE URL、chat WebSocket 和 shell WebSocket 支持 node subpath。
- Portal HTTP/WS proxy、node ACL 和 cookie stripping tests 通过。
- Portal 50 tests 通过。
- CloudCLI deployment-path 3 tests、typecheck、build 通过。
- CloudCLI Codey-managed update policy 6 tests 通过。
- CloudCLI custom-provider detection、remote device-auth command 和 stale login
  replacement tests 通过。
- A100 4141/8443 和 `copilot-api.service` 未中断。
- 旧 `codey-agent.service`、`:8444`、运行目录和 ACA HMAC secret 已删除。

后续状态：

- A100 已有用户账号和会话；本次 rollout 不重置、复制或迁移这些数据。
- 三个新节点的首次 username/password 仍由用户创建。

## 13. Fleet rollout

2026-09-05 已完成三节点扩展，统一源码包：

```text
codey-cloudcli-source-20260905-8.tar.gz
SHA-256: 247b74512f0c7e79f4dae585eae7c587510d236295646cadaa31d580fada13a2
```

| Node | Release | 用户数据 |
| --- | --- | --- |
| jpe2 | `20260905-053337` | 独立数据库，首次账号待创建 |
| jpe3 | `20260905-053550` | 独立数据库，首次账号待创建 |
| westus2 | `20260905-053339` | 独立数据库，首次账号待创建 |

验收：

- 每节点 8 client tests、35 server tests、typecheck、build 通过。
- 实际 service environment 下验证 Codex custom-provider auth、GPT-6/max、
  Git 和原生 PTY。
- 三个节点的隔离临时 Codex 真实请求均成功，确认 context `872000`。
  smoke 不加载用户 MCP 配置，也不创建 CloudCLI 账号。
- ACA portal container 可访问四个节点 health/auth/base path，匿名 projects API
  返回 `401`；原有 `4141/usage` 仍为 `200`。
- 新节点公网/CorpNet 直连 TCP `3001` 不通，ACA 私网访问正常。
- Portal 52 tests 通过，包含四节点 allowlist、重叠 IP 的 Private Link 路由、
  per-user filtering 与 HTTP/WS gateway。
- 新 Portal image：`codey:20260905-cloudcli-fleet`，
  revision：`codey--cloudcli0905`。仅更新 portal image；AAD 配置、MCP image、
  Azure Files 与 Session Share 数据保留。
- 浏览器逐一切换三节点，确认实际 iframe URL 和 Create Account 表单；原有
  Usage 页面仍显示 `5/5` 节点正常。三个 NIC NSG 的原规则和 westus2 4141 LB
  rule 与部署前快照一致。

新节点尚未创建账号，因此登录后浏览器聊天、文件编辑、Git 操作仍需要用户验收，
不能把 readiness/runtime smoke 当作该完整流程已测试。

以后每次 rollout：

1. 新增独立 3001 服务。
2. 节点本地验证。
3. 验证 ACA VNet connectivity。
4. 加入 `cloudcli-nodes.aca.json`。
5. 发布新的 Codey revision。
6. 浏览器完成二次登录和功能测试。
7. 确认 4141/8443 未受影响。

## 14. Rollback

节点回滚：

```bash
systemctl --user disable --now codey-cloudcli.service
```

Portal 回滚：

- 从 `cloudcli-nodes.aca.json` 删除节点。
- 回退 Codey ACA portal image；此次上一个 image 为 `codey:20260905-local-https`。

如需撤销本次网络增量，仅删除对应 VM 的 `CodeyCloudCLI*` 规则和 westus2
ILB 的 `cloudcli-3001` rule/probe。不要改动原有 4141 rule、backend pool、
PLS/Private Endpoint 或 peering。变更前 JSON 快照保存在
`Q:\codex_manager\artifacts\codey-cloudcli-fleet-20260905`。

CloudCLI 使用独立目录和端口，rollback 不需要：

- VM reboot。
- 修改 IP。
- 重启或回滚 `copilot-api`。
- 删除 Session Share 数据。

## 15. 开源合规

CloudCLI fork 使用 AGPL-3.0-or-later。正式向更多用户提供网络服务前，需要确认：

- 修改后源码提供方式。
- attribution/NOTICE。
- 内部 Microsoft 开源使用流程。
- fork 与上游更新策略。

本文记录工程设计，不提供法律意见。
