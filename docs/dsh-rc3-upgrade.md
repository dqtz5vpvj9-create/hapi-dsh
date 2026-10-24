# DSH 0.2.1-rc.3 升级记录

本次将 HAPI DSH 的官方依赖从 `0.2.1-rc.2` 升级到 `0.2.1-rc.3`，兼容包版本为 `hapi-dsh@0.1.2`。原版 DSH Web、HAPI DSH Host、Linux Runner 和 Windows Runner 已完成切换，三个配对节点均在线。官方源码对照提交为 [`1f81c047fc48fa190a683e469daa699857e9afe8`](https://github.com/deepseek-ai/deepseek-harness/tree/1f81c047fc48fa190a683e469daa699857e9afe8)。HAPI DSH 使用原始 npm 依赖，不修改上游实现。

升级先在独立候选目录安装、构建和验证，再切换实际服务。rc.2 文档中的耗时、测试数量与截图保留原版本归属；下面登记 rc.3 的实际结果。

## 版本与 profile

版本必须同时覆盖以下入口，避免 CLI、Host、Runner 和浏览器 bootstrap 接受不同版本：

| 位置 | 升级要求 |
| --- | --- |
| `package.json`、`package-lock.json` | 更新官方运行时依赖、开发依赖 `dsh-client-store` 和 `engines.dsh`；由包管理器生成锁文件 |
| `src/cli/config.ts`、`src/build-info.ts` | 更新 CLI 精确版本检查及构建元信息 |
| `src/client/federation.tsx` | 更新 bootstrap 与 release graph 的版本字面量校验 |
| `scripts/distribution-pack.mjs` | 更新分发包的官方依赖版本检查 |
| `tests/official-conversation-fixture.ts`、`tests/codex-conversation-history.test.ts` | 更新真实官方 Conversation fixture 的版本断言 |
| `UPSTREAMS.json`、`NOTICE`、`README.md` | 更新来源、当前兼容版本及安装包名称 |
| `tests/federation-official.test.ts`、`src/client/notify-summary-display.tsx` | 保持版本注释准确，并重新检查对应真实 graph 与官方消息操作 DOM |

完整构建会从 manifest 生成 `dist/runner/package.json`。浏览器 store runtime 从本次安装的官方 `dsh-client-store` 打包，不能只改 NOTICE 而沿用旧产物。Host 与 Runner 必须使用一致的官方版本。

新 profile 和已有 rc.2 profile 分别验收。CLI 优先解析本包的官方依赖并检查其版本，但已有 profile 还保存自己的插件依赖；仓库升级不能单独证明这些依赖已同步。应核对实际 profile 的版本、启动后的 bootstrap release 和插件资源，再确认普通本地 DSH 与 HAPI DSH 均能打开。新的 `More` 入口涉及 `ui-entry-customization` 与 `ui-plugin-manager`，也要检查其依赖是否意外进入首屏同步加载，以及延后激活是否影响入口可用性。

## 适配变化

- 会话所需的语言资源、插件管理页和 More 入口在首次渲染前激活。账户模块、HMR 和分析模块仅在通过官方入口打开 Settings 后加载；使用公开 `settings.action` 插槽观察需求，保留官方按钮、快捷键和账户实现。
- 插件视图跟随官方 `layout.panelInfo` 的导航，Guide 中的 Browse 可以显示官方插件页。
- 插件创建通过 Loader 的公开 service isolation 转交给该 Host 的共享 `uiWorkspace.startSession`，保留官方 preset 与 append 草稿语义。
- 指定会话的独立资源窗格先绑定该会话，再释放公开传输接口上的 `workspace/follow` 订阅，避免恢复流程创建空会话或重置另一个草稿的 preset。其余事件流照常运行。
- 恢复插件页面时，在首次挂载官方 root 前选定保存的 panel，避免短暂挂载 Conversation 后自动聚焦，抢走当前会话焦点。
- 新 More 按钮固定为紧凑宽度，避免挤掉侧栏的插件与自动化任务文字。禁用可选 More 插件不会影响 Files、Terminal 等页面；窗格关闭时立即释放迟到的导航适配。

## 最小回归矩阵

各组使用同一份候选构建，浏览器性能测试串行运行。每次截图由 webshot 生成后实际查看；没有查看的截图只能列为产物，不能写成视觉验收通过。

| 范围 | 本次入口与覆盖 | 状态 |
| --- | --- | --- |
| 类型、协议与产物 | Host/client/E2E 类型检查、全部逻辑测试、完整构建 | 通过：1,170 项中 1,169 通过、1 项默认跳过、0 失败 |
| 真实官方 Host/Runner | 显式启用 `tests/federation-official.test.ts`，新 profile、真实 graph、插件资源、RPC/event stream、Host-only Runner | 1/1 通过，4.27 秒；上行默认跳过项已另行执行 |
| rc.3 菜单与草稿 | `e2e/rc3-compatibility.spec.ts`，两处菜单、草稿复用/追加/刷新、无隐式 create/submit、多窗格恢复焦点 | 最终复测 1/1 通过，29.1 秒；对应截图已查看 |
| 手机历史滚动 | `e2e/mobile-scroll.spec.ts` 全部 12 项：持触、惯性、补页、方向切换、360/390px、长工具历史 | 首轮 11/12；原失败保留。修复后展开工具专项通过，全程最大帧 150.1ms、1,260 个历史锚点 |
| 手机工作区与源呈现 | `e2e/mobile-chrome.spec.ts` 2 项、`e2e/source-presentation.spec.ts` 2 项；顶部/底部栏、状态入口、队列编辑、命令摘要与展开 | 4/4 通过 |
| 通用 UI 与性能 | `e2e/ui-cli.ts --perf`，5 轮桌面及 360/390px：打开正文与输入框、双向滚动、实时更新、草稿、队列、多窗格 | 最终 5 轮共 86/86 通过；warm body p95 44.7ms |
| 插件与共享 graph | `e2e/shared-restore.spec.ts` 与 `e2e/plugin-workspace.spec.ts` 的 Files/Terminal 保持状态用例 | 2/2 通过，含 13 pane 恢复 |
| 冷启动与后台激活 | `e2e/cold-boot.spec.ts` 2 项：首屏不等待可选账户模块、手势期间延后激活、浏览器资源缓存复用 | 通过；最终复测含按需账户加载、下载中关闭设置与重新打开，草稿原节点保留 |
| Linux 安装包 | 干净目录安装实际 `.tgz`，CLI/profile/Host/Runner、分块 HTTP、凭据不外泄与撤销 | 通过；实际启动官方 Host，验证 5 个延迟分块以及 Runner 配对与安装 |
| Windows 运行环境 | 同一 `.tgz` 旁目录安装，真实 CLI 版本检查，再切换已有 Runner | 安装与切换均通过：HAPI-DSH 0.1.2 / DSH rc.3 / pnpm 11.28.5；原机器及会话 ID 保留，168 个启用插件均 active |
| macOS 安装 | 仓库已有三平台 CI；本次未在本机执行 macOS | 未测，不能引用旧包结果代替 |
| 已有 profile 与本地部署 | 保留原配置、会话、插件和收件箱；实际版本、bootstrap、来源身份、HTTP/WS 一致 | 通过；各 Host/Runner 实报 rc.3，公开入口提供本次产物，认证 WebSocket 正常并协商压缩 |
| 生产只读页面 | 390×844 和 1440×900，原版 Web 已有会话 | 两张 webshot 均已查看，无可见横向溢出；手机输入区紧凑，桌面侧栏与标题栏正常 |

手机滚动保留现有门槛：反向回拉不超过 2px、最大单帧位移与同 DOM 锚变化小于 160px、空白帧为 0、最大帧间隔小于 200.2ms，输入框与固定栏位移不超过 1px。返回当前会话的阅读位置偏差不超过 1px。不得为了适配新版本而放宽这些断言。

普通滑动验收默认不启用 Playwright 全 DOM snapshots，避免快照遍历污染帧时长；诊断时按需单独采集，并保留首个失败证据。最长帧超标不能用后续偶然通过替代。新版本的冷启动数字需要重新测量，不能沿用 rc.2 的历史数据。

## 结果记录

新增 `e2e/rc3-compatibility.spec.ts` 使用真实 rc.3 Host 与合成 provider，完成两处 More 菜单、Guide 无隐式创建、Standard/Creator 草稿隔离与追加、刷新保留、刷新后焦点稳定、零 prompt 提交检查。最终用例 29.1 秒通过。对应桌面 webshot 已逐图查看，按钮和菜单没有裁切。官方 SidebarSessionView 在刷新中对取消 readiness 记录的日志仅按已知恢复会话 ID、准确调用栈和恢复阶段单独登记；其他 console error 与 pageerror 仍失败。

候选目录为 `/mnt/cache/data-cache/hapi-dsh-rc3-candidate`，在验证期间与原 rc.2 依赖和产物隔离。最终类型检查、完整构建及逻辑测试通过：1,170 项中 1,169 项通过，1 项真实 federation 测试已另行显式执行并通过。实际分发包经过 Linux 干净安装和 Windows 旁目录安装后，用于生产切换。

本机原版 DSH 保留原有 ACP、SDK 和 Codex 修改，合并官方 rc.3 tag 后，完整构建 9/9 通过，相关回归 20 个文件、360 项通过。Web 进程已切换，运行态 bootstrap 确认 rc.3。575 个会话 ID 与原两条收件箱消息 ID 逐一相同；原 183 个启用插件全部 active，新增 `entry-customization` 后为 184 个。两个目录选择插件的动态 entry ID 随重启变化，已按唯一模块和实例配置严格对应；`hooks-codex` 继续禁用。Windows Runner 原机器与会话 ID 保留，切换时没有运行任务、队列消息或待答问题。原生 HAPI Hub、原生 HAPI Runner 与 Windows DSH Desktop 未重启。

最终只读核对还确认了三个配对节点在线、原有来源身份与普通会话保留、公开入口提供本次 `client.js`，以及认证 WebSocket 正常协商压缩。生产截图使用拒绝写操作的临时代理；画面中的布局同步失败提示由代理主动阻断布局保存造成。该检查没有创建或挂接会话，只证明已有原版 DSH 会话的新版渲染，不代表原生 HAPI 恢复或真机触控验收。证据位于 `/mnt/cache/data-cache/hapi-dsh-production-rc3-visual`，部署核对位于 `/mnt/cache/data-cache/dsh-rc3-upgrade-i0nug4jk/final-readonly-verification.json`。升级前的源码、依赖、产物及 profile 备份保留在对应升级目录中，供回滚使用。

首轮完整浏览器矩阵 19/20 通过，另有 5 轮通用 UI/性能 86/86 通过。31 张 webshot 已逐张查看。唯一失败为展开工具历史的 649.9ms 长帧，原始记录保留在 `/mnt/cache/data-cache/hapi-dsh-rc3-regression-6w7115b1`。专项 CDP 诊断发现 deferred module 的 load 回调触发两段 React 工作；原测量还漏掉了两轮手势之间的空档。进一步全程诊断确认，多个延后插件的全局 locale 注册会重渲染整段已保留历史，不能逐个挪动热点来回避。最终方案把轻量 UI 插件前移，约 2.46MB gzip 的账户模块改为显式 Settings 需求加载。`conversation-plugins-ready` 与 `deferred-plugins-ready` 分别表示首轮会话插件、完整按需图的完成；阅读测试持续覆盖三个方向及方向间隔，并断言未请求账户/HMR。Settings 测试单独验证账户页面加载与草稿保持。

最终调度方案的五轮性能验收为 86/86 通过，耗时 99.14 秒。冷启动最大 2444.9ms（门槛 6000ms），首次正文最大 395.8ms（门槛 1500ms），长历史首次正文最大 410.1ms，热打开 p95 44.7ms，桌面滚动最大帧 99.9ms。展开工具历史专项连续采样覆盖三个方向与空档，最大帧 150.1ms，1,260 个历史锚点，反向跳跃、空白和固定控件漂移均为 0。数据来自隔离官方 rc.3 Host、合成会话和本地 Chromium，不代表真机或用户网络。最终性能报告为 `/mnt/cache/data-cache/hapi-dsh-rc3-demand-perf/hapi-ui-acceptance-1792826545826.json`。
