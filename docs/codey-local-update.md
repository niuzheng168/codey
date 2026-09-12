# 本地更新器：Codey、Codex、DevTunnel

更新器以已安装的 **Codey 0.1.3** 为工具管理兼容基线，一次明确更新一个组件。
它不是 `codey setup`，也不要求先通过 Portal 签名发布更新源。
原有 `codey update PACKAGE.tgz` 仍然**只更新 Codey**；`codey update codey PACKAGE.tgz`
是它的显式别名。把同一个可信、经过验证的共享 npm 包传到各节点，在
**原 OS owner 的外部终端**执行：

```sh
codey update /absolute/path/codey-new.tgz --check
codey update /absolute/path/codey-new.tgz
```

路径支持空格（由 shell 正常加引号）。Windows 使用本机绝对路径，例如：

```powershell
codey update "C:\Downloads\codey-new.tgz" --check
codey update "C:\Downloads\codey-new.tgz"
```

工具子命令从 **Codey 0.1.4** 开始提供。已发布的 0.1.3 包不会原地重打或覆盖，
旧 0.1.3 CLI 不会自动获得新功能。可按下文首次引导方式使用 0.1.4 CLI 指向
仍运行 0.1.3 的安装。发布新版不会自动升级任何现有节点。

## 组件与边界

| 选择 | 更新内容 | 不包含 |
| --- | --- | --- |
| `PACKAGE.tgz` / `codey PACKAGE.tgz` | Codey 整包、Workspace、模型网关、包内 SDK JavaScript、锁定依赖 | Codex / DevTunnel / Node / Python |
| `codex TOOL-UPDATE.json` | Codey 实际使用的独立原生 Codex CLI **完整发行目录**，包含 app-server | Codex 桌面 App、其他 CLI 安装、模型配置 |
| `devtunnel TOOL-UPDATE.json` | 现有受管隧道使用的 DevTunnel 完整发行目录 | 新建隧道、登录/注册、端口/权限配置、Node |

- Codex 的 app-server 通过 `codex app-server` 启动，不是另一份独立 npm 服务包。
  工具升级同时更新这个 CLI 的 `exec` 和 app-server；不能只看 PATH 中另一份
  `codex --version`。实际受管入口、原版本和目标版本会出现在检查报告中。
- **始终不安装或升级 Node / Python**；没有 `all`、隐式 `latest`、联网安装脚本或
  自动接管系统/桌面 App 安装的行为。工具包只能用于已识别的受管 Linux/Windows x64 节点。
- 不运行新机安装器/`setup`，不重新登录，不轮换模型 key，不生成新的模型配置、
  TLS/SSO 身份或注册信息。
- 本地验收只有包/原生模块检查与本机已鉴权的健康 GET；**不会发送模型提示词，
  不运行 Codex 模型验收**。它不替代发行包在发布前的兼容性和真实模型测试。
- 当前接受完整共享 Codey npm 布局。旧版两个独立应用、未知服务、部分安装和
  不匹配的 CLI/后台服务目录不会被自动接管。

## Codey 包参数

| 参数 | 行为 |
| --- | --- |
| `PACKAGE.tgz` | 本地、可信的 Codey npm 包；不接受 npm 名称、`latest`、URL |
| `--check` | 检查包、现有布局和 Node 兼容性；不安装依赖、不写更新任务、不改服务 |
| `--sha256 HASH` | 额外核对从独立可信渠道获得的包 SHA-256 |
| `--recover` | 恢复上次中断的本地事务，不接收新包 |
| `--installed-root DIR` | 首次引导用：由新 CLI 更新指定的旧应用目录；必须是原 owner 的实际安装 |

`--check` 不是任务空闲承诺。真正应用前会再次检查当前配置、活动任务和模型连接。
不兼容现有 Node 时直接拒绝，不通过升级 Node 来消除阻塞。相同构建指纹是 no-op；
同版本号但构建不同的包仍可更新。选择本地旧包是明确的本地换包行为，不会降低
签名更新源的防降级序号。

## Codey 包更新过程

1. 只读检查压缩包路径、类型、大小、重复项、原生二进制/嵌套应用、统一 lock、
   应用身份和入口指纹。可选检查外部 SHA-256。
2. 在私有新目录运行现有 npm，使用独立临时 HOME，不继承模型凭据、
   `NODE_OPTIONS` 或 npm 安装覆盖参数。先禁止 lifecycle scripts 安装，再逐文件
   校验压缩包与安装结果，最后启用所需原生依赖 hooks 并执行 `codey doctor`。
3. 排除其他本地更新；校验服务/配置基线，确认空闲后才切换。
4. 验证新服务，保存版本记录。失败只恢复本次代码指针/运行描述符/版本标记，
   不恢复旧数据库或旧密钥，不覆盖另一部署者的修改。

依赖冷安装仍可能联网，并需要现有平台编译工具。不会自动安装缺失的工具。
安装来源必须可信：完整性校验不是对任意本地 npm 代码的安全背书。
需要不兼容数据/配置迁移的发行版应另行审核，本命令不是通用迁移器。

### Linux x64 受管节点

使用现有升级器的发现与原子包指针切换逻辑，只停止/启动
`codey-cloudcli.service` 和其已识别的网关 service。为避免与 Portal 事务并发，
短暂停止原 `codey-node-updater.service`，取得其现有锁后更新，最后恢复升级器；
**不替换升级器代码或凭据**。已有未完成 Portal job 时拒绝更新。

本地版本明确记作 `source: local-package`，保留原签名序号。不会伪造新的签名发行版；
后续更高序号、由 owner 确认的 Portal 发行版仍可接管正常升级。

### 已识别的 Windows x64 受管节点

复用现有安装器的 owner 校验和互斥锁，只调整原 `runtime.json` 的 Codey
应用路径/构建标记。只重启 Codey 任务，不重新注册任务，不更换
工具/守护脚本，也不停止 DevTunnel host/renew。

先结束原生 Codex 工作。无法判断原生进程是否处于任务间隙时保守拒绝，
不会结束 Codex 进程。请勿从 Codey Workspace 内的终端运行更新，避免维护过程
被它正在重启的父服务终止。

### 普通用户 npm 安装

必须先自行结束使用该包的 `codey start` 等进程。保持原包路径和 npm CLI 入口，
换入新包，旧目录留作回滚；不会创建、启动或猜测未知后台服务。更新后由用户重新
运行原来的启动命令。

安装路径及其 HOME 内的父目录必须由当前用户拥有，且不能允许组或其他用户写入；
不安全的旧目录会被拒绝，不会自动更改其权限。新暂存包使用独立的私有 npm 权限，
不依赖调用终端的 `umask`，确保激活后仍能通过下一次更新检查。

## 独立更新 Codex / DevTunnel

### 制作工具包（发布/验收方）

先从官方渠道取得并**独立核验**所选平台的发行版，保留其全部运行时伴随文件，
在独立目录解压。根入口规范为 Linux 的 `codex` / `devtunnel` 或 Windows 的
`codex.exe` / `devtunnel.exe`；必要时仅规范原官方入口文件名。
不要用 npm shim、桌面 App 安装目录或安装脚本代替原生发行目录。

```sh
# REVIEWED_VERSION 是已验收的明确版本号，不是 latest。
node scripts/build-tool-update.mjs \
  --component codex --platform linux-x64 --version "$REVIEWED_VERSION" \
  --source /absolute/verified-vendor-distribution \
  --output /absolute/new-tool-bundle
```

`--component` 可选 `codex` / `devtunnel`，`--platform` 可选 `linux-x64` /
`windows-x64`。构建器**不下载、不执行、不发布**原生工具，也不覆盖已有输出。
产物如下，传输时必须带齐整个目录：

```text
new-tool-bundle/
  tool-update.json
  tool-update.json.sha256
  files/
    codex
    ...发行版伴随文件...
```

manifest 固定组件、平台、版本、入口和每个文件的大小、SHA-256、可执行标记。
整个 manifest 的 SHA-256 必须由节点 owner 从**独立可信渠道**取得；同目录的
校验文件只是传输辅助，不能自己证明发行来源。工具格式拒绝链接、特殊文件、
越界路径、Windows 名称冲突、额外/缺失文件和错误的原生 x64 入口。
哈希匹配不是对任意二进制的安全背书，仍须发布前兼容性/真实模型验收。

### 在节点执行

```sh
codey update codex /absolute/new-tool-bundle/tool-update.json --sha256 "$TRUSTED_MANIFEST_SHA256" --check
codey update codex /absolute/new-tool-bundle/tool-update.json --sha256 "$TRUSTED_MANIFEST_SHA256"

# DevTunnel 使用它自己的包和 SHA-256；先检查，再明确同意短暂断线。
codey update devtunnel /absolute/tunnel-bundle/tool-update.json --sha256 "$TRUSTED_TUNNEL_SHA256" --check
codey update devtunnel /absolute/tunnel-bundle/tool-update.json --sha256 "$TRUSTED_TUNNEL_SHA256" --allow-disconnect
```

Windows 在**原用户、非管理员 PowerShell**中使用相同子命令，将路径和环境变量
换成本机形式，例如：

```powershell
codey update codex "C:\Downloads\codex-bundle\tool-update.json" --sha256 $env:TRUSTED_MANIFEST_SHA256 --check
codey update codex "C:\Downloads\codex-bundle\tool-update.json" --sha256 $env:TRUSTED_MANIFEST_SHA256
```

工具命令的 `--sha256` 是**必填项**，校验的是 manifest，不是某一个 exe。
`--check` 不复制工具、不执行候选工具、不写任务记录、不改服务；它会读取已安装工具
的 `--version`。真实应用先暂存并复核**全部**文件，再在隔离 HOME/CODEX_HOME 中
检查精确版本。Codex 还要完成 `initialize`、`initialized`、`thread/loaded/list`
握手，不能创建 thread 或发送提示词。相同版本号也不能代替完整伴随文件校验。

### 具体切换和回退

- **Linux Codex**：只接受原受管稳定入口（例如 `~/.local/bin/codex`），使用正在运行的
  Workspace 的 `CODEY_CODEX_EXECUTABLE`，未配置时才查它自己的 PATH。暂停拉取升级器，
  确认空闲，只重启 Workspace，切换 CLI 入口到完整候选目录；网关、DevTunnel 不动。
- **Windows Codex**：保留 `runtime.json` 和 `CODEY_CODEX_EXECUTABLE`，切换现有
  `codex-bin` 目录/官方 junction，保留原目录或旧 junction。只重启原 Codey 任务
  （该任务包含 Workspace 和网关），不修改桌面 App/安装商店。不通过关闭终端或
  全局杀进程来更新：外部 CLI/Desktop/未知 Codex 进程仍在运行时拒绝。
- **Linux DevTunnel**：保留稳定 exe 入口、同一个隧道 ID、续期脚本和 unit 文件；
  暂停原续期 timer，正在续期时不强杀；重启 host 后恢复 timer 的原 active 状态。
- **Windows DevTunnel**：只修改描述符中的 `devtunnelExe` 和 host 的 executable，
  只重启 tunnel 任务。旧 exe 保留；续期 watchdog **不停止**，已经发起的续期可用
  旧 exe 完成，下次执行读取新描述符。Codey、隧道 ID、登录、helper、renew 配置不改。

DevTunnel 会短暂断线，必须在**不依赖该隧道的外部终端**执行并提供
`--allow-disconnect`。验收同时检查新 host 进程和原隧道的已连接 host 状态；
仅进程存在、版本输出正确不算通过。候选不兼容、健康检查失败时，回退本次入口/
描述符，不恢复旧数据库、登录或密钥。所有组件共用本地事务锁和 `--recover`；
首次移动入口后的短暂缺口也可恢复。旧目录和日志保留，不自动清理。

### 和 Portal「软件更新」的区别

以上是**本机、显式授权的更新入口**。Portal 现有 Linux 心跳、protocol 1 的签名
Codey feed、发行版选择器和防降级序号不变；工具 manifest 不能冒充 Codey npm
发行版提交给该 feed。本次没有把 Codex/DevTunnel 自动更新选项接到网页，也没有
新增 Windows 拉取 agent。Windows 本地更新适配器通过隔离测试不等于已在
目标 Windows 节点上完成实机更新。

## 首次引导旧 CLI

旧版本没有 `update` 子命令时，不要为了获得它而重跑 `setup`：

1. 将新发行包和配套 `install-codey.mjs` 放在一起，执行
   `node install-codey.mjs --check`。它只在新私有 prefix 安装并验证，打印
   `packageRoot`，不改 PATH 或现有服务。
2. 使用打印出的新 CLI，明确指定原安装目录：

   ```sh
   node /absolute/new/packageRoot/bin/codey.mjs update /absolute/path/codey-new.tgz \
     --installed-root /absolute/old/packageRoot
   ```

Windows 命令相同，替换成本机路径并正常加引号。旧目录可从原安装记录取得；
原生 Windows 描述符的字段名为 `codeyDirectory`，Linux updater profile
为 `codeyAnchor`。只取所需路径，不公开包含凭据的完整配置文件。

bootstrap CLI 所在的临时安装不会成为后台服务的冒名目标；真正更新的仍须是
原 owner 已管理的应用，所有运行时、并发和空闲检查照常执行。
读取旧安装时兼容此前共享包的平台清单和同 OS 的旧 npm 元数据，不改写旧元数据；
新包仍必须符合当前 Linux/Windows 共享包格式。这不启用已移除的平台。

## 中断与回滚

正常失败自动回滚；若进程/机器被强行终止，执行：

```sh
codey update --recover
```

本地状态在用户 HOME 的 `.local/share/codey-local-update/`，具体私有任务目录在
输出的 `job` 字段中。任务包含原版本、安装日志和事务日志；不自动清理依赖缓存
或旧版本。恢复不重新安装包。

如果普通 npm 目录首次切换时恰好中断、导致原 CLI 暂时找不到，可用任务保留的
`previous-codey/bin/codey.mjs`，通过原 Node 执行 `update --recover`。Linux
受管节点的目录备份为任务中的 `backup/codey`，也可使用任务保留的
`update-service.py recover /absolute/job/local-update.json`（原 Python，加
`-I -S -B`）。不要删除锁、手改指针或强行覆盖报告存在并发修改的运行描述符。
恢复本身也互斥。如果连恢复进程都被强制杀死，遗留的 `recovery.lock` 会要求人工
检查，不能并发或盲目重复恢复。回滚未完成时，Linux 的拉取升级器保持暂停，
待恢复确认后才继续，避免另一个 Portal job 覆盖尚未处理的事务。

## 验证

```sh
node --test test/codey-package-update.test.mjs test/codey-package-tool-update.test.mjs test/codey-package-update-services.test.mjs
python3 -I -B test/test_codey_local_update.py
python3 -I -B test/test_codey_tool_update.py
```

设置 `CODEY_TEST_POWERSHELL` 可在任一支持 PowerShell 的测试机上额外解析完整
Windows 适配器，并用模拟任务测试配置切换、工具指针缺口恢复、回滚和组件隔离。
Linux npm 安装和 Codex JSONL 协议测试使用隔离 HOME 和无模型的合成应用；
Linux/systemd 和 Windows 任务测试使用模拟控制器。
这些不能冒充 Windows 实机或生产模型验收。
