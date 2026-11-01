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
等待确认、源端已接收及明确拒绝。RPC 接收回执不会撤掉消息，只有同一会话接受到
`user/message.source.rpcId` 才撤掉乐观回显。明确拒绝保留消息及原因，可以手动移除；
未知结果保持原 ID 等待对账。

队列最多保存 256 条、4 MiB 序列化数据，不静默淘汰未确认消息。达到限制或浏览器
写入失败会拒绝本次本机接纳并保留草稿。图片、文件、审批、插话和取消不进入普通
文本离线队列。控制操作继续绑定精确原生 turn/request ID。

只有认证 bootstrap 或 catalog 确认的账户与 Host 存储 scope 可以恢复队列；首次
出队还需要同 scope 的新 catalog。切换账户、明确撤销来源或取消 Host 配对会停止
原队列并清理 HHPI 自有持久数据。暂时离线和不完整目录不会充当授权撤销。

契约覆盖同步持久保存、配额失败、刷新、丢失 ACK、FIFO、权限拒绝、源身份隔离、
接受回执早于正文，以及 beginSubmission 与 prompt 之间关闭 Pane。组件契约覆盖
真实 dock 的回执状态和手动移除。原生回执核对另由源端 durable ledger 保证；未知
结果不允许直接重放原生写入。
