# macOS 从 Portal 更新 Codey

## 当前实现和上线边界

已实现 Apple Silicon (`macos-arm64`) / Intel (`macos-x64`) 的独立升级代理、
真实安装版本上报、分平台签名发行版和 owner 确认队列。支持已有
`schema: 2`、`kind: codey-macos-oneclick`、`layout: npm-codey-package`
的原用户 LaunchAgent 安装，不以“Workspace 在线”推断 Codey 版本。

**代码实现不等于已上线。** 必须部署新版 Portal，在 Mac 首次接入代理，
再发布对应平台的签名发行版。已发布的 **0.1.4 包只声明 Linux/Windows**，
不能重标记或重打同版本当作 Mac 包。**0.1.5** 的共享包已包含 Mac 平台声明，
依赖版本和已发布 0.1.4 的字节不变。Mac 可先按下文显式发布测试发行版，
再从 Portal 进行首次实机验收；“可选择发行版”不等于“已经实机验收通过”。

接入代理可以直接读取原来的 Mac npm 安装，包括旧三平台包中的 Apple Silicon
安装；**不需要先装 0.1.5 才能接入**。首次成功心跳应显示真实的旧版本。
不支持将早期 schema-1 的 CloudCLI / data relay 拆分布局、Codex Desktop 或
外部 launchd 服务自动迁移为受管 npm 节点。Intel 节点也必须具备相同受管布局、
支持该架构的原 worker 和工具；不能通过修改平台字段绕过。

## zhn-mac 的首次接入

新版 Portal 的「设置 → 软件更新 → zhn-mac → 管理 → 接入升级器」下载专用 ZIP。
下载绑定本节点和原 Workspace 身份；不新增/重注册节点，不换原隧道和 TLS/SSO key。
在 Mac 原登录用户的外部终端，进入解压的 `codey-updater` 目录：

```sh
chmod 600 config.json
PYTHON="$(/usr/bin/plutil -extract pythonExe raw -o - \
  "$HOME/.config/codey-machine-macos/runtime.json")"
"$PYTHON" -I -S -B ./install.py
"$PYTHON" -I -S -B ./install.py --apply
```

默认命令只检查，不发送模型请求或下载/安装依赖。`--apply` 只创建独立的
`com.codey.node-updater.<nodeId>` 登录用户 LaunchAgent，不重启 Codey、
不安装 Node/Python，不动原 Codex、DevTunnel、模型配置或 tunnel/renew 任务。
原 Python 缺失、布局未知、owner/架构/签名公钥不匹配时拒绝，不用 sudo 或
重跑新机安装解决。ZIP 和 config/logs 都是私密材料，不能公开分享。

本任务没有读取 zhn-mac 的私密运行时，也没有远程升级这台 Mac；上面的布局、
Python、工具和服务绑定必须由首次只读检查确认，不能据 Portal 在线状态推定。

## 日常更新与保护

- 用户在 Portal 选本平台发行版、预览并确认后才领取任务；预览不触发升级。
- 代理独立于 Codey，在原用户登录期间向 Portal 发起出站 HTTPS 请求。
  不开新入站管理端口；睡眠、离线或注销期间不能更新。
- 签名、有效期、平台、Node major、版本指纹和防降级序号在 Portal 与 Mac 双端校验。
  Linux、Windows、Apple Silicon、Intel 不会互相领取发行版。
- 原 Node/npm 的 `pacote` 暂存应用；相同依赖直接引用保留的依赖树，不整树复制或重装，
  不同依赖使用锁定的 `npm ci`。候选目录和原生模块
  `codey doctor` 验证通过后，才有可能停应用；不对同名公共 npm 项目做更新。
- 原安装 `install.lock` 贯穿切换和健康检查。切换前再次验证全部包文件、
  配置、真实 worker/Codey 进程和任务定义。只更新 runtime.json 的包路径/指纹/
  release ID，并重启原 Codey LaunchAgent，保留旧包供回滚。
- 活动 Codey 会话、模型连接、无法证明空闲的外部 Codex/Desktop 进程均阻止切换。
  请先结束任务并关闭该 Mac 本机 Codex/Desktop；没有 force 或批量强杀。
- 成功必须有目标版本、启动状态、原生模块和已鉴权本机健康检查；**不自动发送模型请求、
  创建合成会话或运行 `codex exec`**，同包任务也如此。新请求使用
  `authenticated-health-v1`，健康证明绑定任务/签名摘要/版本/入口哈希，记录 `modelRequests: false`。
  不会把计划版本直接填进当前版本栏，也不会写假模型成功证明。
- 完成先落盘再确认 Portal。断网/丢失回执只补确认，不重复安装或模型请求。
  崩溃先做本地恢复；新用户工作或配置漂移会阻止回退并要求检查，不循环停服务。
- 历史请求没有新标记时，完成恢复仍须原有真实模型证明；旧未完成事务只安全回退，
  不重新推理，不把已失败/回退任务改为成功。

**此 Portal 升级器只更新 Codey。** Mac 的 Codex CLI/app-server/Desktop、
DevTunnel、Node、Python 不在本次自动更新范围；Linux/Windows 本地工具更新命令
不会因此被宣称支持 Mac。

## 运维发布门槛

同一 0.1.5 `.tgz` 可供四个平台使用，但每个平台有独立签名清单/ID，整个 catalog
的序号严格递增。先部署新版 Portal，再发布 Mac feed，以免旧 Portal 因不认识
Mac 清单拒绝整个目录。仍不发布新的 Mac 新机安装器。

在原生目标 Mac，用暂存候选包的原 Node 执行 `codey doctor --json`（不可只做
`--package-only`），保存真实输出为构建目录的 `doctor-macos-arm64.json`
或 `doctor-macos-x64.json`。发布器要求其平台、版本、包入口/锁文件指纹、
源 commit、实际 Node major 和五项原生检查与该包完全匹配；没有 Mac 原生
验证报告则默认拒绝签名发布。常规发布一次只声明这个报告实测的 Node major。

```sh
node scripts/publish-node-update.mjs publish \
  --manifest /absolute/build/codey-package.json \
  --output /absolute/feed --private-key /absolute/private.pem \
  --platform macos-arm64 --sequence NEW_GLOBAL_SEQUENCE --codey-node-majors 24
```

### 首次实机测试：先发布 canary，再从 Portal 验收

用户明确要求先开放 Mac 测试时，可对**同一份已构建、已通过基础验证的包**使用：

```sh
node scripts/publish-node-update.mjs publish \
  --manifest /absolute/build/codey-package.json \
  --output /absolute/feed --private-key /absolute/private.pem \
  --platform macos-arm64 --sequence NEW_GLOBAL_SEQUENCE --codey-node-majors 22,24 \
  --macos-validation canary --notes "Owner approved first native macOS testing; acceptance pending"
```

Intel 使用 `--platform macos-x64` 和下一个全局序号。Node majors 是此次允许测试的
原有运行时，不是已完成的 Mac 验证矩阵；不升级 Node。没有显式 canary 参数和说明，
仍要求原生报告。canary 只允许**缺少**报告，不忽略格式损坏、失败或指纹不匹配的报告，
也不放宽基础构建验证、实际包的平台/指纹、签名、公钥、有效期或防降级检查。

签名说明会强制标注 `[macOS CANARY: native acceptance pending]`，不写假 doctor。
发布本身不创建升级任务；先由 owner 在 Portal 选择一台 Mac 确认测试。
代理仍须在**停止 Codey 之前**完成暂存包、锁定依赖和原生 doctor 检查，保留空闲检查、
已鉴权健康验收和代码回滚，不自动测试模型。已发布包和签名 ID 不可覆盖；后续正式授权需要新的发行 ID/
全局序号以及真实原生报告，不把 canary 记录改写成已验收。

不能手写假 doctor 成功报告绕过门槛。原生模块通过也不代替 canary 上真实的
launchd 切换、已鉴权健康、回滚以及睡眠/注销后恢复验收；先一台 Mac，再扩大范围。
原包、私有运行日志和事务记录保留。具体手工恢复命令见接入包的 `UPGRADE.md`。

## 回归检查

```sh
npm run check
npm run updates:check
npm run updates:test
npm run updates:test:macos
python3 -I -B test/test_node_updater.py
npm test
```

Linux 上的 Python/Node fixtures 覆盖架构、签名、owner/版本上报、源文件漂移、
真实进程参数解析、独立锁、只切换 Codey、失败回滚和恢复幂等性，但不会调用真实
launchctl 或模型。必须将“代码/模拟回归通过”和“zhn-mac 实机验收通过”分开报告。
