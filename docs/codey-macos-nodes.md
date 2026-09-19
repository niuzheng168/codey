# macOS Codey 节点

完整命令、依赖与安装步骤见 [安装 Skill](../skills/config-new-codey-machine/SKILL.md)。
macOS arm64/x64 与 Linux、Windows 共用一个 npm 包和 Node 安装流程；不依赖 Python，
不安装 Portal 更新代理或常驻本地更新器。当前改动尚未发布，原生 Mac 验收需单独完成。

## 入口与系统适配

```sh
bash scripts/install-macos.sh --check
bash scripts/install-macos.sh --apply --network-approved --expected-computer "$(hostname)"
```

已有个人 Codex 设置时，建议为节点单独指定配置目录，不必批准覆盖个人配置：

```sh
CODEY_NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm \
bash scripts/install-macos.sh --apply --network-approved \
  --expected-computer "$(hostname)" \
  --codex-home "$HOME/.local/share/codey-machine-macos/codex-home"
```

这不迁移个人 auth/sessions，也不改变原有 Codex 程序；模型验收使用节点专属配置。
安装本身包含预检，单独 `--check` 只在需要先审阅计划时运行。

**个人 Codex 的模型路由也是需要保留的配置。** 若清理时删除了个人配置中的 Codey
模型项，而重装又使用独立 `--codex-home`，普通 Codex 会回退到默认 OpenAI 提供商。
只保留 MCP、插件、hooks 和项目表，不等于保留个人 Codex 的可用状态。
需要继续使用 Codey 的个人 Codex 应恢复原模型选择和 `copilot_api` 路由，同时合并保留这些个人表；
不要用节点模板整份覆盖个人配置。

桌面应用也使用 Skill 的标准 `env_key = "CODEY_MODEL_API_KEY"`，不另加
command-auth 或把密钥写进 TOML。应同时核对个人配置的模型项、标准模型目录，
以及 shell 配置是否从 `0600` 的 `provider.env` 导出当前节点 key。
不能仅凭桌面主进程没有环境变量，就判断其 Codex 子进程也没有。
本机桌面内置 0.155.0-alpha.9.2 在正常重新打开后，Codex 子进程已取得当前 key，
标准模板下的真实模型请求通过；这不等于所有桌面版本都已验证。
修改后完全退出并重新打开桌面应用，使用新会话确认路由；原有会话可能仍保存旧提供商。

检查不下载、不写文件、不登录、不启动服务或调用模型。若无 Node，列出待检查项目；
确认安装后才从官方来源下载并校验 Node。已有节点会复用其私有 Node，即使 PATH 没有 Node。
直接执行获准的 `--apply` 已包含预检，无需重复运行 `--check`、doctor 或手工镜像探测。
受限网络可在命令前设置 `CODEY_NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm`，
只对本次安装使用 HTTPS 镜像和 npm 缓存，不修改全局 npm 配置或依赖完整性校验。

`install-machine.mjs` 负责依赖、身份、隧道、证书配置、模型验收与 JSON 导出。
`platform-macos.mjs` 只负责原生架构/GUI 会话、端口归属和 LaunchAgents；
`macos-service.mjs` 用 Node 守护 `codey`、`tunnel`、`renew` 三个组件。
服务依赖原用户登录，并非无人登录时的系统服务。
全新 Mac 节点先复用当前已登录的 GitHub CLI，不调用 DevTunnel 的 `user show/login`，
避免安装被旧 DevTunnel 钥匙串授权阻塞；只保存 gh 的账号 ID、用户名及稳定的工具/配置路径，
不复制其 token。已有节点保留既定账号，后台通过固定路径重新读取凭据；
gh 自身的安全存储仍必须可用。管理 API 签发 host-only/connect-only token，
host 仅通过 stdin 收到 host-only token，不能直接把 gh token 传给 DevTunnel CLI。
这条路径不增加 Codey 自有 GitHub token 文件，也不依赖先前保存在
`copilot-home/github_token` 或 DevTunnel 钥匙串中的独立登录。
清空重装实验须删除 Codey 专属的旧 token，保留用户明确要求复用的 gh 登录；
不能通过保留旧 Copilot 凭据而宣称已验证 gh 模式。
`macos-tools.mjs` 验证并私有复制已有官方 standalone Codex 0.152.0+，包含 code-mode host、
rg 和资源目录；校验 OpenAI 签名、架构、版本、所有文件摘要和内部链接。
没有可复用包才走官方下载安装。保留真实 CLI/SDK 验收，但并行使用低推理强度的短请求，
各限时 60 秒，不更改正常会话配置。

新节点私有描述符包含硬件 UUID，避免网络切换改变 hostname 后误判为另一台 Mac。
命令仍要求确认当前机名；旧描述符不自动迁移。启停适配器同时识别 launchctl 的
`true/false` 和 `disabled/enabled`，停止后再次 start/restart 会正确 enable。
普通 zsh 登录/交互终端及 bash 配置加载私有 `provider.env`，无需继承后台服务环境；
配置文件中的路径会正确引用空格/引号，密钥不会直接写入 shell 配置。

## 端口与注册文件

- HTTP `127.0.0.1:4141` 为带模型 API key 的本地网关，不经过隧道。
- HTTPS `3001` 提供 Workspace/SSO，HTTPS `8443` 提供鉴权只读数据；后者是同一网关的第二个监听。
- 私有 GitHub DevTunnel 仅转发 HTTPS `3001/8443`，不允许匿名访问。
- 本机生成自签名非 CA 证书；私钥不发送给 Portal，也不导入系统根证书库。

验收后只在用户 Home 写出 `0600` 的 `codey-machine-registration.json`，不自动注册 Portal。
用户自行导入，Portal 再验收真实隧道、TLS、SSO 与访问权限并绑定节点证书。
安装器不把本机验收冒充 Portal 已接入；connect token 的续期守护仍保留。

日常统一用 `codey start/restart/stop` 管理 LaunchAgents，`codey devtunnel start/stop`
单独管理隧道，`codey status` 查看状态，`codey doctor` 检查组件。
`codey export FILE.gz` 可按用户要求包含 TLS 私钥等秘密，不发送给 Portal；
恢复使用 `codey import FILE.gz --check` 后确认覆盖。系统 Keychain 登录缓存不迁移。
`codey update FILE.tgz` 只替换应用并保留工具、配置、身份及原启停状态，不部署后台更新器。

## 重跑与删除边界

同版本重跑核对包文件、身份、证书、服务归属和本机鉴权，刷新注册文件，不重新安装、
重启或调用模型，不换密钥。旧 Python/升级代理布局必须单独迁移；失败安装先审查私有状态。
失败重试加 `--retry-failed`，通过 `application.json` 复用已验证的 Node/应用，
通过私有工具记录复用 DevTunnel/Codex；原生模块不可用或文件改变仍拒绝继续。
可捕获的 npm 失败仅清理当次新建 app prefix，保留 Node；被强杀后的锁/不完整目录不自动删除。

安装阶段输出实际耗时。3 分钟仅作为依赖可用、网络正常时的快速路径目标，不能保证首次下载、
人工设备登录和 Portal 手动接入都在 3 分钟内完成；模拟安装耗时不能作为完整节点实测。

`~/.config/codey-machine-macos/resources.json` 记录程序、LaunchAgents、CLI/PATH 项与保留目录。
尚无统一 `codey uninstall`；删除前复核实际归属，默认保留配置、数据、Codex auth/sessions，
不整删 runtimeRoot，不自动删除 Portal 记录或云端隧道。

模拟测试不证明真实 GitHub 登录、模型访问、Intel 硬件运行或睡眠/重新登录后的恢复能力。

## 本机构建实验与正式发布

正式发行仍只允许 Linux x64，从已提交的 `origin/main` 及其固定子模块构建。
Mac 可使用 `--allow-reviewed-diff --node-dir <Node分发目录>` 做开发实验；使用发行声明的
Node 24.20.0/npm 11 工具链，不使用会省略 shrinkwrap 的 npm 12。
Mac 实验强制标记为 dirty，不得作为正式发布包。`CODEY_NPM_REGISTRY` 同样可供实验构建使用。
共享 `.tgz` 仍只有平台无关的应用代码及同一份锁，拒绝 node_modules、ELF、PE 和 Mach-O 文件。
原生依赖在目标系统安装；不能将 Mac 的 node_modules 复制进 Linux 发布包。

`CODEY_PACKAGE_TGZ=/path/to/codey.tgz node --test test/codey-package-shared-install.test.mjs`
在当前支持的平台用独立 HOME/临时端口安装并启动 Workspace/网关。
可加 `CODEY_INSTALL_BUDGET_SECONDS=180` 验证包安装、原生依赖和服务启动的预算；
它不创建正式节点，不执行人工登录、DevTunnel/Portal 接入，不改当前节点。
Linux/Windows 与 Intel Mac 的运行验收仍需在对应平台执行。

2026-09-19 的 macOS arm64 开发实验使用 Node 24.20.0/npm 11.19.0、腾讯 HTTPS npm 镜像，
以及包含 `cf3d4bb` 依赖精简的新包（7,330,084 字节）。在独立 HOME/临时端口下：

| 实验 | 实测耗时 | 覆盖范围 |
| --- | ---: | --- |
| 空 npm 缓存安装 | 110.3 秒 | 依赖安装、原生模块检查、Workspace/网关启动、数据鉴权 |
| 已有 npm 缓存安装 | 5.6 秒 | 同上，不复用应用目录 |
| 已有官方 Codex 0.152.0 复用 | 4.0 秒 | 原生签名/架构/版本校验、完整私有副本及摘要校验 |

以上不是完整新节点从零接入的计时：Node 已准备、应用包已在本地，
不包含人工登录、真实模型请求、LaunchAgent/DevTunnel 配置与 Portal 导入。
没有替换正在运行的节点，也没有发布此开发包；正式发布仍需 Linux 构建及对应平台验收。

### 合入 gh 认证后的独立完整安装

随后合入主仓库 `bf65713` 和网关子模块 `b4a3e91`，补上全新 Mac 的 gh 优先选择，
重新构建完整 Skill。经用户批准清空本地 Codey 专属资源后，由独立 subagent
直接运行完整 Skill，首次成功，**安装命令总耗时 140.592 秒**。
使用已有 gh 登录和共享 npm 缓存；Node、应用及 DevTunnel 都在新节点目录准备，
没有测试 adapter、凭据注入、依赖 donor、跳过模型检查或失败重试。
个人 Codex 使用独立的节点配置目录，原配置、程序和 gh 登录文件的摘要保持不变。

| 验收 | 结果 |
| --- | --- |
| Copilot / DevTunnel 认证 | 均复用 `gh`，固定账号 `zhn_microsoft` / `119696252`；无新增授权或钥匙串交互 |
| 模型验收 | 真实 CLI/SDK 短请求均通过，合计阶段 5.728 秒 |
| 初次在线 doctor、`/usage`、TLS/SSO | 通过；匿名访问拒绝保留 |
| 连续两次 guard | 主要服务 PID 不变；renew 等待定时执行 |
| 重启后认证 | 后台可重新读取固定 gh 账号；后续只读 doctor 全部通过 |
| 凭据边界 | 不保存 gh token；`github_token` 仅为空占位文件；生成配置/参数的秘密扫描通过 |
| 接入状态 | 本机完成；未自动导入 Portal，未验证 Portal 的 token 上传续期 |

这次完整实验包仍为 `0.1.18` 开发包，不等同于已发布的同号包。应用包大小
7,342,275 字节，SHA-256 为
`dbade1e03d8971942c61767f7222af2f82371f16be7c52ce9c2185868e8afef5`；
新节点为 `n-f3f963577aa08be6efbd32f3`，注册文件位于
`/Users/zhn/codey-machine-registration.json`，权限 `0600`。

**重启验收中的异步窗口：** `codey restart` 原有契约只等待原生服务和本地接口，
不等待云端隧道已连接。第一次 restart 用时 9.065 秒，返回后 0.215 秒即启动的 doctor
只在 host connection 项失败；之后观察到已连接，且未修复、未重装的只读 doctor 通过。
不能把 `status.running` 或 restart 退出码当作即时云端连通证明；自动验收应在有限时限内
等待实际 host connection，再运行 doctor。未导入前的续期日志有通用失败消息，
仅凭日志不能断言具体原因或宣称 Portal 续期成功。

独立 subagent 随后在不修复、不重装的同一节点做了第二次有时限重启观测：
restart 返回耗时 9.245 秒，返回后 1.095 秒观测 host count 为 0，
返回后 2.693 秒观测为 1（从命令调用起共 11.938 秒）。
此时 doctor/status、隧道身份及私有 HTTPS 端口/ACL 均通过，受保护文件摘要和凭据扫描也通过。
最终节点保持启用、运行；未做额外模型请求、Portal 导入、整机重启或其他平台实机验收。
