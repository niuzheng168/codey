# 机器自动配置发布：2026-09-07

本次按授权先拉取最新 `main`，再提交、推送并执行更新。
**门户和安装 Skill 已发布；旧四节点网关升级等待认证迁移，不能记为全量升级成功。**

## 已推送的源码

- 拉取并快进到 `5584631`，保留全部本地功能改动，没有代码冲突。
- `copilot-api/dev`：`e63ed216a9633650036a7e4bae05bfcc2dee28ee`，
  包括 opt-in headless 启动和新机器空 History。
- 主仓库功能提交：`8ddf6b869d8a485b500672943ef491c0290a4819`。
- CloudCLI 继续固定到已发布的
  `a9bded2982592297cdbca986d5819b3b83e5ae12`，未替换为未审查的 npm/upstream 版本。

子仓库先推送，主仓库随后提交并推送 gitlink；没有强制推送或丢弃用户改动。

## 已上线的门户与安装包

- Portal 修订：`codey--machine-0907074343`，于 **07:46:43 UTC** 就绪。
- 镜像摘要：
  `sha256:d2596d269289327287e1d14522894e57066bd5700911a6cb82c17cd30af76e15`。
- 安装包：`machine-53c7e29fbf22699c`，从干净且已推送的 fork 提交构建，
  不包含开发工作树 patch。
- 实测个性化 ZIP 为 **4,244,928 bytes**，含 10 个条目。两个依赖源码包均校验通过；
  Node 24.20.0 与锁定依赖由目标机联网安装，不携带 Node binary。
- 包内 CloudCLI 为 1.37.2，copilot-api 为 2.5.1。
- 共享 UI 保留 `ui-20260907t031424z-combined`，没有重复发布相同的前端。

只更新 Portal 镜像以及机器包、网络配置的两个环境变量路径。运行中的 57 个应用/
Skill 文件与冻结快照一致，原有 5 份运行配置文件未变；MCP 镜像、身份、认证、
网络、挂载、Foundry 和语音配置未改动。

生产验证覆盖：

- 已登录同源 POST 下载；匿名、跨源和错误方法拒绝。
- 预留不加入节点列表；同一身份重下不改变 key、ID、到期时间。
- 错误 enrollment/机器文件拒绝，验收失败不启用节点。
- 测试预留通过正常 API 取消，原有活动节点列表不变；短期验证会话已撤销。
- 实际登录的 Chromium 在 1100/390 宽度显示三个步骤，下载按钮可用，无横向溢出；
  手机为触控模拟，不代替物理设备测试。
- 独立测试 VM 从当前生产 ACA 网络经 Private Link 验证 HTTPS、Usage、History、
  Workspace SSO、WebSocket 101 与匿名 401；没有把隔离测试身份添加到生产账号。

## 旧节点网关：未完成的安全迁移

四台既有节点的 CloudCLI 后端各有 804 个文件与目标提交一致，因此不重启该服务。
copilot-api 2.5.1 候选也已在四种现有 Node runtime 下完成隔离启动与 TLS/History
验证，但这不等于生产激活完成。

生产 canary 暴露了现有配置与新版本的差异：

```text
Refusing to listen on non-loopback host "0.0.0.0" without gateway API keys.
```

四节点现有 `auth.apiKeys` 均为空，原模型端口对外监听；`westus2:4141` 仍有非回环
连接。不能通过空/假密钥、移除新版本检查或放置无认证转发来绕过该安全要求；
也不能仅凭本机 Codex 配置使用 localhost，就推断没有其他外部客户端。

| 节点 | 保留的 copilot-api | 本次状态 |
| --- | --- | --- |
| `jpe2` | 2.3.12 | canary 回滚，保留原入口和凭据 |
| `zhn-a100` | 2.3.12 | 候选已验证，未激活 |
| `jpe3` | 2.3.12 | 候选已验证，未激活 |
| `westus2` | 2.3.12 | 候选已验证，未中断外部连接 |

继续升级前需要确认方案：

1. 保留远程模型入口：配置强 API key，并同步所有实际调用方，安排兼容切换。
2. 仅允许本机模型调用：先确认可以停用外部 `4141` 访问，再收紧监听地址。

不能复用 History/SSO key 充当模型访问凭据。迁移后需重新采集运行基线、检查空闲、
验证真实配置下的候选，再进行 canary 和逐节点切换；不要直接重跑旧激活命令。

回滚恢复原应用目录和包标记，未回写 Codex 数据库、恢复旧用户数据或覆盖凭据。
数据库备份、候选和诊断保留在节点专属 release 目录；其他三个 copilot-api 服务、
四个 CloudCLI 服务以及 VM 均未因这次候选准备而重启。

## 验证与清理

- Portal 141 项测试、copilot-api 876 项测试、发布器 9 项测试通过。
- 语法、类型检查、定向 lint 和 Skill validator 通过。
- 构建/传输文件逐项 SHA-256 校验；新网关候选每台验证 11,491 个文件。
- A100 的 Python 3.10 解包兼容问题使用已校验清单与严格路径限制解决；
  没有把解包过滤器改为无条件信任。
- 不使用真实聊天或执行模型任务做发布探测；模型元数据可用性与实际推理分开报告。
  独立新机器的 provider 登录/推理仍未测试，需要机主完成本人认证。
- 私有临时传输容器和独立 ACA 探测文件已清理；生产安装包、旧版本、数据库备份及
  之前授权创建的测试 VM/网络资源保留。

准确的逐节点状态和非敏感验收报告位于 Git 忽略的：

```text
artifacts/machine-fleet-release-current.txt
  → deployment-summary.json
  → http-final.json
  → nodes-verify-legacy.json
  → test-vm-verification.json
```

状态应保持 `awaiting-auth-migration`，直到旧节点认证迁移和实际升级完成；
不得因为 Portal 就绪、候选已准备或源码已推送而提前写成 `complete`。
