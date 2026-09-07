---
name: codey-node-onboarding
description: "为 Codey 添加用户自己的机器节点，配置 copilot-api HTTPS 直连、Azure VNet 私网网关及 CloudCLI Workspace SSO，并验证节点归属和连接安全。用于新增节点或补齐节点接入，不用于导出 Codex 会话、修改门户登录体系或批量重装现有机器。"
metadata:
  version: "1.0.0"
---

# Codey Node Onboarding

这是旧的**手动接入说明**，不是完整安装包。新用户需要“先配置机器，再回页面添加”时，
使用 Codey 页面提供的 **Config new Codey machine 自动配置 Skill**：包含本人预留身份、
改版源码及锁定版本，自动安装 Node/CloudCLI/copilot-api 依赖、准备 TLS 和 VNet，最后导入机器文件。
不要仅凭本说明 ZIP / SHA-256 要求用户自己收集全部安装材料。

把一台**属于当前用户**的机器接入 Codey，保留正在运行的任务。使用当前项目的
Codey 改版 copilot-api 和 CloudCLI fork，不把上游原版当成已具备这些接口。

## 先确认范围

收集门户 HTTPS origin、节点所属账号、目标 OS/SSH 管理入口、节点 FQDN、
当前服务/端口，以及需要的能力：

| 能力 | 路径 | 必要条件 |
| --- | --- | --- |
| 直连 Usage / History | 浏览器 → 节点 HTTPS `8443` | 浏览器所在网络可达、可信证书、独立节点 ticket |
| VNet Usage / History | 浏览器 → ACA → 私网 HTTPS `8443` | ACA 网络连通、服务端可信网关配置、同一节点 ticket |
| Workspace | 浏览器 → ACA → 私网 HTTPS `3001` | CloudCLI fork、每节点 SSO、可信私网网关 |

直连默认开启，刷新旁的 VNet 勾选框只切换 Usage / History；Workspace 始终经
ACA。没有自动 fallback。本机是**当前浏览器所在电脑**，不是 ACA；除非专门建设
ACA 可达的私网链路，不为回环节点配置 VNet。无需旧的 `4242` relay 或 `4310` 本地门户。

只请求缺少的关键输入。用户只要方案或排障时，不自动安装服务、发布 ACA 或改网络。
执行前列出将修改的资源及影响；已经在用的 copilot-api、全局 Node/Codex、
VM 重启、网卡/IP/路由修改须单独确认，不视为“添加节点”的隐含步骤。

## 按需要读取

1. **所有新节点**：读 [节点注册与 HTTPS](references/enrollment-and-https.md)。
   用户在自己的账号注册，使用服务端生成的 ID 和独立密钥。注册不等于部署。
2. **需要 Workspace**：读 [CloudCLI 与单点登录](references/workspace.md)。
   先离线构建，再单独部署；保留原有 Codex 登录、文件和任务。
3. **需要 VNet 或 Workspace**：读 [Azure 私网与网关](references/vnet.md)。
   分清同 VNet、非重叠 peering、重叠地址的 Private Link；最后配置 ACA allowlist。
4. **交付前**：读 [验收与回退](references/verification.md)。验证正向连接和
   未登录/其他用户被拒绝，不能仅凭“端口可达”宣称完成。

仓库可用时先定位 `src/node-policy.mjs`、`src/settings-api.mjs`、
`copilot-api/src/lib/codey-https-config.ts`、`cloudcli/` 和 `config/`，
检查仓库指令及当前配置是否已变化。没有源码时，让运维提供同版本构建和网关配置，
不要猜测包下载地址或拿现有用户的凭据代用。

## 不变的隔离边界

- 显示名不是授权。新 ID 为服务端生成的 `n-` 加 24 位十六进制串，
  owner 是登录身份；不接收自定义 ID，不认领他人既有节点。
- 接入资料中的 `clientSigningKey` 仅用于本节点 `8443`，
  `workspaceSsoKey` 仅用于本节点 Workspace。不要混用或自行生成替代它们。
- 门户密码、会话 Cookie、ACA master、CA 私钥不分发给节点或写入报告。
  本下载包是通用操作说明，**不包含任何真实接入密钥或机器清单**。
- 私网 upstream 由运维审核后在服务端配置，不能从用户填写的 HTTPS 地址推导。
  不编辑签名的 `accounts.json` / `node-registry.json`，不重置认证 root。
- 一个节点绑定一个 owner；同一 OS 用户下的工作目录不是不互信用户之间的沙箱。
  Shared 是登录用户可见的共享区，私有节点 History 不应混入他人节点。
- 验证 TLS 的 CA、SAN、SNI 和有效期。不用禁用 TLS 校验、开放 Internet/Any、
  改默认路由或暴露 `4141` 来绕过接入问题。

## 可复用的离线工具

[scripts/gateway-entry.mjs](scripts/gateway-entry.mjs) 只生成**待审核的 JSON 条目**：

```text
node scripts/gateway-entry.mjs --node-id <门户生成的ID> --ip <ACA可达的RFC1918_IP> --tls <证书DNS名称>
```

工具不登录 Azure、不访问网络、不写配置、不处理密钥，也不证明 IP 的归属或可达性。
把输出分别合并到两份网关配置的 `nodes` 数组，不能覆盖已有节点。

交付简报说明：节点 ID / owner、已启用的连接方式、修改的资源、实测结果、
未测试项及精确回退边界。输出路径和摘要，不输出密钥、Cookie 或完整认证环境。
