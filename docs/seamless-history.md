# 无缝历史加载（seamless history）

官方 DSH Conversation 只在顶部提供一个手动 "加载更早 / Load earlier" 按钮；到顶后继续上滚不会自动翻页。本插件（`src/client/seamless/**`）在读者接近顶部时自动驱动这个控件，保留官方分页与锚定实现。首次打开会话另有有界预取：如果官方窗口尚未包含两轮，就在首屏绘制机会之后补入上一轮，避免最近一轮以外的内容看起来消失。

## 为什么驱动官方控件

官方 `use-chat-navigation` 的 `loadEarlier` 会依次 `cancel()`、`viewport.beginPaging()`、`reading.pauseFollowing()`、`input.loadOlder()`；`beginPaging/preserve` 负责把首个 `[data-chat-paging-anchor]` 行保持在同一视口位置。读者向上浏览时需要这层导航和锚定，因此手势路径自动化官方按钮，不替换 `conversation.view` / `chat.flow`，也不重写 ChatView。

首次打开的预取目标不同：让上一轮进入已保留窗口，同时继续跟随最新输出。自动点击按钮会调用 `pauseFollowing()`，因此预取使用显式 `SessionReference.binding.session` 上的公开 `loadOlder()`，跳过按钮的导航动作。历史仍由官方 Session 加载、合并和渲染；本插件不写 `scrollTop`、不移动焦点，也不读取或修改 composer 草稿。首次预取的浏览器行为验证属于本轮新增验收，不能沿用此前手势路径的通过记录。

这是明确的 DOM 兼容边界：依赖官方 `[data-conversation-scroll]`、`[data-chat-flow]`、`[data-chat-following-tail]`、列内直系按钮结构，以及 `data-pane-id` / `data-hapi-pane-visible` / `data-conversation-session`。当前固定版本升级为 `0.2.1-rc.3`；这些结构及手势行为需要按 [rc.3 升级记录](dsh-rc3-upgrade.md) 重新验证。结构变化导致 helper 找不到控件时，自动路径惰性降级为官方手动按钮，不报错、不阻塞界面。

## 向上浏览的手势策略

- 只响应**向上意图**：scroll（真实输入或滚动条拖动）、wheel、touch 方向采样、keyboard（仅滚动容器内且焦点不是 input/textarea/contenteditable）。
- 近顶部阈值 `min(clientHeight, 600)` px；`data-chat-following-tail` 存在（tail following）时不触发；正文选区或正文指针拖选视为读者固定。composer 保留焦点不阻断正文滚轮分页，但编辑器内的键盘输入不作为分页手势。
- 单 surface 单飞；burst 上限 3 页 / 1200ms；跨 pane 聚合并发 2、启动 4 次 / 1000ms（超出丢弃、等下一次手势，不排队）。
- 每个手势最多自动翻一页；开始前重新读取官方控件，`disabled`（= 正在加载）时绝不点击。
- 可信触摸打断官方分页锚时，如果更早按钮已经处于 loading，也观察该在途页。因此手动点击和官方预取同样能保留正在阅读的位置；观察过程不发请求，不占用或释放自动分页槽位，不增加自动页数。源失败仍由官方路径处理。
- 成功判定不依赖按钮 re-enable：记录顶部锚点身份与行数，只有**顶行变化且行数增长**才算前进；自动请求超时或按钮已可用但无 prepend 记为 `no-progress`；只有行数下降且顶行身份改变才视为官方窗口 reset，直接重置状态且不做补偿。
- 失败冷却 1s×失败次数（上限 4s）；连续 3 次失败 `suspended`，停止自动加载；手动翻页成功后自动恢复。`data-hapi-seamless` 取 `error | suspended | limit`，并通过 `hapi-dsh:seamless-history` CustomEvent 提供给诊断层（失败事件有节流，不会形成 click loop）。
- 每 host+session 自动加载页数上限默认 20（可配置），到限后停止自动、保留手动按钮。官方 retained window 没有 trim API，手动翻页仍可无限增长；这是被显式接受的限制。

## 首次打开时补入上一轮

`initial.ts` 的 `bindInitialHistory(target, reference, visibility)` 绑定一个明确的官方 Session reference。它等待 reference ready、会话状态为 `open`、窗格可见后，在下一次动画帧后的任务中检查公开 `eventSource`，给初始正文和 composer 留出先绘制的机会。隐藏窗格不会启动预取，也不会为了预取扫描事件窗口。

- 完成条件是最近两轮均已有 `turn/start` 和原始输入，或官方 `hasMore` 已为 false。没有更早历史的短会话不增加请求。
- 2026-10-22 性能修正：初始补页恢复为最多两页；窗口已有 1500 个协议事件时也停止预取，避免工具密集的长 Turn 持续占用渲染。达到预算标为 `limited`，向上阅读、手动翻页和精确定位仍可继续加载。
- 每个 Session generation 最多发起 **2 页**初始预取。此前核对的 `0.2.1-rc.2` 官方 `loadOlder()` 每页最多读取 **500 条 append-origin user/assistant message**；`turn/start`、步骤、工具等协议事件不按此消息上限逐条计数。该版本的官方页还尝试满足至少 50 条消息、跨越两个 Turn starts，500 条上限或历史耗尽优先结束该页。这组上游分页语义保留为 rc.2 记录，不能直接当作 rc.3 已核实的行为。
- 两个 pane 绑定同一个 Session face 时共用初始预取计划。官方 `loadingOlder` 继续承担同一 Session 的单飞；预取与手势路径还共用 `shared.ts` 中的跨 pane gate 和 host+session ledger。全页聚合上限仍为并发 2、每秒启动 4 次；成功向前扩展的自动页都计入默认 20 页上限。聚合并发不足时，初始预取可在槽位释放后继续；手势请求仍等待读者的下一次手势。
- 每页完成后检查事件窗口头部是否向更早的 seq 前进。只有 live 追加、没有更早内容时不能算成功补页；失败或无进展停止初始自动尝试，不形成后台重试循环。手动按钮和既有手势分页仍然可用。
- 窗格内发生滚轮、指针、触摸或键盘输入后，不再继续初始预取。已发出的共享读取正常完成，不取消其他 pane 的请求，也不打断源执行。
- 关闭 occurrence 或销毁共享 Host 会移除该 occurrence 的订阅和监听器。已经关闭的 reference 后续 ready/reject 不得修改其他 occurrence 的共享计划；外部 pane owner 仍负责释放 reference。

surface 上的 `data-hapi-initial-history` 为诊断标记，值为 `waiting | loading | ready | limited | error | reader`。`ready` 只说明当前官方窗口已满足上述条件；它不证明原生源历史已完整回填。超过两页仍不足两轮时标记 `limited`，保留手动和手势加载，不能宣称任意大的 Turn 都已自动展开。

这一路径只读取 **DSH Host 已有的 journal 页面**。如果 Host 的 200 条 tail seed 尚未完成源历史 backfill，那么缺失内容还不在该 journal 内，公开 `loadOlder()` 无法提前取出。后台回填及 display generation 替换的完成时间仍是独立边界，见 [live-history.md](live-history.md)。

## 集成与验证

以下通过数量和位移测量记录于 rc.2 阶段，尚不能作为 rc.3 升级通过的证据。升级后还需覆盖触边继续拖动、手动加载后再次触摸、抬手间隙到页和在途惯性等手机回归。

- 页面级安装一次：`src/client/index.ts` 在 `installWorkspace` 的 disposers 段调用 `installSeamlessHistory(document, …)`，覆盖 local 与 remote Host pane。初始预取在 `surface/session-view.tsx` 的共享视图和 `federation.tsx` 的兼容 chat 视图上绑定显式 reference，并在释放前清理。
- 本轮定向单测：`tests/client-seamless-history.test.ts` **36/36 通过**，新增可见性/open 条件、两页上限、真实 Turn 计数、失败不重试、读者接管及聚合释放通知。`tests/client-one-graph-session-view.test.ts` **5/5 通过**，保留官方 SlotRegistry 生命周期验证，并覆盖订阅清理及已关闭 reference 不污染存活视图。Session/DOM 部分明确是协议夹具，不作为真实浏览器集成证据。
- 本轮 `e2e/seamless-history.spec.ts` 两条专项已通过：新增初始预取用例使用三轮、每轮 520 条合成 assistant 条目及原始输入，实际自动读取 **2 页**，上一轮输入和回答出现，继续 tail-follow，源发送为 0；既有上滚分页用例也通过，锚点相对位置 **44 px → 44 px**，单次请求、不空白。两条均使用真实 pinned DSH retained window。其余慢页/失败恢复/reload 用例没有在本轮重新运行，不能沿用旧批次结果宣称整份 spec 已通过。
- 上一批 R7 的定向 e2e 记录为 5/5：顶部手势分页和锚点偏移 |Δ|≤2px、无空白帧、单次请求、慢页单飞、失败冷却/恢复、连续失败 suspend 后手动恢复、reload 后单手势单请求。其 live 探针曾使锚点行从 104 增到 216，无 400、无只读，手动按钮仍在；这些保留为历史证据。

## 已知残留

- DOM 兼容边界（见上），上游结构变化时自动降级为手动按钮。
- 触摸板惯性/overscroll 真机、真实拖选、同一会话两个 pane 的聚合 fairness、remote Host pane 的 Hub 隧道延迟，需人工/真机补充。
- 全量历史 seed 导致长会话开窗慢属于 projection/transport 层，本插件不解决；滚动加载的页来自 DSH Host journal 页，不发起新的 HAPI 读取。
- 极大 Turn 可能用完两个初始页仍未到达上一轮；Host source backfill 尚未完成时也可能暂时无法补齐。初始预取不取消这些明确边界，也没有新增 retained-window trim 能力。
