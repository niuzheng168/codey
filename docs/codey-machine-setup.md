# 先配置机器，再在页面添加

新流程使用 `config-new-codey-machine`，不是原来只有说明的
`codey-node-onboarding`。旧的手动注册保留在设置页的“高级”折叠区域。

## 用户流程

1. 本人登录，下载个性化轻量 Skill。包内有预留机器身份、两个 Codey fork 的
   源码/lockfile/许可证、准确版本及校验值、网络和安装脚本。
   **不需要把所有 binary 打包**：Node 从官方发行地址自动下载并核验 SHA-256，
   Bun/npm 依赖按锁文件在独立 release 内安装，Codex 随 CloudCLI 的依赖安装。
2. Codex 盘点目标机、显示 Azure 网络计划，再在授权范围内配置服务、TLS、SSO、
   VNet。当前支持目标为 Azure Linux x64；Windows/macOS 可以作为控制端。
   缺普通工具由 Codex 按官方方式安装；Azure RBAC、系统权限和本人 provider 登录
   不能通过下载包凭空获得。已有任务、全局 Node/Codex 和其他服务不能被替换。
3. 本机验证后生成不含签名 key/私钥的 `codey-machine.json`。本人在页面选择文件，
   Portal 从真实私网验证 HTTPS、Usage、History、SSO、匿名拒绝及 WebSocket。
   **全部通过才添加**，并立即更新两个动态网关，不需每添加一台机器重新发布镜像。

下载不会创建可访问节点，只在签名 registry 中预留 `enabled=false` 的身份，有效期
七天。每用户最多四个未过期预留。失败后可重新下载同一预留，ID/key/到期时间不变；
避免重试反复创建身份和 Azure 资源。已取消、过期、已消费或别人的预留不能添加。

安装器只接管自己的未完成安装；`--retry-failed` 不能升级已就绪的服务。
没有 Codex 数据库的全新机器返回空 History，不创建假 SQLite schema。
`copilot-api --headless` 不会在 systemd 中弹 provider 设置，但不会绕过模型身份认证。

## 隔离与网络

- Portal 始终分配随机 node ID，owner 来自登录身份。ZIP 不含 Portal master、
  密码、Cookie、其他节点凭据、CA 私钥或 provider token。
- 每台机器生成 SAN 精确绑定预留 ID 的非 CA 自签名 leaf，私钥留在节点。
  Portal 在发送任何 HTTP ticket/SSO assertion 前校验证书。拒绝 CA、通配符、
  其他节点证书、公网/回环/metadata 地址及任意端口；固定私网 `8443/3001`。
- `vmResourceId` 是诊断元数据，不作为可抢占的全局授权名字。真正用于代理的是经过
  TLS/认证验证并写入签名 registry 的入口；不能凭猜到别人的 VM/node 名称访问数据。
- 新机器为 VNet 专用，无需公共 FQDN、浏览器证书安装或公网 SSH/Workspace 放行。
  Usage/History 与 Workspace 都走同源认证网关，旧节点的直连能力保持不变。
- 网络脚本同时检查目标/门户 CIDR 和门户已有 peering。重叠时创建节点专属
  `/28`、Standard ILB、PLS、PE，只批准精确连接；不覆盖既有 peering/LB。
- PLS 的动态 NAT IP 从其自动创建的 NIC 读取，不能假设 PLS 的 `ipConfigurations`
  一定返回实际 IP。NSG 限定目的 VM `/32` 和两个新端口，并检查共享 NSG 的 VNet
  范围，防止相同私有 IP 在其他 VNet 被误伤。私网源和 Azure probe 放行在 deny 之前。
- 原 SSH、公网 IP、VM IP、默认路由和其他业务不动；网络资源有独立费用。
  按生成的 `.azure-state.json` 审核本次回退，不能删除原网卡或共享网络。

## 运维发布一次性配置

先检查两个 public fork 的目标提交及工作树，不对运行服务做 `--remote` 同步。
依赖提交/push 在前，Codey submodule pointer 在后。构建只从 Git 导出源码，不打包
开发者 home、`.env`、缓存或数据库：

```sh
python3 scripts/build-machine-bundle.py --output /path/to/new-machine-release
```

开发验证可显式加 `--allow-reviewed-diff` 纳入已审查的 **tracked diff**，manifest
记录 patch SHA；新源文件须先纳入 Git。生产发布优先使用干净提交。
这一步只生成几 MB 的源码包和清单；实际 runtime/npm 安装与构建发生在目标机。

在既有持久卷发布固定三个文件（保留旧 release 供正在下载的用户使用）：

```text
/data/machine-bundles/
  releases/machine-<digest>/
    manifest.json
    cloudcli-source.tar.gz
    copilot-api-source.tar.gz
  active.json                 # {"releaseId":"machine-<digest>"}，原子切换
```

Portal 固定文件名、限制大小、拒绝 symlink/path traversal，下载流重新校验 CRC/SHA。
个性化 enrollment 只在响应内生成，不落盘到公共下载区。
下载必须是已登录同源 POST，响应 `private, no-store`、`Vary: Cookie`、
`Content-Disposition: attachment`；无匿名 bootstrap 认证豁免。

另在运维保护的位置保存 `config/machine-network.example.json` 对应的真实两个
subnet ID。PE subnet 必须与 ACA infrastructure subnet 不同且在同一个 Portal VNet。
在首次发布包含此功能的 Portal 镜像时配置：

```dotenv
PORTAL_MACHINE_BUNDLE_ROOT=/data/machine-bundles
PORTAL_MACHINE_NETWORK_CONFIG=/data/machine-network.json
```

还必须启用现有 Workspace SSO、data/workspace 网关及已发布的共享 Workspace UI。
未配置/缺包时页面禁用自动配置下载，不能悄悄返回旧的说明 ZIP。
后续依赖包发布可切换 `active.json`；已有机器不被自动升级或重启。

## 验证

```sh
npm run skill:build
npm run check
npm run machine:check
npm test
python3 test/machine-scripts.py
```

回归覆盖账号隔离、预留/重下/取消/过期/消费、verify-before-add、私网 leaf TLS、
匿名拒绝、WS upgrade、轻量包校验、Source/Node 供应源约束、CIDR/NSG/动态 NAT、
文件提取和无密钥机器文件。copilot-api 的 headless 与 fresh-history 测试在子仓库。
实机证据记录在独立 artifacts；本机、ACA、浏览器和模型推理结果分开报告。

### 2026-09-07 验证记录

- 个性化轻量包约 4 MB；Ubuntu 24.04 x64 实机完成联网依赖安装、本机 TLS、
  Usage/History、SSO 和匿名拒绝。无 Codex 数据库的场景已覆盖。
- 从实际 ACA 网络经 Private Link 进行隔离验收，五个数据请求均为 200，
  Workspace HTTP 为 200、WebSocket 为 101；其他用户/管理员拒绝，注销撤销连接。
- 网络重复执行未增加资源；安装重复执行未重启两个服务或 VM。
- 门户 141 tests、Python 10 tests、copilot-api 28 tests、语法/typecheck、
  Skill validator 通过；390/1100 宽度 Chromium 布局验证无横向溢出（模拟数据）。
- 清理 81 个临时传输/隔离验证文件，未删除生产文件；测试机服务和私网资源保留。
- **未发布生产版本，测试身份未加入生产节点列表；未测试模型账号登录/推理。**
  正式使用需要发布此功能并以本人生产账号重新预留/绑定，不能导入隔离测试身份。

完整非敏感结果摘要位于 Git 忽略的
`artifacts/machine-onboarding-20260907/verification-summary.json`。
