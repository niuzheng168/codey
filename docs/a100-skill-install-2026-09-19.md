# A100：清理旧 Codey 后，从完整 Skill 安装的实测

日期：2026-09-19，全部时间为 UTC。目标：`zhn-a100`，用户 `zhn`。

## 结论与边界

**首次完整安装成功，47.183 秒，满足本次“安装不超过 3 分钟”的目标。**
Copilot API、DevTunnel 均自动使用已有的 `gh` 账号，没有新的设备码或浏览器登录。
没有跳过依赖安装、TLS/SSO/鉴权检查、真实 Codex CLI/SDK 模型请求或注册文件导出。

这是工作区构建的、包含 gh 认证复用的 **Codey 0.1.18 开发包**，
不能与已发布的同号包等同。**本次提交仅包含调研/实测文档，
不包含认证实现代码，也不发布安装包。** Windows/macOS 尚未进行原生机器验收。

另有一个必须单独说明的操作问题：**准备阶段的 Python 诊断误触发了
`/data/g` 镜像复制，部分既有文件被改写；已停止，但没有修改前快照可供恢复。**
详见下方“诊断副作用”。不能把服务 PID 未变说成所有其他文件都完全未受影响。

## 测试前提

- A100 已安装并登录 GitHub CLI；保留 `~/.config/gh`，不重新授权、不增加 scopes。
- 保留共享 npm 缓存、系统工具、独立 Codex 安装和会话、Niuma、SSH、
  GitHub Copilot CLI 及其他项目。
- 清除经核实仅由旧 Codey 使用的应用、依赖、配置、数据库、日志、缓存、
  备份、历史实验目录、systemd 单元和 shell 中的 Codey 管理块。
- 同时删除旧 Codey 使用的 Copilot token 与 DevTunnel 独立登录缓存；
  不是通过保留这两份登录来实现“没有登录提示”。
- 为新 Codey 使用独立目录：
  `/home/zhn/.local/share/codey-machine/codex-home`。
  共享 `~/.codex/config.toml`、`models.json`、Codex 可执行文件和会话不覆盖。
- 新建节点身份、证书、模型 key 和私有隧道；不恢复旧身份来冒充全新安装。
- 不删除云端其他隧道，不自动导入 Portal，不修改其他服务配置。

因此，这是**清空 Codey 本机独占资源后的安装**，不是无 Node/gh、无 npm 缓存的
裸机基准。共享会话、shell 历史和混合 systemd journal 中的历史 Codey 引用不删除。

## 清理范围与耗时

归属核验共确认 **90 个路径、1,540,578 个文件/目录/链接、40,852,805,158
逻辑字节（约 40.85 GB）**。其中 5 个服务启用链接由 systemctl 删除，
85 个路径由经过核验的清理脚本删除。

处理的单元：

- `codey-cloudcli.service`
- `codey-copilot-api.service`
- `codey-devtunnel.service`
- `codey-devtunnel-renew.service` / `.timer`
- `codey-devtunnel-health.service` / `.timer`

先停止定时器，再停止服务；只终止确认使用旧 Codey 模型 key 的孤儿 Codex
app-server。用户另行允许停止 A100 的 Codex 进程，但没有因此停止 Niuma 的 Codex。
清理不跟随目录链接，不删除共享 Codex、gh 或其他项目。

| 操作 | 实测 |
| --- | ---: |
| 清理命令，含最终归属复核和 SSH 往返 | **102.988 秒** |
| 其中实际停服、删除及前后比对 | 68.246 秒 |
| 清理命令开始 | 09:01:07 |
| 清理完成 | 09:02:50 |

完成后确认旧清单路径消失，`3001/4141/8443` 全部空闲。
`gh` 配置及共享 Codex 配置的摘要不变，其他已记录的用户/系统服务状态、
MainPID 和启动时间不变。
审计脚本的早期只读检查曾遇到系统 PAM/sshd 子进程不可读取 `exe` 的
`PermissionError`；核对名称、cgroup 和 root 父进程后将它们保留，没有提权
接管或停止这些系统进程。全部删除只在最终归属检查通过后执行。

## 完整 Skill 入口与计时

使用正常构建器生成完整 ZIP，而不是之前的隔离探测包：

```bash
python3 scripts/build-machine-bundle.py \
  --output artifacts/a100-skill-reinstall-20260919T084357Z/bundle-v3 \
  --portal-origin https://codey.ambitiouspond-a4ecfeb2.japaneast.azurecontainerapps.io \
  --allow-reviewed-diff \
  --node-dir /home/zhn/.local/share/codey-tools/node-v24.20.0 \
  --keep-work
```

`--allow-reviewed-diff` 仅用于这次开发测试，不绕过正式发布的 main/provenance 要求。
ZIP 大小为 7,651,846 字节，SHA-256：

```text
6e1fa789980745b9fb21d5c3b9892821c4f33ececfa1e75121a2c96f46813eba
```

在 A100 解压后的完整 Skill 目录执行：

```bash
export CODEX_HOME="$HOME/.local/share/codey-machine/codex-home"

bash scripts/install-npm.sh \
  --package assets/codey-0.1.18.tgz --check

bash scripts/install-npm.sh \
  --package assets/codey-0.1.18.tgz \
  --expected-computer zhn-a100
```

没有 `--retry-failed`、依赖复用 donor、测试 adapter、登录注入或跳过验收选项。
计时器的标准输入关闭，出现新的设备码登录即判定失败。Python 仅用于本次
审计和外部计时；正常安装链路不依赖 Python。

### 安装命令内的阶段耗时

开始：**09:05:24**；结束：**09:06:12**。精确耗时使用单调时钟，退出码 0。

| 阶段 | 耗时 |
| --- | ---: |
| 入口与只读预检 | 0.626 秒 |
| 官方 Node、Codey npm 包/依赖、DevTunnel CLI | 15.060 秒 |
| gh 复用、创建私有隧道、生成 TLS | 12.215 秒 |
| Copilot 认证复用、官方 Codex 安装与配置 | 6.279 秒 |
| 服务启动、真实 CLI/SDK 请求、TLS/SSO/鉴权及 JSON 导出 | 13.003 秒 |
| **总计** | **47.183 秒** |

独立操作耗时：

| 操作 | 耗时 |
| --- | ---: |
| 最终开发 Skill 构建 | 37.640 秒 |
| Skill 传输、摘要核对和解压 | 5.177 秒 |
| 清理后的独立 `--check`，含 SSH 往返 | 2.228 秒 |
| 安装后的额外 CLI/guard/重启/安全复核 | 24.751 秒 |

**不要把本次包含代码修改、三次开发构建、归属盘点、清理和问题排查的整段工作，
称作 47 秒或三分钟。** 47.183 秒严格指完整安装命令本身。
共享 npm 缓存未清空；网络更慢、缓存全冷或需要人工完成首次 gh 登录时，不保证此速度。

## 验收结果

- 新节点：`n-957dc71214acd2678d843145`，与被删除的旧节点不同。
- 两路认证均为 `source: gh`，账号均为 `zhn_microsoft`，ID 均为 `119696252`。
- 独立 `devtunnel user show --json` 仍为 **`Not logged in`**，
  但私有隧道 host 已连接，证明没有偷用旧 DevTunnel 登录。
- Copilot `github_token` 不存在或为空；仅写账号绑定 `github-cli.json`，权限 `0600`。
- 在 A100 本机比对实际 gh 凭据：生成的配置、服务单元、注册文件、
  进程 argv、Copilot 数据文件及新服务日志均未包含该 GitHub token；
  凭据未传回控制机或打印。
- `gpt-6-astra` 的真实 Codex CLI 请求返回准确的 `CODEY_CODEX_OK`；
  SDK 请求返回准确的 `CODEY_CLOUDCLI_OK`，不是提示词回显。
- `codey status --json` 正常；`codey doctor --json` **18 项全部通过**。
- `codey copilot login`、`codey devtunnel login` 均复用 gh，不触发授权。
- `codey guard --json` 幂等，已有主要服务不重启。
- 实际执行 `codey restart --json` 后，后台自动重新读取 gh 认证，
  gateway、Workspace、私有 tunnel 和 doctor 再次通过。
- 两项 HTTPS 接口的 TLS、Workspace SSO、数据鉴权与匿名拒绝通过；
  仅转发私有 HTTPS `3001/8443`，不转发 `4141`。
- gh 配置、共享 Codex 配置/程序保持不变。
  Niuma workbench PID `2503882`、model-link PID `1023130`、
  Niuma Codex PID `2503887` 保持不变。

本次实际安装的工具版本：

| 工具 | 版本 |
| --- | --- |
| Codey | 0.1.18，开发构建 |
| Node | 24.20.0 |
| 官方 Codex CLI | 0.155.1 |
| GitHub CLI | 2.97.0 |
| DevTunnel CLI | 1.0.2094+24665e6583 |

### 安装结束状态

私有注册文件：

```text
/home/zhn/codey-machine-registration.json
```

权限 `0600`，仅报告路径，不输出其接入凭据。**本机完成，待用户手动导入 Portal。**
未验证 Portal 导入后的端到端访问或 connect token 上传续期，未做整机重启测试。
续期和健康检查定时器已启用；未导入 Portal 前，不能声称 Portal 续期已经成功。

### 后续通过 Codey CLI 更新

完整安装的节点支持本地应用包更新，不需要清空数据或重跑 Skill：

```bash
codey update "$HOME/Downloads/codey.tgz" --check --json
codey update "$HOME/Downloads/codey.tgz"
codey doctor
```

在原用户的外部终端中执行，使用可信、兼容的新版 `.tgz`；完整 Skill ZIP 需先解压，
取其 `assets` 中的 Codey npm 包，不能把 ZIP 直接传给 `update`。
可以用 `--sha256 HASH` 核对独立获得的发行摘要；依赖锁一致时自动复用已有依赖，
显式 `--offline` 也要求锁一致。

更新保留节点身份、配置、认证和 TLS，准备新版本后切换服务，并保留旧版本；
捕获到失败时尝试回退，回退失败或中断留下的锁需要人工核对。
它**不支持裸 `codey update` 自动发现/下载最新版**，不接受 URL，
也不升级 Node、Codex CLI 或 DevTunnel。

文档提交前，在 A100 对当前已有的开发包执行了
`codey update .../assets/codey-0.1.18.tgz --check --json`：
返回 `ok: true`、`check: true`、`dependencyMode: reuse-installed-offline`、
`downloads: false`。这是同包的只读预检，**不是一次新的跨版本更新验收**，
没有执行实际更新或重启服务。

## 遇到的问题与处理

### 认证与安装器

1. **`gh auth status` 会被失效的非活动账号拖成失败。**
   不用这个总退出码判断“没有登录”；读取选定缓存账号并验证身份，随后固定账号 ID、
   用户名、gh 路径及配置目录，不跟随 `gh auth switch` 偷换账号。
2. **gh token 不能直接沿用默认 VS Code token exchange。**
   早期 A100 调研得到 403；实现明确的 direct OAuth 模式，而非伪装成 OpenCode。
   本次完整 CLI/SDK 请求验证该路径可用。
3. **原生 DevTunnel 不能直接把 gh token 当作 tunnel access token。**
   使用管理 API 签发 host-only/connect-only token；官方 host CLI 只通过 stdin 收到
   host-only token，不拿到 GitHub 原始凭据。
4. **旧 Linux 预检会阻止所有正在运行的 Codex，包括其他服务。**
   已修改为核对目标 `CODEX_HOME` 和安装器祖先进程；独立目录的 Codex 可以共存，
   同目录、重叠目录、未知归属或 Codex 祖先进程仍拒绝，不通过杀进程解除检查。
5. **精简子进程环境可能丢失 Linux keyring 会话。**
   gh 登录探测现在传递当前 D-Bus/XDG runtime 环境，不把这些会话地址写入账号绑定。
   A100 使用文件型 gh 登录缓存；这里没有宣称原生 keyring 解锁场景已验收。
6. **只读 shell 预检仍提示共享 `~/.codex` 文件存在。**
   共用安装器随后正确报告 `replaceConfiguration: []`，使用独立 Codex home；
   实测没有覆盖这两个共享文件。这条提示非阻塞，但仍可进一步改善一致性。

上述必要改动在本次安装前完成。**实际全新安装只有一次，首次即成功，
没有失败后跳过检查重试来压低统计。**

### 诊断副作用：不是安装成功可以掩盖的问题

准备阶段，一次在 A100 Home 中执行的 Python/TOML 诊断导入了 Home 里的
`copy.py`，遮蔽标准库模块。该文件没有 `__main__` 保护，会执行：

```text
shutil.copytree("/home/zhn/g", "/data/g", dirs_exist_ok=True)
```

因此诊断进程实际改写了部分既有 `/data/g` 镜像文件。发现后核对其 SSH
进程关系，只终止了该诊断子进程；后续诊断全部使用隔离解释器
`/usr/bin/python3 -I -S`，没有再导入 Home 中的模块。

只读核对发现 `/data/g` 及采样镜像文件早已存在，并非可以安全整删的新临时目录。
检查时 `/data` 可用空间为 57,344 字节；没有事前容量快照，
**不能确定磁盘已满是否由这次复制造成，也不能保证已覆盖内容可恢复**。

没有猜测性执行 git reset/clean、删除镜像或覆写恢复，没有删除源项目。
此副作用**已停止但未回滚，影响范围没有完整量化**，需要保留现场另行核对。
其他已记录 systemd 服务的 PID/状态不变，只能证明没有重启这些服务，
不能替代对镜像内容影响的说明。

随后按用户要求，将脚本改名为 `/home/zhn/copy_projects_to_data.py`，
保持内容不变，并删除了 4 个旧的 `copy.cpython-*.pyc` 缓存。
已在 Home 目录用普通 Python 进程确认 `import copy` 解析并加载
`/usr/lib/python3.10/copy.py`，不再加载该维护脚本。
改名与验证没有执行目录复制，也没有恢复或改动前述镜像文件。

## 回归与证据

- 根目录 Node 回归：**593 项，578 通过，15 跳过，0 失败**。
- 使用本次构建的全新锁定依赖环境：Copilot API **944/944 通过**，
  完整 `tsc` 通过，包括新增 direct GitHub auth 测试。
- 完整包构建通过 runtime dependency audit、原生模块与 CLI/gateway smoke 检查。
- 原有本地 Copilot 依赖目录曾有 tsdown 版本与声明不一致的类型检查问题；
  不能把它算成认证代码失败，也不跳过正式类型检查：本次在全新锁定环境中通过。

工作区证据目录：

```text
artifacts/a100-skill-reinstall-20260919T084357Z/
```

关键文件为 `reset-plan.json`、`reset-result.json`、`reset-wall-timing.json`、
`install-timestamped.log`、`install-result.json`、`acceptance-result.json`、
`protected-before.json`、`protected-after-install.json`、
`node-tests-final.log` 和 `bun-tests-fresh-lock.log`。
可安装的完整开发 Skill 在 `bundle-v3/config-new-codey-machine.zip`。

A100 保留的本次审计/安装材料目录：

```text
/home/zhn/.local/state/a100-install-audit-20260919T084357Z/
```

这些是本次新生成的测试材料，不是复用的旧 Codey 安装或旧登录缓存。
其中 `installation-report.md` 保留了实验结束时的报告副本；
后续脚本改名及 CLI 更新说明以本文件为准。
