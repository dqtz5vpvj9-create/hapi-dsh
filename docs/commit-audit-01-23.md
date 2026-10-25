# HAPI DSH 提交审计：1–23

审计基线是 `6d540ca58d7b1b84cdcbe4ab7faeeda416a2bc20`。序号沿用[本次 69 条提交清单](commit-audit-manifest.json)；其中本段有 20 条主线提交、3 条备份分支提交。备份分支不是额外上线的三个版本。

本次逐提交检查了实际 diff、文件清单和主要调用链，并把重要历史问题追到基线代码。大型提交按源投影、生命周期、界面和测试入口进行重点审查，不宣称已经逐行证明其中数万行代码全部正确。本次没有运行构建、单测、浏览器或性能实验；文中“已修复”表示后续提交中存在对应修复及可检查的回归代码，不等同于本次重新完成生产验收。当前工作树中的冷打开、标题和展示代交接修复尚未包含在上述基线中。

## 需要优先处理的现存问题

### A1：慢消费者仍可让源事件队列无界积压

严重度为 P1；这是可由代码直接确认、此前也已隔离复现的留存路径，尚不能单独解释某次生产 OOM。[内存分析](memory-breakdown.md)记录：阻塞真实 CodexService 的首个消费者后，1,024 份累计快照使堆从 19.16 增至 276.43 MiB；排空后为 27.31 MiB，逐条消费对照也是 27.31 MiB。本审计引用已有实验，没有重新运行它。

基线 `src/codex/service.ts:299–329` 每接收一个事件就通过 `previous.then(...)` 添加任务，闭包保留该 `event`，直到此前任务结束。`src/hapi-agent/service.ts:264–297` 相同，并会在普通元数据更新时等待 `transport.getSession`。队列没有待处理字节数或项数上限；`eventWork/work` Map 只有一个源对应的尾 Promise，不代表前面的 Promise 闭包已释放。一次缓慢内容准备、源请求或挂起的 attach，就能让后续累计文本快照同时存活。原始 Codex 链在 **#2 `073886ef`** 引入，observed 链在 **#4 `1cdb2e7`** 引入。

需要纠正一个容易产生的误判：`src/codex/history-journal.ts:87` 的 checkpoint **仅有 generation、sequence 两个标量**，从 #18 引入时就是如此，并不复制完整 journal。journal 自身在 `:83–110` 有 1,024 条、8 MiB 和 4,096 条覆盖证明的上限；队列闭包却独立持有事件，所以 journal 淘汰不能释放仍被闭包引用的消息。on-demand 在两个 service 的 queue 入口仅跳过尚未 attach 的源，对已经打开的源不起这个限制作用。

建议的隔离验收是阻塞真实 service 的首个 `handleEvent`，经正常订阅回调输入独立分配的累计正文事件，比较 512/1,024 次输入的待处理字节数、堆留存和解除阻塞后的完成顺序，并覆盖 invalidation、remove/add、tool/final、投递回执。不应直接丢弃所有中间事件；只有确认同源、同 item、同 epoch 且语义允许覆盖的累计快照才可能合并。本次只提出验收方法，没有执行它。

### A2：有 opening cache 时，冷打开仍先用旧内容，最新正文受后台补全影响

严重度为 P1，触发条件和分支可直接确认。实现由 **#18 `9e459db`** 引入，**#19 `58800d1`** 默认启用。

基线 `src/codex/agent.ts:313–339` 在 opening cache 带 epoch 时直接投影缓存，不先读取当前源尾页；`startHistorySync` 到 `:371` 才启动后续同步。没有缓存的路径才使用最新尾页。基线 `src/hapi-agent/agent.ts:197–219` 对 observed 源也优先缓存，甚至不要求缓存带 epoch。虽然 projection 明确标记 stale/fault，正文仍然是旧缓存，不能把它的首次绘制当成“最新内容已就绪”。

当缓存和当前最新消息不重叠、源归档较大或历史读取较慢时，用户会先看到旧片段，再等待完整历史或展示代替换。Native 与 observed 路径均正在本轮工作树修复，但本审计基线尚未包含它们，不能把未提交代码提前归入此处的已修复清单。需要分别用旧缓存、阻塞 archive、可用最新尾页和变化 epoch 的源测试。

### A3：同源展示代替换尚无“新正文可用后再交接”的前端约束

严重度为 P1。**#18** 引入共享 Conversation 的切代路径；其后的快速历史回填增加了正常使用中发生切代的机会。

基线 `src/client/federation.tsx:898–905` 在 source/display ID 改变时先 park 当前 pane，再创建下一视图；`:918–921` 也在布局换代时提前 park。`src/client/surface/session-view.tsx:103–104,180` 的 ready 通知取决于 reference 的 ready 和框架提交，没有把可见正文、可用输入框、阅读定位完成作为交接条件。因此不能从 reference ready 或外壳仍存在推出用户没有看到 Loading history 或输入控件临时默认值。

后端 `src/codex/service.ts:223–231` 必须先退役旧 Agent，再构造新 Agent，以保证投递/审批 journal 只有一个可写 owner；这条安全边界本身不是错误。缺的是同一精确原始源的前端视图交接，而不是让两个后端同时可写。本轮工作树正在修复此处，仍应以独立正文空白负控和草稿/唯一可操作 editor 的 E2E 为准。

### A4：按需 attach 仍不等于按需保留整份源显示状态

这是 P2 的长期内存成本，不能仅凭它叫作泄漏。#2/#4 建立 service 常驻 Agent；后续 `c366dad` 把发现改为 on-demand，但没有让已 attach 的源随最后一个阅读者离开而释放显示侧重对象。

基线 `src/codex/service.ts:146–168,183–186` 将 Agent 和 journal 留在 service Map；其清除路径是源删除、身份/展示代替换或 service dispose。observed 在 `src/hapi-agent/service.ts:66–70,305–311` 类似。关闭浏览器 pane 不会经过这些后端清除路径。Agent 仍持有投影索引、Session 历史、子会话和最多 8 MiB 的接收 journal；依次打开很多大源后，后台保留成本仍随已访问源数增长。

浏览器 warmup 的 5 个引用和最近视图的 2 个缓存上限，不能约束这些服务端对象。需要区分必须常驻的执行/投递/审批事实与可重建的显示历史，再用“打开多个大源→关掉全部 pane→继续原生执行”的测试验证回收；不能为了回收内存终止源执行或丢失未决投递。本次未测实际增长速率。

## 已修复的历史问题，不能再次算作现存缺陷

| 历史问题 | 引入与扩展 | 基线中的修复证据 |
| --- | --- | --- |
| 流式 delta 的 sliced string 留住累计正文 | #2 首次使用 `row.text.slice(...)` 后将 chunk 留在 `stream.records`；#4 扩展到 notify-summary/observed；#13 增加 final-tail 分支 | `5784b23` 改为独立 delta；基线 `src/codex/projector.ts:336`、`src/hapi-agent/projector.ts:133`。对应内存 fixture 为 `tests/fixtures/source-stream-memory.ts`。不能将 #13 误认成最初根因。 |
| observed final-tail 丢失 `live.text` 更新 | #13 对末尾文本延伸分支修改时遗漏 | `5784b23`；基线 `src/hapi-agent/projector.ts:135` 已同时更新 `live.text`、`live.item`。 |
| ScopeIndex 按 fresh transport row ID 留存全部 cumulative `data/message` | #4 新增 `Fact.data`，存于 facts Map | `6d540ca` 仅保存强类型身份、tool/prompt、错误和终态元数据；基线 `src/hapi-agent/scopes.ts:19–36,53–94`，回归 fixture `tests/fixtures/source-scope-memory.ts`。 |
| Native backward paging 发送不支持的 `untilAt/untilSeq` 组合 | #13 将 snapshot head 加到 backward 请求 | #14 改为 epoch 固定和末尾验证；基线 `src/codex/history.ts:75` 起保留正确协议说明。 |
| warmup eviction 回调重入活 Map，导致页面冻结 | #18 建立缓存，#20 延续 live Map 删除/重插次序 | `d628377` 先提交新 selection，再释放旧引用；基线 `src/client/surface/session-warmup.ts:110–124`。 |
| 手机始终展示 pane 顶栏；状态感叹号常驻 | #22 增加独立工具栏；#23 把状态移成常驻警告入口 | `4764ae0` 后基线 `src/client/styles.ts:286` 隐藏手机顶栏；`3199931` 后 `src/client/pane-source-status.tsx:6–34` 将回执放进现有菜单。 |

## 逐提交记录

### 1. [`6c64e7d`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/6c64e7d6c15a08739632a21fed527a27da09ec9f) — Initialize HAPI DSH documentation

Git 作者为 Shinn；Agent 未确认。实际变更只有初始 README。它规定单一多机工作区、未修改的官方 DSH UI、原生执行归源端、pane 关闭不结束执行、未知投递不能自动重放，以及 CLI 安装和配对 Runner 的目标。

这些边界仍适用，但 README 中的初始依赖版本、安装步骤和能力描述应以当前实现为准。它没有实现任何运行时能力，也没有给出可证明冷打开或滚动体验的性能验收，不能计作“已经完成全部 HAPI 体验”。

### 2. [`073886ef`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/073886ef252d16b87994c98a007034c336804d3b) — Implement unified DSH workspace with native Codex and paired runners

Git 作者为 Shinn；Agent 未确认。检查了初始 Codex service/projector/history-cache 和 federation 实现，并核对其余文件清单。该提交建立 CLI/配置、Hub federation、Runner 配对、原生 Codex 投影、持久投递/审批、工作区布局及官方 pane graph，是项目实际起点。

核心源身份、持久 journal 和官方会话投影仍在基线中。初版 catalog 会主动 attach 源，前端每 pane 启动完整 graph；后续共享 graph、懒启动和 on-demand discovery 已改变这些路径，不能把初版全量启动描述成当前默认行为。此提交首次引入流 delta sliced-string 留存，已由 `5784b23` 修复；同时引入仍存在的事件 Promise 队列（A1）和 service 级显示状态常驻（A4）。

### 3. [`e60d7e8`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/e60d7e8a94d8db762e79ec8c59d70ebd494d0142) — fix(distribution): install the official DSH pnpm prerequisite

Git 作者为 Shinn；Agent 未确认。实际 diff 在 CI 安装指定 pnpm，在 CLI 安装失败时识别官方 DSH 的缺少 pnpm 标记，给出可操作提示，并补安装场景测试/文档。检查了退出码 127 与准确错误标记的限定，避免将任意命令输出暴露给用户。

安装前置依赖的目的仍有效；当前跨平台分发还经过 `e9ffa4e` 等后续调整。此提交没有单独证明 Windows/macOS/Linux 均可安装，更不能把一个 pnpm 诊断修复当作跨平台交付完成。本次未运行安装。

### 4. [`1cdb2e7`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/1cdb2e7dcbcc7db367eeb65bb8293df558736e9d) — feat: integrate HAPI source capabilities into the unmodified DSH workspace

Git 作者为 Shinn；Agent 未确认。该提交是 462 文件的大型功能整合。实际检查了 `src/index.ts` 的服务注册/目录路径、NativeProjector、observed service/ScopeIndex，并核对新增源生命周期、创建、文件/终端、模型设置、历史/迁移、通知/语音、队列编辑、分享和多源 UI 的文件入口。它将 Native Codex 之外的 HAPI 引擎作为观察源接入，并通过 provider/slot 接入官方能力。

多数能力仍构成基线，源工作目录/机器身份的检查也必须保留。它将 #2 的流 slicing 方案扩展到 observed，另以 `Fact.data` 长期保留 fresh row 的原始快照；两项分别由 `5784b23`、`6d540ca` 修复。新增 observed 串行事件链仍有 A1 风险。功能覆盖面很大不代表交互路径完整：后续多个提交仍修正 queue 编辑、权限误判、真正源目录和冷打开；本条不将文件存在当作功能验收通过。

### 5. [`3d27a01`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/3d27a01f915a4d3de5f1362d35fe0781f9f70631) — fix(client): generate ids without crypto.randomUUID on insecure origins

这是备份分支提交，Git 作者 hongwen000，Agent 未确认。实际加入 `randomId`，优先原生 randomUUID，否则用 `getRandomValues` 构造 UUID v4，并替换浏览器调用点；没有降级为 Math.random。

与主线 #9 的 stable patch-id 完全相同，因此其功能通过 #9 进入主线，而非此备份提交额外上线。它解决非 secure-origin 下 API 缺失，不提供 HTTP 页面传输安全；两者不能混淆。

### 6. [`0bd5950`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/0bd595040a4cb280cb30b0e34a243ea8e1d06b14) — fix(host): keep the Host available while a large catalog attaches

这是备份分支提交，Git 作者 hongwen000，Agent 未确认。实际将同步等待两个 source service 启动，改为等待最多 5 秒，剩余导入在后台继续，失败仍记录。#10 将同样行为应用到经过 #8 扩展后的 index 上；两者 patch-id 不同，不能称字节等同。

原方案只释放 Host 启动门槛，并不减少 attach、全历史投影或后台内存。后续 #12 提取 `startSourceCatalogs`，再由 `c366dad` 改为 on-demand；基线 `src/index.ts:510,516` 已配置 on-demand。这个历史提交不是当前全部会话仍被 eager attach 的证据。

### 7. [`9c8c4bd`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/9c8c4bdb69a08871b28c02edc26b336fda9c856b) — test(e2e): cover the live HTTPS site and wait for the preview notice

这是备份分支提交，Git 作者 hongwen000，Agent 未确认。实际增加可选的 live HTTPS 页面/目录检查，并在受 preview notice 影响的操作前等待提示；与主线 #11 的 stable patch-id 完全相同。

测试主要证明 shell、catalog 和连接入口，不要求真实源最新正文或首个可操作输入框按时出现。它不能发现后来用户描述的旧缓存先显示、后台长期补全或切代短暂空白。没有证据表明此备份分支独立发布。

### 8. [`159907f`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/159907f6e2ffec0dda2e042cd87a5864e23411ed) — feat: preserve native input, share selection, and workspace navigation

Git 作者为 Shinn；Agent 未确认。实际检查 composer-enter 行为和安装、链接导航、分享选择、Companion 服务以及 federation 目录状态 diff。Enter 设置保留 IME/候选优先级，普通 Enter 由原编辑器产生换行，修饰键经官方 submit；当前页链接导航先完成草稿保存；分享选择基于精确源/Host；Companion 导出凭据要求正向 owner 身份证明。

这些能力仍存在，其设计符合“复用官方编辑器，不重建输入 owner”。代价是额外的 pane/绑定生命周期需要测试，不能由 Enter 单测推断所有草稿跨切代安全。未确认本提交引入新的现存 P1；也不能把它等同于后续 `806b1f0` 的自动持久化修复。

### 9. [`70af5ba`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/70af5bad1546b153464049cf6af257cba803451b) — fix(client): generate ids without crypto.randomUUID on insecure origins

Git 作者 hongwen000；Agent 未确认。这是 #5 在主线上的等效提交。检查了新增 helper、UUID v4/version/variant 约束和调用点迁移。目的和实现延续到基线；浏览器能力缺失不会再直接使新建窗格/操作 ID 生成抛错。未运行浏览器验证，也不以此证明全部非 HTTPS API 都可用。

### 10. [`24a3f78`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/24a3f78a7e935a8f5886eec954cb337267a0032a) — fix(host): keep the Host available while a large catalog attaches

Git 作者 hongwen000；Agent 未确认。主线实际加入 Promise.race 与 5,000 ms 定时器，Host 可以先就绪而 source attach 继续。与 #6 行为相同，周围 Controller 选项已包含 Companion 等新内容。

它改善的是启动等待上界，不是会话冷打开或资源占用本身。后续 #12 的 helper 与 on-demand 接替了它；当前仍慢必须沿真实 source resolve/prepare/历史与渲染链查，不能再次只调这个 5 秒窗口。

### 11. [`17883f2`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/17883f229fc69216f126aebe65b5cd90fa477dcd) — test(e2e): cover the live HTTPS site and wait for the preview notice

Git 作者 hongwen000；Agent 未确认。主线测试与 #7 等效。实际验证页面加载、部分工作区控件、pageerror、只读 catalog 的连接/在线事实，并保存截图；没有以最新正文和可用 editor 为 readiness 定义。

测试入口后续保留并扩展，但原始测试通过与 HAPI 级 UI 指标之间存在明显覆盖缺口。截图生成也不是视觉检查的替代；本审计没有生成截图或声称原截图已经复审。

### 12. [`d3517b7`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/d3517b7549526e4309ce0e0c47b6c5fe5feac755) — fix: restore source workspaces and official plugin usability

Git 作者为 Shinn；Agent 未确认。实际检查 controller 的原始源 resolver、精确 Hub 绑定、lease 恢复、异步 main view 导航保护、federation 资源目标、Native 行排序/终止事件以及启动 helper。它还加入旧终端、源文件恢复、Runner 能力偏差和官方插件使用入口。

关键正确性改进仍保留：目录未到不能被当作用户切到空 pane；源会话查找不能拿另一 Hub 的同 ID 代替；工作目录文件不能退回 Hub 本地文件系统。`compareNativeMessages` 改用 invokedAt 优先，避免“排队时间”错当执行顺序。恢复链的新增异步层本身没有解决 A2/A3，后续需真实冷启动/生成代切换验收，不能只依据 resolver 测试判断用户已看到正文。

### 13. [`1dad739`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/1dad739f2cef8ab6b376bdccb81e5daecf03ea75) — feat: structural pane surface, native history and restore fixes

Git 作者 hongwen000，提交含 Astra co-author；但本地实际执行日志能够确认该批提交由 DeepSeek 工具会话提交/amend，其中 final-tail 修改也由 DeepSeek 完成，详见下方归属证据。不能把整个提交每一行都归给同一个模型。

实际检查 pane graph 过滤、catalog 错误分类、原始 Hub/展示代恢复、历史分页和 observed final settlement。它减少每 pane 启用的窗口级插件，复用编译后的 bundle 函数，但当时仍保留每 pane graph。共享 Host Conversation 在 #18/#19 才进入默认路径。该提交曾以 backward 请求带 `untilAt/untilSeq`，#14 明确纠正为源 epoch；final-tail 修改遗漏的 `live.text` 更新及 slicing 留存后来由 `5784b23` 修复。

不可把此提交的历史测量数字当成本次测得的内存，也不可把它认作最初 O(n²) streaming 留存的来源；首次来源是 #2。

### 14. [`8bb56a4`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/8bb56a4ffe7d227ea990e222a088b0c5d25c5771) — fix: live feedback batch — history, diagnostics, writable sources, startup, UI v2, seamless history

Git 作者 hongwen000；Agent 未确认。实际检查 epoch 固定的历史分页、Native 可发送性与操作权限分离、resume-before-send、lazy pane gate 和新 seamless controller。历史读取用结构 epoch 及末尾验证，纠正 #13 的协议误用。已知 inactive 源可在校验同一 native thread 后恢复，只有明确 `session_inactive` 拒绝才授权一次自动恢复；未知网络结果不能自动重送。

seamless 的原方案通过官方 Load earlier 控件触发分页，保留上游滚动 owner，并引入每源自动页数和总并发限制。它只覆盖触发策略，不能推导连续手势期间官方锚点始终正确；后续 `2a044ef/c5af894/5b6ff47/a5073b2` 分别补移动/手动/桌面在途分页。lazy gate 只延迟首次隐藏 pane 启动，启动后保持存活；当前共享聊天路径已替代完整 pane graph，资源 pane 仍需独立图。不能把它叫作“隐藏 pane 全部释放”。

### 15. [`4aaf3d7`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/4aaf3d7fab22ab0bed4db6fecebef83df65e11fc) — feat(composer): compact workspace composer, remove routine metadata rows, handoff doc

Git 作者 hongwen000；Agent 未确认。实际检查 Native/observed actions 中删除常规设置/usage/goal/notices 长条、只保留待处理与异常状态，以及 composer 几何/overflow 的 CSS。它仍使用官方 editor/Send/Stop，通过 slot 提供自己的控制；不是另写聊天编辑器。

基线仍含 compact 样式与 overflow 设计，但其中使用上游 hashed class（`src/client/styles.ts:210–246`）属于版本绑定的兼容层，升级不能假设自动正确。后来 `8304f2c` 修复自动增高，手机布局也多次调整。原提交注释声称 compact 并不能证明视觉达标；本次未进行视觉验收。移走常规 metadata 不代表后端不再接收或保留这些数据。

### 16. [`4f19dca`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/4f19dcac032c3489edf495372e33a75dcfebf1fb) — docs(handoff): add Phase-0 pre-read findings for architecture A

Git 作者 hongwen000；Agent 未确认。只改 handoff 文档，记录共享 Host graph 的前期分析、官方 per-session scope 与 global seam，以及冷启动仍可能受单图开销影响。此提交不改变任何运行时或性能。

其“共享图减少重复工作，但不保证冷打开达到 HAPI”的边界仍有价值；文中 pin 与当时开销数字是历史记录，不能直接作为当前 rc.3 的实测结果。

### 17. [`6a47858`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/6a47858d9d8a1c9776571c6bcb824bfdb37c138c) — docs(handoff): record official AppFrame/scope boundary for architecture A

Git 作者 hongwen000；Agent 未确认。实际 diff 明确一个 Host 只能有一个官方 AppFrame，全局 current/navigation/rightbar/dialogs 与 per-session Conversation 的边界，给出 `SessionProvider + conversation.content` 公开 factory 路径，要求 retain/release 精确配对。

它支持后来 #18 的实现，而不是宣称官方已经提供多套 pane header。文档当时的产品决策门不是当前重新询问用户的理由；用户后续已授权共享图和性能修复。仍应保留“不能每 pane dispose 整个 Host graph、不得抢全局 mainView”的技术边界。

### 18. [`9e459db`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/9e459db3e861055bf9ce5337ac4068e34202db45) — feat: add opt-in shared Host views and live history reconciliation

Git 作者为 Shinn；Agent 未确认。这是本段最重要的架构变更。实际检查了官方 SessionProvider/factory portal 的 `session-view.tsx`、引用 ready/unmount 生命周期、Codex create/refresh/applyRows、service 生命周期版本、receive journal 和重试。原始代码将 shared 模式和 fastHistorySeed 留为 opt-in；数据层在 REST 读取之前记录实时事件，用 epoch/barrier 合并，防止重连、rewind 或 remove/add 复活旧数据。

共享 Host/每会话 factory 的方向仍是基线；聊天 pane 不再需要各自完整 graph。后台同源替代保持一个可写 journal owner，也是必须保留的约束。但 cache 优先开屏（A2）、reference ready 不等于正文 ready 的切代（A3）和长期 attached 状态（A4）仍没有在这个提交解决。新增 checkpoint 没有复制消息数组，不能把 journal 本身描述成无限增长。

### 19. [`58800d1`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/58800d1fa71d8900951af8f2d08eb0b0caf8856a) — feat: default shared Host views and tail-first history seed

Git 作者 hongwen000；已有原始写入和提交日志确认 Agent 为本地 `deepseek-official / deepseek-flash`，见[冷打开溯源](cold-opening-provenance.md)。实际代码只有三处默认值调整：shared 从显式 opt-in 改为除 legacy 外默认使用，隐藏引用延迟策略同步默认启用，Native 与 observed service 均传 `fastHistorySeed: true`。

它将 #18 从实验路径变为主要使用路径，性能影响比 diff 行数大。标题中的 tail-first 不完整：存在 cache 时仍先用缓存，真实 tail 只在无缓存分支读取。基线共享聊天已经恒定启用，fastHistorySeed 仍配置为 true，因此 A2 在当前代码仍可触发。#18 注释原本要求先验证富草稿/附件/滚动切代；仅三处默认切换无法证明这些验证已经完成。

### 20. [`95892d0`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/95892d0e3877f94bd2d491c2557bc0e00e287e5b) — fix: polish shared pane startup and source composer

Git 作者为 Shinn；Agent 未确认。实际检查了启动 shell、模型/effort/权限 picker 的能力验证、initial-history 计划和 warmup 修改。首屏先绘制不含消息/草稿/凭据的布局预览，再释放官方模块启动；初始 previous-turn 补页在首帧后通过公开 loadOlder 进行，有页数上限并在读者输入时停止继续预取。picker 在提交动作前重新检查最新 capability。

这些机制仍影响基线，但启动布局预览不是正文可用证据；15 秒后出现“仍在连接”也没有减少真实请求/投影时间。初始历史后来由 `118c33c` 等收紧；warmup 同步 release 重入问题由 `d628377` 修复。模型“不可改”误判后续还需 `33b18b2/35a930e/f2301fd` 分离 settings 能力与 transcript fault，不能将本提交视为问题终点。

### 21. [`370f4fc`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/370f4fc5eaaa037a04642a61c0999bae00c28e88) — Recover interrupted workspace navigation and source actions

Git 作者 hongwen000；Agent 未确认。实际检查 reading-view 的 reload/replace 锚点、真实源 discovery、状态文本、队列编辑恢复与审批持久化。它增加精确消息/审批/投递导航，使用公开 loadThrough 恢复阅读；队列编辑必须先有源取消回执，恢复时不覆盖现有草稿，显式 append 保留 reference chips；已完成审批和未知回执不伪装成待执行/已成功。

这些语义在基线仍有用。但初版 reload anchor 以展示 session、DOM node/seq 为核心，跨展示代尚不完整，后续 `a37ef84` 等补源消息映射；初版未知投递仍出现在输入区附近，`431c659` 才进一步将其与真实排队分离。源 discovery 补目录完整性，但目录正确并不证明正文实时。该提交新增 81 个文件的变更面不能由少量新单测覆盖所有恢复交叉路径。

### 22. [`34ab8fc`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/34ab8fc75937b9d7c346630a8436e6544761b671) — Restore independent toolbar controls on every workspace pane

Git 作者 hongwen000；Agent 未确认。实际新增每 pane header，含独立新建/缩放/文件/关闭/更多操作，并在点击文件或插件入口前聚焦正确 pane，修复操作误落到别的 pane 的风险。

桌面 per-pane 工具栏仍保留；手机始终占位的问题在 `4764ae0` 后改为隐藏。此提交还将当时 AGENTS 的 UI 验收阶段改成用户测试为主，这确实降低了当时代理自己的浏览器验收要求，但它是历史阶段文本，不能据此杜撰是谁拒绝测试。当前用户已明确要求代理进行 E2E 和视觉验收，旧规则不能沿用。

### 23. [`4935ce2`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/4935ce22c46398e83f9253d2daee911858121d67) — Move source status into pane headers and prune empty layouts

Git 作者 hongwen000；Agent 未确认。实际将源投递/异常状态经 portal 放进 pane header，阅读定位扩大到整个 pane 以找到这些移位节点；同时移除重复工作区顶栏，增加 `pruneEmptyPanes`，保留非空叶子、焦点与比例，在全部为空时保留一个入口。

该提交引入用户后来反感的常驻感叹号：readOnly/disconnected/旧 unknown receipt 都可使入口长期存在。基线已经由 `3199931` 改放现有菜单，不能再次报告“当前仍固定显示 !”。空 pane 清理目的仍保留，但空状态只代表布局资源为空，不能拿它判断源执行是否结束；实现未借此中断源任务。

## Agent 归属的证据范围

除 #13 的以下局部证据及 #19 的默认启用记录外，本段其他提交的实际模型均记为 **未确认**。Shinn、hongwen000 是 Git 作者；Co-authored-by 是署名，均不足以单独判断 DeepSeek、Astra 或 GPT PRO。没有在本地搜到记录也不构成 GPT PRO 的证明。

本轮之前已提取的本地工具日志可确认：session `7dc6cc17-78b6-4cca-a2be-4f9c2b351826` 的 provider/model 为 `deepseek-official / deepseek-flash`。UTC `2026-10-21T15:12:37.686Z` 的工具调用加入 observed final-tail 分支；`15:40:49.948Z` 的后续调用为处理最终文本分歧而改写该分支，同时漏掉 `live.text` 更新。对应原始压缩记录解压行分别为 1312、1679，工具返回在 1315、1682；这里只记录身份和代码行为，不复制私人会话内容。

主工具 session `da18567e-38f5-4b5e-9dbd-5548795735de` 的同一 DeepSeek provider/model 于 UTC `15:48:50.852Z` 执行提交，`15:57:20.276Z` 执行 amend；解压行 4116/4119、4299/4302 的调用/结果将最终哈希确认到 `1dad739`。这足以说明 #13 的提交执行及上述分支来自本地 DeepSeek，不能据此推断 #2/#4 的作者模型，也不能给 #13 的全部 43 个文件作单模型归属。

#19 的已核验日志记录 UTC `2026-10-22T03:38:25.580Z` 将两个 service constructor 改成 `fastHistorySeed: true`，工具结果确认写入；同一 `deepseek-official / deepseek-flash` 会话随后提交并推送 `58800d1`。这证明的是默认启用者，不是 #18 cache-first 设计的原始作者。该边界与[冷打开溯源](cold-opening-provenance.md)一致。

## 后续验收应补的最小集合

首先验证真实源最新尾页先于 archive 就绪，包括 Native 与 observed、旧缓存无 overlap、epoch 改变和同 epoch 新消息。然后验证同源代切换全过程没有正文空白或多个可操作 composer，草稿与焦点保留，返回旧布局不会复用永久 inert 视图。内存验收应分别记录源事件排队字节、attached 显示状态与无可见消费者时的留存；浏览器 warm cache 数量不能替代这些服务端指标。

连续上滑验收要在历史请求被阻塞时持续输入，并采样旧正文锚点的每一帧位置，而不只是最终 scrollTop。工具、队列和移动布局仍需实际截图视觉检查。以上均为审计提出的验收要求，本次只读审计没有执行或宣称通过。
