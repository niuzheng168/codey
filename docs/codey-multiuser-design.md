# Codey 多用户与节点隔离

> 日期：2026-09-05。此文取代单账号设计中“唯一用户 zhn”的限制。
> 不启用公开注册，不把节点名称当作授权，也不改动现有 VM 服务。
> 2026-09-08 源码扩展：管理员只读节点总览。生产状态以本轮发布验收记录为准；
> 文末的部署结果仍是 2026-09-05 的历史记录。

## 账号

- 原 `zhn` 迁移为管理员，保留其 principal ID、密码 verifier、节点和数据。
  初始迁移保持旧会话的 MAC/version，因此不要求现有用户重新登录。
- 管理员在“账号与节点 → 全局管理 → 用户管理”创建或停用用户。新用户初始没有节点，
  角色固定为普通用户；HTTP body 不能指定角色、principal ID 或节点归属。
- 每个用户可修改自己的密码，须验证当前密码。新密码至少 12 字符；
  不静默修改原有 zhn 初始密码。密码仅存储 salted scrypt verifier。
- 停用、改密、重新启用会更新该账号的 auth version；旧 Cookie 不能复活。
  其他账号的会话不受影响。管理员也没有读取他人节点数据的授权例外。
- 管理员可通过 API 删除已停用且没有活动节点的普通账号；原管理员不能
  停用或删除。删除账号不会回收其节点 ID 给别的账号。
- 登录限流为每账号每 15 分钟 5 次尝试，另有全局 100 次上限，
  不依赖可伪造的客户端 IP。未知用户也执行同等成本的密码验证。

## 持久化与身份

Azure Files 原挂载不变，`/data/portal-auth` 新增：

```text
accounts.json       account ID / username / role / enabled / password verifier / auth version
node-registry.json  immutable node ID / owner ID / public endpoint / display preferences
sessions/           existing opaque-session records
```

两个 JSON store 由不同用途的 HMAC key 保护完整性，root key 仅存在 ACA secret。
跨副本写入使用 `wx` 排他锁和同目录原子替换；不存在未签名回退或损坏后重新初始化。
已在实际 Azure Files 挂载验证排他创建和原子替换。

不按用户提供的 username/path/HTTP header 定位数据。会话查到的不可变 account ID
才是 owner。旧 `/data/portal-users-vnet` 文件保留作为迁移与恢复依据，不再作为
节点 ACL 的可编辑真源。每次请求读取已签名的 ownership snapshot；handler cache
也按配置 revision / role 隔离，不持有过期权限列表。

## 节点归属与注册

- 原本 zhn 的节点一次性导入并绑定其旧 principal ID。
- 节点设置、修改和移除仍只允许本人操作。管理员可在只读总览查看他人的节点元数据，
  但不能获取其设置、接入资料或私有数据。名称、区域、HTTPS endpoint、颜色可编辑；
  owner、node ID、key mode、私网 target、管理字段不能经网页修改。
- 新节点 ID 由服务端随机生成，不允许通过“添加一个同名节点”认领别人节点。
  名称只用于显示；知道真实 ID 或 endpoint 也不会获得权限。
- 用户在自己的机器配置新 node ID 和专属 key，才可接入。填写别人机器的地址
  不会绕过那台机器的 audience/signature 校验。
- 移除保留不可重新分配的 tombstone，防止旧票据/密钥因 ID 回收而跨用户生效。
- 每用户最多 32 个活动节点；注册还受存储数量限制。

### 直连密钥

原 VM 的旧 browser key 为迁移兼容继续使用，但只能签发给 zhn 已拥有的旧节点。
网页永不导出这把 legacy key。

新节点 key 从 **ACA-only root** 和 immutable node ID 经 HMAC 派生，与 Workspace
key 使用不同域。不能用存在于旧 VM 的 legacy shared key 推导新用户节点 key。
用户只能获取自己新节点的接入材料；不会获得全局 root 或其他节点 key。

VM 原有 HTTPS handler 已支持 node-bound tickets，现有 VM 无需重启。
新用户的机器需自行配置该唯一 ID、专属 key、允许的 Codey origin 和可信 TLS。

## 每条数据路径都检查归属

| 接口 | 规则 |
| --- | --- |
| `/api/nodes`、`/api/client-nodes` | 只返回本人节点；只签发本人 node ticket |
| `/api/settings`、node update/remove/enrollment | 从登录身份确定 owner，禁止 mass assignment |
| `/api/node-data/<id>/...` | 当前 owner + 服务端私网 allowlist + scope ticket |
| `/api/cloudcli/nodes` | 只列出本人已部署 Workspace 的节点 |
| `/cloudcli/<id>/...` | HTTP/SSE/文件/终端路径先检查 owner，再签发 SSO assertion |
| Workspace `/ws`、`/shell` | upgrade 时验证登录、Origin、node owner；不是仅隐藏入口 |
| `/api/session-history/<source>/...` | 非 Shared 的 source 必须属于当前 owner，包含 archive URL |
| Shared list/detail/archive | 已登录用户可读，普通用户不能 rename/delete/restore/purge |
| `/api/admin/users` | 管理员账号管理，不授予跨用户节点读取权 |
| `GET /api/admin/nodes` | 仅管理员可读全局节点元数据；不签票据、不返回 endpoint、密钥或私有数据 |

Workspace 长连接持续验证会话及节点授权。移除节点、停用或改密后，新请求立即
被拒绝，已建立连接最多 5 秒内断开；不杀掉用户在 VM 上启动的任务。
所有上游请求继续删除门户 Cookie、客户端身份头；HTTPS 仍校验 CA/SNI。

不接受通过旧 `/api/nodes/provision` 写入任意 node ID 的 hosted 注册方式，
避免“先伪造列表，再申请别人的直连票据”。普通用户不能通过全局 Shared 服务
凭据执行管理操作，Shared service client 只在服务端使用。

## 管理员只读节点总览

“账号与节点 → 全局管理 → 节点总览”与用户管理共用一个顶级页签，默认不影响
“我的节点”。总览统计所有已添加且未移除的节点，包含已停用用户的节点；
未激活、取消或过期的待配置身份不计入节点总数。所属用户数只统计拥有这些节点的账号。

总览将签名归属表、公开账号资料和升级器心跳快照按 **node ID + owner ID** 关联。
返回字段仅包括节点 ID/名称/区域、所属账号 ID/用户名/启停、上报状态/时间、
最近上报的节点发行版以及 CloudCLI、copilot-api 的版本、commit 和 Node major。
不会返回服务地址、私网 IP、凭据/哈希、配置、会话、文件路径、迁移或升级任务。
GET 不探测机器、不读目标发行版目录、不修改状态存储；普通用户为 403，其他方法为 405。

90 秒内的已授权升级器心跳显示“心跳在线”，超时显示“心跳超时”；
未接入、未首次上报、已撤销、账号停用或时间异常单独标识。版本是节点最近的上报值，
不是目标发行版，也不是模型/服务健康证明；失联后的值可能过期，缺失值显示“未上报”。
CloudCLI 列是节点端版本，共享 Workspace UI 独立发布，当前协议不报告 Codex CLI 版本。
存储损坏返回错误而非假装零节点；刷新失败保留明确标注时间的旧快照，权限失效清空总览。

支持搜索、所属用户/状态筛选和每页 20 条分页。仅在该面板可见时每 30 秒刷新，
另提供手动刷新；窄屏表格独立横向滚动，不撑宽整页。以上可见性不改变任何 owner ACL。

## 页面与缓存

- 右上角“账号与节点”管理个人节点，管理员另见包含只读节点总览及用户管理的全局管理区。
- 新用户看到空节点提示，不继承 zhn 的 `local`、VM 或 Workspace。
- Usage / Session History 的 VNet 小开关保留；仅有受信任私网配置的节点可用。
- 页面 CSP 的 `connect-src` 只包含本人的节点 origin，不泄露其他人的 endpoint。
- 数据响应 `no-store`；账号切换广播让其他标签页重新加载，心跳也检查身份变更。
- Session History 的节点分类来自本人列表；Shared 是明确公共共享区，
  已经主动上传到 Shared 的内容允许其他已登录用户阅读。

## 新节点 Workspace / VNet 部署

注册节点保存设置并给出独立接入参数，不等于自动安装软件或建立网络路由。

1. 用户创建自己的节点，取得其 node ID、client key、Workspace key、account ID。
2. 在自己的 VM 配置 copilot-api HTTPS。部署 CloudCLI fork，使用该用户的
   `CODEY_PORTAL_USERNAME` / `CODEY_PORTAL_PRINCIPAL_ID` 及该节点 SSO key。
3. 运维将该 node ID 对应的可信私网 upstream / TLS SNI 加入
   `config/node-data.aca.json` 和 `config/cloudcli-nodes.aca.json` 后发布。
4. 同一个节点只能有一个 owner；新用户不会自动获得当前 zhn 的 VM。

网页不能填写 arbitrary 私网 proxy target，防止将节点设置变成 SSRF 入口。
这是整节点隔离，不是在同一个 Linux 用户下为不互信用户提供 OS 沙箱。

## 仍然存在的边界

- 已发出的浏览器直连票据为离线验证，最多继续有效 60 秒；注销/停用后不能续签。
  它仍只适用于原 owner 的原 node，不会因此获得他人节点访问权。
- 已下载的数据无法远程收回。拥有 Azure/宿主机 root 权限的基础设施管理员
  不属于应用层账户隔离所能阻挡的攻击者。
- 新文件 store 使用现有 ACA-only root 的用途隔离 key。轮换 root 时必须先
  使用旧 key 读取并用新 key 重签 store，不能直接更换后丢弃已有账号数据。
- 如果进程在持有 `accounts.json.lock` 或 `node-registry.json.lock` 时被终止，
  写操作会失败关闭。运维确认旧 writer 已停止并保留备份后，才可移除对应锁；
  不根据超时自动窃取锁，不重建数据文件。
- 不应直接回退到旧单账号镜像：它不识别新账号/归属表，还可能复活旧 bootstrap
  密码。认证故障应保持 fail-closed 并前向修复。

## 验证

`test/admin-nodes-ui.test.mjs` 验证管理员入口、只读表格、筛选/分页、刷新、
失败/过期快照与权限失效清空；`test/node-updates.test.mjs` 验证跨 owner 元数据关联、
版本来源、心跳过期/撤销/归属不匹配及 GET 不修改存储。

`test/multi-user.test.mjs` 使用两个独立账号、两个可验证签名的模拟 VM、真实 HTTP
与 WebSocket，验证双向越权（包括管理员访问普通用户节点）、猜 ID、伪造用户头、
非法注册、直连错误 key、Shared 读写分离、配置持久化、会话迁移、改密、停用、
删除和活动连接撤销。模拟 VM 的 browser handler 不额外检查 owner，避免掩盖
Broker 签发越权票据的漏洞。

`scripts/verify-codey-multiuser-live.mjs` 在生产创建临时普通账号和无真实 VM 的
测试节点，测试隔离后移除测试节点、停用并删除临时账号。不会对真实 Shared
session 或他人节点执行潜在破坏性的负面测试；所有业务节点保持原样。
管理员密码只由 stdin 传入，测试密码/key/Cookie 不输出或保存在日志里。

记录目录：`Q:\codex_manager\artifacts\codey-multiuser-20260905`。

## 已部署验证结果

- 当前 revision：`codey--multiuser2-0905`；
  image：`codexshareef492f53f0.azurecr.io/codey:20260905-multiuser2`。
- 语法检查和 **77 tests** 全部通过。
- 真实 ACA 验证创建了临时普通账号：初始空节点，个人设置可独立保存；
  访问四个 zhn VM 的 Usage、History、Workspace HTTP、shell WebSocket
  均被拒绝，伪造用户头和已知节点 ID 无效。
- 使用临时账号自己的 node key 伪造 A100 audience，直接请求实际 A100 HTTPS
  接口返回 **401**。管理员也不能获取该临时用户节点的接入资料。
- Shared 可读取，普通用户不能执行 Shared 管理操作。
- 验证后已移除临时节点、停用并删除临时账号；保留不可复用的节点 tombstone，
  不保留活动测试账号。没有修改任何真实 Shared session 或业务节点设置。
- 浏览器无需重新登录即可打开“账号与节点”：仍为 zhn、5 个原节点，用户列表
  只有 zhn 管理员。
- 完整结果：`Q:\codex_manager\artifacts\codey-multiuser-20260905\final-verification.json`。
