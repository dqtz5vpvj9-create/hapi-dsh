# 安装与运行

首次使用从[快速指南](../QUICKSTART.md)开始。当前运行时只接入普通 DSH 和 HHPI 原生 Codex；技术包名仍为 `hapi-dsh`。旧 HAPI Hub 的连接、认证和来源注册不再属于启动配置。

本文说明正式 bundle 的安装顺序。安装后核对运行中的 Host、Runner 实际 release 和完整扩展集合；行为变更及验证范围见[发行说明](hhpi-retirement-release-notes.md)。升级保留原 profile、机器配对和原生执行身份。

## 先确定运行位置

| 角色 | 使用的配置 | 所有权 |
| --- | --- | --- |
| 工作区主 Host | `RuntimeConfig` | 浏览器登录、统一目录、布局和账号级应用服务 |
| 原 DSH Host / 配对 Runner | `RunnerConfig` | 原 DSH Session、插件和本机资源 |
| Codex 源 | Host 或 Runner 的 `sources` | 原 app-server、原 native thread 和源历史 |
| Codex 资源 owner | 同一真实源 OS 的 `sourceWorkspaces` | 该 OS 用户的文件、上传和 PTY |

安装官方 DSH `0.2.2-rc.1`、Node 24.x 与 pnpm 11.28.5。Host 与每个 Runner 使用相同正式 bundle 的全部扩展；只匹配 npm 版本号不够。[扩展说明](hhpi-extension-install.md)区分开发覆盖安装和正式发行安装。

## 主 Host 配置

`init` 创建私有配置和专用官方 Web profile；`--config-only` 只写配置，适用于 profile 已由完整 bundle 安装的情形。已有实例用 `install` 更新原 profile。

```text
hapi-dsh init --profile hapi --port 3080
hapi-dsh doctor
hapi-dsh start --no-open
```

默认配置位于 `$XDG_CONFIG_HOME/hapi-dsh/config.json`，未设置时为 `~/.config/hapi-dsh/config.json`。`--config` 或 `HAPI_DSH_CONFIG_FILE` 可指定另一文件；`DSH_HOME` / `--dsh-home` 控制 DSH 数据目录。服务、安装器和后续 CLI 使用同一 home、profile 与配置。

最小配置示例中的绝对路径需按本机替换：

```json
{
  "version": 1,
  "dsh": { "home": "/home/alice/.dsh", "profile": "hapi" },
  "server": { "host": "127.0.0.1", "port": 3080 },
  "federation": { "credentialsFile": "/home/alice/.config/hapi-dsh/runner-pairings.json" }
}
```

配置、邀请和配对策略保持私有普通文件；Unix 使用 `0600`，程序拒绝符号链接与过宽权限，写入沿用原子替换。`config` 只显示当前模式认可的配置；`runner config` 隐去配对凭据。官方 DSH 登录链接或 `server.loginPasswordFile` 属于浏览器准入，与机器配对是两条独立边界。

`doctor` 核对本机版本、构建、profile 与受管 release。它不会把远程源或浏览器未测状态标成成功；`--offline` 只用于本机检查。

## 远程访问与反向代理

默认监听回环地址。配置外部入口时设置 `server.publicUrl` 和 `server.trustedHosts`，例如：

```json
{
  "host": "127.0.0.1",
  "port": 3080,
  "publicUrl": "https://work.example.test",
  "trustedHosts": ["work.example.test:443"]
}
```

这是 `server` 字段内容。代理保留原 Host、正确转发 HTTP 与 WebSocket；路径前缀部署还需正确处理 Cookie Path、前缀重写与末尾斜线。HTTPS Cookie 保留 Secure。机器通道使用正式配对认证，不能要求 Runner 在握手前完成交互式网页登录。首次部署优先使用独立域名根路径。

也可配置 `server.tls.certFile` / `keyFile` 使用官方 HTTPS listener。路径必须绝对、证书必须受客户端信任，程序不会关闭 TLS 校验。已有配置直接更新这些字段后按发布流程重启，不重新初始化。

## 配对 DSH Runner

主 Host 创建单独的机器凭据：

```text
hapi-dsh pair --name lab-workstation --hub-url https://work.example.test --output PRIVATE_INVITATION.json
```

目标机器安装同版完整 bundle，初始化独立配置：

```text
hapi-dsh runner init --pairing-file PRIVATE_INVITATION.json --profile hapi-runner
hapi-dsh runner start
```

已用 bundle 安装 Runner profile 时，初始化加 `--config-only`。`RunnerConfig` 默认在 `~/.config/hapi-dsh/runner.json`，`--config` 或 `HAPI_DSH_RUNNER_CONFIG_FILE` 可改路径。Runner 监听本机 `127.0.0.1`，主动连接主 Host，原 DSH Cookie 留在所属机器。每个机器 ID 同时只有一个连接；未知结果的写操作不会在重连时自动重发。

已有 DSH Web 保留原 Session 与插件，使用 `runner init --config-only --dsh-home EXISTING_HOME` 生成配对配置，再把受管 runtime 的 `hapi-dsh/dist/runner/index.js` 挂到原 profile：

```yaml
- insert:
    - id: hhpi-existing-web-runner
      name: /absolute/release/runtime/node_modules/hapi-dsh/dist/runner/index.js
      config:
        configFile: /absolute/private/existing-runner.json
```

这种挂载不执行 `runner start`，不启动第二个 Host。原 Web 应符合固定版本、同版扩展及回环 listener 要求。需要重启时先检查原执行状态，不能用新建替代进程绕过原 owner。

`hapi-dsh revoke --machine-id MACHINE_ID` 撤销机器。配对策略损坏时会关闭连接并拒绝继续授权。重新配对先处理旧记录并保留原机器身份，不能仅改名字冒充迁移。

## 原生源与源 OS 资源

在真正承载 Codex 的 Host/Runner 私有配置中增加 `sources`，保留 machine/source/engine/nativeId。[原生接入](hhpi-native-attachment.md)给出已有 Unix socket、SSH/named-pipe bridge 和只读历史元数据 helper 的边界。

要支持新建后的任务在原生卸载后重开继续工作，不能只复制 `ownership: "shared"` 的最小示例。先核实该源与所有共享写者参与兼容的原生线程锁，再按[同机 app-server 配置](hhpi-native-attachment.md#同机-app-server)增加 `writerLock: "native"`；未核实则保留只读边界。Linux 与 Windows 源分别核对，更新显示服务配置不意味着可以重启或接管原生执行。

只有运行在源 OS 用户上下文的服务才可配置：

```json
{ "sourceWorkspaces": [{ "sourceId": "native", "provider": "local-system" }] }
```

这里 `native` 必须是该配置中真实的 Codex source ID。资源服务按请求的已认证来源授权，并以系统用户权限运行；它不是 Codex sandbox 的权限替身。中央 SSH RPC 转发不能注册成 Windows 本机资源服务。

Windows 需在 Windows 以原 machine ID 正式配对独立源 Runner，保留既有 Runner 的身份和原 DSH 入口；profile/data 分离，接同一个既有 Codex app-server。路由迁移可以改变 Host，但不能改变 source/engine/nativeId 或复制历史创建替代执行。升级后从实际 Runner 核对扩展集合、Session 0 单实例监督、来源在线及原 app-server 身份。开机恢复、回滚和界面能力按各自的实际验证记录确认。

## 升级、备份与旧配置

正式 bundle 在受管 release 中安装，保留完整源码、许可、旧 release、profile manifest/lock 和现有数据；遵守 idle、健康检查与回滚。[分发文档](distribution.md)说明具体入口。系统服务监督 CLI 的退出、重启及子进程生命周期，避免同一配置双实例；任务管理器显示 Ready 不能证明 Runner 正在运行。

备份私有配置、机器配对、原 DSH home/profile、HHPI 数据目录和浏览器原始存储。`DSH_HOME/profiles/PROFILE/data/hapi-dsh` 中的账号、布局、操作回执等数据随版本保留；回滚不回放写操作、不撤销原生任务结果。锁仍按真实进程状态处理，不能按文件年龄随意删除。

产品解析器明确拒绝旧 `hapi` 字段、旧来源注册和旧登录参数。离线迁移工具才可读取保留下来的旧数据。先核对原机器、native ID、精确别名和布局，再准备当前配置；旧草稿、附件、布局和回执的恢复不按新账号猜测归属，不自动发送。
