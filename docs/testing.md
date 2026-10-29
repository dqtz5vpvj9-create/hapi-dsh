# hapi-dsh 敏捷测试套件

日常先跑受影响的测试或快速套件，发布前跑完整检查。用真实 React 组件的 DOM 行为和进程内契约揭露问题；只有涉及布局、滚动、真实编辑器或上游集成时才进入两条发布 UI 场景。新套件不沿用已删除的六门禁通过结论。

## 运行入口

| 命令 | 用途 |
| --- | --- |
| `npm run test:fast` | 连续阅读与关键 Node 契约，以及全部组件体验测试；不会构建或启动浏览器 |
| `npm run test:history` | 真实投影、正文流、SourceSessions 和官方 Conversation 贯穿的连续阅读回归 |
| `npm run test:changed -- --list` | 查看工作区改动会选中哪些测试、为何扩大范围 |
| `npm run test:changed` | 检查 staged、unstaged、untracked 改动并执行选中的测试 |
| `npm run test:changed -- --since origin/main` | 比较指定 Git revision 到当前工作区，含未跟踪文件 |
| `npm run test:changed -- --files src/client/source-directory.tsx` | 为明确路径选测，支持多个路径；不隐含其他工作区改动 |
| `npm run test:experience` | 单独执行 DOM 体验层；可追加测试文件名或 `-t` 名称过滤 |
| `npm run test:watch` | 组件测试的交互 watch 模式，沿 Vitest 静态依赖图重跑 |
| `npm run test:faults` | 先验证正常版本，再确认组件和历史阅读的故意回归分别触发指定行为断言 |
| `npm run test:smoke:history` | 两条有界的真实站点桌面/手机连续分页与往返阅读检查；不发送消息 |
| `npm test` | 全部 Node 测试与 DOM 体验测试，分阶段串行 |
| `npm run check` | 类型检查、全量测试、完整构建 |
| `npm run test:install` | 已有的独立安装与启动检查，不启动浏览器 |

`test:micro` 指向快速套件。`test:release` 保留完整 `check`；`check` 包含故障检出验证。`deploy` 执行全量测试、故障检出、既有发布保护及真实历史阅读检查，不使用选测替代发布检查。

为 `test:fast`、`test:changed` 或 `npm test` 追加 `-- --report /mnt/cache/data-cache/hapi-dsh-tests.json` 可保存选择原因、文件清单、阶段耗时与退出状态。默认每阶段上限：快速/选测 120 秒，全量 300 秒；超时退出 124、停止该子进程组、不自动重试。`--timeout 30` 可主动收紧预算。列清单、无改动和仅文档改动都明确标为未执行，不能当作测试通过。

## 覆盖用户实际行为

| 场景 | 执行与断言 |
| --- | --- |
| 打开有 40 个子会话的父会话 | 使用真实 pinned Session/Agent registry；父打开不得读取任何子 transcript。保留既有请求数量断言和 2 秒粗粒度上限 |
| 连续历史阅读 | 真实 NativeProjector → SourceFrameFeed → SourceSessions → pinned 官方 Conversation；连续三页后保留已读源行与正文、游标推进、同一 binding、预算内无伪造向后缺口；超预算后向后继续并返回新 head |
| 历史补页与实时更新交错 | 检查迟到响应、去重、窗口有界、普通增量不触发重连定位，真实正文实例/版本变化仍恢复 |
| 草稿恢复、多 Pane 与换代 | 挂载生产 autosave slot，在 DOM 输入中文，卸载再打开、切换源会话、模拟存储配额失败；检查可见草稿和错误通知 |
| 中文输入法与发送快捷键 | 挂载生产 Enter slot，检查 capture/bubble 路径、组合输入、当前焦点/可见性及同一个组件切换会话后的操作对象 |
| 排队消息 | 点击真实 Queue 组件，检查双击只调用一次、待确认期间保留消息、源错误可见、不同 Pane 互不干扰、重连不发送 |
| 目录选择 | 手动释放请求，制造先发后到、切换机器、错误与恢复；检查真实按钮状态和目录结果，卸载时取消 debounce |
| 审批与原生提问 | 点击真实 NativeActions 组件；提交回执保留“等待源端确认”、拒绝重复提交、重挂载不重发，同请求 ID 的不同源答案隔离 |
| 历史窗口尾部缺口 | 挂载真实 Latest slot，检查操作只发给所属 Pane、加载期间禁用、真正关闭缺口才移除按钮 |

`tests/experience/` 使用 Vitest、jsdom、Testing Library，依赖固定在 `package.json`。组件、React 生命周期、snapshot store、autosave 和 action ledger 使用生产实现；远端 RPC、slot 注册与 editor owner 是明确的边界 fixture。Queue 的 Tooltip/FileTypeIcon 是展示替身。没有加载真实 Lexical、完整官方 Client graph 或模型；没有连接生产 HAPI。测试环境拒绝意外的 `fetch`。

开发/CI 使用 Node 24.19 或更新的 24.x。新增依赖均来自 npm 官方 registry，许可证均为 MIT：`vitest@5.0.5`、`vite@7.3.7`、`jsdom@30.1.3`、`@testing-library/react@16.3.3`、`@testing-library/dom@10.4.1`、`@testing-library/user-event@14.6.8`、`@testing-library/jest-dom@7.0.1`。来源分别为 [Vitest](https://github.com/vitest-dev/vitest)、[Vite](https://github.com/vitejs/vite)、[jsdom](https://github.com/jsdom/jsdom) 和 [Testing Library](https://github.com/testing-library)。Vite 固定在兼容现有构建依赖的 7.x；没有升级现有运行时依赖。锁文件同步移除了之前遗留的 Playwright 条目。

普通交互用 `user-event`；需要精确控制 debounce 或 IME 顺序的用例使用 DOM 事件和可控时钟。异步 RPC 通过可手动 resolve/reject 的 Promise 排序，不靠长时间 sleep。每例卸载组件、恢复 timer/mock/storage；默认单例超时 5 秒且 retry 为 0。断言查找按钮、标签、可见文本和原端调用，不复制组件内部实现或存大块 HTML 快照。

## 选测的适用范围

选择器追踪 TypeScript import、re-export、`.js` 到 `.ts` 的映射、共享 helper，以及现有 esbuild fixture 的 `src/...` 字面量。Git rename 的旧、新路径和删除文件都参与选择。遇到不可解析的动态 import，纳入依赖它的测试；配置、锁文件、上游版本、全局 setup 或无映射文件改动直接回退全量。source/test 下的文本资源也不能当作说明文档跳过。

这只是内循环加速器，不是“不会漏测”的证明。新加动态资源或通过插件注册间接关联的行为，应增加明确测试依赖或走全量；CSS 的真实布局仍需浏览器。CI 和发布继续运行全量。选择器及 runner 自身覆盖重命名、删除、动态导入、报告、加载错误、测试外异常、超时退出等风险。

## 测试能否抓到回归

`test:faults` 在 Vitest 内存模块中分别注入：取消迟到响应隔离、让草稿 key 错误地跟随显示会话、取消 IME 保护。每次只运行对应的具名行为测试，检查 JSON 报告里的确切断言失败。语法错误、模块加载失败、未选中测试、超时或故障未检出均让演练失败。源文件和发布构建不受修改。这 3 个样本证明对应断言有检测能力，不代表所有缺陷已覆盖。

同一命令还运行 `scripts/test-history-faults.ts`：先通过两条完整阅读旅程，再仅在测试内存构建中分别恢复旧投影坐标、DOM-only 进度判定和预算内强制 locality 裁剪。每个故障只能命中指定的一条行为断言，加载错误、超时和零用例均不算检出。普通补页还检查一次 `prepend`、已有官方节点的 key 与对象保留，防止测试用全量重建掩盖生产端全量重建。

## 发布 UI 检查：最多两条场景

由 Agent 执行并单独报告，不能把 DOM 测试或 HTTP 成功替代成真实体验通过。使用已运行的官方 Host 与隔离浏览器；不复制用户官方 profile。发送、取消、审批和断网只对合成会话执行，生产会话只读。每条场景预算 60 秒，遇到失败保存证据并定位，不循环重跑直到通过。

1. **桌面两会话**：打开有历史的 A、B；确认首次目标画面同时具备正文、编辑器、历史和阅读导航。A 向前补页，再返回最新；B 的更新不能改变 A 的阅读位置。在合成会话输入未发送草稿、切换窗格、关闭并重开、刷新，检查草稿和操作对象。任何阶段不可用都算失败，不能仅检查最后截图。
2. **手机视口**：390×844 打开同样的会话，检查正文和编辑器可见、按钮可点击、菜单与长行不横向溢出，上下滚动不出现空白/叠字。真实软键盘、IME 和物理设备另记未测，桌面模拟不能替代。

其中连续历史阅读由 `npm run test:smoke:history` 固定执行：桌面和手机视口均须连续六段向上阅读获得更早的可见内容，随后往返已读区间，再通过官方按钮回到底部、三次上滑已加载的尾部区间，检查不重新取历史页；共享 Portal 的 mounted reader 缺失、原始页已读却未提交、失败事件和重复区间读取均不能通过。私有目标标题来自 `~/.config/hapi-dsh/smoke-session-title`，可由 `HAPI_DSH_SMOKE_SESSION_TITLE` 或 `--session-title` 覆盖；launch URL 继续使用已有私有文件。浏览器复用 Agent 主机已安装的 webshot 配套运行时，不成为产品依赖。缺少环境或目标、三页未提交、源游标未推进、失败事件、页面异常和阅读跳变都让命令失败。报告只保存匿名数量、位移与阶段，不保存会话内容和凭据。该命令的两条桌面/手机检查占用同一发布 UI 预算；双 Pane、草稿和截图的结论仍须按各自实际执行情况报告。

截图统一用已安装的 `webshot`。可运行以下有界采集入口：

```sh
npm run test:smoke:capture -- --ready-selector '.hapi-pane:has([data-conversation-scroll] [data-chat-anchor-key]) [data-composer-input]' --output /mnt/cache/data-cache/hapi-dsh-smoke
```

默认从本机私有 `~/.config/hapi-dsh/launch-url` 读取地址；也可用 `--url-file` 指向授权测试站点。上例要求同一 Pane 有历史正文和编辑器。截图是独立浏览器上下文，若该页面没有已打开会话，此条件会失败；需要先用浏览器完成上面的交互场景，或为仅检查工作区外壳明确使用 `[data-hapi-workspace]`，并如实记录范围。采集器不会替用户点击、发送或创建会话。

两张截图串行、各最多 20 秒。URL 和页面日志不输出到报告，截图可能包含私有内容，仅保存在本地忽略目录。`report.json` 始终保留 `visualReview: required` 与 `interactionChecks: not-run`；Agent 必须实际查看图片并另记视觉结论。采集成功不等于发布 UI 通过。缺少 webshot 时明确失败，不安装整套 e2e 或静默跳过。

## 依据和证据边界

本设计采用 ARS quick 路线核查；方法、论文、检索请求和阅读范围见[证据备忘](testing-evidence.md)。[Testing Library](https://testing-library.com/docs/guiding-principles/) 支持基于用户行为的 DOM 断言；[jsdom](https://github.com/jsdom/jsdom#unimplemented-parts-of-the-web-platform) 明确不承担布局渲染。Java 的 [TIA 研究](https://arxiv.org/abs/2211.07782) 与 [mutation 实证研究](https://homes.cs.washington.edu/~mernst/pubs/mutation-effectiveness-fse2014-abstract.html) 支持缩短反馈及检验断言能力的方向，其统计结果不能直接当成此项目的收益。

运行耗时必须取实际报告，不能沿用旧 e2e 或单次最优数字。纯 Node、DOM、真实 Host/原生执行、真实浏览器与物理设备是不同证据层；没有执行的项目标为未测。

## 首次实测（2026-10-27）

本机 Node 24.22.1 下，快速套件 123 个 Node 测试加 21 个组件测试全部通过，总计 8.8 秒；报告见本地忽略目录 `artifacts/test-fast.json`。全量验证通过 1710 个 Node 测试和 21 个组件测试，两个阶段分别约 89.8 秒和 4.6 秒。另有 1 个既有官方集成测试按默认配置跳过，CI 单独开启 `HAPI_DSH_OFFICIAL_TESTS=1`；本次没有执行该可选集成。类型检查、完整构建和 3 个定向故障演练均通过，远端 CI 尚未运行。

Client 已通过既有发布脚本更新，未重启 Host；认证 HTTP、压缩 WebSocket 与线上 Client 版本核对通过。桌面 1440×900 和手机视口 390×844 的截图已实际查看，正文和编辑器均可见。首次只等待工作区外壳的桌面截图仍在加载，因此未计为会话通过，后续采集改为等待同一 Pane 内正文和编辑器同时出现。

截图保存在本地 `/mnt/cache/data-cache/hapi-dsh-testing-smoke-conversation-20261027/`，可能包含私有内容，不入库。当前没有可用的交互浏览器控制面，本次未执行上述两条完整交互场景，也未验证真实滚动、软键盘或物理设备；截图记录不构成这些层面的验收。
