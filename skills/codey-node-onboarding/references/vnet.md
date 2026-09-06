# ACA 到节点的 VNet 接入

先完成 [注册与 HTTPS](enrollment-and-https.md)，Workspace 还需
[CloudCLI SSO](workspace.md)。门户管理员角色不等于 Azure 网络操作权限；
没有对应资源权限时提供计划和配置条目给运维，不索取或绕过管理员凭据。

## 1. 发现真实拓扑

用当前 Azure CLI/官方文档确认命令字段，先只读查询：

```powershell
az account show --query "{id:id,name:name,tenantId:tenantId}"
az containerapp show -g $AppResourceGroup -n $AppName `
  --query "{environment:properties.environmentId,legacyEnvironment:properties.managedEnvironmentId,revision:properties.latestReadyRevisionName}"
az containerapp env show --ids $EnvironmentId `
  --query "{subnet:properties.vnetConfiguration.infrastructureSubnetId,profiles:properties.workloadProfiles}"
az network vnet show --ids $AcaVnetId --query "{addressSpace:addressSpace,peerings:virtualNetworkPeerings[].{name:name,state:peeringState,remote:remoteVirtualNetwork.id}}"
az network vnet show --ids $NodeVnetId --query "{addressSpace:addressSpace,subnets:subnets[].{id:id,prefix:addressPrefix,nsg:networkSecurityGroup.id}}"
az network nic show-effective-route-table --ids $NodeNicId
az network nic list-effective-nsg --ids $NodeNicId
```

变量来自用户确认的目标资源；空字段先查证，不能凭旧节点样例补齐。记录：
ACA integration subnet/CIDR、VM NIC/subnet/private IP、相关 peering/UDR/NSG、
既有 Private Endpoint/PLS/ILB、TLS DNS、listener、当前 revision 和 rollback image。
不要在报告里输出 ACA secret、完整环境变量或含凭据的模板。

现有 Codey 使用支持 VNet 的 workload-profiles environment。若目标门户没有
VNet integration，不能把“新增节点”偷换成删除/重建其 ACA 环境；迁移涉及域名、
origin/证书、数据挂载和登录配置，须另立明确方案。不要为每台 VM 新建 ACA 环境。

## 2. 按地址关系选择路径

### 同一个 VNet

用现有 subnet 路由到 VM 私有 IP；不需要 peering、改公网 IP 或 reboot。
验证实际 NSG/UDR/OS firewall 没有阻断目标端口即可。

### 不重叠的 VNet

通常用双向 VNet peering（跨区域用 global peering）。先检查地址空间和已有
peering 路由是否冲突，不仅比较两台 VM 的 IP。已有可用 peering 直接复用。
准备两端名称、resource group、subscription 和 remote resource ID；经授权后
才创建缺失方向，例如：

```powershell
az network vnet peering create --subscription $AcaSubscription `
  -g $AcaResourceGroup --vnet-name $AcaVnetName -n $AcaToNodePeeringName `
  --remote-vnet $NodeVnetId --allow-vnet-access
az network vnet peering create --subscription $NodeSubscription `
  -g $NodeResourceGroup --vnet-name $NodeVnetName -n $NodeToAcaPeeringName `
  --remote-vnet $AcaVnetId --allow-vnet-access
```

两边应为 `Connected`。Peering 不自动传递到第三个 VNet；不要因此随意加默认路由。
普通节点访问不需要擅自打开 gateway transit、use-remote-gateways 或
allow-forwarded-traffic。需要这些功能时依据真实拓扑单独设计。

### 有重叠地址/ACA 已有冲突路由

不要强行 peering、改 VM IP/CIDR 或重置网卡。采用经批准的私有服务路径：

```text
ACA → ACA 可达的 Private Endpoint IP
    → 已批准的 Private Link Service
    → Standard internal Load Balancer 的独立 frontend / TCP rule
    → VM 私有 IP:8443 或 :3001
```

- 服务提供方先建/复用合适的 Standard ILB；后端仅是目标 VM，并创建对应的
  TCP health probes 和 rules。健康探测不要放行到应用身份校验接口。
- PLS 绑定该 ILB frontend，分配 NAT IP 池；在指定 PLS subnet 上按 Azure 要求
  配置 Private Link Service network policies，不修改无关 subnet。
- 消费方使用**与 ACA infrastructure subnet 分开的适用 subnet**部署 PE，
  通过精确 resource ID 和审批连接，避免面向任意订阅自动批准。
- 节点看到的业务源地址是 **PLS NAT IP**，不是 ACA 原始 subnet。
  ILB health probe 另按 Azure 的探测来源/`AzureLoadBalancer` service tag 配置。
- 验证 PE 连接 `Approved`、LB 后端/probe 正常，以及 ACA 发起的实际连接。
  网关 upstream 使用 **PE IP**，不能使用重叠网段中不明确的 VM IP。
- 同一个 ILB frontend:port 不能同时代表不同独立节点。新增机器需要隔离的
  frontend/服务或明确设计的不同端口，不把已有 `8443` rule 改指向新 VM。
  已有 `4141`、`3001`、`8443` rules/probes 不得被替换或删除。

这些资源有独立权限和费用。事先列出新增资源、审批方、预估影响及删除回退清单；
不为排障反复创建 PE/PLS 或清理别人的资源。

## 3. 最小必要网络规则

| 目标 | 正常业务源 | 用途 |
| --- | --- | --- |
| TCP `8443` | 实际 ACA integration subnet；走 PLS 时为 NAT IP 池 | VNet Usage / History |
| TCP `3001` | 同上 | Workspace |
| TCP `8443`（可选） | 已批准的 CorpNet/浏览器网络 | 浏览器直连 |
| LB probe | Azure LB 探测来源 | 仅 LB 后端探测端口 |

检查 NIC 和 subnet 两层 NSG、OS firewall 及回程路由。追加精确目的 IP/端口的
独立规则，选择真正空闲且符合现有 deny 顺序的优先级；不要硬编码 `100` 或
将 `VirtualNetwork`/`Internet` 全部放行。尤其 Workspace `3001` 只应从私网网关
可达，其他来源应被现有或经审阅的新规则拒绝。

保留 SSH、现有 CorpNet、provider `4141` 及其他业务规则。不要覆盖 NSG、
清空 firewall、替换默认路由、改公网 IP 或重启 VM。若必须变更这些已有配置，
停止普通接入步骤，单独告知影响并取得授权。

## 4. 服务端网关 allowlist

网络通了仍不等于门户可用。运维在**当前门户源码**中分别追加相同新 `nodeId`：

`config/node-data.aca.json` 的 `nodes` 数组：

```json
{
  "id": "n-0123456789abcdef01234567",
  "upstream": "https://10.42.0.4:8443",
  "tlsServerName": "node.example.test"
}
```

`config/cloudcli-nodes.aca.json` 的 `nodes` 数组（仅需要 Workspace 时）：

```json
{
  "id": "n-0123456789abcdef01234567",
  "name": "My workstation",
  "region": "Private VNet",
  "upstream": "https://10.42.0.4:3001",
  "tlsServerName": "node.example.test"
}
```

以上全部是虚构示例，不是可直接认领的节点。可使用本 Skill
`scripts/gateway-entry.mjs` 生成结构正确的条目，再**合并**现有配置。
此工具不验证 Azure 归属/网络，只接受新格式 ID、RFC1918 IPv4、合法 TLS DNS。

- `upstream` 必须是运维核实的私网 HTTPS origin，不带路径、凭据、query/fragment；
  PLS 模式填 PE IP。数据和 Workspace 可分开部署，不添加未启用的服务。
- `tlsServerName` 是证书 SAN 中的 DNS 名，不是 VM 的 Azure resource name。
  私网 IP 与 SAN 不同正常，通过固定 SNI 校验；不使用 insecure TLS。
- ACA 信任公开 CA 链（`config/codey-node-ca.pem` 或明确的 gateway CA 配置）。
  新增 CA 时保留仍在用的旧 CA，不能替换后让原节点失效；私钥不进镜像。
- ownership 真源是签名 registry；不能编辑 registry 或旧用户 JSON。
  新节点通常无需添加到旧 `config/nodes.aca.json`，也不能借此给其他账号分配它。
- 现有 data gateway 配置最多 32 个条目，注册是每用户最多 32 个活动节点。
  接近容量时显式报告，不静默删除其他人的条目。

## 5. 发布与证据

运行门户检查/测试，制作唯一 tag；确认 diff 只有预期 gateway/公开 CA 变更。
仅更新 ACA **portal container image**，保留 MCP image、secrets、resources、
挂载、environment 和账号数据。等待新 revision Ready 后再检查 HTTP/WS；
正常 rollout 不需要修改 workload quota 或 VM。

新副本刚启动的临时平台/CSI 报错先看 provisioning/events 与旧副本健康状况，
不要因此重建存储或环境。失败时沿 [验收与回退](verification.md) 恢复本次
allowlist/部署变更，不能退到不支持多用户隔离的老镜像。

架构资料（变更前核实当前官方说明）：

- `https://learn.microsoft.com/en-us/azure/container-apps/networking`
- `https://learn.microsoft.com/en-us/azure/virtual-network/virtual-network-peering-overview`
- `https://learn.microsoft.com/en-us/azure/private-link/private-link-service-overview`
