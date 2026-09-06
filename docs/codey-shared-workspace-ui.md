# Workspace 前端统一发布

状态：2026-09-06 已实现并完成本地验证，**尚未切换生产 Portal**。
线上目前仍使用四节点静态副本；本次没有更新 ACA、VM、模型或生产存储。

## 改变了什么

```text
浏览器 /cloudcli/<node>/
  → Portal 登录 + 节点归属检查
  → Portal 读取共享存储中的同一份前端模板
       ├─ JS/CSS/字体/图标：/cloudcli-ui/<release>/…
       ├─ 节点启动配置：/cloudcli/<node>/_ui/runtime.js
       ├─ PWA manifest、service worker：仍按节点限定 scope
       └─ API / SSE / WebSocket / 终端：继续代理到相应 VM

手动语音转写和润色 → 仍由 Portal 的 voice gateway 处理
```

发布单位从“四份节点构建”改成“一份版本化前端包”。节点 ID 不进入构建参数；
运行时由已经通过鉴权的节点路径设置 API 和 Router 的前缀。

- 节点文件、Git、进程、会话、草稿数据库和终端仍留在各自 VM。
- 共用的是页面代码，不是用户数据或节点凭据。
- Portal 外层页面仍按原方式发布一次；本流程负责 CloudCLI 工作区前端。
- 修改节点 API/后端能力仍需要更新相关节点，本流程不承诺任意前后端版本兼容。

## 版本和存储

所有 Portal 副本必须挂载**同一个持久目录**，例如现有 Azure Files：

```text
/data/cloudcli-ui/
  .codey-ui-store.json
  active.json
  releases/
    ui-<版本一>/
      ui-package.json
      index.html
      assets/…
      icons/…
      manifest.json
      sw.js
    ui-<版本二>/…
  history/<发布事务>.json
```

- `ui-package.json` 包含文件尺寸、SHA-256、前端版本和 API contract。
  不包含 `.env`、节点配置、私钥、源码映射、节点后端或聊天内容。
- 文件上传并校验后，最后写入包清单，再原子替换 `active.json`。
  不会先删除旧入口，也不覆盖已有版本的不同内容。
- Portal 每次获取页面时重新读取当前版本指针，无需重启服务或更换镜像。
- 旧版本不自动删除；旧标签页的懒加载资源、刷新前的会话及回滚仍然可用。
- 发布工具采用独占写锁和 `--expected-current` 检查。崩溃遗留锁不会自动抢占；
  必须先确认旧发布进程已经停止，再由管理员处理。所有发布者都必须遵循此协议，
  不应绕过工具直接修改存储中的指针或版本目录。
- 如果切换阶段发生网络错误，服务端可能已经完成切换；先核对当前版本再重试，
  不能仅凭命令失败就认定旧版本仍然生效。

## 首次迁移：只需改一次 Portal

1. 在发布机器安装 CloudCLI 锁定的前端依赖，并运行本项目测试。
2. 复制 `config/workspace-ui-publish.example.json` 为
   `config/workspace-ui-publish.json`，填写已有 subscription、resource group、
   storage account、share 和 `cloudcli-ui` 子目录。配置文件不保存密钥。
3. 先发布第一份前端包到该目录：

   ```sh
   npm run workspace:publish -- \
     --config config/workspace-ui-publish.json \
     --apply --expected-current none
   ```

4. **单独授权并发布一次新的 Portal 后端**，配置：

   ```dotenv
   PORTAL_CLOUDCLI_UI_ROOT=/data/cloudcli-ui
   ```

   路径必须对应第 3 步的 share 子目录。无需修改或重启四个节点。
   Docker 镜像不安装前端依赖，也不携带某个节点专属的前端产物。
5. 经登录验证两个以上 Workspace：入口的 `X-Codey-Ui-Release` 相同，
   JS/CSS 地址相同，但 `_ui/runtime.js`、API、WebSocket 和 worker scope
   各自属于目标节点；再核对未登录和跨账号节点访问被拒绝。

保留了迁移开关：未配置或显式设空 `PORTAL_CLOUDCLI_UI_ROOT` 时，继续走原来的
VM 前端代理。开关已经启用但包缺失/损坏时返回 503，不悄悄退回某台机器的旧界面。

## 此后的日常发布：一个命令、一个目标

```sh
npm run workspace:publish -- \
  --config config/workspace-ui-publish.json \
  --apply --expected-current <当前版本>
```

该命令在隔离的源码快照上运行前端测试、**构建一次**，随后校验和发布一个包。
不会读取项目 `.env` 参与前端构建，不调用模型，不执行任何 VM Run Command，
也不重启 Portal、CloudCLI 或 copilot-api。

`--expected-current` 是前一次发布报告中的 `active.release`，用于拒绝过时发布。
也可以通过已登录的 `/cloudcli/<自己节点>/_ui/version.json` 查看当前前端版本。

默认是 dry-run：省略 `--apply` 时只构建/验证并显示计划，不请求 Azure、不改目标。
已有经过验证的包可跳过重复构建：

```sh
npm run workspace:build -- --test

npm run workspace:publish -- \
  --config config/workspace-ui-publish.json \
  --package dist/cloudcli-ui/<版本>
```

确认计划后，对同一个包追加 `--apply --expected-current <当前版本>`。

Azure 发布需要已登录的 `az` 和 `azure-storage-file-share`。启动器优先使用 Linux
Azure CLI 自带的 Python，也可用 `CODEY_DEPLOY_PYTHON` 指定部署 venv。
这些依赖只在发布机器需要，Portal 本身没有新增运行时依赖。
存储 key 由 Azure CLI 读取后仅在内存使用，不写入参数、URL、配置或日志。
工具不创建 storage account、share、模型或其他云资源。

## 本地演练和回滚

对本地独立目录使用相同的发布校验、写锁和原子切换协议：

```sh
npm run workspace:publish -- \
  --package dist/cloudcli-ui/<版本> \
  --local /tmp/codey-preview/cloudcli-ui \
  --apply --expected-current none
```

回滚不重建前端，用保留的旧包切换回去：

```sh
npm run workspace:publish -- \
  --config config/workspace-ui-publish.json \
  --package dist/cloudcli-ui/<旧版本> \
  --apply --expected-current <当前版本>
```

工具会核对存储中旧版本的内容，没有差异就只切换入口；不会覆盖不同内容，
也不会删除当前版本。首次迁移需要退回旧托管方式时，可将 Portal 的
`PORTAL_CLOUDCLI_UI_ROOT` 显式设空；节点的旧前端副本仍保留。

## 隔离、兼容和浏览器行为

- 共用资源依然经过 Portal 登录检查；节点页面、运行时配置、manifest、worker
  还必须通过同样的节点归属检查。共享缓存里只有不可变页面代码。
- HTML/运行时配置使用 `private, no-store`；带版本的静态资源可私有缓存。
  退出/撤权仍由原有机制阻止 API 和 WebSocket，不能收回已经下载的页面代码。
- Router basename 与 API/终端前缀来自运行时节点配置，不能从共享 JS 的地址推断。
- service worker 仍位于每个节点的 `sw.js`，不扩展到整个 Portal；
  清理缓存及点击通知只影响自己的节点。
- 草稿和偏好的浏览器副本以节点路径命名。旧的无节点缓存无法可靠判断归属，
  因此保留原始数据但不自动采用；首次刷新从相应节点后端加载已保存数据。
  未同步内容应先在旧标签页保留/复制。按账号共享的语音服务和语言偏好不受影响。
- 旧的 `/cloudcli/<node>/assets/…` 请求仍代理到 VM，确保迁移前标签页可继续工作。
  新版页面和资源由 Portal 提供，日常发布不再更新这些 VM 副本。
- 包标注 `cloudCliVersion` 与 `apiContract: 1`。本次沿用现有节点 API，不新增
  VM 接口；这不是自动探测或兼容任意后端版本的机制。未来变更接口时，发布前
  仍需验证目标节点版本，并按需升级节点后端。

## 验证

```sh
npm run check
npm run check:workspace
npm test
python3 -I -S test/test_cloudcli_ui_publish.py
cd cloudcli
NODE_ENV=test npm run test:client
npm run typecheck
npm run lint
```

本次还用真实生产构建，在本地 Portal 和合成节点上完成浏览器验证：
宽屏与 375px 页面加载同一入口 JS；深层会话路由、节点 WebSocket、PWA scope、
草稿/偏好缓存隔离、运行中版本切换和旧资源保留均通过。没有访问真实聊天或 VM。

- Portal 120 项测试、前端 451 项测试、发布器 9 项离线测试通过；
  既有 secret helper 的 8 项测试也通过。
- 前端类型检查、生产构建和本次修改文件的 lint 通过。初次全仓库 lint 检查曾有两个
  既有后端 `boundaries(no-unknown)` 错误，位于 `auth.middleware.ts` 和
  `websocket-auth.service.ts`，已通过下述后续配置修复消除，未修改这两个文件。
- Azure 目标执行了零请求 dry-run；真实 Azure 上传/首次迁移尚未执行。
- 工作区中并行的 Codex 会话后端改动被保留，不包含在前端包中。

本机完整验证记录为
`artifacts/shared-workspace-ui-20260906/validation-summary.json`；
同目录保留构建、测试、浏览器日志和截图。

### 后续 lint 修复（2026-09-06）

两个错误均源于 `.oxlintrc.json` 未登记 `server/shared/index.ts` 公共入口。
现已仅补充该入口的元素定义，没有关闭规则、放宽未知文件检查或修改认证逻辑。
复验全量 lint 为 0 errors、127 条原有 warnings；前后端类型检查、
44 项认证/WebSocket 测试和 7 项正反向模块边界验证全部通过。
记录位于 `artifacts/backend-lint-fix-20260906/`。本修复仅影响开发检查，
无需部署或重启节点；共享 UI 的首次迁移仍待执行。
