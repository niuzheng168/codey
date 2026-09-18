# macOS Codey 节点

完整命令、依赖与安装步骤见 [安装 Skill](../skills/config-new-codey-machine/SKILL.md)。
macOS arm64/x64 与 Linux、Windows 共用一个 npm 包和 Node 安装流程；不依赖 Python，
不安装 Portal 更新代理或常驻本地更新器。当前改动尚未发布，原生 Mac 验收需单独完成。

## 入口与系统适配

```sh
bash scripts/install-macos.sh --check
bash scripts/install-macos.sh --apply --network-approved --expected-computer "$(hostname)"
```

检查不下载、不写文件、不登录、不启动服务或调用模型。若无 Node，列出待检查项目；
确认安装后才从官方来源下载并校验 Node。已有节点会复用其私有 Node，即使 PATH 没有 Node。

`install-machine.mjs` 负责依赖、身份、隧道、证书配置、模型验收与 JSON 导出。
`platform-macos.mjs` 只负责原生架构/GUI 会话、端口归属和 LaunchAgents；
`macos-service.mjs` 用 Node 守护 `codey`、`tunnel`、`renew` 三个组件。
服务依赖原用户登录，并非无人登录时的系统服务。

## 端口与注册文件

- HTTP `127.0.0.1:4141` 为带模型 API key 的本地网关，不经过隧道。
- HTTPS `3001` 提供 Workspace/SSO，HTTPS `8443` 提供鉴权只读数据；后者是同一网关的第二个监听。
- 私有 GitHub DevTunnel 仅转发 HTTPS `3001/8443`，不允许匿名访问。
- 本机生成自签名非 CA 证书；私钥不发送给 Portal，也不导入系统根证书库。

验收后只在用户 Home 写出 `0600` 的 `codey-machine-registration.json`，不自动注册 Portal。
用户自行导入，Portal 再验收真实隧道、TLS、SSO 与访问权限并绑定节点证书。
安装器不把本机验收冒充 Portal 已接入；connect token 的续期守护仍保留。

日常统一用 `codey start/restart/stop` 管理 LaunchAgents，`codey devtunnel start/stop`
单独管理隧道，`codey status` 查看状态，`codey doctor` 检查组件。
`codey export FILE.gz` 可按用户要求包含 TLS 私钥等秘密，不发送给 Portal；
恢复使用 `codey import FILE.gz --check` 后确认覆盖。系统 Keychain 登录缓存不迁移。
`codey update FILE.tgz` 只替换应用并保留工具、配置、身份及原启停状态，不部署后台更新器。

## 重跑与删除边界

同版本重跑核对包文件、身份、证书、服务归属和本机鉴权，刷新注册文件，不重新安装、
重启或调用模型，不换密钥。旧 Python/升级代理布局必须单独迁移；失败安装先审查私有状态。

`~/.config/codey-machine-macos/resources.json` 记录程序、LaunchAgents、CLI/PATH 项与保留目录。
尚无统一 `codey uninstall`；删除前复核实际归属，默认保留配置、数据、Codex auth/sessions，
不整删 runtimeRoot，不自动删除 Portal 记录或云端隧道。

模拟测试不证明真实 GitHub 登录、模型访问、Intel 硬件运行或睡眠/重新登录后的恢复能力。
