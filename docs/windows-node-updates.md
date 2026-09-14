# Windows 从 Portal 更新 Codey

## 能力与发布状态

新版完整安装 Skill 会自动安装并启动此原生代理，上传机器注册 JSON 时同步绑定凭据；
不需要第二次手动接入。下面的独立接入步骤用于已有、尚未接入的节点和维护修复。

Windows x64 使用独立拉取代理和 Portal 接入入口，并消费 Windows/Linux/macOS 共用的
整包签名发行版。它不是把
“平台不支持”文字隐藏掉：版本来自正在运行的原 Codey 进程、安装指纹和本机已鉴权
健康检查。没有代理上报时仍明确显示未知。

这需要**部署包含该实现的新 Portal**，并在现有 Windows 上**首次安装一次专用代理**。
仅安装 Codey 应用/离线包（包括 0.1.6）不会自动接入代理；不需要重打应用 `.tgz`。
新版完整 Skill 将新机安装和升级代理配置合并；已有 Windows 节点仍可独立接入，
不强制重新注册或重装应用。

## 原用户首次接入

1. 新 Portal 的「设置 → 软件更新」中，在 Windows 节点的「管理」菜单选择
   「接入升级器」。下载包含本节点专属凭据，只能交给该机器原用户，不能公开分享。
2. 在该 Windows 的原用户、非管理员 PowerShell 中，进入解压后的 `codey-updater`：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Apply
   ```

   执行策略仅作用于该进程。安装器复用原 Node/npm、Windows PowerShell、系统已有
   .NET Framework 编译器；仅创建独立的 `Codey Node Updater <nodeId>` 隐藏登录任务。
   不安装/升级工具，不重启 Codey，不动模型 key、TLS/SSO、隧道或原三个任务。
3. 原用户保持登录（锁屏可以），等待心跳。Portal 应显示「升级器在线」和本机真实
   Codey 版本。注销会结束任务，下次登录恢复；这不是 SYSTEM 权限的无人登录服务。

后台宿主只传递允许的系统环境变量，其中 `COMPUTERNAME` 必须保留原始大小写，
供本机身份绑定检查使用。旧宿主遗漏该变量时可能已在线，但显示版本未上报和
`configuration_changed`；升级独立代理即可，无需重装应用或放宽身份校验。

## 发行版与日常更新

Codey 整包只发布一次：同一个 `.tgz`、SHA-256、签名清单、release ID 和序号供
Windows、Linux、Mac 使用，不再分平台开放更新。Windows 不接受旧的
CloudCLI/copilot-api 拆分包、Linux 任务或 Codex/DevTunnel 工具 manifest。
历史单平台签名仍按原范围读取，不会被擅自扩大授权。

共享清单使用 `platform: shared`，支持的运行环境来自实际包的 `runtimePlatforms`。
原 Windows 节点身份仍是 `windows-x64`。先部署新版 Portal，再刷新独立升级器；
新代理上报 `sharedCodeyReleases: true`。旧代理会显示需要更新升级器，而不是把
共享应用说成“Windows 版本尚未开放”。不需要重装 Codey 或重新注册节点。

发布已构建、已验证的共享包（运维执行，不在 Windows 节点生成签名）：

```sh
node scripts/publish-node-update.mjs publish \
  --manifest /absolute/build/codey-package.json \
  --output /absolute/feed --private-key /absolute/private.pem \
  --sequence NEW_GLOBAL_SEQUENCE --codey-node-majors 24
```

只声明兼容、已验证的 Node major。先上传不可变包和清单，最后原子发布 catalog。
不得为了 Windows 重打同版本的应用或改锁文件。发布器检查实际包与验收摘要，
不伪造 Windows 原生验收；代理在停止应用前仍检查本机 Node、原生模块和候选包。
首次使用单台 Windows canary，真实验收后再扩大范围；各节点绑定同一份共享签名。

用户在 Portal 预览、确认；代理才领取任务。忙碌/离线等待，签名、有效期、版本、
Node、配置与防降级检查失败则拒绝。**先结束 Codey 工作并退出 Windows 本机 Codex**：
当前无法安全判定的原生 Codex 进程仍保守视为忙碌，没有 force、没有强杀用户任务。

更新复用原安装中的固定 Node，通过原 npm 的 pacote 提取应用。依赖锁相同时，
直接引用经过检查、保留的现有依赖树，不整树复制、不访问 npm 源或重编译；依赖锁不同时使用 `npm ci`，
而非全局安装重新解析版本范围。候选与原生模块验证完成前不停止应用。切换前在原
installer mutex 内重验所有应用文件，只重启 Codey 任务，不动隧道/续期任务。
随后要求目标版本、启动状态和本机已鉴权健康检查通过，才标记成功。
**日常更新和同包校验均不发送模型请求、不创建合成会话、不运行 `codex exec`。**
新请求显式使用 `authenticated-health-v1`；`health-proof.json` 绑定任务 ID、签名摘要、
版本和入口哈希，并记录 `modelRequests: false`，不伪造模型成功。
失败不恢复旧数据库/密钥，拒绝覆盖并发部署。

## 崩溃、并发与撤销

- GUI task host 使用 Windows Job Object 管理自己的整棵进程树；宿主崩溃不会留下
  重复代理。Codey/隧道任务由任务计划程序独立创建，不属于该进程树。
- 与本地 CLI 共用 `.local/share/codey-local-update` 锁，同时使用原 Windows
  installer mutex。恢复先于 Portal 请求，已完成的事务只补确认，不重跑模型/安装。
- 旧请求没有健康验收标记时，完成恢复仍要求原有真实 `model-proof.json`；不会改写旧回执、
  重跑推理，或将已失败/回退的历史任务改成成功。旧未完成事务只按原日志安全回退。
- 无法恢复或发现新用户工作时保留日志与回退记录，进入需人工处理状态；不循环强停。
- 凭据轮换保留签名序号上限。安装代理前若仍有本机事务，则拒绝覆盖代理。
- 撤销只取消授权/未开始的任务，不关机、不删除用户数据；正在切换的本机事务仍需
  安全收尾。授权已失效的最终确认不会让旧 pending 凭据永久阻碍重新接入。

代理状态：`%USERPROFILE%\.config\codey-updater`；
代理和日志：`%USERPROFILE%\.local\share\codey-updater`；
应用事务：`%USERPROFILE%\.local\share\codey-machine-windows\local-updates`。
不要分享 config.json、runtime.json、原始日志或凭据。`rollback_failed` 时按接入包
`UPGRADE.md` 用原 Node 执行 `agent.mjs recover --config <原config.json>`，不要删锁重装。

## 验证边界

```sh
npm run updates:check
npm run updates:test
python3 -I -B test/test_node_updater.py
```

设置 `CODEY_TEST_POWERSHELL` 可额外运行完整 PowerShell 解析、C# 宿主编译、
模拟 Task Scheduler 及恢复测试。测试包含真实的本地 Portal HTTP/签名/授权/队列，
以及代理的隔离状态机、坏签名、平台绑定、防降级、忙碌、并发、回滚和重试确认测试。
模拟任务/模型调用不等于目标 Windows 实机验收。上线仍需检查实际节点的心跳、日志、
已鉴权健康、原生模块与重启恢复，不自动进行模型测试，也不把“代码实现完成”描述为“Windows 已升级成功”。

Windows schema-2 runtime 使用 `kind=codey-windows-oneclick` 和
`layout=npm-codey-package` 绑定平台，没有必填的 `platform` 字段。健康探针遵循
该描述符格式，仍校验原用户、节点、Node 和应用目录；不能因缺少不存在的字段把
有效安装误报为 `configuration_changed`。失败任务不会改变页面上的已安装版本。
