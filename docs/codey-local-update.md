# 本地只更新 Codey

`codey update` 是现有节点的应用换包命令，不是 `codey setup`，也不要求先通过
Portal 签名发布更新源。把同一个可信、经过验证的共享 npm 包传到各节点，在
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

## 范围

- 更新 Codey 整包，包括 Workspace、模型网关、包内 SDK JavaScript 和锁定依赖。
- **不安装或升级**独立 Codex CLI、Node、Python、DevTunnel。
- 不运行新机安装器/`setup`，不重新登录，不轮换模型 key，不生成新的模型配置、
  TLS/SSO 身份或注册信息。
- 本地验收只有包/原生模块检查与本机已鉴权的健康 GET；**不会发送模型提示词，
  不运行 Codex 模型验收**。它不替代发行包在发布前的兼容性和真实模型测试。
- 当前接受完整共享 Codey npm 布局。旧版两个独立应用、未知服务、部分安装和
  不匹配的 CLI/后台服务目录不会被自动接管。

## 参数

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

## 更新过程

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
node --test test/codey-package-update.test.mjs test/codey-package-update-services.test.mjs
python3 -I -B test/test_codey_local_update.py
```

设置 `CODEY_TEST_POWERSHELL` 可在任一支持 PowerShell 的测试机上额外解析完整
Windows 适配器，并用模拟任务测试配置切换和回滚。Linux npm 安装测试使用隔离
HOME 和无模型的合成应用；Linux/systemd 和 Windows 任务测试使用模拟控制器。
这些不能冒充 Windows 实机或生产模型验收。
