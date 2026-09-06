# 节点接入 Skill 下载

> 日期：2026-09-05。提供通用说明包与受认证下载，不自动执行节点安装或 Azure 网络操作。

## 用户入口

- Usage 的“节点分布 → 添加机器”旁提供紧凑的“下载接入 Skill”链接。
- 空节点账号也能下载；不需要先有一台已工作的节点。
- “添加机器”定位到 `/settings#add-node`，新节点表单内也有 ZIP、SHA-256 和安装说明。
- 等已有节点异步渲染完成后再定位新增表单，避免已有节点把它推到屏幕下方。
- 下载必须通过现有 Codey 登录。它不属于匿名静态文件或 MCP 认证豁免。

下载路径：

```text
/downloads/codey-node-onboarding.zip
/downloads/codey-node-onboarding.sha256
```

ZIP 只有一个顶层 `codey-node-onboarding/` 目录。用户把它放到个人
`.agents/skills/`，例如 Windows 的 `%USERPROFILE%\.agents\skills\`，
Linux/macOS 的 `~/.agents/skills/`；然后在 Codex 使用 `$codey-node-onboarding`。
保留已有同名 Skill，不在不检查差异的情况下覆盖。若当前客户端没有自动发现，
可重新打开 Codex；这不是重启 copilot-api。安装位置依据当前官方技能说明：
`https://developers.openai.com/codex/skills/`。

## 包内容与边界

源码在 `Q:\codex_manager\skills\codey-node-onboarding`：

```text
SKILL.md
agents/openai.yaml
references/enrollment-and-https.md
references/workspace.md
references/vnet.md
references/verification.md
scripts/gateway-entry.mjs
```

Skill 区分 owner 注册与运维部署，明确新的随机 node ID、每节点两类独立 key、
当前账号绑定、同源网关、证书校验和整节点隔离。Azure 路径分为同 VNet、
不重叠 peering、重叠 CIDR 的 PE → PLS → ILB。没有机器清单、真实门户账号/密钥、
数据库、会话、环境导出、CA 私钥或应用安装包。

附带的 Node.js 工具只离线生成待合并的网关 JSON 条目，拒绝 legacy ID、
公网/loopback/metadata IP、非 DNS TLS 名称和非法端口；不执行 Azure 命令、不写配置。
它不能判断资源归属/网络可达性，运维仍须审核。

Skill 特别说明了现有 Linux CloudCLI 安装器的边界：`--stage-only` 可构建，
旧非 stage 路径的 HTTP health probe 不适用于 HTTPS SSO；旧迁移激活脚本不能
直接用于首次安装。因此提供首次安装的受限独立 unit/环境参数与回退步骤。
此次不修改这些安装器，不执行它们。

## 构建与认证

`scripts/build-node-skill.mjs` 只读取固定的 7 个已审查文件，拒绝越界路径、
文件符号链接和异常文件大小，生成固定 ZIP 元数据及 SHA-256。
不会递归把 `.env`、备份或后续临时文件混入包。

```text
npm run skill:build
npm run skill:check
```

`Dockerfile` 用隔离 build stage 从 Skill 源码重新打包，不信任本机留下的
`public/downloads` 二进制。运行镜像只复制构建结果；不会把源码树中的其他目录
作为下载目录暴露。门户固定映射这两个下载 URL，不提供任意文件读取。

认证在 `createMultiUserPortalServer` 现有入口执行；下载只允许 GET/HEAD，
响应 `Content-Disposition: attachment`、`private, no-store`、`Vary: Cookie`
和 `nosniff`。HEAD 的长度与真实包一致。失效/伪造 Cookie 拒绝；页面导航可跳转
登录页，但不能取到 ZIP。下载包是所有已登录用户共用的通用说明，不按用户嵌入
接入资料；真实 enrollment 仍只能通过本人节点的独立接口获取。

## 验证记录

目录：`Q:\codex_manager\artifacts\codey-node-skill-20260905`。

- Skill Creator validator 通过。
- Python `zipfile.testzip()` 独立校验 ZIP CRC/条目通过。
- 门户语法检查与最终 **88 tests** 通过，包括普通账号/管理员下载、未登录/伪造身份、
  方法限制、路径穿越、HEAD、注销后拒绝、包内容与来源一致、离线工具及现有网关
  config loaders 的兼容性。
- 回归中确认 Windows 的 `accounts.json` 原子 rename 偶发 `EPERM`，会使既有
  账号写入测试返回 503。`SignedStore` 现在仅对 Windows 的 EPERM/EBUSY
  重试同一次 atomic rename，总退避等待上限 465 ms；持有原 writer lock，
  不删除旧目标、不窃取锁、不绕过权限。Linux/macOS 和其他错误立即失败不变。
  另有 **13 项**账号隔离与文件替换回归通过；诊断模块只在 artifacts，不进镜像。
- 未启动本地门户或 relay，未更改节点服务、VM 网络、门户认证规则或 MCP 镜像。
- 云端发布及浏览器实测结果记录于 `final-verification.json`。

## 已发布

- Revision：`codey--node-skill-0905225718`；portal image：
  `codey:20260905-node-skill-final-225718`，ACR run `ce1d`。
- ZIP 为 **20,803 bytes**，7 个文件；SHA-256：
  `529d6a6cc9924a40e27e0ddcb8ad39c6b6ac51eed331b1609bd8f500da5017fc`。
- 浏览器实际点击“添加机器”后进入 `/settings#add-node`，等待原有 5 个节点渲染
  完成后新增表单在视口内。首页下载链接与添加按钮同排，两处没有水平溢出。
- 使用正常密码登录建立独立短期验收会话，经生产 HTTPS 下载的字节与源码构建
  一致；ZIP、SHA-256、HEAD、匿名/伪造 Cookie、注销后拒绝、方法限制及路径穿越
  均验证。验收只注销自己的临时会话，不影响用户浏览器登录。
- portal/mcp 两个容器 Ready、restartCount 0、100% latest traffic。
  比较部署前后配置，只有 portal image 和 revision suffix 改动；MCP 镜像、
  secrets/资源/挂载/网络配置保持原样。本机 `4141`/`8443` 原 listener 不变。
- 本机 Skill 副本已安装到 `C:\Users\zhn\.codex\skills\codey-node-onboarding`，
  与发布包的 7 个源文件一致；未重启 Codex 或 copilot-api。
