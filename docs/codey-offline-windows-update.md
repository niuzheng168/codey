# Windows {{CODEY_VERSION}} 离线升级包

这是交付说明模板，构建器会在包内 README 中填入版本和目标电脑。

这是**已有 Windows 节点的本地维护包**，不是新机安装器，不需要网页升级可用，
也不会自动接入 Portal 升级代理。Portal 已支持 Windows；“未接入升级器 / 版本未上报”
不是应用版本检查结果。仅升级 Codey 应用不会自动安装独立代理。

交付两个文件，放在同一个目录：

- `codey-{{CODEY_VERSION}}-windows-x64-offline.zip`
- `Update-Codey-{{CODEY_VERSION}}.ps1`

ZIP 内包含**原样保留、相同 SHA-256 的已发布 `codey-{{CODEY_VERSION}}.tgz`**、Windows/x64
锁定生产依赖的 npm 缓存、Node 22/24 ABI 对应的官方 SQLite 预编译模块，以及原版
{{CODEY_VERSION}} 更新器的引导副本。它不是另一个 `codey-win` 应用发行版，不重写发布包或 lock。

## 在 {{EXPECTED_COMPUTER}} 执行

1. 保存工作，结束 Codey 任务并退出 Windows 本机 Codex。不要强杀其他任务。
2. 从开始菜单打开原 Windows 用户的**非管理员** PowerShell，进入存放这两个文件的
   目录；不要使用 Codey Workspace/Codex 派生终端。
3. 先检查，再明确应用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Update-Codey-{{CODEY_VERSION}}.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Update-Codey-{{CODEY_VERSION}}.ps1 -Apply
```

这里的执行策略只作用于本次 PowerShell 进程，不更改系统/用户策略。
默认检查会把已校验的引导文件放到本人 HOME，检查包、依赖和现有安装，但不安装依赖
或改服务。`-Apply` 在新的私有目录通过原 npm 自带的 pacote 提取已核验的共享包，
再执行 `npm ci --offline --ignore-scripts`，严格遵守原 shrinkwrap，而不是让全局
安装重新解析依赖版本范围。校验全部依赖版本，放入已核验的 SQLite 预编译模块，执行真实 SQLite、
bcrypt、PTY、ripgrep、SDK 本地检测，然后才调用**未经修改的 {{CODEY_VERSION}} Windows 更新器**
检查空闲、切换和验收。忙碌、未知布局、错误用户/机器、Node ABI 不支持均拒绝。

使用原 `runtime.json` 中的 Node/npm，不依赖 PATH 中碰巧存在的 `node` 或旧 `codey`。
不安装 Node、Codex、DevTunnel、编译器，不执行 npm lifecycle hooks、`npm rebuild`
或 `codey setup`。仅重启 Codey 的 Workspace/网关任务；保留隧道、登录、模型 key、
TLS/SSO、任务定义、数据和原代码备份。

**“离线”指升级依赖不联网下载，不访问 Portal，不要求 agent 在线。**
原应用重启后的正常行为不变：已配置的 Copilot 网关可能需要连接 GitHub 刷新登录。
因此这不是保证模型服务在完全隔离网络中启动的改造；本机健康检查不通过仍会回滚，
不会跳过认证或替换凭据。升级检查本身不发送模型提示词。

## 失败与恢复

普通失败由原更新器回滚代码和本次描述符修改。不要删除锁、覆盖安装、重跑 setup
或公开完整 `runtime.json`。断电/被终止后保留两个交付文件，使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Update-Codey-{{CODEY_VERSION}}.ps1 -Recover
```

仅恢复与此包匹配的已有事务，不重复安装。日志和旧代码位于本人 HOME 的
`.local\share\codey-machine-windows\local-updates`，引导文件位于
`.codey-offline`（短路径，兼容 Windows PowerShell 5.1 解压）。不自动清理这些目录。

## 以后从 Portal 更新

不必先升级应用版本才能接入。在 Portal 的「设置 → 软件更新 → 本机 → 管理 →
接入升级器」下载**本机专属** ZIP；在原用户的外部、非管理员 PowerShell 中进入
解压后的 `codey-updater`，执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Apply
```

这一步只安装独立代理。等待 Portal 显示升级器在线和实际版本，再从网页选择更新。
不要重新注册机器，也不要把专属 ZIP、config.json 或 runtime.json 发给其他人。

## 构建与验证边界

`scripts/build-codey-offline-windows.py` 使用已验证的原 tgz、跨目标
`npm ci --os=win32 --cpu=x64 --ignore-scripts --omit=dev` 生成的独立缓存、与锁定
better-sqlite3 版本匹配且核对 GitHub release asset digest 的 Windows/x64
Node ABI 127/137 预编译包。生成脚本固定 ZIP、manifest、runner 的 SHA-256，
缓存解压目录再次使用前也检查，不信任旁边自称正确的哈希文件。

隔离测试覆盖路径穿越、Windows 名称冲突、链接、缓存篡改、缺少依赖、
错误 ABI/原生架构、关闭联网与 hooks 的安装参数、PowerShell 解析及原更新器的
模拟切换/回滚。Linux 上的跨目标离线 npm 安装、PE 检查和 PowerShell 模拟测试
**不是目标 Windows 实机升级验收**；真正的原生模块和任务健康检测在 `-Apply`
时执行，失败不强行切换。
