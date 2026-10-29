# HHPI / HAPI DSH

HHPI 的目标是为 **DSH Web** 提供跨机器的 Agent 远程接入，让 DSH、Codex 等会话进入同一个工作区。HAPI 是可参考、复用或修改的实现，不限定 HHPI 的协议、内部架构或部署方式，也不要求接入 HAPI Web。目标边界见 [HHPI 远程接入架构](docs/hhpi-remote-access-design.md)。

所有聊天仍出现在同一个侧边栏。窗格可以并排打开本机 DSH、远端 DSH、HAPI 原生 Codex 和其他 HAPI 引擎会话；完整聊天界面使用官方 Conversation，包含会话头部、视图切换、消息、输入框及各处插件扩展点。工作区负责窗口、分屏、会话路由和布局保存，执行与审批继续由会话原来的引擎负责。

本仓库当前包名仍为 `hapi-dsh`，实现包含既有 HAPI 桥和远端 DSH Runner，使用项目维护的 DSH 扩展；目标架构尚未全部实现。主机安装 `hapi-dsh`，远端 DSH 主机安装包内独立的 `hapi-dsh-runner` Host 插件。下文 HAPI Hub 的安装步骤描述当前实现，不表示 HHPI 长期必须依赖 HAPI 部署。

完整替代的对照基准是原 HAPI 的实际功能和使用体验。已实现能力、尚有差距的行为及对应证据逐项记录在[功能与 UX 对照表](docs/feature-parity.md)；当前源码不能据此宣称已完成全部替代。

## 快速安装（Windows / macOS / Linux）

同学使用预构建包即可，无需克隆或编译源码。安装 Node.js 24+，取得 `hapi-dsh-0.1.2.tgz` 后执行：

```text
npm install --global pnpm@11.28.5 ./hapi-dsh-0.1.2.tgz
hapi-dsh init --hapi-url http://127.0.0.1:3006
hapi-dsh login
hapi-dsh doctor
hapi-dsh start
```

把示例地址换成自己的兼容 HAPI Hub。`login` 隐藏令牌输入并保存到私有配置，后续直接 `hapi-dsh start`。Windows PowerShell 若拦截 `.ps1`，使用 `npm.cmd` / `hapi-dsh.cmd`。无管理员权限的安装、升级和排障见[给使用者的快速指南](QUICKSTART.md)。只访问已有部署的同学无需安装，直接打开工作区网址即可。

## 工作区与官方插件

文件、文档和终端属于插件视图。工作区保存它们真实的会话身份、资源地址、标签实例和导航参数；官方 Files、DocumentPreview、Terminal 负责显示。文件读取、写入和终端输入通过公开 provider 转发到这个窗格所属的原 HAPI Runner。普通 DSH 会话继续使用原 provider。

支持将官方右栏标签放到独立窗格，与聊天并排使用。切换窗口会保留已经挂载的视图；移动和关闭工作区窗格不会结束源会话或 PTY。插件可通过公开 `hapiWorkspacePane` 获取自己的焦点、可见性及资源导航能力，并登记未保存内容的关闭保护。

源文件的编辑、冲突核对、上传、文件管理、搜索及 Git diff 通过官方公共 slots 扩展。文档保留官方解析和预览能力；HAPI 独有的 artifact 和 Markdown 本地图片增加来源适配，避免把 Runner 路径解释成 Hub 路径。采用 machine TerminalHost 的终端保留官方渲染器及源控制租约、输出序号和输入回执。

旧 HAPI 布局的 SessionTerminal 同样使用真实官方 `ClientTerminals` 和 Terminal body，通过独立的公开标签类型保留原 source/terminal ID、10,000 行滚动缓冲、触控栏、宏和共享字号。旧源协议是 attach-or-create，且没有逐条输入 ACK；适配器明确保留这些限制，关闭标签只 detach。愿意替换旧终端视图的插件可使用 `hapi-dsh/client` 导出的 kind、seat 和注入契约。工作区内切换到其他插件页面的地址和参数也会保存，几何、原终端身份与当前视图分别保留。详见[旧终端兼容边界](docs/legacy-terminal-protocol.md)。

每个聊天窗格保留官方 `main → ConversationRoot` 的完整组件树。团队快捷入口等 `conversation.session.header.utilities` 贡献与第三方头部按钮走同一公开注册路径；原生审批和队列控件进入 `conversation.input.dock`。源会话已有的身份、连接与执行状态记录另外提供“源会话状态”视图，使没有本地 DSH Workspace 的远端空线程也有真实业务内容，不制造聊天消息或本地目录。

兼容性取决于插件使用的接口。依赖公开 Session、资源、tab 和 provider 的插件可以进入这一工作区；直接操作 Host 文件系统、Host 进程或原 DSH AgentLoop 内部状态的插件需要相应源适配。项目不自动宣称任意第三方插件支持任意 HAPI 引擎。

## 固定版本

| 组件 | 本仓库使用的版本 |
| --- | --- |
| Node.js | 24 或更新版本；CI 固定 24.19.0 |
| pnpm | 11.28.5；官方 DSH 插件管理器要求 `pnpm` 位于 `PATH` |
| 官方 DSH | `@deepseek-ai/dsh@0.2.1-rc.3`，主机和 Runner 必须一致 |
| DSH 对照源码 | [`1f81c047fc48fa190a683e469daa699857e9afe8`](https://github.com/deepseek-ai/deepseek-harness/tree/1f81c047fc48fa190a683e469daa699857e9afe8) |
| HAPI 原生桥 | [`dqtz5vpvj9-create/hapi@55166cf8d87814ccfb383b538a8e8c55283bed81`](https://github.com/dqtz5vpvj9-create/hapi/tree/55166cf8d87814ccfb383b538a8e8c55283bed81) |
| 构建 HAPI 时需要 | Bun 1.4.0；运行本插件本身不需要 Bun |

所有直接 npm 依赖及锁文件均固定版本。不要把公开 npm 上同名 HAPI 的版本号当作上述原生桥源码版本。

`0.1.2` 已适配 DSH rc.3，并在本地 Host、Linux Runner 和 Windows Runner 上完成升级。安装、浏览器与性能验收结果见 [rc.3 升级记录](docs/dsh-rc3-upgrade.md)。

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

输入该 HAPI Hub 的访问令牌并启动（三个平台相同）：

```text
node dist/cli.js login
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

将生成的 `artifacts/hapi-dsh-0.1.2.tgz` 、`artifacts/INSTALL.md` 和 `artifacts/SHA256SUMS` 一起分发。接收方在同一目录校验并安装：

```bash
sha256sum -c SHA256SUMS
npm install --global pnpm@11.28.5
npm install --global ./hapi-dsh-0.1.2.tgz
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

开发时运行 `npm run test:fast`；按改动选测用 `npm run test:changed`，完整验证用 `npm run check`。新套件包含进程内契约与真实 React 组件的 DOM 交互测试，`npm run test:faults` 检查典型回归是否会触发断言。命令、覆盖边界与发布 UI 检查见[测试套件说明](docs/testing.md)。

Conversation 窗格默认复用所属 Host 的一个真实官方 Client graph，各窗格通过显式 SessionProvider 绑定会话，保留独立的视图、草稿和滚动状态。Host chrome、settings 和官方右栏共享，按 focused pane 路由；文件、文档等非 conversation 插件视图暂用兼容路径。统一侧边栏聚合所有 Host 和源引擎目录。HAPI Codex 与其他 HAPI 引擎在主 Host 注册源会话适配器，同样进入官方 Conversation。

详见[架构与扩展边界](docs/architecture.md)、[可复现验证](docs/validation.md)和[维护者分发流程](docs/distribution.md)。测试区分模型桩、真实传输和真实官方 DSH 进程。发布前仍需使用实际 HAPI、原生 Codex app-server 和模型凭据做部署验收；自动化 fixture 不能证明这项验收已经完成。

自 `58800d1` 起，架构 A 是普通 URL 的默认路径；`?hapiGraph=shared` 仍可显式选择它，`?hapiGraph=legacy` 可回到每 pane graph 的兼容路径。本地会话复用主 Client graph，远端 chat pane 复用该 Host 的 catalog graph。旧 per-pane rich draft 的自动存储迁移仍未完成；旧值保留，但不会自动导入共享 graph。公开 API、状态归属、测量和残余风险见[单 Host graph 报告](docs/one-graph-spike.md)。

源消息同步使用有界接收 journal、历史/live 合并与后台对账。生产 composition 自 `58800d1` 起显式启用快速尾部 seed；底层构造参数缺省值仍为 false。补入更早历史可能替换 display generation，其 rich draft、附件与滚动锚点的安全迁移尚未完整验收；具体保证见[消息连续性说明](docs/live-history.md)。

隐藏且未绑定的窗格保持 deferred 状态，首次可见时才绑定。首次打开会在首屏后有界预取上一轮；源会话的 composer 使用模型/推理强度与权限 capsule。启动反馈、正文与 composer 的独立计时及当前边界见[启动与窗格反馈](docs/startup-feedback.md)。日常客户端验证使用[快速测试入口](docs/testing.md)；[常驻官方环境](docs/warm-validation.md)保留为旧浏览器流程的历史记录。

针对实际部署截图中的源会话恢复、目录外文档、聊天事件和界面问题，代码修复、16 条实际官方浏览器专项及仍未定因的原生空白问题记录在[现场修复说明](docs/live-site-fixes.md)。线上验收新增实际源聊天正文检查；离线诊断只输出结构计数，详见[历史诊断](docs/source-history-diagnostics.md)。

## 许可证与来源

本项目采用 [AGPL-3.0-only](LICENSE)，包含从 HAPI 适配的工作区与原生输入契约。官方 DSH 以未修改的 MIT 许可依赖使用。来源、固定提交和第三方声明见 [NOTICE](NOTICE)。相应版本完整源码保存在本仓库和 GitHub Release 对应标签中。

### 本机一键发布

在已有本机部署上运行 `npm run deploy` 发布客户端，或运行 `npm run deploy:host` 发布 Host 与客户端。命令使用当前账号的私有 `~/.config/hapi-dsh/launch-url`，完成类型检查、全量自动化测试、构建及 HTTP/认证 WebSocket 检查。Host 发布会先确认本机没有普通 DSH 会话执行，只重启 `hapi-dsh-host.service`。发布后的真实界面由 Agent 按[测试说明](docs/testing.md)检查并单独报告；该命令不会提交工作树或推送 Git。插件的执行边界见[插件兼容说明](docs/plugin-compatibility.md)。
