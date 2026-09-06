# Codey 统一密码登录与 Workspace SSO

> 日期：2026-09-05  
> Portal：`codey`，四个 Workspace：`zhn-a100` / `jpe2` / `jpe3` / `westus2`  
> 当前 revision：`codey--multiuser2-0905`，image：`codey:20260905-multiuser2`  
> 认证切换基线为 `codey--pwssotls2-0905`；后续版本增加 Usage/History 手动 VNet 选项。  
> 取代此前“Codey AAD + 每节点 CloudCLI 密码”的交互登录方式。
>
> **多用户更新：** 已加入管理员创建账号、独立密码会话、签名节点归属表与
> 全路径访问控制。详细行为、注册接入及安全边界以
> `Q:\codex_manager\docs\codey-multiuser-design.md` 为准。

## 1. 用户体验与数据

- 初始管理员为 `zhn`，可创建其他账号。原始密码由用户指定，不写入本文、源码或镜像。
- 登录一次，即可进入本人已接入的 Workspace，无需再次登录 CloudCLI。
  zhn 保留原有四个远程 Workspace，新账号默认为空。
- 不修改 Windows/Linux/SSH 密码、Codex 配置或 copilot-api。
- Codey 内部沿用原 owner ID `9e7a208d-62e7-459d-a5be-f74e4b726a5a`
  和原 tenant namespace，使 `/data/portal-users-vnet` 中的节点列表保持不变。
  这是数据归属映射，不是继续接受 AAD 登录。
- A100 沿用原 CloudCLI user ID 和数据库；不复制账号/凭据到其他节点。
  空节点首次收到合法 SSO 请求时创建不可用本地密码登录的内部身份。
- Session Share MCP 的数据、镜像和已有 Entra 机器客户端认证保持不变。

## 2. 请求路径

```text
Browser
  └─ HTTPS + __Host-codey_session (HttpOnly, Secure, SameSite=Strict)
      └─ ACA Codey
          ├─ 密码验证 / 可撤销会话 / Origin 检查 / 节点 ACL
          ├─ 为每次请求创建 20 秒、节点专属的签名断言
          └─ HTTPS (固定 CA + 验证 SNI 主机名)
              └─ VM CloudCLI :3001
                  ├─ 验证签名、aud/sub、method/path、时间及 nonce
                  ├─ 禁止旧 JWT、独立登录/注册、API-key/Platform 绕过
                  └─ 本节点文件 / Git / PTY / Codex
```

浏览器拿不到节点 SSO key、签名断言或另一个长寿命 CloudCLI JWT。
Portal 不向节点转发门户 Cookie、客户端 Authorization 或伪造的身份头。
Workspace 响应强制 `private, no-store`，不允许节点设置门户 Cookie。

## 3. 门户密码与会话

实现：`src/password-auth.mjs`。

- scrypt：`N=131072, r=8, p=1`，随机 32-byte salt，64-byte verifier。
- Azure Container Apps secret `codey-password-account` 只保存用户名、内部 owner ID
  与密码 verifier。没有明文密码环境变量。
- Cookie 为随机 256-bit opaque token；服务端只保存 SHA-256(token)。
- 会话文件位于 `/data/portal-auth/sessions/`，包含 owner、绝对到期时间、
  credential version 和完整性 MAC，不包含原始 Cookie。
- 绝对时限 8 小时，30 分钟无已认证活动后失效。可见页面每分钟进行认证心跳。
- 改变密码 verifier 会改变 credential version，旧会话不再有效。
- 登录尝试使用 Azure Files 上的原子排他文件创建限流：每账号每 15 分钟最多
  5 次，另有全局 100 次上限。计数跨实例/重启保留，不依赖可伪造的客户端 IP。
- 同时最多一个 scrypt 验证，避免匿名并发请求消耗大量 CPU/内存。

### Azure Files 兼容性

实际挂载文件显示 uid 0，而 Portal 以 uid 1000 运行。文件可写，但显式 `utimes`
会返回 `EPERM`。保活优先尝试 `utimes`；遇到不支持/无 SETATTR 权限时，使用
`r+` 打开既有文件并原位写回 JSON 的第一个 `{`，仅更新 mtime。
不修改已签名内容，不提升运行身份，不改挂载权限，也不会重建已注销的会话文件。

## 4. 认证和 CSRF 边界

- 未认证的业务页面跳转登录；API、静态应用文件及 WebSocket 返回 `401`。
- 唯一公开的门户内容为登录页及其 JS/CSS、最小健康检查。
- 旧 `/portal-auth/start` / `callback` / AAD session mint 不再可用；
  `codey_aad`、Basic Authorization、`x-ms-client-principal-id` 不能代替新会话。
- 所有非 GET/HEAD 业务请求必须携带匹配固定 public origin 的 Origin；
  如果存在 Fetch Metadata，还必须为 `same-origin`。
- 所有 Workspace WebSocket 握手也检查 Origin 和有效会话。
- MCP 的 OAuth discovery/登录协议端点保留。MCP 数据/API 请求仍必须使用
  有效 Entra Bearer credential（或其已配置的服务凭据），由 MCP 再验证。
  门户 Cookie 不会被当成 MCP 访问令牌，也不会转发给 MCP。
- MCP proxy 的 upstream origin 固定，不接受 absolute-form/scheme-relative
  请求 URL 更改目的主机。

## 5. Workspace 节点认证

实现：

- `src/workspace-sso.mjs` / `src/cloudcli-gateway.mjs`
- `cloudcli/server/modules/auth/portal-sso.service.ts`
- `cloudcli/server/modules/auth/portal-sso.module.ts`

ACA 保存 master secret `codey-workspace-sso`，通过带 node ID 的 HMAC 派生每节点
独立 key。各 VM 只持有自己的 key，保存在：

```text
~/.config/codey-cloudcli/portal-sso.env
```

文件权限为 `0600`。断言包含：

```text
iss, aud=node ID, sub=owner ID, username,
sid, method, path+query, iat, exp, random nonce
```

节点严格验证固定 issuer/user/node、20 秒最大有效期、时钟、HTTP 方法与路径。
nonce 在有效期内不可重放。HTTP 全局 guard 位于 body parser、CORS、auth/API-key
路由和静态资源之前；WebSocket 在 upgrade 时独立验证。同一 HTTP 请求内部使用
不可从网络伪造的 Symbol 标记，不在路由 prefix 被移除后重新匹配 URL。

旧 CloudCLI JWT（包括以前登录 A100 得到的 JWT）在 SSO 模式下不被接受。
`/api/auth/login` / `register` / `refresh` / 节点独立 logout 都被禁用。
Frontend 使用 Cookie-backed requests 和不带 query token 的 WebSocket URL。

## 6. TLS 与网络

| Node | ACA upstream | 验证的 TLS hostname |
| --- | --- | --- |
| zhn-a100 | `https://10.0.0.7:3001` | `zhn-a100.japaneast.cloudapp.azure.com` |
| jpe2 | `https://172.18.0.4:3001` | `zhn-jpe-2.japaneast.cloudapp.azure.com` |
| jpe3 | `https://172.16.0.4:3001` | `zhn-jpe3.japaneast.cloudapp.azure.com` |
| westus2 | `https://10.0.2.4:3001` | `zhn-usw2.westus2.cloudapp.azure.com` |

复用各节点既有 TLS leaf/key，不复制私钥到 ACA、不重启 copilot-api。
Portal 镜像只携带公共 CA `config/codey-node-ca.pem`；显式
`rejectUnauthorized=true`，没有跳过证书验证的 fallback。

四节点的 `3001` 都仅允许 ACA 私网路径。A100 增加只针对 `10.0.0.7:3001`
的 NSG allow/deny，其他端口和 VM 不受影响。westus2 仍经现有 Private Link；
其 CloudCLI probe 改为 TCP 3001，原 4141 probe/rule 未改动。

现有 VM leaf certificates 到期日期为 **2026-12-03**，须在此前续签。

## 7. 退出与边界

- POST `/portal-auth/logout` 删除服务端会话、清除 Cookie/cache/storage。
- 当前实例立即断开该会话的 Workspace HTTP streams/WebSockets；
  其他实例及绝对/闲置过期由最多 5 秒的 lease 检查收回。
- 旧 Cookie 的新 HTTP 请求和 WebSocket 握手立即被拒绝。
- 不强杀用户已经启动的 VM/Codex 任务；退出是撤销访问，而不是销毁工作。
- 已下载/已显示的数据无法被“远程收回”。
- 原有浏览器直连 Usage/History 继续使用只读、节点专属 bearer tickets。
  新模式将其有效期从 10 分钟降为最多 60 秒；已经签发的此类离线验证票据，
  不会因门户退出而即时失效，到期后不能在未登录状态下续签。
  Workspace 文件写入、终端和聊天不使用这些只读票据。
- Usage/History 现增加用户显式勾选的 ACA/VNet 模式，默认仍为直连。
  `/api/node-data/*` 逐请求验证 Portal session 和节点 ACL，门户退出后拒绝
  旧 Cookie 的新读取；浏览器不再持有这条私网请求使用的 ticket。
  详见 `Q:\codex_manager\docs\codey-node-connection-modes.md`。

本方案是整个节点的账号隔离，不是同一个 Linux 用户内的多租户 OS 沙箱。
每个账号有其自己节点上已配置的 Linux identity 能力，不能把密码分享给不互信的人。
原 zhn 初始密码较短且具有常见模式，建议改为
更长的随机密码；密码登录和限流不能替代高强度密码或 MFA。

## 8. 部署、验证与回滚

源码包：

```text
codey-cloudcli-source-20260905-sso2.tar.gz
SHA-256: dbc38f8dc05c5f3e4314c2cc3be36dfd328e5905c1c43ce5ad6cc3285bc5264d
```

节点使用 `install-codey-cloudcli.sh --portal-sso --stage-only` 先构建验证，
再用 `activate-codey-cloudcli-sso.sh` 切换独立服务。
切换前通过 SQLite online backup 保存原数据库、unit 和 release 链接。
没有 reboot，没有重启 copilot-api，没有改变系统 Node/default nvm。

部署辅助工具：

- `scripts/create-codey-auth-secrets.mjs`：从 stdin 读取初始密码，仅保存 verifier。
- `scripts/set-codey-aca-auth-secrets.py`：通过 in-process Azure CLI 更新指定 secrets，
  避免把 secret 值放入操作系统命令行。
- `scripts/verify-codey-auth-live.mjs`：验证匿名拒绝、正确登录、SSO、跨站拒绝、
  四节点 WebSocket 和 logout/replay。

验证记录：

```text
Q:\codex_manager\artifacts\codey-password-sso-20260905
```

回滚必须同时考虑 Portal 与节点的 HTTPS/SSO 协议，不应只回退一侧或临时关闭认证。
每节点备份保存在 `~/.local/share/codey-cloudcli/backups/password-sso-*`。
MCP mirror/data 与 copilot-api 不在本次回滚范围内。

## 9. 已验证结果

- Portal `npm run check` 与 **57 项 tests** 通过。
- 每个 VM 构建分别通过 **10 个 client tests、43 个 server tests** 及 typecheck/build。
  本机 CloudCLI lint 无 errors；上游已有 warnings 保留。
- 初次线上登录暴露 Azure Files `utimes EPERM`；修复后在真实 `/data` 挂载上
  验证 session create / touch / revoke 全部通过，没有提升容器权限。
- 线上 HTTP/WS verifier 使用真实门户密码登录，验证四节点 `username=zhn`、
  `needsSetup=false`、projects API `200`、WebSocket upgrade `101`。
- 匿名请求、伪造 principal header、跨站请求被拒绝；
  独立节点 login/register 为 `403`；退出后旧 Cookie 与 WebSocket 重连为 `401`，
  已打开的四条 Workspace socket 全部关闭。
- 浏览器实测：从新登录表单进入 Workspace，并切换四节点；均直接显示项目 UI，
  不出现节点登录/注册表单。Usage 为 **5/5 正常**，Session History 显示
  **504 个会话 / Shared 79**（这是验证时快照，不是固定数量）。
- 四个 VM 的 public DNS `:3001` 均不可直接连接；ACA→VM 走验证证书的 HTTPS。
- 原有 copilot-api PID 未变：本机 `12972`、A100 `2282749`、jpe2 `3618629`、
  jpe3 `3863297`、westus2 `3016591`。没有重启 VM。
- ACA `portal`/`mcp` 均 ready，restart count `0`，最新 revision 接收全部流量；
  MCP image 仍为 `codey-mcp:20260904-154632`。

额外冷备份逐行比对在 A100 遇到既有的 `xfs_buf_lock` I/O 等待
（该机另有此前已等待数小时的 Python 读任务）。只停止了本次验证进程，没有
修复/重启文件系统或修改 VM 网络。因此不声称完成该冷备份逐行比对；
在线数据库备份已在切换前成功创建，当前 API、浏览器项目与共享会话访问已验证。
