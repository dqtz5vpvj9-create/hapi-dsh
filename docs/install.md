# 安装与运行

首次使用预构建 `.tgz` 的同学先看[快速安装指南](../QUICKSTART.md)，Windows、macOS 和 Linux 使用同一个包。下面补充 HAPI 准备、远程部署和高级配置。

## 准备 HAPI

本插件接入已经运行的 HAPI Hub。要保留本仓库所适配的原生 Codex 身份、队列、审批和恢复语义，Hub 与其 HAPI Runner 使用同一固定源码：

```bash
git clone https://github.com/dqtz5vpvj9-create/hapi.git
cd hapi
git checkout 55166cf8d87814ccfb383b538a8e8c55283bed81
bun install --frozen-lockfile
bun run build:single-exe
```

固定源码的 `package.json` 指定 Bun 1.4.0。单文件产物在 `cli/dist-exe/<平台目标>/hapi`；把本机对应产物放入你的可执行路径，再按该版本 HAPI 的说明启动 `hapi hub` 和 `hapi runner start`。HAPI Runner 通过自己的 `HAPI_API_URL`、`CLI_API_TOKEN` 连接 HAPI Hub。Codex 登录、Codex home 和工作目录仍由 HAPI Runner 管理。

现有 HAPI 部署无需重新构建，前提是实际运行的二进制来自上述提交。HAPI 的公开 API 不报告源码 SHA；`doctor` 能验证认证与 API 连通性，不能替你证明部署来源。

## 两个 Hub / Runner 的职责

| 进程 | 负责什么 | 凭据 |
| --- | --- | --- |
| HAPI Hub | 原生 Codex 的机器目录、历史、队列与控制 API | HAPI 访问令牌及其签发的 Web JWT |
| HAPI Runner | 在指定机器运行 Codex 原生 app-server / 原生桥 | 现有 HAPI Runner 配置 |
| HAPI DSH 主 Host | 官方 DSH Web、统一工作区、HAPI 适配器、DSH 机器目录 | 官方 DSH 浏览器登录，加本地 HAPI 访问令牌 |
| HAPI DSH Runner | 官方 DSH Web 的完整远端 Host 和反向传输 | 每台机器独立的配对凭据 |

同一机器可以运行两种 Runner。它们并不互相替代。仅使用 HAPI 原生 Codex 时不必在该机器额外安装 DSH Runner；希望该机器承载 DSH 会话和 DSH 插件时才安装。

## 主 Host 安装

需要 Node.js 24 或更新版本，以及 `PATH` 中可执行的 pnpm。固定官方 DSH 的 `dsh plugin` 命令通过 pnpm 管理 profile 依赖；本项目沿用上游固定版本 pnpm 11.28.5。主 Host 与 DSH Runner 所在机器都需要这一安装前提。以下用源码入口演示；从 `.tgz` 全局安装后，将 `node dist/cli.js` 换为 `hapi-dsh`。

```bash
npm install --global pnpm@11.28.5
npm ci
npm run build
node dist/cli.js init \
  --hapi-url http://127.0.0.1:3006 \
  --profile hapi \
  --port 3080
```

默认配置路径是 `$XDG_CONFIG_HOME/hapi-dsh/config.json`；没有 `XDG_CONFIG_HOME` 时使用用户配置目录中的 `hapi-dsh/config.json`。可用 `--config /absolute/path/config.json` 或环境变量 `HAPI_DSH_CONFIG_FILE` 指定路径。DSH 数据位置来自 `DSH_HOME`，否则使用默认用户 DSH 目录；`--dsh-home` 可显式指定。

配置里 `hapi.id` 在首次创建时随机生成，它代表稳定的 HAPI Hub 身份。修改 Hub 地址或轮换访问令牌时保留这个 ID；不要从地址或令牌重新生成。旧配置缺少该字段时会在锁保护下自动持久化一个随机 ID。

输入令牌、检查、启动：

```bash
node dist/cli.js login
node dist/cli.js doctor
node dist/cli.js start --no-open
```

`login` 交互输入不回显，并保存到已有私有配置；自动化可使用 `login --stdin`。已有环境变量仍优先于保存值。命名空间使用 HAPI 所接受的访问令牌形式。插件先向 `/api/auth` 交换 Web JWT，随后使用 JWT 访问会话和机器目录；不会把 CLI 令牌当作现成 JWT。

`doctor --offline` 只检查本机版本、产物和 profile；`doctor --json` 提供结构化结果。缺少在线 HAPI Runner 会给出提示，原生会话创建需要 Runner 真正在线。

进入工作区后，通过统一的新建入口选择 DSH 或原生 Codex。Codex 的机器、home 和模型来自 HAPI Runner；创建请求被接收后，原生身份元数据可能稍后才出现。界面会保留创建记录，重开窗口或重启主 Host 后可以继续查询和接入原来的 thread，不需要重新创建。原生设置、消息分支、计划操作和不确定结果的恢复见[原生 Codex 使用与恢复](native-codex.md)。

## 本地配置

下面是字段示例，路径和地址应替换为自己的值。它不包含令牌：

```json
{
  "version": 1,
  "dsh": {
    "home": "/home/alice/.dsh",
    "profile": "hapi"
  },
  "hapi": {
    "id": "2aef3072-69d0-4407-9ab7-d97fd742db13",
    "url": "http://127.0.0.1:3006",
    "tokenEnv": "HAPI_DSH_TOKEN"
  },
  "server": {
    "host": "127.0.0.1",
    "port": 3080,
    "publicUrl": "https://work.example.test",
    "trustedHosts": ["work.example.test:443"]
  },
  "federation": {
    "credentialsFile": "/home/alice/.config/hapi-dsh/runner-pairings.json"
  }
}
```

配置、Runner 邀请和配对策略必须是普通文件；程序拒绝符号链接以及 Unix 上允许组或其他用户读取的权限。新建文件使用 `0600`，更新采用原子替换，并在支持目录同步的 Unix 平台同步目录项。可在私有配置的 `hapi.token` 中存储访问令牌；`hapi.tokenEnv` 指定的环境变量优先。令牌不会进入 Cordis 配置行、浏览器配置或命令参数。

`hapi-dsh config` 和 `hapi-dsh runner config` 仅输出脱敏配置。需要绝对路径的字段包括 DSH home、配对策略文件以及 TLS 证书/密钥文件。

## 远程访问与反向代理

主 Host 默认仅在回环地址监听。给主 Host 配置外部入口时，两项设置各司其职：

```bash
hapi-dsh init \
  --hapi-url http://127.0.0.1:3006 \
  --public-url https://work.example.test \
  --trusted-host work.example.test:443
```

已有配置直接修改 `server.publicUrl` 与 `server.trustedHosts`，再重启，不要重新执行 `init`。需要多个可信域名时在 JSON 中增加数组元素。域名不带端口表示允许该域名的任意端口；带端口则限定该 authority。

DSH 的[官方代理说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/guide/public-deployments.md)要求代理保留浏览器的 `Host`、转发 HTTP 和 WebSocket 升级，并在使用路径前缀时去掉该前缀、重写 Cookie Path、将裸前缀重定向到以 `/` 结尾的入口。HTTPS 代理还要为外部 Cookie 设置 `Secure`。该要求同样适用于 `/hapi-dsh/*` 机器路由和 Runner 反向 WebSocket。

首次部署建议使用独立域名的根路径，以减少前缀和 Cookie 重写配置。Runner 邀请的 `hubUrl` 必须是 Runner 能访问的相同入口，不能使用另一台机器的 `127.0.0.1`。代理不能要求 Runner 在 WebSocket 握手前经过交互式网页登录；机器认证使用配对 Bearer 凭据。

也可以使用官方 DSH 自带的 HTTPS listener：

```bash
hapi-dsh init \
  --hapi-url http://127.0.0.1:3006 \
  --host 192.0.2.10 \
  --public-url https://work.example.test:3080 \
  --trusted-host work.example.test:3080 \
  --tls-cert /private/tls/fullchain.pem \
  --tls-key /private/tls/privkey.pem
```

把文档示例 IP 替换为本机实际接口 IP。证书必须由客户端信任并覆盖访问名称；本插件不签发或续期证书，也不关闭 TLS 校验。证书更新后重启官方 listener。官方 DSH 登录链接包含启动凭据，只提供给预期的工作区使用者。

## DSH 机器配对、撤销与恢复

主 Host 上创建独立机器身份和凭据：

```bash
hapi-dsh pair --name lab-workstation \
  --hub-url https://work.example.test \
  --output /private/lab-runner-invitation.json
```

默认机器 ID 随机生成；需要固定人类可读 ID 时可用 `--machine-id lab-workstation`。ID 使用字母、数字、点、下划线或连字符，不能复用仍然配对的 ID。主机策略文件只保存凭据的 SHA-256 摘要；原始凭据只写入私有邀请。

在目标机器安装同版本 `.tgz`，私下传入邀请，并初始化：

```bash
hapi-dsh runner init \
  --pairing-file /private/lab-runner-invitation.json \
  --profile hapi-runner
hapi-dsh runner start
```

Runner 的配置默认是 `hapi-dsh/runner.json`，可通过 `--config` 或 `HAPI_DSH_RUNNER_CONFIG_FILE` 改变。它保存机器 ID、名字、Hub 地址、独立 DSH home/profile 及私有凭据。安装完成后邀请不再参与运行，可以由操作者安全移除。

Runner 只监听本机回环地址，Hub 不需要向 Runner 打开入站端口。原始 DSH Cookie 留在 Runner 进程内；Hub 凭据、主 Host Cookie 和 HAPI 令牌不进入远端浏览器包。协议握手严格要求同一 DSH 版本；同一机器身份同一时刻仅允许一个连接。

撤销使用 `hapi-dsh revoke --machine-id ID`。文件监控通常立即生效，另有最多 15 秒的定时刷新；配对策略损坏时 Hub 会关闭现有 Runner 连接并拒绝继续授权。重新配对之前需先撤销旧记录，再生成新的邀请，并显式更新接收方私有配置；`runner init` 不覆盖已有文件。

连接恢复会重新建立传输并同步目录。未完成请求返回连接失败；如果远端可能已执行，不会盲目自动重试。会话本身仍属于远端官方 DSH，Runner 不复制或回放引擎执行。

### 接入已经运行的 DSH Web

统一列表只包含主 Host 和已配对的 Host；同机另一个 DSH Web 的会话不会自动进入列表。要保留原 Web 的执行归属和插件配置，在它的现有 profile 中挂载 Runner 插件，不要新开一个指向相同数据目录的 DSH 进程。

先用 `hapi-dsh pair` 为现有 Web 生成独立邀请，再执行 `hapi-dsh runner init --pairing-file PRIVATE_FILE --config /absolute/existing-web-runner.json --dsh-home EXISTING_HOME --config-only`。这一步只生成私有配对配置；不要执行 `runner start`。在原 Web profile 的 `cordis.patch.yml` 追加以下配置，将两个路径替换为实际安装位置：

```yaml
- insert:
    - id: hapi-dsh-existing-web-runner
      name: /absolute/hapi-dsh/dist/runner/index.js
      config:
        configFile: /absolute/existing-web-runner.json
```

插件直接使用该 Web 的官方连接、客户端模块和监听服务；配置中的 `dsh.profile`、`server` 仅供独立 Runner 启动器使用，在这种挂载方式下不启动新实例。原 Web 必须使用固定 DSH 版本并监听 `127.0.0.1`。认证仍由原 Web 与配对凭据共同控制，原始 Web 登录令牌不传给浏览器。

配置通常通过官方 HMR 生效。如果插件管理接口报告 `restart-required`，先确认原 Web 没有正在执行的会话，再正常重启原进程。接入后，通过主 Host 的机器目录及该机器路由下的 `hapi-dsh/bootstrap`、`api/session/list` 检查连通性和原会话 ID；界面由用户手测。

## Profile 与插件管理

`init` 对新 profile 执行官方的 `--from-default-profile web`，随后执行 `dsh plugin ... add link:...`。`install` 对既有 Web profile 只安装 bundle，并通过 `--dump-config` 验证结果。现有目录缺少 manifest 或 profile 类型不兼容时会停止，保留原始内容供人工修复。

主 profile 包含根 bundle `hapi-dsh`；Runner profile 只安装 `dist/runner` 中的 `hapi-dsh-runner`。后者故意没有 `dsh.client`，因此不会在每台 Runner 重复安装统一工作区 shell。第三方插件继续通过所属机器的官方 DSH 插件机制安装和管理。

从源码或全局 npm 路径安装后，profile 使用 link 指向该位置，运行期间不要删除或移动包目录。升级包后运行相应的 `install` / `runner install` 再重启。DSH 固定版本有变化时需要协同升级所有主 Host 和 Runner，并重新执行真实官方集成测试。

## 持久运行与数据备份

可用系统服务管理器执行 `hapi-dsh start --no-open --config /absolute/config.json` 或 `hapi-dsh runner start --config /absolute/runner.json`。服务使用 Node 24 的固定可执行路径，并从服务私有环境文件或 `0600` 配置提供凭据。CLI 转发 SIGINT/SIGTERM 和退出码，不自行守护或隐藏子进程失败。

需要保留的数据：私有配置及稳定 ID、配对策略、完整 DSH profile 数据，以及原 HAPI Hub/Runner 的数据。插件自己的布局、原生投递与审批状态、创建/设置/分支/计划回执在 `DSH_HOME/profiles/<profile>/data/hapi-dsh`。删除回执会丢失工作区对未确定操作的恢复依据；备份与迁移时完整保留该目录和原 HAPI 数据。不要把 DSH 布局写入 HAPI 只接受其原生会话 ID 的工作区 API。

配置迁移、安装、配对和布局写入使用官方 `withFileLock` 协调同机进程。锁记录的 PID 确认已退出时可自动接管；仍存活、无法确认或记录不完整时等待后报错。不要仅因文件旧就删除锁，也不要把同一 DSH home 放在跨机器或跨 PID namespace 共享写入的网络目录。残缺锁或 PID 复用需先由操作者确认没有相关进程再清理。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| `doctor` 报 DSH 版本不匹配 | 使用包自带的固定 DSH；移除错误的 `dsh.command` override |
| `init` 报配置已存在 | 用 `install` 重试安装；要新实例时指定另一配置文件和 profile |
| 远程浏览器 API 返回 403 | 校验 `trustedHosts`、代理保留的 Host、Origin 和挂载前缀 |
| HAPI 认证 401 | 确认令牌和命名空间、私有文件/环境变量来源；不要把 Web JWT 当作长期 CLI 令牌 |
| 原生会话只能看历史 | 检查 HAPI Runner 在线、native connection 为 attached、Codex 原生身份完整 |
| 新建会话停在 accepted / indeterminate | 打开创建记录继续检查；已有来源会话时只等待原生身份，不再创建另一个会话 |
| 原生设置、分支或计划结果不确定 | 检查原操作回执与原生状态；不要以刷新页面或新建操作 ID 代替结果确认 |
| DSH Runner 一直断开重连 | 检查邀请 URL、HTTPS 信任、配对是否撤销、固定 DSH 版本及机器 ID 是否被另一进程占用 |
| 窗口状态保存冲突 | 选择界面提供的本地或服务端布局；不会静默覆盖并发修改 |

验证分层和已知验收边界见[验证文档](validation.md)。
