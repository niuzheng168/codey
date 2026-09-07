# 验收与精确回退

## 完成条件

1. 源码包及下载的 Node SHA-256 与 manifest 一致；Node、两个 fork 的 commit/version
   可追溯，npm/Bun 依赖使用锁文件安装，不要求所有 binary 都包含在 ZIP。
2. 目标机 `codey-copilot-api.service` 和 `codey-cloudcli.service` active/enabled。
   `4141` 仅 loopback；`8443/3001` 仅既有 VM 私有 IP；没有修改全局 Node/Codex。
3. 本机正确 SNI/CA 的 TLS 握手、带本节点 ticket 的 Usage/History、
   带本 owner 的 Workspace SSO 均通过；匿名请求 401。
4. Azure 路由按计划建立。Peering 双向 Connected；或 PE Approved，PLS NAT/IP、
   LB 规则与后端仅指向本机。实际 NSG 只允许正确来源的两个服务端口。
5. **由门户发起的** TLS、Usage/History、SSO 和 WebSocket 通过后，页面才能添加。
   本地 `/healthz` 200 不能代替 ACA 可达性。
6. 同 owner 能看到节点与 Workspace；未登录、其他用户/管理员不能访问或认领它。
   移除后不能用旧机器文件重新认领；需新的预留身份与明确的机器重配。
7. 如果用户要模型推理，另验证本人 provider 登录与一次真实请求。
   无 provider 认证不能标“全部就绪”；只读服务和网络通过可单独交付。
8. `codey-node-updater.service` active/enabled；加机完成后设置页显示升级器在线，
   owner/ID 和组件/Node 版本正确。私有升级凭据不能登录门户或调用模型，其他账号
   无法排队升级。后续通过页面确认更新，不借首次安装器重装或改变 enrollment。

## 故障定位

- 下载得到说明 ZIP：回到新入口下载“完整机器配置 Skill”，不是手动旧 Skill。
- 缺失 assets / hash 不匹配：停止执行，重新下载完整包；不拿别人的 enrollment 补齐。
- NSG 没有可用优先级或 Azure RBAC 不足：报告具体资源，不覆盖企业安全规则。
- SSH 超时：保持 SSH/公网规则不变；用用户已授权的 Azure 管理渠道。
- 地址重叠：PLS 路径，不强行 peering、不改 VM IP/默认路由。
- `installation.json` ID/release 不匹配、端口/服务被占：停止，不重装未知环境。
- 本机通过、门户添加失败：检查 PE/LB/NSG/UDR/ACA egress；保留机器文件供重试。
  不删除正在工作的节点或重新创建多个邀请绕过失败。

## 回退

- 未添加的配置包：在门户“待配置身份”取消，立即拒绝该 ID 后续添加。
  包有签名 key，应从 Downloads/临时传输位置移入 owner 受保护目录或删除多余副本。
- 已添加的机器：本人在页面移除；撤销门户访问，但不关 VM、不删项目/会话。
- 本次首次安装：只 disable/stop `codey-copilot-api.service` 和
  `codey-cloudcli.service`、`codey-node-updater.service`；仅在它们确属本次新建时操作。
  保留 `.codex`、业务数据、证书与诊断，别清理用户目录。
- Azure：依据对应 `.azure-state.json` 逐项审核本次新建资源。先移除本次 NSG rules，
  PE → PLS → 本次 NIC backend association → LB → 专属 /28；不要删 NIC 或原 subnet。
  删除前核实 node-specific name/ownership tags 与当前引用，避免删除后来已复用的资源。
  新建 peering 仅在确定没有其他节点依赖时撤回，复用的 peering 永不删除。
- Linger 是 OS user 级设置；若还有其他用户服务依赖它，不回退关闭。

不通过回滚清除真实故障证据，不通过关 TLS 校验、伪造门户会话或共享 master 来“验通”。
