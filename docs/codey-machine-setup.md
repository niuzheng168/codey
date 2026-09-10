# Codey 原生节点接入：GitHub 私有 DevTunnel

当前入口为 `skills/config-new-codey-machine/SKILL.md`，流程只有：
**本人完整包 → Codex CLI 准备 → 计划/确认 → GitHub 授权和原生安装 → 本机/门户验收**。
Windows、macOS、Linux 均使用私有 DevTunnel，不要求节点拥有 Azure VM、订阅或网络管理权限。

## 边界

- 每个包仅用于一个 owner/node，身份预留七天，失败重下同一身份不轮换 key。
- Windows/macOS 保留本机 Codex 和模型代理；Linux 首次独立安装，拒绝接管已有服务。
- 程序、构建依赖、TLS 和配置隔离；新服务仅 loopback，不开放入站端口。
- 主入口只转发到对应 OS 安装器。`scripts/codey_node/common/` 提供原生 Codex CLI、
  文件和 HTTPS 自检；`devtunnel/` 提供 GitHub、绑定和 connect-only 续期；
  `platforms/` 保留原生差异，不把 Linux 构建或 Windows 包校验放在公共隧道模块。
- Codex CLI 是独立步骤：复用已核对的原生可执行文件，或从官方平台包安装固定版本并校验 SHA-512。
  无需预装 Node/Desktop，不改全局 PATH、不登录模型、不覆盖已有 Codex 配置。
- `service/` 只复制目标 supervisor 的完整依赖，并在导入任何包模块前校验每个 Python 文件。
- Windows 使用登录任务，macOS 使用 launchd，Linux 使用 systemd 用户服务。
- 用户登录缓存不自动清理/切换。隧道认证、Codey 登录、模型认证是三个不同层次。
- DevTunnel 出站仍受公司网络/代理政策约束；其预览服务不是无条件可达性或 SLA 保证。

## 发布与兼容

Portal 动态生成 enrollment 和 node-scoped 更新凭据，公开源码目录不含这些私密 assets。
发布必须使用已经验证的源码和固定依赖；更新源码不等于已经发布/实机验收。
Linux 的两份源码归档和 release ID 格式保持兼容，Windows/macOS 另带只读 relay 源码。
各平台 bundle 和 immutable active pointer 仍各自独立，不从其他 OS 回退下载。

新增包统一声明 `network.mode=devtunnel`、`tunnelAuthProvider=github`。只有 owner 的
机器请求可以更新本节点 connect-only 凭据；门户不向浏览器或节点分发 master。
机器导入文件不含令牌/私钥/VM 地址，必须实际通过 TLS、数据/SSO、匿名拒绝和 WebSocket。
Linux 签名升级器保持独立；其他平台不宣称支持 Linux 的升级流程。

已有私网节点及已配置的旧登录不自动迁移、重启或轮换身份。
旧网络安装流程完整归档在 `archive/config-new-codey-machine-vnet-20260909/`，
附原始 commit 和逐文件 SHA-256；不在主 Skill、Docker COPY 或新下载包中。
历史源码仅供未来审查恢复，不能用作现有节点的升级命令。
旧入口及 Windows Resume/既有节点修复工具另存于
`archive/config-new-codey-machine-legacy-tools-20260909/`；同样不出现在首次安装下载包中。

## 验证

- Python：共享认证、Linux 计划/安装事务、Windows/macOS 回归、归档回归。
- Portal：各平台包内容、无网络资源前提、节点归属、私有隧道激活及 token 续期。
- 实机：先只读检查。A100 等工作节点用于安全拒绝和独立回归，不覆盖原代理/服务。
  完整首次安装必须在没有端口/服务冲突的目标完成，不能把单元测试记成端到端验收。
