# 原 HAPI 移动滚动机制调查

2026-10-23。只读对照原 HAPI 的提交、源码、回归和历史用户指示；本文不代表本轮 HAPI DSH 的浏览器或真机验收结果。调查期间 HAPI DSH 正在并行修改，下表描述的是本轮修复前检查到的差异。

## 结论

原 HAPI 用“一个滚动位置控制者、手势与惯性优先、发布前重新取阅读位置”解决自动补页和读者运动竞争。降低主线程耗时有必要，但不能替代这些所有权规则。Chrome 下拉刷新另有独立原因：根页面和正文的 overscroll 边界必须完整。

HAPI DSH 必须继续使用官方 Conversation。不能把原 HAPI 的 `NativeChatViewport` 类拷贝进来覆盖或修改 DSH。原实现提供的是行为依据；修复应落在我们的外层滚动边界、自动补页调度及自有阅读恢复任务上，必要能力通过官方公开接口完成。

## 用户要求和数值来源

历史原文已用 agentsview 定点读取；下列 ordinal 和时间保留核查线索，私人会话 ID 不写入仓库。

| 来源 | 已核实的要求或界限 |
| --- | --- |
| 用户 ordinal 7512，2026-10-05 12:21:44 UTC | 上拉、加载和下拉须流畅；刚看过的区域往返不能再重新加载。 |
| 用户 ordinal 7942，2026-10-05 15:20:35 UTC | 利用多个 session 之间反复切换的局部性，避免每次都像首次进入。 |
| 用户 ordinal 8023，2026-10-05 16:07:52 UTC | 普通切换回来应显示最新内容；用户明确否定把这种切换解释成恢复旧阅读位置。 |
| 原 HAPI `docs/chat-experience-contract.md`“验收条件”；`docs/plans/tmux-workspace-implementation.md:144` | 受控、同宽、静止补页每帧锚点误差不超过 1 CSS px；手势期间检查程序滚动是否违背用户意图。宽度改变按语义连续性判断。 |
| 原 HAPI `e2e/history-continuous-preload.spec.ts:48-54` | 测试门槛：窗口不超过 800 条、挂载不超过 40 行、空白帧为 0。它们是该实现的回归门槛，不是用户给所有实现指定的常数。 |
| 当前 HAPI DSH `docs/ui-acceptance.md` | 150/500ms 缓存目标、帧间隔 p95≤50ms/max≤200ms、手机尺寸门槛另有来源，不能称为上面历史用户原话。 |

原 HAPI 文档记录过 Pixel 9 的补页后 100 帧最大偏移约 0.19 CSS px，以及刷新后的 60 帧位置不变。这是当时、当设备、当构建的历史测量，不是当前 HAPI DSH 已达到的结果。

## 关键提交与机制

| 提交及源码 | 解决的具体竞争 |
| --- | --- |
| `7e8383e0`，hongwen000；`web/src/chat/nativeViewport.ts:303-306` | HAPI 自动分页可能发生在手势中，所以 `beginPaging()` 只停止旧 preserve，不采用官方显式按钮在请求时锁住旧行的策略。 |
| 同提交；`nativeViewport.ts:133-154` | `rowRect.top - viewportRect.top + scrollTop` 是行的文档坐标。它不变而 scrollTop 变化，说明是手势或惯性；立即释放旧锚点。读者离开末尾后立即恢复浏览器锚定，不等 500ms 的阅读采样。 |
| 同提交；`nativeViewport.ts:208-223`；`NativeCodexThread.tsx:64,175-177` | 网络完成不等于可以恢复请求开始时的位置。在发布前建立保留任务，在 React DOM 变更边界再次读取旧 DOM 当前阅读位置，消除并发渲染期间积累的手势位移。 |
| 同提交；`web/src/chat/dsh/use-chat-navigation.ts:129-151` | reader movement 释放 preserve；reading sample pending 时不得 preserve；仍在加载的分页只在实际滚动停止后重新捕获锚点。 |
| 同提交；`nativeViewport.ts:76-82` | 输入回调可能晚于 compositor 移动。先读取当前几何，立即停止旧任务，并把已发生的移动交给 Reading，避免一次布局提交先跟随旧 tail。 |
| `55166cf8`，hongwen000；`HappyThread.tsx:137-146,860-870,997-1010` | 已在末尾的轻触不应脱离跟随。只取消真实进行中的 tail 导航；离末尾 24px 内的轻微挪动不产生“回到运行中”提示。 |
| `a6f302eb`，上游既有修复；`HappyThread.mobile-scroll.test.tsx` | 手机原生 pan 会先产生 pointercancel，再产生 scroll。pointercancel 不代表用户没操作，也不代表惯性结束。 |
| `01bffa3c` 与既有基础样式；`web/src/index.css:296-325,345-357` | html/body 使用视口高度与 `overscroll-behavior:none`；聊天存在时根层 overflow hidden；实际纵向滚动容器使用 overscroll contain，阻断传播到浏览器刷新。 |
| `f7a40bd5`，上游既有修复；`web/src/index.css:542-549` | 移除消息 `content-visibility:auto` 的粗估高度替换，避免旧消息进入视野时改变 scrollTop。当前检查的 HAPI DSH 官方 chat/conversation 包没有该属性，故不能把它当作已确认的当前根因。 |

原 HAPI 的 `native-thread.css:1-4` 还有一项配合：阅读时允许浏览器锚定，跟随末尾时禁用，虚拟 spacer 排除出锚点候选。不是对整个正文永久设置 `overflow-anchor:none`。

## 当前适配差异与最小修复方向

1. **自动调用显式分页按钮。** HAPI DSH `src/client/seamless/controller.ts` 在接近历史边缘时调用官方按钮。当前安装包 `@deepseek-ai/dsh-client-ui-chat/lib/client.js:672-674,2280-2284` 的按钮会保留旧分页锚点并暂停 follow。这与原 HAPI 专门避开的手势中分页策略不同。优先避免在手指拖动或其惯性中再次发动这类显式导航；滚动结束后检查是否仍需要补页。已经在途的请求必须另测，不能只证明“不新开请求”。
2. **自有 replace 恢复可能重新夺权。** 修复前 `src/client/reading-view.ts:214-227` 在 retained window replace 后立即创建 reload 定位；只有新的 wheel/touchstart/pointerdown/keydown 才取消。touchend 后的惯性和晚到 replace 需单独处理，不能把旧书签的恢复当作新的用户导航。
3. **浏览器刷新边界缺失。** 官方 conversation 包没有正文 overscroll 规则；自有根层也缺原 HAPI 的完整边界。修复根页面和正文、侧栏的 overscroll，保留触摸缩放，不通过全局 touch preventDefault 解决。
4. **额外读取会占用手势主线程。** 自有 reading-view 每个 rAF 做阅读候选几何查询及可能的 sessionStorage 写入，官方另有其采样器。应区分“恢复必须有的身份”和“每帧更新书签”，保持可见局部采样；不能为了测试又扫描全部已保留节点。

这些是源码级风险路径。哪一条对应用户当下的弹跳，仍需同轮事件与位置轨迹证明；不能从实现差异直接宣称复现。

## 必须补足的过程回归

- 手指拖动结束不等于滚动结束。记录 touchend 后仍有真实位移的惯性段，再在其间让分页提交、图像/工具输出增高、源窗口 replace。测试必须证明确实存在抬手后位移，不能仅等待固定 400ms 就称为惯性覆盖。
- 覆盖 pointercancel 先于 scroll、外层惯性期间内层工具区 scrollend、连续快速反向手势。内层结束不能错误释放外层所有权。
- 受控静止补页逐帧偏移≤1 CSS px；主动手势中允许正常位移，禁止逆向回拉。除帧位置外记录程序性 scrollTop/scrollTo 写入及原因，才能定位“谁拉回了页面”。原 HAPI `e2e/history-reading-anchor.spec.ts:155-191` 已用这种方式检查 wheel 与图片增高竞争。
- 到顶继续下拉，正文/侧栏外层文档不滚动、不重新导航；在聊天短页和加载空页也重复。桌面移动模拟只能证明网页边界，Android Chrome 的刷新 UI 仍须实际设备闭环。
- 长工具内容应同时检查内层和外层 scroller，避免手势全部被内层消费而外层断言空通过；补页前后核验同一句/同一节点身份。
- 已读区域往返历史请求为 0，正文无空白、重叠；新消息到达不得拉走历史阅读位置。普通 sidebar 会话切换仍按用户要求回最新，不混淆为同一页面重连恢复。

原 HAPI 的现有触摸回归本身也有边界：`e2e/history-prepend-stability.spec.ts:36-38` 在最后一次移动后停 120ms 才抬手，并在停稳到顶后释放页面。它证明停稳补页稳定，不能直接作为强 fling 与在途页面并发的证据。本轮应补这个缺口，而不是原样复制测试。

## 本轮已复现的自有阅读恢复竞争

`tests/client-source-reading.test.ts` 调用真实 `bindPaneReading`，使用显式的 DOM、时钟和 Session 边界替身。修改前 7 项中 3 项失败：持有触点时的 replace、抬手早于首个 compositor scroll、无 scrollend 时的连续滚动都会立即启动旧锚点的 `loadThrough`。

局部修复后，只有隐式 replace 恢复等待手势及外层滚动结束。轻触没有滚动、旧浏览器没有 scrollend 时使用可被滚动续期的 180ms 静默窗口；真实惯性等待外层 scrollend，下一 rAF 才读取位置，给官方监听器完成阅读状态更新的机会，新输入或滚动会取消该 rAF。内层工具区的事件不能放行。读者继续移动且旧行仍在当前 DOM 时更新为停稳后的书签，已滑到底部则结束旧恢复；旧行被 replace 移除时保留原书签，静止重连仍执行恢复。新明确导航优先，隐藏 pane 不会永久等待已经消失的手势。

最终定向测试 13/13 通过，与已有功能契约合跑 21/21 通过，客户端类型检查通过。这些是逻辑验证；移动浏览器、实际 fling、截图和生产验收由同轮独立测试任务负责，本文不把替身测试视为已经完成这些验收。

## 在途分页与下一手势的真实复现

后续移动浏览器测试发现原指标只比较连续两帧中仍可见的行，恰好漏掉被整个补页推到屏幕外的旧行。改为保留一个仍连接的旧 HTMLElement 后，360px 页面在 600ms 延迟分页和下一次持触拖动相遇时出现 **1903px** 单帧位移。其中 1840px 是新页高度，63px 是真实手指位移；不是截图视觉猜测。证据文件为 `touch-360-1792774063478.json`，位于临时视觉验收目录。

对照测试证明抬手后的真实惯性已有正确的浏览器锚定：同样的 1840px prepend 由浏览器补偿，旧行只随惯性移动 66px，补页后仍继续滚动。因此修复只接管“本控制器自己的请求在途，且新的可信正文触摸已让官方释放旧锚点”的持触阶段。通过三次局部命中测试保留一个当前旧行，以 `rowTop + scrollTop` 的变化扣除真实手指运动；仅在确认头部 prepend 时写入一次。没有新增全部历史节点扫描，也没有替换官方 Conversation。

手指离开即删除临时 CSS marker，将惯性交还浏览器；外层 scrollend、工具/导航按钮、新 wheel/key 输入、源替换与卸载也会释放。marker 不写官方 inline `overflowAnchor`，故不会恢复旧值而覆盖官方新任务。普通分页和正常惯性没有自有补偿。

首轮真实回归中，旧行最大位移从 1903px 降为 63px，正文无空白、无逆向回拉；在途页落入真实 fling，以及持触停顿后同一手指继续拖动的两项也通过。360px 的同轮测试仍出现 216.6ms 单帧，超过现有 200.2ms 门槛，因此该轮整体保持失败，不能据此宣称全部性能验收完成。最终构建与完整回归结果以同轮验收报告为准。

独立运行随后再次暴露 1840px 跳跃。固定请求交付时机及触摸起点后，`touch-inflight-process-button-1792776482961.json` 明确记录了近顶部从 process heading 按钮起拖：touchstart 时 scrollTop=91，既不是编辑器也不是内层滚动；第十次移动到达顶部后旧页提交，marker 从未建立，也没有提前失败结案，旧行从 46px 跳到 1886px。这是自有过滤器把“可点击”误当成“不能开始拖动”。修复只改为排除实际编辑器，允许按钮、链接和 contenteditable=false 起拖；touchend 仍早于点击动作释放所有权。该确定用例与真实惯性、持触停顿回归分别保留，不能靠普通滑动偶尔通过代替。

修后该确定用例已完成红绿对照（`touch-inflight-process-button-1792776682706.json`）：保留旧行偏移从 1840px 降为 0，同一手势实际移动从 91px 增至 331px，空白与逆向回拉为 0，最大帧间隔 100.1ms。事件轴确认先建立 marker、提交时 scrollTop 从 0 补到 1840、同一手指继续拖动；这是该竞态的验证，完整移动与冷启动套件另行验收。

独立 360px 回归还定位了提前结束分页的另一条路径（`touch-360-1792776903460.json`）。请求时有 148 个锚节点；实时尾部更新后变为 147 个，但 earliest key 仍是 turn175 的输入，原头部 HTMLElement 仍在 index 0。旧 `resynced` 仅凭数量下降就宣布 window-reset 并撤掉保护，随后真正的 prepend 才到达，导致 1840px 跳跃。最小修复要求“数量下降且最早身份改变”才认定窗口重置，普通 live-tail 收缩继续等待；原 prepend 成功条件保留。进度 probe 另合并为一次结构查询，不再读取未使用的几何 offset；这项消除冗余的修改不是对 216.6ms 长帧根因的断言。三项新增逻辑回归分别覆盖 live-tail 收缩、真正替换/清空窗口及无布局读取的结构 probe。

另外确认了独立的公开 API 竞争：固定版本官方 `loadThrough(seq)` 在 `loadingOlder=true` 时会直接返回已解决的 Promise，调用方不能把它当成定位历史已经加载。`history-navigation.ts` 通过公开 Session 订阅等待 busy 结束，并在同一同步调用内检查状态和发起定位；取消、删除与绑定替换会结束等待，且不会取消其他视图的共享分页。重连会在 loading 状态先发布替换窗口，因此还须等待其 open 通知。这项逻辑与弹跳或 216.6ms 长帧归因分开验证；7 个公共等待测试与阅读、锚点和分页测试合计 69 项通过。

## 后台插件激活与手势竞争

修复窗口误判后的独立 360px 回归，earlier 的旧锚跳跃为 0，later 的 62px 为真实运动，最大帧间隔分别为 150ms、116.7ms，未出现 reset 或 failed（`touch-360-1792777249384.json`）。随后完整 10 项中 9 项通过，唯一失败是展开工具后的 later 滑动出现 216.6ms 帧间隔；当时没有 prepend、正文高度变化或锚点跳跃。因此这项长帧不能再归因于分页补偿。

测试代理的短 CDP trace 找到了另一项实际工作：手势期间多个 `/plugins/?rev=…` 的 load 回调衔接官方导入与全局 React 更新。load EventDispatch 达到 76–129ms，其中 React FunctionCall 为 50–98ms，另有最高 24ms 的样式更新。原 `installDeferredPlugins` 只在整批 `entries.sync(fullGraph)` 开始前等待前台空闲；它开始后，后续插件即使在新手势中下载完成，也会接着激活。

候选修复仍使用官方 `entries.sync`。`deferredBootStages` 生成依赖闭合且单调累积的 graph，每一阶段保留已有条目身份，只增加一个可延后条目及其依赖。阶段之间先让出宏任务，使新触摸事件有机会进入，再检查前台空闲。HMR 及依赖它的可延后条目放在最后的完整 graph，防止其更新流提前恢复整批加载；如果首屏必需条目实际依赖 HMR，真实依赖优先。显式打开 panel 则在当前阶段完成后直接协调完整 graph，不增加新的按需路由系统。

这个边界不会中断已经在途的单个插件，也不声称消除所有长任务。官方同步失败会进入既有错误报告与清理通道；单个插件的 state failure 仍由后续累积协调及最终状态检查处理。卸载会取消后续阶段，并清理自有前台活动监听。新增逻辑回归覆盖阶段完成后新手势暂停、主动打开 panel、卸载及拒绝；冷启动回归固定 account 插件在途后再持触，核验同阶段允许完成、后续阶段暂停、原编辑器与草稿保留。旧构建上的负对照已在 account 返回后持触的 900ms 内捕获 13 个后续阶段请求，包含 HMR，证明测试确实命中原漏洞。

本轮集成已通过类型检查、全量 micro（1126 项，1125 通过、1 跳过）及完整构建。完整移动与冷启动 10 项正在对该构建验收；最终浏览器结果仍待该轮报告，不能把以上逻辑和构建 gate 当作手势帧门槛已经通过。

同一 Session 多 pane 的定位优先规则还补了一处终态处理：失败的显式目标不再持续占有初始背景补页资格；保留目标供重试，同时允许普通兄弟 pane 补足上下文。`ready`、`error` 和 `reader` 都是终态，只有正在定位或尚未处理的显式目标需要让背景任务等待。这项修复不取消其他 pane 的共享分页。
