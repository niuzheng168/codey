# Codey 原生节点接入：GitHub 私有 DevTunnel

当前入口为 `skills/config-new-codey-machine/SKILL.md`，流程只有：
**DevTunnel → copilot-api → Codex → CloudCLI**。
Linux 直接运行 `bash scripts/setup-linux.sh --apply`；已有安装会自动停止、归档和覆盖，
不再先运行普通 plan，也不再要求切换 `--replace-existing`。
Windows、macOS、Linux 均使用私有 DevTunnel，不要求节点拥有 Azure VM、订阅或网络管理权限。

## 边界

- 每个包仅用于一个 owner/node，身份预留七天，失败重下同一身份不轮换 key。
- Linux 停止 owner 的旧 Codex app-server，并用 OpenAI 官方 installer 在原用户 bin
  更新或安装 `latest`；Windows/macOS 仍保留各自原生处理。
- Linux 自动接管当前用户的既有 Codey systemd 服务，包括 ready、旧版和失败安装。
- 程序、构建依赖、TLS 和配置隔离；新服务仅 loopback，不开放入站端口。
- 主入口只转发到对应 OS 安装器。`scripts/codey_node/common/` 提供原生 Codex CLI、
  文件和 HTTPS 自检；`devtunnel/` 提供 GitHub、绑定和 connect-only 续期；
  `platforms/` 保留原生差异，不把 Linux 构建或 Windows 包校验放在公共隧道模块。
- Linux Codex 更新属于同一安装事务；保留 `.codex`、auth 和 sessions，并合并模型配置。
- `service/` 只复制目标 supervisor 的完整依赖，并在导入任何包模块前校验每个 Python 文件。
- Windows 使用登录任务，macOS 使用 launchd，Linux 使用 systemd 用户服务。
- 用户登录缓存不自动清理/切换。隧道认证、Codey 登录、模型认证是三个不同层次。
- DevTunnel 出站仍受公司网络/代理政策约束；其预览服务不是无条件可达性或 SLA 保证。

## Linux 直接覆盖

```bash
bash scripts/setup-linux.sh --apply
```

同一命令适用于干净机器、旧服务、ready 节点和失败安装。它自动：

1. 配置当前节点的 GitHub 私有 DevTunnel。
2. stop/disable 当前用户的 Codey units，并归档旧 runtime/config/unit。
3. 覆盖安装 copilot-api，写配置、完成 GitHub Copilot 登录、创建 systemd 并测试。
4. 停止旧 Codex app-server，以官方 installer 更新或安装最新版 Codex，写配置并真实调用模型。
5. 覆盖安装 CloudCLI，创建 systemd、DevTunnel 守护、续期 timer 和独立 updater。

`--replace-existing` 与 `--enable-linger` 只作为旧调用的兼容参数；普通安装已自动覆盖并启用 linger。
Home、`.codex`、auth 和 sessions 保留。停止已识别服务后若目标端口仍被未知程序占用，
安装停止而不杀无关进程。

## Linux ready 节点的 Codex/Codey 401 修复

同一 ready 节点若仍固定托管 CLI、登录 shell 使用旧 key，或 Codex/Codey 返回 401：

```bash
bash scripts/setup-linux.sh --repair-client
bash scripts/setup-linux.sh --repair-client --apply
```

第一条只计划；第二条会复用 owner CLI、让 shell/CloudCLI 使用当前 `provider.env`，
停止旧 key 的 owner app-server、重启 CloudCLI，并归档不再使用的托管 CLI。
不删除 `.codex`、session/auth，也不把旧 key 加回 gateway。完成后必须分别验证真实 Codex 与 Codey 回复。

## 发布与兼容

Portal 动态生成 enrollment 和 node-scoped 更新凭据，公开源码目录不含这些私密 assets。
发布必须使用已经验证的源码和固定依赖；更新源码不等于已经发布/实机验收。
Linux 的两份源码归档和 release ID 格式保持兼容，Windows/macOS 另带只读 relay 源码。
各平台 bundle 和 immutable active pointer 仍各自独立，不从其他 OS 回退下载。

新增包统一声明 `network.mode=devtunnel`、`tunnelAuthProvider=github`。只有 owner 的
机器请求可以更新本节点 connect-only 凭据；门户不向浏览器或节点分发 master。
机器导入文件不含令牌/私钥/VM 地址，必须实际通过 TLS、数据/SSO、匿名拒绝和 WebSocket。
Linux 签名升级器保持独立；其他平台不宣称支持 Linux 的升级流程。

Linux 使用当前安装包身份覆盖旧节点；旧门户节点记录不会自动删除。
旧网络安装流程完整归档在 `archive/config-new-codey-machine-vnet-20260909/`，
附原始 commit 和逐文件 SHA-256；不在主 Skill、Docker COPY 或新下载包中。
历史源码仅供未来审查恢复，不能用作现有节点的升级命令。
旧入口及 Windows Resume/既有节点修复工具另存于
`archive/config-new-codey-machine-legacy-tools-20260909/`；同样不出现在首次安装下载包中。

## 验证

- Python：共享认证、Linux 计划/安装事务、Windows/macOS 回归、归档回归。
- Portal：各平台包内容、无网络资源前提、节点归属、私有隧道激活及 token 续期。
- 实机：验证已有 ready/旧版安装被自动归档覆盖，旧 key 拒绝且用户数据保留。
  非迁移清单的冲突必须停止，不能把单元测试记成端到端验收。
