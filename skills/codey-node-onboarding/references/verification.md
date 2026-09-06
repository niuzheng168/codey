# 验收、故障定位与可回退边界

## 成功标准

仅验证用户本次启用的能力，未部署的能力明确标记“不适用”，不可宣称已成功。
网络测试必须从实际消费方做：本机能访问 VM 不证明 ACA 可达，ACA TCP 可达也不
证明浏览器证书信任/CORS/权限正确。

| 检查 | 预期 |
| --- | --- |
| owner 登录后的节点设置 | 只出现自己的节点；新 ID、owner 不被手工重写 |
| HTTPS listener | 正确 CA/SNI/SAN/有效期；`healthz` 或 CloudCLI `health` 正常 |
| 匿名数据请求 | `8443/usage`、节点 History 拒绝；健康检查可匿名 |
| 直连（若需要） | 四个 Usage API 与 History 正常，失败不自动切换 VNet |
| VNet（若需要） | 勾选刷新旁 VNet 后，浏览器只请求 Codey 同源 `/api/node-data/<id>/...` |
| VNet 数据 | `/usage`、`/token-usage`、`/token-usage/daily`、`/token-usage/events` 与 History 正常 |
| Workspace（若需要） | `/cloudcli/<id>/` 免二次登录，资源/API/SSE/WebSocket/shell 正常 |
| Workspace 直达 | 匿名 `3001/api/auth/status` 返回 `401`；其他网络不应直接进入 |
| 未登录 Codey | 节点接口/Workspace 拒绝，页面最多跳登录页，不返回私有内容 |
| 另一个已授权测试账号 | 猜 ID、改 URL、伪造身份头都不能读目标节点、History、enrollment 或 Workspace |
| Shared | 普通账号只读共享内容，不看到其他账号的私有节点来源 |

使用自己的测试节点/专用临时账号做负面测试，经授权才创建和清理测试资源。
不要对他人的真实会话尝试删除、改密、移除节点来证明权限；不要上传私密测试内容到
Shared。检查 HTTP 和 WebSocket，不只检查列表是否隐藏。仅知道名称或复用别人的
endpoint 不能获得 access ticket。

Workspace smoke test 使用独立临时项目/文件，在授权范围内做一次无害的 shell
命令或聊天；不要影响已有任务。大规模枚举所有项目/会话不是节点接入验收的必要步骤。
退出/撤销会话后 Workspace 新连接拒绝，既有连接按服务 lease 关闭；浏览器 ticket
的离线最长 60 秒边界需单独说明。

门户源码的最低回归检查：

```text
npm run check
node --test --test-concurrency=2 "test/*.test.mjs"
```

这些测试中的 loopback 临时端口是隔离的测试进程，不要顺便启动旧本地门户。
运行节点构建/测试时依照对应仓库指令，不能用重新安装全局依赖当作测试。

## 常见故障分层

- **页面没有节点**：当前账号、signed owner registry、tombstone、是否只在另一个
  账号创建；不是网卡问题。admin 不自动拥有所有节点。
- **能看到节点但 VNet 未配置**：generated ID 是否已加入服务端 allowlist、
  新镜像是否 Ready；网页设置不会自动创建私网 target。
- **超时**：在 ACA 验证 TCP 路由、两层 NSG、listener、OS firewall；
  重叠 CIDR 检查是否误用了 VM IP 而非 PE IP。PLS 看 NAT 源与 LB probe。
- **TLS 错误**：检查时钟、证书有效期、完整链、CA、SAN/SNI 和 DNS；
  IP 可达不代表 hostname 校验正确。不要改成不验证 TLS。
- **401/403**：nodeId、两类 key 是否放反、精确 origin、SSO username/principal、
  系统时钟、ticket 期限、method/path 及登录状态。只看字段匹配，不打印凭据。
- **Workspace 空白/404**：确认是当前 Codey fork，并按实际
  `/cloudcli/<nodeId>/` 编译；检查 proxy prefix 与 WS URL，不能靠改第二次登录绕过。
- **本机权限点击重试仍失败**：检查 loopback HTTPS listener/证书、浏览器
  Local Network Access，以及浏览器指向的是本机；无需启动 relay 掩盖问题。

## 回退及报告

事前保留本次修改文件、资源 ID、旧 revision/image、NSG/LB 规则摘要、服务状态。
不要把真实 keys/env/cookies 放进可下载报告。

失败时一次只回退本次新增的配置/资源：

- ACA：退回**最近仍支持当前多用户 schema/认证**的已知健康配置或前向修复。
  不重建账号/节点 registry，不轮换 master，不删除 Azure Files/MCP 数据。
- CloudCLI：恢复自己的 previous release/unit/env，仅重启 CloudCLI；
  新安装没有 previous 时只停新服务并保留文件。不覆盖活动数据库。
- 网络：仅撤回此次明确创建且确认无人依赖的规则/peering/PE/PLS/LB 条目。
  发现其他资源已依赖它们时停止并交由运维协调。
- 节点 registry：移除节点会留下不可复用 tombstone；不是恢复旧 ID 的手段。
  不为了重试而反复移除/重建节点及丢弃旧数据。

交付前对比受保护的 VM boot ID、copilot PID/端口、SSH 和现有网络规则；除获准的
改动外应不变。报告具体测试与结果、哪些是真实 ACA/浏览器实测、哪些只是离线检查，
并列出仍待权限/网络/维护窗口的步骤。没有执行的测试不能写“通过”。
