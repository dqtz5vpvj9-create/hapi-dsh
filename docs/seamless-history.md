# 无缝历史加载（seamless history）

官方 DSH Conversation 只在顶部提供一个手动 "加载更早 / Load earlier" 按钮；到顶后继续上滚不会自动翻页。本插件（`src/client/seamless/**`）自动化这个官方控件，让读者接近顶部时无缝取上一页，同时保留官方分页与锚定实现。

## 为什么驱动官方控件

官方 `use-chat-navigation` 的 `loadEarlier` 会依次 `cancel()`、`viewport.beginPaging()`、`reading.pauseFollowing()`、`input.loadOlder()`；`beginPaging/preserve` 负责把首个 `[data-chat-paging-anchor]` 行保持在同一视口位置。公开的 `ISession.loadOlder()` 可翻页，但绕过了这层导航/锚定包装，需要自己重写锚定；替换 `conversation.view` / `chat.flow` slot 则等于重写官方 ChatView 或跨 graph 混用组件，违反“复用官方 Conversation”的约束。因此这里选择自动化官方按钮：分页、去重、失败复位、锚定全部由上游负责，插件只负责**触发时机**。

这是明确的 DOM 兼容边界：依赖官方 `[data-conversation-scroll]`、`[data-chat-flow]`、`[data-chat-following-tail]`、列内直系按钮结构，以及 `data-pane-id` / `data-hapi-pane-visible` / `data-conversation-session`。pinned `0.2.1-rc.2` 的结构变化时，所有 helper 找不到即惰性降级为官方手动按钮，不报错、不阻塞界面。

## 触发策略

- 只响应**向上意图**：scroll（真实输入或滚动条拖动）、wheel、touch 方向采样、keyboard（仅滚动容器内且焦点不是 input/textarea/contenteditable）。
- 近顶部阈值 `min(clientHeight, 600)` px；`data-chat-following-tail` 存在（tail following）时不触发；有正文选区、正文指针拖选、编辑焦点时视为读者固定。
- 单 surface 单飞；burst 上限 3 页 / 1200ms；跨 pane 聚合并发 2、启动 4 次 / 1000ms（超出丢弃、等下一次手势，不排队）。
- 每个手势最多自动翻一页；开始前重新读取官方控件，`disabled`（= 正在加载）时绝不点击。
- 成功判定不依赖按钮 re-enable：记录顶部锚点身份与行数，只有**顶行变化且行数增长**才算前进；超时或观察到按钮已可用但无 prepend 记为 `no-progress`；行数下降视为官方窗口 reset，直接重置状态且不做补偿。
- 失败冷却 1s×失败次数（上限 4s）；连续 3 次失败 `suspended`，停止自动加载；手动翻页成功后自动恢复。`data-hapi-seamless` 取 `error | suspended | limit`，并通过 `hapi-dsh:seamless-history` CustomEvent 提供给诊断层（失败事件有节流，不会形成 click loop）。
- 每 host+session 自动加载页数上限默认 20（可配置），到限后停止自动、保留手动按钮。官方 retained window 没有 trim API，手动翻页仍可无限增长；这是被显式接受的限制。

## 集成与验证

- 页面级安装一次：`src/client/index.ts` 在 `installWorkspace` 的 disposers 段调用 `installSeamlessHistory(document, …)`，覆盖 local 与 remote Host pane；不修改 federation。
- 单测（`tests/client-seamless-history.test.ts`，29 项）：意图方向、单飞/超时/burst/冷却/suspend/恢复/页上限、锚点 residual 幂等、聚合并发、每会话账本；FakeView 明确标注为 fake。
- 定向 e2e（`e2e/seamless-history.spec.ts`，5/5）：顶部向上手势自动翻页且锚点偏移 |Δ|≤2px、无空白帧、一次手势一个 host journal page 请求；慢页期间多手势仍单飞；失败后手动可用、冷却后恢复；连续失败 suspend 后零请求、手动翻页恢复；reload 后单手势恰好一个请求。
- live 探针：在大历史会话中一次向上手势使锚点行从 104 增到 216，无 400、无只读、手动按钮仍在。

## 已知残留

- DOM 兼容边界（见上），上游结构变化时自动降级为手动按钮。
- 触摸板惯性/overscroll 真机、真实拖选、同一会话两个 pane 的聚合 fairness、remote Host pane 的 Hub 隧道延迟，需人工/真机补充。
- 全量历史 seed 导致长会话开窗慢属于 projection/transport 层，本插件不解决；滚动加载的页来自 DSH Host journal 页，不发起新的 HAPI 读取。
