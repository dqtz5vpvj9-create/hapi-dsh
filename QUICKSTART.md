# 安装 HHPI 工作区

HHPI 让普通 DSH 与原生 Codex 会话进入同一个 DSH Web 工作区。只访问别人部署的工作区时，直接打开浏览器入口，无需本机安装。

从[公开发行页](https://github.com/dqtz5vpvj9-create/hapi-dsh/releases/tag/preview-20261111)下载完整预览版 bundle，并让 Host 和每个 Runner 安装同一份扩展集合。发行页同时提供 `SHA256SUMS`、安装说明与本次验证范围；[项目网站](https://dqtz5vpvj9-create.github.io/hapi-dsh/)展示实际界面与工作流。

## 安装完整 bundle

安装 Node.js 24.x、`pnpm@11.28.5` 和固定的官方 DSH `0.2.2-rc.1`。安装需要联网，不需要 Git 或 Bun。Windows PowerShell 若拦截 `.ps1`，使用 `npm.cmd` / `dsh.cmd`，无需放宽执行策略。

```text
npm install --global pnpm@11.28.5 @deepseek-ai/dsh@0.2.2-rc.1
```

下载 [`hapi-dsh-bundle-0.1.2-preview-20261111.tgz`](https://github.com/dqtz5vpvj9-create/hapi-dsh/releases/download/preview-20261111/hapi-dsh-bundle-0.1.2-preview-20261111.tgz)，按发行页的 `SHA256SUMS` 核对文件后，解压到长期保留的目录：

```text
tar -xzf hapi-dsh-bundle-0.1.2-preview-20261111.tgz
node package/dist/install.mjs install --profile hapi --role host
```

完整 bundle 包含 HHPI 与匹配的 DSH 源码扩展。安装器打印受管 release 目录；下文 `RELEASE` 指该目录，需替换为本机实际路径。保留此目录，profile 会引用其中的运行时。

```text
node "RELEASE/runtime/node_modules/hapi-dsh/dist/cli.js" init --config-only
node "RELEASE/runtime/node_modules/hapi-dsh/dist/cli.js" doctor
node "RELEASE/runtime/node_modules/hapi-dsh/dist/cli.js" start
```

默认 profile 是 `hapi`，默认入口是 `127.0.0.1:3080`。通过官方 DSH 打开或打印的登录链接进入，保持终端运行；`Ctrl+C` 退出 Web Host，不取消原生 Codex 任务。自定义 DSH home/profile 时，初始化参数必须与 bundle 安装一致。已有私有配置跳过 `init`，给后续 CLI 命令使用同一 `--config`。

技术命令名仍是 `hapi-dsh`，可使用已安装的命令 shim 代替上面的 `node .../cli.js`。单独的 `hapi-dsh-VERSION.tgz` 是插件包，普通 npm 安装不能证明完整 HHPI 扩展集合已经接通；同名 DSH rc 也不够。不要用临时 `npx --package URL` 代替长期安装位置。

## 接入原有会话

本机普通 DSH 会话由原 provider 提供。接入另一台 DSH 机器时，在主 Host 生成私有邀请：

```text
hapi-dsh pair --name workstation --hub-url https://work.example.test --output PRIVATE_INVITATION.json
```

在目标机器安装同一 bundle，使用其 CLI 初始化 Runner 配置，再启动：

```text
hapi-dsh runner init --pairing-file PRIVATE_INVITATION.json
hapi-dsh runner start
```

使用受管 bundle 的 Runner profile 时先安装 `--role runner --profile hapi-runner`，再对 `runner init` 加 `--config-only`，避免重复安装另一份依赖。现有 DSH Web 应在原 profile 挂载 Runner 插件，不再启动第二个执行 Host。[安装指南](https://github.com/dqtz5vpvj9-create/hapi-dsh/blob/main/docs/install.md)包含这条路径。

邀请与配置含机器配对凭据，只通过可信渠道传递。这里的 `--hub-url` 是 HHPI 主 Host 的地址，与已经退休的 HAPI Hub 接口无关。

Codex 则在原机器连接既有 app-server，并配置原生身份和历史元数据读取。需要文件、上传或终端时，在真实源 OS 的 Host/Runner 上显式注册资源 owner，详见[原生源接入](https://github.com/dqtz5vpvj9-create/hapi-dsh/blob/main/docs/hhpi-native-attachment.md)。连接历史不会启动另一个模型 owner。

## 升级、恢复与排障

- 升级完整 bundle，保留原配置、机器身份、profile 和至少两个先前 release；安装器的 idle/health/rollback 流程见[分发文档](https://github.com/dqtz5vpvj9-create/hapi-dsh/blob/main/docs/distribution.md)。不要重新 `init` 覆盖配置。
- `hapi-dsh doctor --offline` 检查本机版本与安装；它不证明源连接、浏览器或模型可用。
- Runner 断线时检查私有邀请所指入口、证书信任、配对撤销、固定版本和同一机器是否启动了重复实例。
- 原有配置含 `hapi` 或旧 `engine: dsh` 来源时，产品会明确拒绝启动。保留原文件，先做离线迁移与精确身份核对，再准备新配置；删除字段不等于数据已迁移。
- 旧浏览器草稿、附件和布局保留在原存储中。通过明确的本机恢复/导出入口处理，不会按新登录账号自动认领，也不会自动发送。

维护者另提供 `hapi-dsh-offline-recovery-VERSION.tgz`。将工作区“本机恢复”的完整导出保存在私有文件中，解压独立工具后运行 `node package/cli.mjs recover-browser --input PRIVATE_BROWSER_EXPORT.json --output NEW_PRIVATE_DIRECTORY`，可离线保留草稿和附件原始字节。该工具不安装为 DSH 插件，也不会自动恢复到当前账号；具体用法见[独立恢复说明](https://github.com/dqtz5vpvj9-create/hapi-dsh/blob/main/docs/offline-recovery.md)。

配置路径默认位于用户的 `.config/hapi-dsh`；可通过 `--config` 指定私有文件。登录链接、邀请、账号与会话数据不随软件包分发。
