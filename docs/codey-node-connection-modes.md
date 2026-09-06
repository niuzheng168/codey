# Codey 节点连接方式

> 日期：2026-09-05。取代 Usage / Session History “只能浏览器直连”的限制。
> 这是显式选择，不是自动降级，也不启动本地 Portal 或 relay。

## 交互

Usage 与 Session History 各自在**刷新按钮旁边**提供紧凑的 **VNet** 勾选框，
两处共用同一个设置并同步状态。原页面顶部的大块说明已移除；
完整说明改为悬停提示和屏幕阅读器描述。Workspace 不显示这个只读数据开关。

- 新浏览器默认不勾选，继续使用浏览器直连。
- 勾选后，Usage 和节点 Session History 全部通过同源 ACA API 读取，
  不向 VM 公网地址或浏览器本机发送数据请求，适用于非 CorpNet 客户端。
- 取消勾选立即恢复直连。失败时不会擅自切换路径。
- 选择仅保存在当前浏览器 localStorage；刷新保留，不改变其他用户或机器。
  退出登录清除站点数据后恢复默认直连。
- VNet 模式只显示服务端已配置并分配给当前用户的远程节点。
  `local` 指当前打开浏览器的电脑，不是最初部署 Codey 的 Windows 电脑；
  本机节点仅在直连模式访问，不计入 VNet 的远程节点响应分母。
- Workspace 始终通过 ACA → VNet，不受勾选框影响。Shared History 仍走原 ACA API。
- 切换路径后丢弃旧请求的结果，防止较慢的直连请求覆盖新的 VNet 状态。

## 路径

```text
默认：Browser → VM/public DNS:8443 + 节点专属短期 bearer ticket
                 或当前浏览器电脑 127.0.0.1:8443

勾选：Browser → Codey /api/node-data/<node>/<read-only path>
                 Cookie 登录 + 用户节点 ACL
               → ACA VNet → private IP:8443
                 TLS 校验 + 服务端新签发的只读 ticket
```

| Node | ACA private HTTPS upstream | TLS SNI |
| --- | --- | --- |
| zhn-a100 | `10.0.0.7:8443` | `zhn-a100.japaneast.cloudapp.azure.com` |
| jpe2 | `172.18.0.4:8443` | `zhn-jpe-2.japaneast.cloudapp.azure.com` |
| jpe3 | `172.16.0.4:8443` | `zhn-jpe3.japaneast.cloudapp.azure.com` |
| westus2 | `10.0.2.4:8443` | `zhn-usw2.westus2.cloudapp.azure.com` |

前三台复用现有 VNet/peering 和 HTTPS listener，无 VM/NSG 修改。
West US 2 仅给现有 `codey-westus2-ilb` 增加独立 TCP `codey-data-8443`
probe/rule，经原 Private Endpoint / PLS 转发到 VM `172.16.0.4:8443`。
原 `copilot-proxy-4141`、`cloudcli-3001` 规则不变，不开放新的公网入口。

## 安全边界

- 所有 `/api/node-data/*` 请求先验证现有可撤销门户登录。
- 节点必须同时属于当前用户的 server/client node lists，并存在于只读部署配置
  `config/node-data.aca.json`。用户填入的 URL 不参与选择私网上游。
- 配置只允许非回环 RFC1918 IPv4 HTTPS origin，要求显式 TLS hostname；
  使用 `codey-node-ca.pem` 验证 CA 和 SNI，不跳过 TLS 验证。
- 只允许 GET/HEAD，以及 `/usage`、三个 `/token-usage*` 路径、
  `/session-history` 和 active/archived 单会话详情。无模型调用、写入、终端、
  通用代理或 arbitrary URL 参数；query 参数也采用逐路径白名单。
- 不转发浏览器 Cookie、Authorization、API key 或身份头。
  服务端为此次读取签发 60 秒、node/principal/scope 绑定 ticket。
- 不跟随重定向；响应仅接受有限大小 JSON，有超时和并发上限。
  不转发上游 Set-Cookie，响应为 `private, no-store`。
- 退出后旧门户 Cookie 无法读取新的 VNet 数据。默认直连模式已经签发的
  browser ticket 仍遵循原有最多 60 秒离线有效期边界。

## 代码与验证

- Gateway：`src/node-data-gateway.mjs` / `src/server.mjs`。
- 浏览器：`public/node-transport.js`、`public/app.js`、两类 client aggregators。
- 部署：`PORTAL_NODE_DATA_CONFIG=/app/config/node-data.aca.json`，
  复用已有 `PORTAL_CLIENT_RELAY_SIGNING_KEY` secret。
- 测试：`test/node-data-gateway.test.mjs`、`test/node-transport.test.mjs`、
  `test/password-auth.test.mjs`。包含默认直连、不自动 fallback、VNet 不访问
  本机/公网、用户隔离、路由/query 白名单、TLS/JSON/超时、未登录和注销拒绝。
- 生产验证：`scripts/verify-codey-auth-live.mjs`。密码仅从 stdin 读取，
  可设 `CODEY_VERIFY_SKIP_BAD_PASSWORD=true` 避免额外失败登录次数。
- 变更前快照及验证记录：`artifacts/codey-hybrid-data-20260905/`。

本次只部署 Portal 镜像、增加上述私网 LB rule/probe；不更新或重启任何 VM、
copilot-api、CloudCLI，不改变本机服务、SSH、公共 IP、路由或既有网络规则。

## 已部署结果

- Revision：`codey--datavnet-0905`，100% traffic，portal/mcp 均 Ready。
- Image：`codexshareef492f53f0.azurecr.io/codey:20260905-node-data-vnet`，
  ACR run `ce18`。
- Digest：`sha256:d1b65c5f7072453b80f45111a96695cbf9395887d0e500b74b94ec75dcdbc86d`。
- `npm run check` 和 **66 tests** 通过。
- 生产 HTTP 验证：每台 VM 的四个 Usage API、历史列表/详情均 `200`；
  Workspace HTTP/WS 仍正常。匿名/伪造用户头/注销后的 Cookie 均拒绝，
  写入请求拒绝，任意 URL/节点不允许转发。
- 实际浏览器：默认未勾选 → 直连 `5/5`；勾选 → VNet `4/4`；
  VNet 历史有四个 VM 来源和 Shared（快照：合并后 477，Shared 79）；
  刷新保留选择，取消勾选恢复直连。验证后恢复未勾选。
- 这是本机 CorpNet 浏览器显式选用私网代理的验证，并未远控用户的非 CorpNet
  电脑；单元测试另外断言 VNet 模式不会发出浏览器本机/VM 公网数据请求。
- 发布期间新 ACA 副本曾短暂报告 Azure Files CSI driver 未注册，
  随平台初始化自行恢复；未修改挂载配置、迁移/删除数据或重启 VM。
- 发布前后比较确认：四台 VM 的 boot ID、copilot-api 和 CloudCLI MainPID
  均不变；本机 `4141` / `8443` 仍由原 PID `12972` 提供。
- 完整记录：`Q:\codex_manager\artifacts\codey-hybrid-data-20260905\final-verification.json`。

### 紧凑开关更新

2026-09-05 部署 `codey--compact-vnet-0905` / `codey:20260905-compact-vnet`。
仅调整前端布局：大块提示改为刷新右侧的 `VNet` 小勾选框，两页同步，说明移到
悬停提示及无障碍描述。没有更改认证、数据路由、节点服务或网络规则。

**67 tests** 通过；浏览器实测控件约 `72 × 38` CSS pixels，与 Usage 刷新同排，
Session History 刷新旁也可操作。切换 VNet 为 `4/4`，从历史页取消后同步回直连
`5/5`，两页没有水平溢出。验证后保留默认未勾选。
记录：`Q:\codex_manager\artifacts\codey-compact-connection-20260905\final-verification.json`。
