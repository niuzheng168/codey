# 注册自己的节点并配置 HTTPS

## 1. 门户注册与接入材料

由节点 owner 登录 Codey，打开“添加机器 → 账号与节点 → 添加自己的节点”，
填写名称、区域及 `https://<node-fqdn>:8443/usage`。此地址用于浏览器直连，
不是 ACA 私网 target。没有账号时由门户管理员创建；新账号默认无节点。

创建后，在该节点卡片点“查看本节点接入资料”。响应对应：

| 字段 | 用途 |
| --- | --- |
| `nodeId` | 服务端分配的不可变 ID；所有组件必须完全一致 |
| `portalOrigin` | 精确 HTTPS origin，不带路径或尾随 `/` |
| `username` / `principalId` | Workspace 绑定的 owner；不是 VM 的 Linux 用户名 |
| `clientSigningKey` | 节点 HTTPS ticket 的签名校验 key |
| `workspaceSsoKey` | Workspace SSO 专用 key |

API 是已登录同源 `POST /api/settings/nodes/<nodeId>/enrollment`。
新建 API 只接受公开设置，不接受 owner、id、key 或私网 upstream。优先使用页面；
自动化调用需保留正常登录、Origin 检查，不伪造用户头或输出 Cookie。

材料只能交给对应机器的 owner/授权运维，用受保护文件传递。不要经 URL 参数、
shell 命令行参数、聊天、截图、普通日志或源码传密钥。配置中的占位符不是真实密钥。
旧节点不导出 legacy shared key；需要全新接入身份就注册新节点，不能复制旧 ID。

## 2. 只读盘点，避免中断现有服务

先区分“全新机器”和“已在使用的机器”。记录 listener、进程、服务配置路径，
只查看必要字段，避免打印包含认证参数的完整进程环境。

Linux 示例：

```bash
ss -lntp
systemctl --user show copilot-api.service -p MainPID -p ActiveState -p FragmentPath
systemctl --user show codey-cloudcli.service -p MainPID -p ActiveState -p FragmentPath
command -v node
command -v codex
```

Windows 用本机 PowerShell，不转到 WSL：

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object LocalPort -in 4141,8443,3001 |
  Select-Object LocalAddress,LocalPort,OwningProcess
Get-Command node,codex -ErrorAction SilentlyContinue | Select-Object Name,Source
```

根据该机器真实使用的 Task Scheduler / Windows 服务、Linux systemd user、
macOS launchd 管理服务。不要在 Windows/macOS 上照搬 systemd。macOS 可先用
`lsof -nP -iTCP -sTCP:LISTEN` 确认监听。

`scripts/{linux,windows,macos}/install-codex-workstation.*` 是较早的工作站安装器，
可能修改 Codex、SSH、模型、全局运行环境及已有配置，**不是无侵入的新节点注册器**。
不要把它们或旧 node-relay/tunnel 安装器当作本流程默认步骤。

## 3. TLS 与 copilot-api HTTPS

先检查构建实际支持 `copilot-api/src/lib/codey-https-config.ts` 和
`codey-browser-handler.ts`。本功能是同一 copilot-api 进程的额外 HTTPS listener，
不是 `4141` 模型代理转发，也不需要 relay。

为节点 DNS 名称使用受信任 CA 签发的证书，SAN 包含节点 FQDN。服务器保存自己的
leaf private key 和 fullchain；ACA 只安装公开 CA 链。浏览器直连也必须信任该链。
不要复制 CA private key 到节点；不要把证书错误改成“忽略”。

把以下环境项加入**实际启动 copilot-api 的服务**，路径须替换成 OS 原生绝对路径：

```dotenv
COPILOT_API_CODEY_HTTPS_PORT=8443
COPILOT_API_CODEY_HTTPS_HOST=<经过审核的监听IP>
COPILOT_API_CODEY_TLS_CERT=<fullchain.pem的绝对路径>
COPILOT_API_CODEY_TLS_KEY=<server.key.pem的绝对路径>
COPILOT_API_CODEY_NODE_ID=<enrollment.nodeId>
COPILOT_API_CODEY_ALLOWED_ORIGIN=<enrollment.portalOrigin>
COPILOT_API_CODEY_SIGNING_KEY_FILE=<本节点client-key文件的绝对路径>
```

`SIGNING_KEY_FILE` 内容是 `clientSigningKey` 原样字符串，不是 JSON，不是
`workspaceSsoKey`，不做 base64 解码。仅服务账号可读取（Linux/macOS `0600`，
Windows 为该账号配置受限 ACL）。TLS key 也一样保护。不要修改其他 provider key。

监听选择：

- 当前浏览器电脑上的 local 节点：优先 `127.0.0.1:8443`，证书 SAN 也须匹配
  实际使用的 IP/主机名；浏览器 Local Network Access 权限不是身份认证替代品。
- Azure VM：通常绑定已存在的 VM 私有 IP。需要浏览器 CorpNet 直连时，核实
  现有 DNS、公网 NAT/路由及限源 NSG；**private bind 不代表公网绝对不可达**。
- 只做 VNet 时不必新建公网入口。不要用 `0.0.0.0` + 全网放行来排障。

新服务在配置完整、端口空闲、TLS 与 key 可读后启动。已有进程通常需要重启才能
加载新增 HTTPS 环境项：先向用户说明影响，取得该次重启授权并安排窗口；不能因为
“只是加 HTTPS”就重启正在支撑 Codex 的 copilot-api。保留原配置和构建用于回退。

## 4. 初步验证

在有证书信任与路由的客户端，以正确 hostname 测试：

```bash
curl --noproxy '*' --cacert /path/to/public-ca.pem \
  --resolve node.example.test:8443:10.42.0.4 \
  https://node.example.test:8443/healthz
```

示例 IP/域名仅是占位示例。`/healthz` 只说明 HTTPS listener 活着；
匿名 `/usage` 和 `/session-history` 必须拒绝。浏览器登录门户后才获得短期、
node/principal/scope 绑定 ticket；确认默认直连能读取四个 Usage API 和节点 History。
浏览器带 Origin 时只允许 `portalOrigin`，不放宽为 `*`。

票据最多 60 秒，离线验证意味着退出后旧票据可能存活到过期；不能再续签。
JWT/Cookie/Basic 密码、另一个节点的 key 或猜到节点名称都不能代替该 ticket。

仅直连不需要修改 Azure 网关配置。需要从非 CorpNet 网络使用 Usage/History 或
Workspace 时，继续 [VNet](vnet.md)；Workspace 还需 [独立 CloudCLI](workspace.md)。
