# Codey 原生节点接入：GitHub 私有 DevTunnel

当前入口为 `skills/config-new-codey-machine/SKILL.md`，流程只有：
**本人完整包 → Codex CLI 准备 → 计划/确认 → GitHub 授权和原生安装 → 本机/门户验收**。
主 Skill 保持 1–6 步，每步列出准备检查、目标、执行脚本和验收标准；
Linux legacy 替换是其中显式批准的迁移分支，不是默认行为。
Windows、macOS、Linux 均使用私有 DevTunnel，不要求节点拥有 Azure VM、订阅或网络管理权限。

## 边界

- 每个包仅用于一个 owner/node，身份预留七天，失败重下同一身份不轮换 key。
- Windows/macOS 保留本机 Codex 和模型代理；Linux 默认拒绝接管已有服务，
  仅同用户已识别的旧 Codey user services 可经下述显式迁移处理。
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

## Linux legacy takeover：先计划，再显式迁移

- **准备检查**：Agent 先运行普通 `bash scripts/setup-linux.sh` plan。
  检测到同用户已识别的旧 Codey user services 后，核对 unit、PID、runtime/config 路径及中断影响；
  当前 ready 安装、未知服务或任意占端口进程不适用。安装包必须支持该迁移选项。
- **目标**：将已批准的旧安装停用并归档，随后用当前个人包的全新 node ID/凭据安装；
  不把迁移当作 ready 安装的升级、失败重试或降级绕过。
- **执行脚本**：在解压后的 Skill 根目录先运行第一条，批准精确清单后才运行第二条；
  继续使用已审核的 `--enable-linger`、`--codex-home` 等所需参数。

  ```bash
  bash scripts/setup-linux.sh --replace-existing
  bash scripts/setup-linux.sh --replace-existing --apply
  ```

  plan 不 stop/disable 或归档；apply 才停用清单内旧 unit，并归档计划列出的
  `codey-machine`、旧 CloudCLI、copilot-api、updater 和 relay 标准 runtime/config。
  归档位置以计划/执行报告为准，不公开其中凭据。不恢复旧 key/服务，
  不删除或搬走 Home/整个 `.codex`，session/auth 保留。未知服务/端口仍终止安装，不扩大清理。
- **验收标准**：旧实例退出且归档完整；新身份、新 key、新服务路径及真实 Codey/Codex/SSO 验收通过，
  旧 key 被拒绝。若复用 unit 名，按内容、运行路径和 PID 区分新旧实例。
  失败保留归档，不自动恢复旧服务；完成 ready 后去掉 `--replace-existing`，只走普通验收或签名升级。

## 发布与兼容

Portal 动态生成 enrollment 和 node-scoped 更新凭据，公开源码目录不含这些私密 assets。
发布必须使用已经验证的源码和固定依赖；更新源码不等于已经发布/实机验收。
Linux 的两份源码归档和 release ID 格式保持兼容，Windows/macOS 另带只读 relay 源码。
各平台 bundle 和 immutable active pointer 仍各自独立，不从其他 OS 回退下载。

新增包统一声明 `network.mode=devtunnel`、`tunnelAuthProvider=github`。只有 owner 的
机器请求可以更新本节点 connect-only 凭据；门户不向浏览器或节点分发 master。
机器导入文件不含令牌/私钥/VM 地址，必须实际通过 TLS、数据/SSO、匿名拒绝和 WebSocket。
Linux 签名升级器保持独立；其他平台不宣称支持 Linux 的升级流程。

已有私网节点及已配置的旧登录不自动迁移、重启或轮换身份；
只有上述已批准、已识别的 Linux legacy 清单才进入全新身份迁移，旧门户节点移除另行确认。
旧网络安装流程完整归档在 `archive/config-new-codey-machine-vnet-20260909/`，
附原始 commit 和逐文件 SHA-256；不在主 Skill、Docker COPY 或新下载包中。
历史源码仅供未来审查恢复，不能用作现有节点的升级命令。
旧入口及 Windows Resume/既有节点修复工具另存于
`archive/config-new-codey-machine-legacy-tools-20260909/`；同样不出现在首次安装下载包中。

## 验证

- Python：共享认证、Linux 计划/安装事务、Windows/macOS 回归、归档回归。
- Portal：各平台包内容、无网络资源前提、节点归属、私有隧道激活及 token 续期。
- 实机：先只读检查，验证未知服务/端口和 ready 安装被安全拒绝；
  legacy 迁移单独授权并验证归档、旧 key 拒绝及用户数据保留。
  非迁移清单的冲突必须停止，不能把单元测试记成端到端验收。
