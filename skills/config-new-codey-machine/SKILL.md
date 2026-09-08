---
name: config-new-codey-machine
description: "配置新的 Codey 节点：Windows/Linux 使用原生 Azure VNet 安装包；macOS Apple Silicon/Intel 使用独立 CloudCLI、HTTPS 数据服务及私有 DevTunnel。默认先计划，产出无密钥机器文件后由门户验通添加。Mac 保留现有 Codex/模型代理，launchd 登录后运行并仅续期本节点令牌。不覆盖既有身份、任务或服务。"
---

# Configure a new Codey machine

遵循顺序：**下载本人对应平台完整包 → 配置目标机器及 VNet/DevTunnel → 页面验通并添加**。
下载只预留七天有效的机器身份，不会把未部署的机器放进节点列表。
修复后重试时可在“待配置身份”重新下载，保留同一 ID/key/有效期；不要不断创建新身份
和重复的 Azure 网络资源。已成功配置的机器不能借重试包自动升级。

## 包中已有的材料

- `assets/enrollment.json`：本次预留 ID、owner、两个独立节点 key、门户网络信息。
- `assets/manifest.json`：审查过的准确 commit/version、平台、各文件 SHA-256。
- 两份 `*-source.tar.gz`：对应 fork 源码及许可证，包含此发行版的本地补丁。
- Linux 包的 `assets/codey-updater/`：独立升级器、仅绑定本节点 owner/ID 的升级凭据和发行版公钥。
  重下载同一待配置身份不会轮换这份凭据；它不能调用模型或登录门户。
- 当前平台的原生入口及公共辅助脚本：下载校验 Node、安装锁定依赖、构建应用。
  Azure 网络计划与安装执行分开确认，TLS leaf/key 在目标机生成。

## 平台与入口

| 目标 | 入口 | 服务方式 | 状态 |
| --- | --- | --- | --- |
| Windows x64 | `scripts/setup-windows.ps1` | 原 owner 的 InteractiveToken 登录任务，隐藏监督进程 | 原生脚本；必须使用已发布的 Windows 完整包 |
| Linux x64 | `scripts/setup-linux.sh` | systemd 用户服务及独立签名升级器 | 原生脚本；现有 Linux 包保持兼容 |
| macOS Apple Silicon / Intel | `scripts/setup-macos.sh` | 本人 launchd 登录服务及私有 DevTunnel | 分架构完整包；不回退到 Linux/Windows |

门户分别发布 Windows、Linux、macOS Apple Silicon/Intel 的依赖清单和包。尚未发布某平台包时，其下载按钮必须
明确不可用，不能给用户 Linux 包、只有说明的 ZIP 或旧的工作站安装器。
旧 `/bootstrap/*` / `install-codex-workstation.*` 配置工作站，不是这个完整节点流程。
重下载待配置身份保留原平台、ID/key 和有效期，不能借重试更换操作系统。
Windows/Linux 使用 Azure VNet；macOS 使用自己的 DevTunnel，跳过下方 Azure 网络步骤。
既有 Windows DevTunnel 节点不需重新运行首次安装，也不轮换其密钥或重启其服务。

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
目标为 Azure Linux x64、Windows x64 或 macOS。Linux 的 Ubuntu 24.04 / Python 3.12
路径已有部署验证；Windows 安装器需要 Python 3.12+、原生 OpenSSL 和依赖构建工具。
必须如实记录 Windows 的首次干净机器安装验收，不能把语法/规划测试当成完成安装。
控制端系统不等于目标系统：Windows/macOS 上的 Codex 仍可管理 Linux 目标。

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

**本节仅用于 Windows/Linux。Mac 不需要 Azure VM resource ID、VNet、入站防火墙规则，
也不允许用伪造的 VM 信息绕过平台校验。Mac 直接使用下面的 macOS 步骤。**

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

## 2. 使用匹配的原生入口安装

### macOS

使用本人下载的 Apple Silicon 或 Intel 完整包；不能在两种架构之间互换包。
本机需要已登录/可用的 Codex 和现有 `127.0.0.1:4141` 模型代理；这是为了复用已有
工作站，而不是覆盖其 provider、登录、模型目录或全局运行环境。缺少模型身份时先由
本人正常配置，不复制其他机器的凭据。脚本自动发现 Codex 中 `cat <key-file>` 的
现有凭据引用；其他配置可显式提供 `--usage-key-file`，但不把密钥内容放进参数。

普通工具为 Python 3.12+、OpenSSL 3、Xcode Command Line Tools 和 DevTunnel。
缺失时先按官方方式安装这些普通工具；可使用现有 Homebrew，不能用 sudo 运行节点。
完成 `devtunnel user login`；这是独立登录，**不要求 Mac 节点拥有 Azure 部署权限**。
只创建绑定此次随机节点 ID 的私有隧道和 HTTPS 3001/8443 端口，不允许匿名访问。

```text
bash scripts/setup-macos.sh --name "Mac"
bash scripts/setup-macos.sh --name "Mac" --apply
```

默认先输出计划；可使用 `--codex-bin`、`--devtunnel-bin`、`--openssl-bin`、
`--workspace-root` 指定已审查的本机路径。若公司网络要求使用已批准的 HTTPS npm
镜像，用 `--npm-registry <无凭据HTTPS地址>` 指定；只在独立 release 中改写 tarball
位置，保留所有锁定版本及 integrity，不关闭 TLS/摘要校验、不放宽全局 npm 策略。

安装边界：

- 服务和固定 Node runtime 位于 `~/.local/share/codey-machine-macos/<nodeId>`；
  独立 DB、TLS leaf/key、enrollment、私有日志位于
  `~/.config/codey-machine-macos/<nodeId>`，目录 0700、敏感文件 0600。
- 只新建 CloudCLI 与 HTTPS 只读数据服务，监听 `127.0.0.1:3001/8443`。
  数据服务带本人已有代理 key 读取本机用量，读取本机 Codex 历史；不向其他地址转发该 key，
  不重启或修改 `4141`、Codex、其他节点、SSH、系统代理/路由或防火墙。
- Codey 使用同一个已发布的共享 Workspace UI；此 Mac 只构建独立后端。
- 本人 launchd 登录后运行 codex、workspace、data、tunnel 和 renewal；Mac 需开机、保持
  登录和联网。不会禁止休眠、修改电源策略或安装 root/system 服务。
- 续期使用第三份仅绑定本节点的 `tunnelUpdateKey`，不是模型、数据 ticket 或 SSO key。
  它只能提交同一 tunnel ID 的 connect-only 令牌，不能启用节点、改证书、换归属或管理
  Azure。门户验证真实 DevTunnel 服务，令牌加密存入签名状态；不写入公开机器文件，
  不转发到浏览器，不每次续期发布 ACA revision。
- DevTunnel 账号/MFA 仍可能要求本人重新登录。续期失败只报告并退避，不开放匿名访问。
  节点取消/移除或 owner 停用后，续期请求拒绝；用户退出 Codey 后不能继续访问 Workspace。
- 成功安装重跑只验收，不重启或升级。失败保留审计与同一隧道 ID；审查后使用
  `--retry-failed`，禁止重新下载/创建一堆身份或接管未识别的既有服务。

自检通过生成 `output/codey-machine.json`，其中只有节点 ID、平台、公开 TLS 证书、
隧道坐标和名称；不含 connect token、更新 key 或本机 provider key。回页面“验通并添加”，
由 ACA 验证真实隧道、TLS、Usage/History、SSO 和 WebSocket 后才算接入。
本机自检不代表云端可达，也不代表模型推理已经验证；交付时另做独立测试任务/项目。

原生桌面正在占用的 Codex 会话不允许强行接管、删锁或静默 fork；新增节点并不改变
此所有权保护。现有桌面会话与新建 Codey 任务的执行能力须分别验收。
Codey 新任务使用独立的 Codex app-server 与本人专属 Unix socket；它不替换桌面进程
或默认控制 socket。配置的后端不可用时明确失败，不自动改用旧 exec SDK。
使用已安装的 Codex 原生可执行文件，共享本人已有登录/config；原生历史仍按只读规则读取。

### Windows

先完成同一身份的 Azure 网络计划/授权，把 `output/network.json` 交给目标 owner。
在原用户、**非管理员** PowerShell 中先运行计划：

```powershell
.\scripts\setup-windows.ps1 -NetworkFile .\output\network.json -Name windows-devbox
```

检查计划中的端口冲突、私网监听地址、来源网段和磁盘/工具要求。获得明确网络确认后：

```powershell
.\scripts\setup-windows.ps1 -NetworkFile .\output\network.json -Name windows-devbox -Apply -NetworkApproved
```

可用 `-PythonExe`、`-OpenSslExe`、`-CodexExe` 指定已安装的绝对路径。脚本不升级
全局工具、不改执行策略、不转入 WSL，不更改既有 Codex config/provider/login。
原生 Codex 读取器优先由 owner 用 `-CodexExe` 指向已安装且验证过的 Desktop CLI；
未指定时仅查本次发行包的原生可执行文件，不从任意 PATH 取替代程序。

网络授权并不意味着脚本自动改防火墙。Windows 防火墙如需补规则，先单独展示并
取得确认：仅允许 network.json 的 `allowedSources` 到本机指定私网 IP 的
TCP 3001/8443；Private Link 还需审核 Azure LB 健康探测源。不要开放 4141/22、
Internet/Any 或更改全局防火墙策略。权限不足不能偷偷切到管理员/SYSTEM。

Windows 独立目录是 `~/.local/share/codey-machine-windows` 与
`~/.config/codey-machine-windows`，后者及发行目录 ACL 仅 owner/SYSTEM/Administrators。
每节点创建两个唯一登录任务，使用 pythonw 隐藏监督独立 Node 服务，非登录期间不运行。
受保护 copilot-api / 已用端口 / 未识别安装目录导致拒绝安装，不接管已有服务。
失败仅撤销这次创建的精确任务，保留目录和 owner-only 构建日志；不递归清理旧目录。
同一成功安装重跑只验收；首次安装器不是升级工具。

Windows **尚不安装 Linux 签名升级器**。可达性由门户通过已验证 TLS 的 Workspace
健康接口检测；“Workspace 在线”与“有升级器心跳”是两件事。不要伪造心跳、填入
目标发行版版本，或因此放开该节点的升级权限。

### Linux

在目标 **OS owner** 的 shell 中执行，不能以 root 运行安装器：

```text
bash scripts/setup-linux.sh --network-file output/network.json --out output/codey-machine.json
bash scripts/setup-linux.sh --network-file output/network.json --out output/codey-machine.json --apply
```

旧 `configure-machine.py` 入口保留兼容，但不能直接用它安装 Windows。
先读计划再执行。需要 SSH 退出后继续服务时说明 `loginctl enable-linger <owner>`
这个 OS 设置并在获准后启用，或传 `--enable-linger`；权限不足时不擅自更改 sudoers。
Azure Run Command 默认 root：只在 root 层完成经授权的 linger，再用 `runuser`、
正确 HOME/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS 在 owner 身份运行安装器。

配置结果：

- 独立安装在 `~/.local/share/codey-machine`，密钥在 `~/.config/codey-machine`（0600）。
- `codey-copilot-api.service`：模型 API 只监听 `127.0.0.1:4141`；
  节点私网 HTTPS `8443` 提供 ticket 认证的 Usage / History。
- `codey-cloudcli.service`：私网 HTTPS `3001`，只接受绑定本次 owner/node 的 SSO。
- `codey-node-updater.service`：使用 OS Python 3.12+，仅出站 HTTPS 拉取本人确认的
  签名发行包；不依赖正在升级的 Node、CloudCLI 或 copilot-api，也不开放管理端口。
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

门户检查预留身份、平台与当前 owner，并从 ACA 实际验证 VNet/DevTunnel、TLS、Usage/History、SSO、
匿名拒绝与 WebSocket；失败保持未添加，成功才启用节点和两个动态私网网关，
**无需每加一台机器重建/发布门户镜像**。其他用户，包括管理员，不能认领此 ID。
新节点的 Usage/History 固定走已认证云端网关（VNet 或 DevTunnel），Workspace 使用门户统一托管的前端。

Linux 添加后在“设置 → 机器软件更新”刷新，确认升级器已连接、ID/owner 与当前机器一致。
以后在这里单机或批量预览、确认升级，不重新运行首次安装器、不重建机器身份。
批量先灰度一台，再最多三台并发；忙碌机器等待，不中断已有任务。升级后必须通过
Codey 和 Codex 真模型调用，否则回退本次代码，不回退用户数据库或凭据。
遇到 API key 或其他配置迁移提示先完成调用方迁移；不要跳过门禁或重新生成不兼容的 key。
只有节点启用后才有升级权限；待配置期间服务收到拒绝并重试属预期，不要放宽鉴权。
详见个性化包中的 `assets/codey-updater/UPGRADE.md`；升级器凭据丢失时由 owner 在
页面明确确认重新接入，不能让别的账号或全局 deploy 脚本接管。

按 [验收与回退](references/verification.md) 交付：准确区分本机测试、ACA 测试、
浏览器测试和模型登录；只输出非敏感摘要、文件路径和本次回退范围。
