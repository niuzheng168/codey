# 先配置机器，再在页面添加

新流程使用 `config-new-codey-machine`，不是原来只有说明的
`codey-node-onboarding`。设置页只展示自动配置和验通后添加流程，不再提供旧版手动注册入口。

## 用户流程

1. 本人登录，选择 **Windows**、**Linux** 或 **macOS Apple Silicon/Intel** 个性化轻量 Skill。
   包内有预留机器身份、两个 Codey fork 的
   源码/lockfile/许可证、准确版本及校验值、网络和安装脚本。
   **不需要把所有 binary 打包**：Node 从官方发行地址自动下载并核验 SHA-256，
   Bun/npm 依赖按锁文件在独立 release 内安装，Codex 随 CloudCLI 的依赖安装。
2. Codex 盘点目标机、显示 Azure 网络计划，再在授权范围内配置服务、TLS、SSO、
   VNet。目标平台为 Azure Linux x64 或 Windows x64，使用不同的原生安装入口；
   Windows/macOS 作为控制端管理 Linux 时仍下载 Linux 包。
   缺普通工具由 Codex 按官方方式安装；Azure RBAC、系统权限和本人 provider 登录
   不能通过下载包凭空获得。已有任务、全局 Node/Codex 和其他服务不能被替换。
3. 本机验证后生成不含签名 key/私钥的 `codey-machine.json`。本人在页面选择文件，
   Portal 从真实私网验证 HTTPS、Usage、History、SSO、匿名拒绝及 WebSocket。
   **全部通过才添加**，并立即更新两个动态网关，不需每添加一台机器重新发布镜像。

下载不会创建可访问节点，只在签名 registry 中预留 `enabled=false` 的身份，有效期
七天。每用户最多四个未过期预留。失败后可重新下载同一预留，ID/key/到期时间不变；
避免重试反复创建身份和 Azure 资源。已取消、过期、已消费或别人的预留不能添加。

Linux 安装器只接管自己的未完成安装；`--retry-failed` 不能升级已就绪的服务。
Windows 的未完成安装必须先人工审查，不自动覆盖；成功安装重跑仅验收。
没有 Codex 数据库的全新机器返回空 History，不创建假 SQLite schema。
`copilot-api --headless` 不会在 systemd 中弹 provider 设置，但不会绕过模型身份认证。

## 独立平台入口

| 目标 | 包内入口 | 服务方式 |
| --- | --- | --- |
| Windows x64 | `scripts/setup-windows.ps1` | 原 owner 登录后运行的隐藏监督进程；不要求无人登录运行 |
| Linux x64 | `scripts/setup-linux.sh` | systemd 用户服务；旧 Python 入口保留兼容 |
| macOS Apple Silicon / Intel | `scripts/setup-macos.sh` | 本人 launchd 服务、独立 Codex 后端及私有 DevTunnel |

所有入口默认只输出计划。Windows 执行需显式 `-Apply -NetworkApproved`，Linux/macOS 需
`--apply`；Azure 网络脚本另行确认。Windows 安装器不改防火墙、执行策略或全局
Node/Python/Codex，也不停止占用端口的已有服务。Windows 包必须使用 `win-x64.zip`
Node 发行物，Linux 包使用 `linux-x64.tar.xz`；预留、重下和添加都绑定同一平台。

Mac 跳过 Azure VNet/VM 配置，使用各自的 `darwin-arm64.tar.gz` / `darwin-x64.tar.gz`
Node 发行物和第三份最小权限的隧道续期 key。复用现有本机 Codex/模型代理，新增的
服务只监听回环地址；门户验通私有隧道后激活。完整生命周期与部署/回退约束见
[macOS 节点](./codey-macos-nodes.md)。节点后台不需要 Azure 部署登录。

Windows 首次完整安装需要 Python 3.12+、原生 OpenSSL 和必要依赖构建工具。
新任务使用 InteractiveToken/LeastPrivilege、登录触发器，不使用 boot/SYSTEM/S4U。
Windows 没有 Linux 签名升级器；不为它分发 Linux 更新包或伪造心跳。
脚本/规划测试已覆盖的平台不等于在干净机器完成实际安装；发布 Windows 完整包前
还需验证依赖构建、PTY/SQLite、TLS/SSO、ACA 访问及重新登录自启。

### 既有 Windows Dev Box 的名称与在线依据

既有节点显示名使用 `windows-devbox`；保留历史兼容 ID `local`，不改变 session 路由、
SSO、密钥或保护规则。当前 Dev Tunnel 已能访问的机器无需重跑首次 VNet 安装器。
`local` 的 Usage/History 回环地址仍指向打开浏览器的设备，因此浏览器数据页标为
“浏览器本机”；不能把这个回环入口当成已开放的远程 Windows 用量服务。

节点总览将“升级器心跳”和“Workspace 健康检查”分开：可信 Dev Tunnel/Windows
节点通过现有 TLS 固定 `/health` 检查可达性，最多缓存 30 秒。不发送用户 Cookie、
SSO assertion 或模型密钥，失败不沿用在线结果。显示“Workspace 在线”时仍单独注明
“未接入升级器”，只显示实际健康接口报告的 CloudCLI 版本，不推测 copilot-api 版本。

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
python3 scripts/build-machine-bundle.py --platform linux-x64 --output /path/to/new-linux-release
python3 scripts/build-machine-bundle.py --platform windows-x64 --output /path/to/new-windows-release
python3 scripts/build-machine-bundle.py --platform macos-arm64 --output /path/to/new-mac-arm-release
python3 scripts/build-machine-bundle.py --platform macos-x64 --output /path/to/new-mac-intel-release
```

开发验证可显式加 `--allow-reviewed-diff` 纳入已审查的 **tracked diff**，manifest
记录 patch SHA；新源文件须先纳入 Git。生产发布优先使用干净提交。
这一步只生成几 MB 的源码包和清单；实际 runtime/npm 安装与构建发生在目标机。

在既有持久卷按平台发布清单和源码包；Mac 另含数据桥源码包（保留旧 release 供正在下载的用户使用）：

```text
/data/machine-bundles/
  releases/machine-<digest>/
    manifest.json
    cloudcli-source.tar.gz
    copilot-api-source.tar.gz
  active.json                 # {"releaseId":"machine-<digest>"}，原子切换
  platforms/windows-x64/
    releases/machine-<digest>/
      manifest.json
      cloudcli-source.tar.gz
      copilot-api-source.tar.gz
    active.json               # Windows 独立指针，不复用 Linux manifest/runtime
  platforms/macos-arm64/       # macos-x64 使用同样的独立目录结构
    releases/machine-<digest>/
      manifest.json
      cloudcli-source.tar.gz
      copilot-api-source.tar.gz
      portal-node-source.tar.gz
    active.json
```

Portal 固定文件名、限制大小、拒绝 symlink/path traversal，下载流重新校验 CRC/SHA。
个性化 enrollment 只在响应内生成，不落盘到公共下载区。
下载必须是已登录同源 POST，响应 `private, no-store`、`Vary: Cookie`、
`Content-Disposition: attachment`；无匿名 bootstrap 认证豁免。
页面通过同源 Fetch 获取轻量 ZIP，再交给浏览器保存；不再用会离开设置页的原生
表单 POST。下载请求明确使用 `referrerPolicy: "same-origin"`，保留可校验的 Origin，
不放宽服务端对跨源、空值或 `Origin: null` 的拒绝。首次下载与同身份重下共用处理，
下载中禁用重复提交，失败在按钮旁显示错误并刷新待配置身份，避免反复占用预留名额。

另在运维保护的位置保存 `config/machine-network.example.json` 对应的真实两个
subnet ID。PE subnet 必须与 ACA infrastructure subnet 不同且在同一个 Portal VNet。
在首次发布包含此功能的 Portal 镜像时配置：

```dotenv
PORTAL_MACHINE_BUNDLE_ROOT=/data/machine-bundles
PORTAL_MACHINE_NETWORK_CONFIG=/data/machine-network.json
```

还必须启用现有 Workspace SSO、data/workspace 网关及已发布的共享 Workspace UI。
未配置/缺包时页面只禁用对应平台下载，不能返回 Linux 代用品或旧的说明 ZIP。
Windows 使用同源 POST `/api/settings/machines/skill?platform=windows-x64`；
Linux 保持无参数旧入口兼容，也接受 `platform=linux-x64`。
平台查询不赋予调用方选择 owner、node ID 或 key 的权限。
Mac 使用 `platform=macos-arm64` 或 `platform=macos-x64`，只需私有 DevTunnel，
不读取或要求 Azure VNet 配置；详细运维边界见 [Mac 节点说明](./codey-macos-nodes.md)。
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

### 2026-09-07 上线前隔离验证

- 个性化轻量包约 4 MB；Ubuntu 24.04 x64 实机完成联网依赖安装、本机 TLS、
  Usage/History、SSO 和匿名拒绝。无 Codex 数据库的场景已覆盖。
- 从实际 ACA 网络经 Private Link 进行隔离验收，五个数据请求均为 200，
  Workspace HTTP 为 200、WebSocket 为 101；其他用户/管理员拒绝，注销撤销连接。
- 网络重复执行未增加资源；安装重复执行未重启两个服务或 VM。
- 门户 141 tests、Python 10 tests、copilot-api 28 tests、语法/typecheck、
  Skill validator 通过；390/1100 宽度 Chromium 布局验证无横向溢出（模拟数据）。
- 清理 81 个临时传输/隔离验证文件，未删除生产文件；测试机服务和私网资源保留。
- 以上验证完成时尚未发布生产版本；测试身份未加入生产节点列表，
  也未测试模型账号登录/推理。正式使用须以本人生产账号预留/绑定，
  不能导入隔离测试身份。

完整非敏感结果摘要位于 Git 忽略的
`artifacts/machine-onboarding-20260907/verification-summary.json`。

### 2026-09-07 生产发布状态

**门户与个性化轻量 Skill 已上线**，生产下载、同身份重下、取消、文件校验、
桌面/手机布局，以及从实际 ACA 到独立测试 VM 的 HTTPS、Usage、History、
Workspace SSO、WebSocket 和匿名拒绝均已验证。

旧四节点的 `copilot-api` 全量升级**尚未完成**：目标版本要求对外监听的模型 API
配置 API key，而现有四节点未配置；`westus2:4141` 仍有外部连接。
canary 已回滚到原版本，未关闭安全检查、添加假密钥、擅自关闭外部入口或修改客户端。
需确认并实施认证迁移后再升级旧节点；新机器安装流程已生成独立 API key，并使用
本机模型监听，不受这项旧配置阻碍。

源码版本、发布物和验收边界见
[生产发布与待完成的旧节点迁移](./codey-machine-release-2026-09-07.md)。
