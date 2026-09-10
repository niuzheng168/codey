---
name: config-new-codey-machine
description: "用本人 GitHub 私有 DevTunnel 原生接入 Windows、macOS 或 Linux，配置 Codex CLI 与模型默认值；支持明确路径的 defaults 和经确认的 Linux legacy 迁移，不接管未知服务或重装当前 ready 安装。"
---

# 新 Codey 节点：安装与验收

**完整包 → Codex CLI → 审核计划 → GitHub 授权与安装 → 本机验收 → 门户验收。**
使用同一 Codey 账号下载的对应平台完整包；源码 review 包不能代替个人安装包。
以下命令均在解压后的 Skill 根目录运行，`python` 指目标 owner 的原生 Python 3.12+。
以目标当前非 root 用户的现有 OS 权限为准；不做 Unix group/ACL 额外准入判定，
不通过 `chmod`/`chown` 改变现有路径权限。明确路径、非链接、并发快照及鉴权检查仍须保留。

## 1. 准备完整包与目标环境

- **准备检查**：核对机器、OS/架构和 owner；只读检查 Python、OpenSSL 3、构建工具、
  8 GiB 可用空间、已有服务及 3001/8443/4141。Linux 不以 root 运行；Windows 不提权。
  确认目标用户实际 Home 和有效 `CODEX_HOME`，不继承控制端路径或硬编码用户名。
  Windows/macOS 仍需可用的本机模型代理及其实际 config.json 绝对路径；缺少 CLI 由第 2 步解决。
- **目标**：使用本人未过期的新节点身份和匹配源码；已有服务默认不动，Codex 登录与会话保留。
- **执行脚本**：`python -I -B scripts/codey.py --help`；
  检查完整包包含 `assets/enrollment.json`、源码及 manifest，Linux 另有独立升级器。
  不打印密钥内容。`--help` 只验证入口，完整身份和摘要由第 3 步校验。
- **验收标准**：平台/owner 正确、材料完整；没有未经审查的服务或端口冲突。
  不清理原代理、全局工具、Home、`.codex`、session/auth 或工作目录。
  同用户已识别的旧 Codey user services 转第 3 步显式迁移计划；未知服务/端口仍须停止流程。

## 2. 安装或复用 Codex CLI

- **准备检查**：使用原 owner；不要求预装 Node 或 Codex Desktop。
  已有原生 CLI 可用 `--codex-bin <绝对路径>` 指定，不把任意 PATH shim 当作原生程序。
- **目标**：获得可运行、路径稳定的 Codex CLI，不执行模型登录、不改全局 PATH。
- **执行脚本**：

  ```text
  python -I -B scripts/codey.py codex
  python -I -B scripts/codey.py codex --apply
  ```

  先审阅第一条的计划，再执行第二条。已有 CLI 则复用；否则使用 `dependencies.json`
  固定的官方平台包，验证 SHA-512，安装到 `~/.local/share/codey-tools/codex/`。
  不修改系统 Python、全局 npm 或安全策略，也不使用 latest。
- **验收标准**：输出原生 executable 和成功的 `codex --version`；
  新安装的版本/摘要匹配，已有 config/auth 未变。**版本通过不等于模型已登录。**

## 3. 查看节点计划并确认范围

- **准备检查**：第 1、2 步通过；明确 DevTunnel 出站 HTTPS/WebSocket 符合网络策略。
  Linux 开机自启需要该 owner 的 linger，先说明影响，不自动提权。
- **目标**：在任何写入或服务变更前，确认身份、目录、模型默认值、监听和自启方式。
  计划中的 `danger-full-access` / `never` 只作用于目标 Codex 配置，不改变安装进程权限。
- **执行脚本**：只运行目标平台的一条，默认不安装：

  | 平台 | 计划命令 |
  | --- | --- |
  | Linux x64 | `bash scripts/setup-linux.sh --enable-linger` |
  | Windows x64 | `.\scripts\setup-windows.ps1 -CopilotApiConfig "<active config.json 绝对路径>"` |
  | macOS | `bash scripts/setup-macos.sh --copilot-api-config "<active config.json 绝对路径>"` |

  Linux/macOS 可设置 `CODEY_PYTHON`，Windows 可用 `-PythonExe` 指定解释器。
  需要显式 Codex Home 时用 `--codex-home` / Windows `-CodexHome`。
  **Agent 必须先跑普通 plan**。只有检测到同用户已识别的 Linux 旧 Codey user services，
  才改跑 `bash scripts/setup-linux.sh --replace-existing`（仍是 plan），
  审阅将 stop/disable 的旧 unit、runtime/config 的归档路径及新节点身份，再请用户批准中断。
  这是 [显式 legacy 迁移](references/verification.md#linux-legacy-显式迁移)，不是升级或强制清理；
  当前 ready 安装、未知服务及任意占端口进程均不适用。安装包未提供该参数时停止，不手工绕过。
  已有目标仅需配置默认值时，使用 [standalone defaults](references/verification.md#独立默认配置)，
  不重跑首次安装；`python -I -B scripts/codey.py defaults ...` 默认只 plan，批准后才加 `--apply`。
- **验收标准**：计划无写入，实际 Home/CODEX_HOME、gateway 路径与变更清单正确；
  未知 TOML、其他 provider/MCP/项目及凭据保留，替换文件有原子写与备份安排。
  只新增回环监听和本节点私有隧道，
  转发仅 HTTPS 3001/8443，不开放 4141，不改入站防火墙、路由或清单外服务。
  迁移归档不得包含整个 Home/`.codex` 或 session/auth；向用户确认后继续。

## 4. GitHub 授权并执行原生安装

- **准备检查**：第 3 步计划已批准。DevTunnel 必须是目标 owner 的 **GitHub** 登录；
  不自动注销/切换 Microsoft 账号，不回退 Entra，不接管旧节点登录缓存。
- **目标**：安装隔离的 Codey runtime、TLS/SSO、私有隧道及原生守护服务。
- **执行脚本**：

  | 平台 | 安装命令 |
  | --- | --- |
  | Linux x64 | `bash scripts/setup-linux.sh --enable-linger --apply` |
  | Windows x64 | `.\scripts\setup-windows.ps1 -CopilotApiConfig "<同计划的绝对路径>" -Apply -NetworkApproved` |
  | macOS | `bash scripts/setup-macos.sh --copilot-api-config "<同计划的绝对路径>" --apply` |

  已批准的 Linux legacy 迁移用 `bash scripts/setup-linux.sh --replace-existing --apply`
  **替代**普通 Linux 安装命令，并保留计划所需的其他参数（如 `--enable-linger`、`--codex-home`）。
  它会 stop/disable 并归档清单内的旧 unit/runtime/config，再以当前完整包的全新身份安装；
  不恢复旧 key/服务，不删除 Home/`.codex`/session/auth。旧服务停用后仍有未知端口占用就停止。
  Linux/Windows 可先准备经过校验的 DevTunnel CLI；未登录时停在授权要求，不启动节点服务。
  按脚本给出的 CLI 绝对路径，由本人执行
  `devtunnel user login --github --use-device-code-auth`（无 GUI Linux），或
  `devtunnel user login --github --use-browser-auth`（有浏览器）。
  用 `devtunnel user show --json` 确认 `status: "Logged in"`、`provider: "github"`，
  然后重跑同一安装命令。macOS 需先准备可用的官方 DevTunnel CLI。
  Linux 新安装在服务首次启动前自动写入有效 Codex Home 的 `models.json`、合并 `config.toml`，
  并设置新服务实际 `COPILOT_API_HOME/config.json` 的 `useResponsesApiWebSocket=false`，
  将该新 gateway 的活动 key 绑定到 `provider.env`。不读旧 gateway 来兼容旧 key。
  Windows/macOS 只改计划明确的已有 gateway 配置，不重启或接管它。
  **模型 Responses WebSocket 关闭，不影响 DevTunnel/Workspace WebSocket；不得一起禁用。**
- **验收标准**：GitHub provider 正确；源码/Node 校验、原生构建和 TLS 自检成功；
  默认配置在启动前落盘，后台模块完整且校验通过；没有匿名隧道、额外端口或凭据泄漏。
  迁移需确认旧进程已退出、归档清单完整、新身份已生效；失败保留归档/诊断和该新身份，
  不自动恢复旧服务/key，不清空 Home 或改权限重试。

## 5. 验收本机接口与守护

- **准备检查**：安装已成功完成，保存本次服务名称及生成的 `output/codey-machine.json`。
- **目标**：验证配置落盘、真实 TLS、数据认证、Workspace SSO 和匿名拒绝，而不只看 PID/health。
- **执行脚本**：已 ready 后重跑普通安装入口做验收；迁移完成必须去掉 `--replace-existing`，
  不再执行替换。保留同一包及其余已审核参数，不重启或升级。
  Linux 另用 `systemctl --user is-enabled` / `is-active` 检查本次 Codey 服务和续期 timer，
  用 `loginctl show-user "$(id -un)" -p Linger` 检查 `Linger=yes`。
  具体服务与其他平台检查见 [验收说明](references/verification.md)。
  守护故障注入不是普通检查：须另获目标、服务和时间窗口授权，空闲时逐项测试自动恢复。
- **验收标准**：重复 defaults 计划无差异，配置/key/catalog 哈希符合预期，机器文件不含密钥；
  本机认证/SSO/匿名拒绝通过。Linux 服务 enabled/active、
  linger 已开；systemd 自动重启，timer 定期续期，升级器独立运行。
  迁移后按运行路径、版本及 PID 区分新旧实例，不能因新服务复用旧 unit 名就误判旧服务已恢复。
  Windows/macOS 是原 owner **登录后**自启，不冒称无人登录开机启动或多机高可用。

## 6. 门户、模型与恢复验收

- **准备检查**：使用同一门户账号，只上传无密钥的机器文件，不上传 ZIP、enrollment 或私钥。
- **目标**：证明从 Codey 到该节点的连接和实际使用可用。
- **执行脚本**：本步不再运行安装脚本。在门户导入机器文件并执行验通/添加；
  缺少模型身份时由本人完成模型登录，再分别做真实 Codey/Codex 请求。
  legacy 迁移只导入新身份生成的机器文件；旧门户节点移除另行确认，不复用旧导入文件。
  Linux 新代理只接受新 key；同步新服务和 owner 的客户端登录环境。
  使用旧 key 的 Codex 后台须经同意后停止，让重新启动的客户端读取新 key，
  不通过增加旧 key、恢复旧服务或关闭认证来完成验收；会话文件保留。
  注销/重启恢复测试须另行批准；恢复后再次执行第 5 步和真实双模型检查。
  Linux 的 [签名自动升级验收](references/verification.md#签名自动升级验收) 需另经 owner 审核发布计划、
  确认任务；不以首次安装器重装节点。记录组件变化、job、receipt 与双模型结果。
- **验收标准**：门户实际通过隧道、TLS、数据认证、SSO、WebSocket；Linux 升级器在线。
  真实 Codey/Codex 返回指定标记；升级的真实切包、验证型 no-op、降级拒绝分别报告，
  不用 `succeeded`、相同版本号或单一入口 hash 代替完整证据。
  分别报告模型回答、SSH 退出后存活和重启恢复结果，未测项明确列出。
  **Copilot 配额不是聊天健康检查**；配额警告不能代替认证或真实模型回答。

## 脚本分工（按需审阅）

`scripts/` 只留原生入口和 `codey.py`；实现位于 `scripts/codey_node/`：
`common/`（CLI、文件、验收）、`devtunnel/`（GitHub、绑定、续期）、
`service/`（模块打包/加载校验）、`platforms/<目标>/`（原生安装/守护）。
个人下载包只带目标平台。旧入口和既有节点修复工具已归档，不在首次安装包中。
