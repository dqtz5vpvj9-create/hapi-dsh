# 移动端普通文本发送

HHPI 的普通文本提交由 `RemoteSessions` 持有。官方 Conversation 的
`beginSubmission` 在返回 request ID 前同步把不可变文本和 operation ID 写入
认证账户及 Host 对应的浏览器存储。`prompt` 确认同一个内容后立即返回本机接纳，
网络投递由独立 outbox 完成。可选 `inputCommitPolicy: after-acceptance` 使官方输入框
在接纳成功后才清理本次草稿；存储配额不足不清空编辑器。

每个会话按本机接纳顺序发送。断线、刷新和关闭 Pane 不生成新 ID，也不取消已经
保存的点击意图。尚未点击发送的输入继续由官方草稿持有，不进入 outbox。
浏览器明确离线时暂停网络尝试；online、pageshow 和重新可见时恢复。

官方 pending submission 展示消息正文。原有输入 dock 展示等待连接、发送中、
等待确认、源端已接收及明确拒绝。普通 RPC 接收回执不会撤掉消息。Codex 使用原生
`userMessage.clientId` 到 `user/message.source.rpcId` 的精确关联；只有实际读到同一
会话、同一 operation ID 的用户消息才撤掉乐观回显。回执可提供源历史的 epoch/seq，
关闭所有 Pane 后仍能按坐标读取，消息离开最新一页也能完成确认。

现有 HAPI → ACP → DSH 链路没有传递原生 user message 的 operation ID，不能凭
文本、时间或列表位置推测关联。DSH 的只读回执改为查询原 owner 数据库中精确
session/localId 的持久队列记录。`ownerAdmission` 只表示“原执行端已保存”：queued、
dispatching、indeterminate、consumed 都不表示原生执行成功，consumed 也可能早于
原生 prompt 接纳。获得该证据后，本机 pending 正文转为 dock 中可展开原文的 owner
回执；原生正文与执行状态继续来自真实 DSH 历史，不伪造 native epoch/seq。

明确拒绝保留消息及原因，可以手动移除；未知结果保持原 ID 等待对账。dock 的状态
列表限制高度并可滚动，避免待确认消息挤走移动端编辑器。

待发送、待确认及明确拒绝的本机队列最多保存 256 条、4 MiB 序列化数据，不静默
淘汰未确认消息。owner 已持久接收的回执使用独立预算：最多 128 条、4 MiB，按接纳
顺序淘汰旧回执，单条已允许提交的长文本保留完整原文。实际浏览器配额不足时，可以
先回收这些已经交接的回执再尝试保存；未交接消息和官方草稿都不能被回收。达到
活动队列限制或仍然写入失败，会拒绝本次本机接纳并保留草稿。

图片、文件、审批、插话和取消不进入普通文本离线队列。控制操作继续绑定精确原生
turn/request ID，恢复连接后仍需重新验证当前目标；不能把一次停止或审批迁移到新
turn/request。停止操作的不确定结果在既有 dock 显示。

## 源端回执与重试边界

`hhpi/receipt` 是独立只读动作，使用完整的原 operation 请求核对不可变指纹，并走
官方 session 资源授权。不存在 ledger 记录时返回 null，不创建记录，也不调用原生
写接口。读取回执无需发送能力；被撤销写权限或原生连接离线后，仍可在 Host 可达且
有读取授权时确认已经保存的消息。查询自身的权限拒绝不会变成原消息被拒绝，也不
会授权重发。

ledger 在原生写入前先保存 indeterminate 标记。已确定 accepted/rejected 的普通
operate 重放立即返回本地回执；未知结果只做只读核对。Codex 可用精确 clientId 的
历史记录恢复 accepted，DSH 可用精确 owner 队列持久记录恢复 accepted。读操作失败
保留原结果，不盲目重复原生写入。accepted Codex 回执可后台补充已接受历史的坐标，
不会因原生连接离线而延迟已确定回执。

只有已证明用户写帧尚未交给 transport 的连接失败、容量拒绝或派发前读取失败，
才能标记 `retryable: true` 并以原 operation ID 继续。socket.send/stdin.write 一经
调用，即使 ACK 丢失、超时或连接被终止，也保持未知。永久拒绝不重试，创建会话的
未知回执也不会因此获得重试许可。审批响应只有确证未派发且原 request/generation
仍相同时才解除本地提交锁；已交给 transport 的响应不能再发。

只有认证 bootstrap 或 catalog 确认的账户与 Host 存储 scope 可以恢复队列；首次
出队还需要同 scope 的新 catalog。切换账户、明确撤销来源或取消 Host 配对会停止
原队列并清理 HHPI 自有持久数据。暂时离线和不完整目录不会充当授权撤销。

契约覆盖同步持久保存、配额失败、刷新、丢失 ACK、FIFO、权限拒绝、源身份隔离、
接受回执早于正文、关闭 Pane 后的历史对账、beginSubmission 与 prompt 之间关闭
Pane，以及撤销来源后迟到 ACK 不得复活存储。真实 loopback WebSocket 合同验证
握手失败、实际容量上限、收到写帧后断线及超时。组件契约覆盖既有 dock 的回执状态、
owner 原文查看和手动移除。
