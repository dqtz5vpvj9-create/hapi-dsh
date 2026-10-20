# HAPI DSH

把 HAPI 的跨机器会话与 tmux 式工作区，组合进 **未经修改的官方 DSH Web**。

所有聊天仍出现在同一个侧边栏。窗格可以并排打开本机 DSH、远端 DSH 和 HAPI 原生 Codex 会话；聊天正文使用官方 Conversation。工作区负责窗口、分屏、会话路由和布局保存，执行与审批继续由会话原来的引擎负责。

这是普通 DSH 插件组合：主机安装 `hapi-dsh`，远端 DSH 主机安装包内独立的 `hapi-dsh-runner` Host 插件。没有 DSH fork、源码补丁、iframe 机器页面或另一套插件管理器。

## 固定版本

| 组件 | 本仓库使用的版本 |
| --- | --- |
| Node.js | 24 或更新版本；CI 固定 24.19.0 |
| pnpm | 11.28.5；官方 DSH 插件管理器要求 `pnpm` 位于 `PATH` |
| 官方 DSH | `@deepseek-ai/dsh@0.2.1-rc.2`，主机和 Runner 必须一致 |
| DSH 对照源码 | [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317) |
| HAPI 原生桥 | [`dqtz5vpvj9-create/hapi@0f8ef6970884c92fb2ddca3070be2ec56cb50333`](https://github.com/dqtz5vpvj9-create/hapi/tree/0f8ef6970884c92fb2ddca3070be2ec56cb50333) |
| 构建 HAPI 时需要 | Bun 1.4.0；运行本插件本身不需要 Bun |

所有直接 npm 依赖及锁文件均固定版本。不要把公开 npm 上同名 HAPI 的版本号当作上述原生桥源码版本。

## 从源码开始

先准备上述 HAPI 版本的 Hub 和至少一台 HAPI Runner。已有部署可以直接使用；从零构建见[安装指南](docs/install.md#准备-hapi)。本插件不会替换或迁移现有 HAPI 数据库。

```bash
git clone https://github.com/dqtz5vpvj9-create/hapi-dsh.git
cd hapi-dsh
npm install --global pnpm@11.28.5
npm ci
npm run build

node dist/cli.js init --hapi-url http://127.0.0.1:3006
```

在 Bash 中交互输入该 HAPI Hub 的访问令牌，避免把令牌写进命令历史：

```bash
read -r -s -p 'HAPI access token: ' HAPI_DSH_TOKEN
export HAPI_DSH_TOKEN
node dist/cli.js doctor
node dist/cli.js start
```

`init` 创建权限为 `0600` 的本地配置，并通过官方 DSH 命令复制一个新的 Web profile，再使用官方插件管理器安装本插件。默认 profile 为 `hapi`，浏览器入口为 `127.0.0.1:3080`。使用官方打印或打开的登录链接进入。

重新安装用 `install`；它保留已有 profile、模型配置和第三方插件。不要重复运行带 `--from-default-profile` 的官方命令覆盖正在使用的 profile。

## 分发给同学

从源码构建一个可安装包：

```bash
npm run check
node scripts/distribution-pack.mjs
```

将生成的 `artifacts/hapi-dsh-0.1.0.tgz` 和 `artifacts/SHA256SUMS` 一起分发。接收方在同一目录校验并安装：

```bash
sha256sum -c SHA256SUMS
npm install --global pnpm@11.28.5
npm install --global ./hapi-dsh-0.1.0.tgz
hapi-dsh --help
```

发布流程会把同一格式的安装包附到 GitHub Release，不自动发布到 npm。每位同学可以连接自己的 HAPI Hub，也可以作为一台配对的 DSH Runner 加入共同工作区。两种部署方式分别见下面和[安装指南](docs/install.md)。

## 加入远端 DSH 机器

主 Hub 需要一个 Runner 能访问的 HTTPS 地址。`public-url` 负责公布地址，`trusted-host` 明确允许官方浏览器信任检查通过的域名。反向代理的 WebSocket、Host、Cookie 和挂载路径要求见[远程访问](docs/install.md#远程访问与反向代理)。

在主 Hub 所在机器生成单独的机器凭据：

```bash
hapi-dsh pair \
  --name alice-workstation \
  --hub-url https://work.example.test \
  --output /private/alice-runner.json
```

把该 `0600` 文件通过可信渠道交给目标机器；它是配对凭据，不能进入仓库、公共下载或聊天截图。在目标机器安装相同插件包后运行：

```bash
hapi-dsh runner init --pairing-file /private/alice-runner.json
hapi-dsh runner start
```

Runner 使用独立官方 Web profile `hapi-runner`，只监听 `127.0.0.1` 的自动分配端口，主动反向连接 Hub。浏览器仍停留在统一工作区；远端的官方 API、事件、审批和插件连接通过这条连接转发。

撤销某台机器：

```bash
hapi-dsh revoke --machine-id MACHINE_ID
```

Hub 自动重新加载配对策略并断开该机器。断线时已发送请求的执行结果可能不确定，传输层不会自动重发操作。

## 使用工作区

侧边栏支持按引擎、机器及标题/目录筛选，归档、置顶和重命名通过所属 Host 执行。窗格与窗口只管理视图；关闭窗格不会终止原生 Codex 执行。

| 按键 | 操作 |
| --- | --- |
| `Ctrl B`，然后 `%` / `"` | 左右 / 上下分屏 |
| `Ctrl B`，然后 `c` | 新建窗口 |
| `Ctrl B`，然后 `x` / `z` | 关闭 / 放大当前窗格 |
| `Ctrl B`，然后方向键 / `o` | 移动焦点 / 下一个窗格 |
| `Ctrl B`，然后 `n` / `p` / `1`–`9` | 切换窗口 |
| `Ctrl B`，然后 `u` / `?` | 恢复关闭的窗口 / 查看快捷键 |

原生 Codex 的身份、队列和审批以 HAPI 原生桥为准。工作区提供以下原生操作，结果由原系统确认：

| 操作 | 行为 |
| --- | --- |
| 新建会话 | 选择实际 Runner、目录、Codex home、模型/推理强度，可创建 worktree；保存创建回执，延迟出现的原生 thread 可继续接入 |
| 原生设置 | 查询实际模型目录，调整模型、推理强度、权限、计划模式和可用服务级别；源尚未确认时保留待确认状态 |
| 原生分支 | 从当前线程或已提交消息对应的原生边界创建；持续查询原操作回执，原生子线程 ready 后再打开 |
| 执行计划 | 仅对原系统发布的计划提案调用原生执行接口；分别展示已提交、排队和已调用状态 |

关闭窗格、刷新页面或重连都不会自动重放不确定操作。创建回执、设置和分支的恢复区别见[原生 Codex 使用与恢复](docs/native-codex.md)。

## 架构与验证

每个远端 DSH Host 有自己的官方 Client Context、插件图和会话对象。统一侧边栏聚合目录，窗格交给该会话所属 Context 的官方 UI 渲染。这样插件仍在它所属机器的运行环境中执行，窗口也可以混排不同机器的会话。HAPI Codex 在主 Host 注册原生会话适配器，同样进入官方 Conversation。

详见[架构与扩展边界](docs/architecture.md)、[可复现验证](docs/validation.md)和[维护者分发流程](docs/distribution.md)。测试区分模型桩、真实传输和真实官方 DSH 进程。发布前仍需使用实际 HAPI、原生 Codex app-server 和模型凭据做部署验收；自动化 fixture 不能证明这项验收已经完成。

## 许可证与来源

本项目采用 [AGPL-3.0-only](LICENSE)，包含从 HAPI 适配的工作区与原生输入契约。官方 DSH 以未修改的 MIT 许可依赖使用。来源、固定提交和第三方声明见 [NOTICE](NOTICE)。相应版本完整源码保存在本仓库和 GitHub Release 对应标签中。
