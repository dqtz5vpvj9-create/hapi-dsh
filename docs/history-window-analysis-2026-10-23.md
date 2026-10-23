# 初始历史窗口：静态结论与固定切点测量

目前不能把 `20` 改成 `4` 或 `2` 就宣布首屏问题解决。较小 follow 可以减少传输、JSON 解析和首次 Conversation 投影，但随后的官方 `loadOlder()` 仍按最多 500 条正文取页。首帧刚显示就补一大页，可能把节省的处理量立即补回来。以下为源码结论；20/4/2 的生产固定切点测量仍待会话选择成功，尚无收益数字。

## 公开接口和实际顺序

Pinned `@deepseek-ai/dsh-api-session-controller` 为 `0.2.1-rc.2`。

| 环节 | 当前行为 | 可用边界 |
| --- | --- | --- |
| `session.follow` | 本仓库 `src/shared/history-window.ts` 将官方 500/50/2 请求限为 20/20/2；先收到完整 snapshot，再发布实时事件。 | 请求公开支持 `maxMessages` 与 `turnWindow`；修改时仍由官方选择连续范围。 |
| `session.page` | 本仓库 `src/codex/session-controller.ts` 原样委托官方；请求有 `throughSeq`、`beforeSeq` 和消息/turn 预算。 | `throughSeq` 来自对应 follow opening；同切点比较时固定 `beforeSeq=throughSeq+1`。 |
| 普通 `loadOlder()` | 官方客户端固定 `maxMessages=500, minMessages=50, minTurns=2`。 | `ISession.loadOlder()` 不接受预算参数；不能在调用处传一个更小值。 |
| 精确 `loadThrough(seq)` | 每页仍上限 500，但最少消息数改为 200；直到覆盖目标，最后一次性发布已取得的旧页。 | 不能混同为普通背景补页；已有 `loadingOlder` 时当前实现直接返回。 |
| 初始补上下文 | `src/client/seamless/initial.ts` 在 `reference.ready` 后经 rAF 和下一宏任务补页，最多两页，已有事件数达到 1500 即停止；读者手势中止后续自动补页。 | 已有首屏正文不显式等待上下文补齐。1500 是发起前门槛，不会把已返回的大页截成 1500 条。 |

接口出处为官方 `lib/types/types.d.ts:467–550`，`lib/types/client/contract/session.d.ts:120–140`；实现为 `lib/index.js` 的 `SessionHistoryController.page/follow` 和 `paginate`，`lib/client.js` 的 `HISTORY_PAGE_OPTIONS`、`JUMP_PAGE_OPTIONS`、`loadOlder`、`loadThrough`。

`paginate` 只数 append-origin 的 `user/message`、`assistant/message`，并返回完整连续范围。达到 `maxMessages` 时会立即截断，`minTurns=2` 不能保证两轮已经包含。消息引用 `sourceEventSeqs` 时还会把范围扩至较早原始事件。因而消息上限不是字节上限，也不是所有事件数量的上限；长 turn 中夹着的大量旧插件状态仍可能随 2 条正文一起返回。没有公开的 record-type 过滤、插件排除或字节预算，不能通过过滤旧事件来假装连续历史仍完整。

## 最低首屏策略

先区分“可读的最新正文与输入框已出现”和“当前、上一轮上下文已经补齐”。普通打开应尽快达到前者，然后在读者空闲时继续取得后者；上下文未齐必须保持真实状态，不能把预算耗尽写成完成。已有源投影、审批、队列和实时订阅必须随开口保留，不能为了瘦身丢掉当前事实。

下一步先测量相同历史切点的 20/4/2。如果 4 条显著减少记录和字节，可优先验证 4 条作为最新视口的候选；2 条可能只有两条连续助手消息、缺失本轮用户输入，不能仅凭更少字节选择。两者都需要覆盖短轮、单个极长轮、工具密集轮和替换来源事件的样本。消息计数配置应使用同一个公开 pager，不能另造正文缓存去拼接官方实时流。

缩小初始 follow 必须与补上下文策略一起验收。仅把自动补页延后一个固定时间不能消除成本，只是挪动卡顿。目前可在本仓库公开 controller 委托层试验较小的普通 page 预算，但这会同时影响背景补页和读者翻页；两种调用都使用同一 500/50/2 请求，接口没有 caller-purpose 字段。精确定位的 500/200/2 必须保持。较小普通页也可能使现有“两页”预算达不到上一轮，所以不能不经验证就全局截到 20 或 4。若要对自动补页、手动翻页分别传预算，需要上游公开 `loadOlder(options)` 或等价能力，不能修改其私有 Session/window。

## 定位优先与审批

`bindPaneReading`、`SourceMessageNavigation` 通过 `loadThrough(seq)` 实现搜索、深链、通知和重载锚点。源码确认了一个独立竞争：自动 `loadOlder` 先占用 flight 时，后到的 `loadThrough` 可立即返回，调用者却把它当成目标已加载。现已在 initial binding 中加入显式定位优先：同一 Session 任一可见 pane 尚未完成定位时，不发起背景补页；读取 `data-hapi-reading` 完成状态后再评估原上下文计划。保留的已完成 target 不会永久堵塞补页，隐藏或卸载 pane 也会释放阻塞。6 项独立绑定测试通过；20/500 参数未改。

这不能撤销已经在途的页。阅读层现已通过 `src/client/history-navigation.ts` 的 `loadHistoryThrough` 统一等待公开 snapshot 中 `openState=open` 且 `loadingOlder=false`，并在同一同步调用中取得历史 flight；`reading-view.ts` 和 `source-navigation.ts` 都已接入。取消或换代会清理等待订阅、抑制过期定位完成，不会取消其他读者共享的在途分页，也没有操作上游私有事件窗口。

`tests/client-history-navigation.test.ts` 的 7 项逻辑回归已通过，覆盖已有分页占用、等待时取消、binding 换代、源删除、重连先发布窗口后变为 open、较早订阅者抢占空闲 flight，以及取得 flight 后取消。该夹具重现 pinned 官方忙时立即返回的行为，属于公开协议边界测试，不等同浏览器或生产历史定位验收。

当前原生审批列表来自完整 `hapi`/`hapiObserved` 投影的 `pendingRequests`，由 `native-actions.tsx` 渲染 `data-hapi-request-id`；审批导航查找该卡片，不依赖把旧审批日志整段加载到正文。缩小历史窗口不能省略投影，也不能把源端最终结案语义改成本地推测。消息目标仍需完整的源消息到显示序号映射及官方定位，不能改成默认跳到末尾。

## 探针与验收边界

`scripts/probe-history-window.mjs --run` 读取本机 launch 文件完成认证，只接受内存中的既有 display session。一次官方 follow opening 取得切点后立即取消，再串行读取 20/4/2 的同切点 HTTP page，各自补一页官方 500/50/2。请求使用 pinned 生成的输入和结果 schema，并校验页内及补页衔接连续性。输出只有固定分组数量、JSON 字节与耗时，不保存身份、正文、凭据或 URL。

补 500 条是潜在成本测量，不声称真实 UI 一定自动补这一页。实际还有上一轮已齐、1500 条门槛、读者手势和显式定位等条件。follow 可能温热 Host 的历史读取，因此这些 HTTP 用时不等同冷 Host 或冷浏览器导航；Node 的 JSON/schema 用时也不能代替浏览器投影、React、布局和绘制。最终还须用同一构建测可见正文、可用输入框、上下文完成、主线程长任务，以及补页遇手势和深链的行为。
