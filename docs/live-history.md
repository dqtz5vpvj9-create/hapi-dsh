# Source history / live 连续性

本页记录 2026-10-22 的实现与验证边界。它描述仓库代码和固定版本 DSH 的协议夹具测试，不代表已经对生产 Hub、真实活动会话或远端隧道完成验收。架构 A 的 Client graph 复用另见 [one-graph-spike.md](one-graph-spike.md)。

## 1. 从实际代码修正根因

交接中“读完 history 才订阅 SSE”的描述不能直接套到当前 Host 服务：`CodexService.start()` 和 `HapiAgentService.start()` 在 catalog discovery **之前**已经调用 `transport.subscribe()`。`HapiClient` 的订阅是全局源事件流，会话 attach 则由服务按 source id 排队。因此这次没有为每个 pane 新增一条 SSE，也没有改变原生执行所有权。

实际需要修复的窗口在订阅之后：

- 首次创建 Agent 仍要等待完整 `readNativeHistory()`。在 Agent 尚未发布时到达的消息必须被保留，并与当次 REST snapshot 合并。
- 历史失败时原有缓存可能缺少末尾若干消息；仅接着处理未来 SSE 不能证明中间连续，必须明确 stale 并自动对账。
- 源历史刷新过去占用该 source 的异步事件队列，较慢的历史分页会推迟已经收到的实时消息。
- REST 返回与内容资源准备都包含 `await`。在这些等待期间，live 更新、rewind、删除、原生 identity 变更都可能使旧 snapshot 失效。
- DSH 的已发布 Session 是有序、追加的事件记录。发现较早的缺失消息或已提交正文修正时，需要现有的 display generation 替换机制，不能在原有事件序号之前偷偷插入内容。

相关实现：`src/codex/service.ts`、`src/hapi-agent/service.ts`、两种 `agent.ts`、`src/codex/history.ts`。原有 epoch-stable 分页与 snapshot-head 终检继续使用；本次未修改上游包或 Hub 协议。

## 2. 收包 journal 与合并规则

`SourceHistoryJournal` 在服务收到事件时同步 capture，先于异步 source 队列执行。每个实际接入的 source 有独立的内存 journal；它服务于整个 Host 的会话观察，不随 pane 新建。已确认不属于该服务的 source 会释放 journal，避免两个 source 服务长期保留相同的消息正文。

一个 history checkpoint 包含 journal generation 和接收序号。读取历史前获取 checkpoint；拿到 REST 结果、进入串行 projection 工作、内容资源准备完成后以及注册新 Session 前都验证它。`messages-invalidated`、`session-removed` 和带 `resume: gap` 的重连形成结构屏障。屏障之前的读取不能在屏障之后作为权威历史发布。

合并按原始 source 时间/序号排序，并使用源 identity 去重：

| 数据 | 合并 identity / 规则 |
|---|---|
| Codex message / reasoning 累积流 | `content.data.id`，把临时 transport row 与最终 durable row 连到同一 stream |
| 其他有 durable `localId` 的消息 | `localId`；transport id 改变不会制造另一条输入 |
| 其余源消息 | 原始 row id |
| 读取期间到达的消息 | 保留在 REST 结果上，不能被较早的 snapshot 覆盖 |
| 读取开始之前收到、REST 尚未索引的消息 | 保留在 live suffix，不能因为不在 REST 页内而删除 |
| 已提交的 stream / 已 invoked 的输入 | 较旧的 provisional / queued 版本不能使其退回未提交状态；缺省 `invokedAt` 也视为尚未 invoked |
| 同一未提交 Codex stream 的累积前缀 | 较短的旧前缀不能覆盖已经收到的较长前缀 |
| REST 对已提交内容的合法修正 | 同一提交状态允许新的源正文；需要时由 projector 请求新 display generation |
| 取消的 queued 输入 | 同时按 transport id 与 localId 从合并结果中移除 |

这是明确的单调状态保护，不是把全部旧 live 值永远覆盖到 REST 上。结构屏障允许源 rewind / identity 变更抛弃旧代际的尾部。没有来源版本的任意正文改写不能仅凭文本长度推断新旧。

增量 projector 也保护同一未完成 stream 的累计前缀：如果初始 REST 已经显示较长正文，稍后排队应用的较短 provisional SSE 不会 abandon 并重开一个更短的 stream。NativeProjector 已有这个保护，本次给 ObservedProjector 补齐。非前缀的正文修正仍会建立修正后的 attempt，final 源正文仍可更正旧 partial；`tests/source-stream-order.test.ts` 覆盖两条路径。

## 3. 有界内存与丢出缓冲后的证明

默认每 source journal 最多保留 **1,024 条事件和 8 MiB 的序列化事件正文**；达到任一上限都会丢出最早事件。预算按 UTF-8 JSON 字节数计算，不等同于 V8 堆分配总量。完整历史读取、已有 DSH Session、内容资源缓存及正在执行的事件队列不包含在这 8 MiB 内。

一个读取 checkpoint 被丢出缓冲覆盖时，该次读取失效，必须重新对账。对于丢出时 source 可能尚未索引的 live 行，journal 额外保留最多 **4,096 条固定大小 hash 证明**，不保留其大正文。新的权威 snapshot 加上仍在缓冲的 live suffix 必须覆盖这些 identity，并保留已提交 / invoked 的单调事实；否则保持 stale，不能声称历史已经完整。

如果证明本身超过上限，系统明确保持 stale，等待结构重新同步，而不是静默假定丢出的行都已进入 REST。该边界也意味着极端长时间断连或持续无法对账不能获得无限缓冲保证。journal 是 Host 进程内存；它不是持久消息数据库，也不代替 Hub 的源历史。

实现和边界用例见 `src/codex/history-journal.ts`、`tests/codex-history-journal.test.ts`、`tests/codex-history-races.test.ts`。

## 4. 非阻塞刷新、stale 与重试

两种 Agent 用 `SourceHistorySync` 将只读 history reconciliation 从 live 事件队列分离。`message-received` 仍按该 source 的顺序投影；`message-updated`、无消息正文的 delivery 更新、history invalidation 和重连请求后台刷新。普通 metadata 更新不再无条件分页完整历史。

相同 source 的刷新请求合并为单飞；两种服务共享最多四个后台刷新槽位。请求在刷新期间再次到达时最多安排必要的后续刷新。失败不会清除 stale；无后续 SSE 时仍会自动重试，初始间隔 1 秒、指数增长到最多 30 秒。计时器仅触发读取，不 dispatch 消息、不自动批准、不 resume 或 abort 原生执行。

内容投影也有自己的顺序队列。历史读取不占用这个队列；读取完成后才排入合并、资源准备和 projector 更新。内容准备期间出现结构屏障会拒绝旧结果；它不会先追加被源删除的正文再等下一次刷新修复。

源暂时不可用时仍可显示已缓存的历史，但 projection error 明确表明它 stale、正在对账。既有 inactive/history/fault 的输入语义继续保留：这些状态本身不会重新把 composer 锁成只读。已删除或被退休的 source lifetime 会立即拒绝新输入；这与可恢复的源离线状态不同。

## 5. Source 生命周期与 display 替换

源删除在收包时就退休其 lifetime；慢速的首次 attach 即使之后成功读出旧历史，也不能注册已删除的源。过期 catalog 不能撤销删除。只有明确的 `session-added` 才能开启新 lifetime。

删除紧接着重新添加也按 incarnation 处理：排队的 removal 只 dispose 当时捕获的旧 Agent，不会删除后来创建的新 Agent。每个新 incarnation 使用新的 display revision，避免重复已公布的事件序号空间。`detachSource()` 使用同样的退休规则。pane 关闭仍只释放显示绑定，不能终止原始执行。

当完整历史要求重新 seed 时，服务把替换登记为一次 attach，receive journal 继续收包。**先 dispose 旧 Agent，再创建新 Agent**，确保同一 source identity 的 durable delivery journal 和 approval journal 始终只有一个可写 owner。失败重试属于服务，独立于已经 dispose 的旧 Agent：获取 source、资源导入或注册准备暂时失败后，不需要下一条 SSE 才能恢复。

每次失败的创建尝试都会消耗 display revision；已经 announce 的 namespace 不会重用。旧 display 到新 display 的 reset 通知保留到恢复成功后。删除会取消这项重试和待通知的 reset。所有这些操作只重建观察，没有创建新的 native thread 或接管 Runner。

## 6. 首屏策略：生产显式启用 `fastHistorySeed`

`9e459db` 检查点使用完整初始 history；`58800d1` 随后在生产 composition 显式启用快速 seed。当前行为如下：

| 路径 | 默认行为 |
|---|---|
| 生产初次 source attach | 先发布 stale cache；没有缓存时先读取有界最新 200 条页，再后台补齐 |
| 初始读取失败 | 显式 stale cache fallback，并自动后台对账 |
| 已发布会话的 history refresh | 后台读取，实时事件继续进入当前 display / journal |
| 未传入参数的 agent/service 构造 | 缺省 false，仍等待完整且 epoch-stable 的初始 history seed |

`fastHistorySeed?: boolean` 是 `NativeCodexOptions` / `HapiObservedOptions` 及相应 service options 的**内部构造参数**。测试或受控嵌入可传入：

```ts
const codex = new CodexService(ctx, transport, {
  stateDirectory,
  fastHistorySeed: true,
})
```

`src/index.ts` 向 Codex 和 observed 两种 source service 显式传入 `fastHistorySeed: true`。构造参数本身的缺省值仍为 false；现有配置 schema、环境变量和 CLI 没有额外的开关入口。

显式启用后，有缓存时先发布 stale cache；没有缓存时先读有界的最新 200 条页。缓存不足或最新页有更早历史时，随后后台读完整 snapshot、合并 live，并在需要时建立新的 display generation。

缓存仍使用版本 1 的 JSON，新增可选 `complete` 字段。旧缓存缺少该字段按 `complete: true` 读取，以兼容原来完整 history seed 的格式；它不代表相对于当前 Hub 仍然新鲜。部分 seed 和失败 fallback 都不能被误认为已经证明完整。缓存不参与推断 delivery / approval 的实际结果。

此前保持关闭的原因仍然存在：DSH 新 display generation 会重新绑定 Session，官方 rich draft、attachment 恢复和滚动锚点在同一 source 换代时尚没有完整的安全迁移事务。现有跨 source handoff 不能替代这个事务。启用快速 seed 改变了初始读取策略，没有自动解决后续 backfill 换代的状态保护；故障恢复或真实 rewind 也仍有这个限制。

## 7. 验证与尚未宣称的结果

backend 定向验证使用真实的固定 DSH Session、AgentRegistry、projection 和 command 包；Hub、消息、资源导入是明确的协议夹具。覆盖包括：

- Agent 尚未存在时的 live 到达；后台 history 阻塞时的 live 输出；历史/live 重叠和 transport id 去重。
- 缺省构造的完整 seed 不产生常规的稍后 backfill 换代；显式 fast seed 在历史阻塞时返回缓存 / 最新页。
- stale fallback 没有下一条 SSE 也会重试；旧 Agent 已退休后 replacement 准备失败也会由服务恢复。
- epoch / reconnect gap 屏障；异步资源导入期间 invalidation 阻止过期 projection 和 Session announcement。
- pending attach 期间删除、删除后 stale catalog、立即 remove/add；旧 writable owner 在新代际准备前退休。
- 已提交与 invoked 的单调性、短前缀、byte budget、evicted coverage、证明上限。

主要测试：`tests/codex-native.test.ts`、`tests/hapi-agent.test.ts`、`tests/codex-history-journal.test.ts`、`tests/codex-history-races.test.ts`、`tests/source-stream-order.test.ts`。浏览器层的合成活动源验证见 `e2e/live-history.spec.ts`；最终执行结果以 [validation.md](validation.md) 为准。

这些测试没有修改用户真实会话，也不证明生产活动会话刷新、远端隧道时序或 150 ms / 500 ms 性能门槛已经达标。当前生产构造启用尾部 seed，Host 重启仍需读取源历史；首次缓存/尾页读取与 Client graph 启动仍有成本，安全的 rich draft/scroll 换代迁移也尚未完成。
