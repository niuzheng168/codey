# Codey Linux 一键节点接入

活动入口是 `skills/config-new-codey-machine/SKILL.md`，Linux x64 只执行：

```bash
bash scripts/install.sh
```

安装包可并行复制到多台机器，包内没有节点 token。运行时在目标机生成独立身份，
最后只上传 `~/codey-machine-registration.json`。

## 网关默认设置

`codey start`、`codey gateway` 和 `codey auth` 在加载网关前启用 Codey 模式。
该模式下 `useResponsesApiWebSocket` 默认 `false`，新配置和缺少该字段的已有配置
都会使用此默认值；已有的显式 `true` / `false` 优先，不会被默认值覆盖。
安装器不再重复写入该字段，也不影响 Workspace 自身的 WebSocket。

## 固定流程

1. 从 Microsoft 官方源下载并校验 DevTunnel，使用 GitHub device code 登录，配置私有 HTTPS `3001/8443`。
2. 停止旧 copilot-api，安装包内新版本，覆盖配置并启动。
3. 停止旧 Codex，从 OpenAI 官方 installer 更新或安装 latest，覆盖模型配置并做真实请求。
4. 停止旧 CloudCLI，安装包内新版本，启动并通过 CloudCLI 的 Codex SDK 做真实请求。
5. 安装包内签名 updater。
6. 启用 systemd 用户服务、DevTunnel renew timer 和 user linger，验证异常退出自动恢复。

## 包内容

只有一个真正的 npm 应用包 `codey-<version>.tgz`，主包定义在
`packages/codey/package.json`。两份 submodule 是构建输入，不再是两个
独立安装的 npm 应用，也不是 `codey` 的 npm dependencies。

```text
package/
├── package.json          # name: codey；唯一应用 manifest 和 bin
├── npm-shrinkwrap.json   # 统一生产依赖锁
├── bin/codey.mjs         # 唯一 CLI
├── lib/                 # CLI 和内联的 Codex SDK JS
├── dist-server/         # Workspace 后端
├── dist/                # Workspace 静态前端
├── gateway/             # 模型网关后端
├── pages/               # 网关静态页面
├── updater/             # 签名更新器
└── codey-build.json      # 源码版本与构建指纹
```

`assets/manifest.json` 使用 schema 2、`name: codey` 和
`dependencyMode: npm-codey-package`，记录 npm 包的 SHA-256、Codey 版本和统一
release ID，同时保留两份源码各自的 commit/version 以便追溯。安装器只执行
一次 `npm install --global --prefix <私有 release> <包内 tgz>`，并在停止旧服务前
检查入口、构建指纹、共享依赖和 SQLite/PTY 原生模块。

两个服务的 `WorkingDirectory` 都指向同一个 `lib/node_modules/codey`。
它们共用 Node、主 manifest 和依赖树，入口分别为 `codey workspace`、
`codey gateway start`，没有嵌套的应用包或第二棵应用依赖树。
两个源码 submodule、现有服务名、端口和数据路径不变。

Node、Codex、DevTunnel 不进入 ZIP；目标机从各自官方源下载。CloudCLI 通过
`CODEY_CODEX_EXECUTABLE` 使用同一份官方 Codex，不携带 Codex native runtime。
锁定版 Codex SDK 的 JS 和许可证在构建阶段内联为 `#codey/codex-sdk`；
避免其 npm 依赖再引入第二份 Codex。其他第三方依赖由 npm 按统一 shrinkwrap 安装。

外层 `config-new-codey-machine.zip` 保留 Skill、安装脚本和统一运行包，兼容
现有 Portal 下载入口。也可独立安装标准 npm 包：

```bash
npm run codey:build -- --output artifacts/codey-npm
npm install --global ./artifacts/codey-npm/codey-0.1.0.tgz
codey --version
codey start
```

公共 npm registry 的 `codey` 名称已被其他项目使用；没有取得名称权限前，
只分发此 `.tgz` 或使用明确配置的私有 registry，不要执行公共源的
`npm install -g codey`。本地构建不执行任何 npm publish。

## 整包升级

新节点的 updater 报告 `layout: npm` 及 `components.codey`，只接受一个 `codey`
组件的签名发布。升级按 shrinkwrap 准备统一依赖，停止两个服务，原子替换一个
包目录，再启动和验收两个服务；失败时整体回滚代码与构建标记，不回滚用户数据。
旧节点继续使用原来的分组件协议，两种布局互相拒绝不兼容的发行版。
新发行目录的 `codey-package.json` 可以直接交给 `scripts/publish-node-update.mjs`，
但仍须提供独立的 `validation.json` 或 `report.json` 验收证据才可签名。

## 数据边界

脚本可以使用 `sudo` 停止旧服务、释放固定端口和启用 linger，但不删除整个 Home。
`~/.codex/auth.json`、`~/.codex/sessions/` 和其他用户文件保留；
`~/.codex/config.toml`、`~/.codex/models.json` 以及 Codey 服务配置按当前版本覆盖。

Windows PowerShell 和 macOS 版本暂不发布；等 Linux 实机流程稳定后再按同样六步迁移。

## 独立发布

完整 Skill ZIP 发布到共享存储的 `machine-bundles/packages-v2/`，使用不可变
`releases/<releaseId>/` 和原子 `active.json`。Portal 只读取并流式返回完整 ZIP，
不再从镜像内文件拼装安装包。

- 更新 Portal：只部署 ACA 镜像，不修改下载包 `active.json`。
- 更新下载包：运行 `scripts/publish-machine-skill.py`，不重启 ACA 或节点服务。
- 首次迁移到 npm 布局时，先部署支持 `codey` 整包更新的 Portal，再发布新的
  安装 Skill；Portal 仍兼容旧 ZIP 与旧节点。不要只发布新包而保留不认识 npm
  布局的旧 Portal 更新服务。

构建完整 Skill：

```bash
npm run machine:build -- --output <新目录> \
  --portal-origin <HTTPS-origin> --updater-public-key-file <公钥文件>
```

构建器生成 `codey-<version>.tgz`、`codey-package.json`、`manifest.json` 和完整
Skill ZIP。发布器会检查 npm 包内唯一的应用 manifest、统一 shrinkwrap 和编译入口，
不再接受旧的三个分包或仅改名的普通 tar。已发布 ZIP 和 Portal 外层 manifest
仍保留，不迁移或覆盖旧下载内容。
