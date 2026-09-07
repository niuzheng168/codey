---
name: config-new-codey-machine
description: "配置一台新的 Codey 机器：使用登录用户下载的接入与改版源码包，自动安装 Codey CloudCLI/copilot-api 及独立 Node/Codex 依赖、每机器 HTTPS/SSO 和 Azure VNet；产出机器文件，最后由用户在门户验通并添加。适用于首次配置 Azure Linux x64 VM，也可从 Windows Codex 经 SSH/Azure 编排；不覆盖已有机器身份、任务或服务。"
---

# Configure a new Codey machine

遵循顺序：**下载本人完整包 → 配置目标机器与 VNet → 页面验通并添加**。
下载只预留七天有效的机器身份，不会把未部署的机器放进节点列表。
修复后重试时可在“待配置身份”重新下载，保留同一 ID/key/有效期；不要不断创建新身份
和重复的 Azure 网络资源。已成功配置的机器不能借重试包自动升级。

## 包中已有的材料

- `assets/enrollment.json`：本次预留 ID、owner、两个独立节点 key、门户网络信息。
- `assets/manifest.json`：审查过的准确 commit/version、平台、各文件 SHA-256。
- 两份 `*-source.tar.gz`：对应 fork 源码及许可证，包含此发行版的本地补丁。
- 两个脚本：自动下载校验 Node、安装锁定的 Bun/npm 依赖、构建应用、配置 Azure 网络
  与目标机服务。TLS leaf/key 在目标机本地生成。

这是**轻量联网安装包**，不把 Node 等所有 binary 塞进 ZIP。脚本将它们安装到独立
release 目录，不改系统 Node/npm、nvm default 或已有服务；目标需可访问官方 Node、
npm registry 及锁文件引用的依赖源。Bun 只用于构建，服务使用独立 Node。

**不要再要求用户逐个提供 enrollment、改版软件包、TLS 材料或证书 FQDN。**
校验所有依赖摘要；不要换成 npm 上游 `latest`，否则会丢失 Codey 补丁。
“最新”由运维发布完整、已验证的依赖 release 决定；一份下载在配置中不会漂移版本。
源码目录中的 Skill 不含私人 assets；只有登录后下载的个性化 ZIP 可直接执行。
缺少这些 assets 时，引导用户回 Codey 下载“完整机器配置 Skill”，不要假造材料。

## 确认目标与授权

只确认目标 VM/OS owner 与可用管理方式；若当前就在目标 VM，可由 IMDS 发现资源 ID。
同一完整包只用于**一台**目标机，不能把包转给其他账号或反复换机器。
此版目标是 **Azure Linux x64（Ubuntu 24.04 / Python 3.12 已验证）**。
Windows/macOS 上的 Codex 可作为控制端；不能在 Windows 上运行 Linux 安装器，
也不能把未知操作系统/架构包装成已支持。

只读检查已有服务、`4141/8443/3001`、磁盘、owner、`~/.codex` 配置是否已存在。
脚本拒绝接管既有 copilot-api / CloudCLI、占用的端口及别的安装身份；遇到冲突先说明，
不停止旧进程、升级全局 Node、修改 Codex provider、重新登录现有账号或重启 VM。

Azure 网络权限与 Codey 登录权限不同。复用用户已有 `az` 登录；没有授权时让本人
在正常登录界面完成 `az login`，不索取 token、ACA master、门户密码或共享账号。
跨订阅/资源组缺少 RBAC 就准确报告具体权限缺口，不绕过权限或声称全自动完成。
先检查控制端的 Python 与 Azure CLI、目标端的 Python 3.12/OpenSSL 和必要编译工具；
缺少普通工具时由 Codex 按官方安装方式补齐（优先用户级隔离安装），而不是向用户索要
二进制包。需要管理员权限安装系统工具时说明影响并取得授权。

## 1. 自动准备 VNet

先在拥有 Azure 权限的控制端运行网络计划；替换下面的路径/VM ID：

```text
python scripts/azure-vnet.py --enrollment assets/enrollment.json --vm-id <目标VM完整资源ID> --out output/network.json
```

脚本读取真实 NIC、subnet、ACA VNet 和已有 peerings，自动选择：

| 拓扑 | 实施 |
| --- | --- |
| 同 VNet | 复用路由，仅限定新服务的 NSG 规则 |
| 无地址冲突 | 复用或补齐双向 peering |
| 与 ACA / 已有 peering 网段重叠 | 独立 /28、Standard ILB、PLS、精确批准的 PE |

说明计划中的资源、费用及影响后，加 `--apply` 执行同一命令。普通的“配置这台机器，
包括 VNet”授权覆盖列出的新增节点资源；不覆盖改 IP、默认路由、SSH、防火墙全局策略、
其他节点或重启。Private Link 只添加本 VM 的 LB 后端成员，不替换它的 IP/NIC。
Azure 资源和两条限源端口规则都有节点专属名字；输出对应 `.azure-state.json` 留作回退。
不要将现有 `172.16/16` 冲突简单归结为“缺 peering”，也不要改已有节点的 LB rule。

控制端与目标机不同时，把完整包和 `output/network.json` 安全传给目标 owner。
优先用用户授权的 SSH key；SSH 超时时可用 Azure Run Command，不开放 Internet SSH。
大文件可经受控私有存储临时传输；令牌仅放受保护文件/API 请求体，不写命令行或日志；
验证相同 SHA-256，传输完成撤销临时权限。不要把 enrollment/key 放到公共 URL。

## 2. 安装并自检目标机

在目标 **OS owner** 的 shell 中执行，不能以 root 运行安装器：

```text
python3 scripts/configure-machine.py --network-file output/network.json --out output/codey-machine.json
python3 scripts/configure-machine.py --network-file output/network.json --out output/codey-machine.json --apply
```

先读计划再执行。需要 SSH 退出后继续服务时说明 `loginctl enable-linger <owner>`
这个 OS 设置并在获准后启用，或传 `--enable-linger`；权限不足时不擅自更改 sudoers。
Azure Run Command 默认 root：只在 root 层完成经授权的 linger，再用 `runuser`、
正确 HOME/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS 在 owner 身份运行安装器。

配置结果：

- 独立安装在 `~/.local/share/codey-machine`，密钥在 `~/.config/codey-machine`（0600）。
- `codey-copilot-api.service`：模型 API 只监听 `127.0.0.1:4141`；
  节点私网 HTTPS `8443` 提供 ticket 认证的 Usage / History。
- `codey-cloudcli.service`：私网 HTTPS `3001`，只接受绑定本次 owner/node 的 SSO。
- 每节点非 CA 自签名 leaf，只包含服务端预留的 DNS SAN；门户只信任这片 leaf。
  不需分发 CA 私钥、申请公共 FQDN 或安装全局信任链；此节点默认 **VNet 专用**。
- 重跑同一成功配置只验收，不重启/重写服务。失败只停止本次新启动的服务，保留诊断。
  依赖构建日志位于 `~/.config/codey-machine/dependency-build.log`。审查失败原因后可用
  `--retry-failed` 重建本次未完成 release；不能借此升级已经就绪的服务。

现有 Codex 登录/config 保留。新机器无模型身份时，服务可先以 `--headless` 启动，
但**不代表模型已登录或能生成回答**。用户可使用 CloudCLI 的本人 Codex 登录，或运行
`~/.local/share/codey-machine/bin/copilot-api auth login --provider copilot` 完成本人授权。
不要替用户选择其他 provider、复制你的 token 或谎报模型推理通过。

## 3. 回页面添加

安装自检通过才生成 `output/codey-machine.json`，包含 ID、公开证书和网络元数据，
**没有两个签名 key / TLS 私钥 / provider 密钥**。
把这个文件交给同一用户，在 Codey“添加机器 → 选择配置完成的机器文件 → 验通并添加”。
不能上传完整 ZIP、SHA-256 文本或 `enrollment.json` 来代替机器文件。

门户检查预留身份与当前 owner，并从 ACA 实际验证 TLS、Usage/History、SSO、
匿名拒绝与 WebSocket；失败保持未添加，成功才启用节点和两个动态私网网关，
**无需每加一台机器重建/发布门户镜像**。其他用户，包括管理员，不能认领此 ID。
新节点的 Usage/History 固定走 VNet，Workspace 使用门户统一托管的前端。

按 [验收与回退](references/verification.md) 交付：准确区分本机测试、ACA 测试、
浏览器测试和模型登录；只输出非敏感摘要、文件路径和本次回退范围。
