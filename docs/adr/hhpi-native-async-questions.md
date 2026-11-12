# 原生 Codex 异步问答

2026-11-12。HHPI 将原生异步问题接到 DSH 已有问答组件，执行和答复仍属于原 Codex thread。

`request_user_input` 的阻塞请求通过 `item/tool/requestUserInput` RPC 到达，问题带 `id/question/options[].label`，答复为该 RPC 的结果。实际 `functions.request_user_input_async` 立即返回 `{"accepted":true}`；原生历史把它存为 `agentMessage`，带 `delivery: "async"` 和 `questions: [{title, options?: string[]}]`。HHPI 原先只投影其中的文字，既丢失问题字段，也没有可答的 RPC。工具名称或正文 bullet 不能替代这些源事实。

源侧使用既有 sparse SQLite 的更新索引、generation/cutover 和持久游标读取结构化问题及显式答复，不因 catalog 刷新重放整个会话。每个 `questionItemId = JSON.stringify(['request_user_input_async', itemId, index])` 独立待答；匹配该身份及问题的原生显式 reply 结算该项，回合结束不清除它。同一记录的新版本可以修订或撤销问题，原 generation 被替换会撤销旧状态。问答投影读取失败保留可读正文及 last-good 状态；提交前必须重新取得源证据，缓存不能授权写入。

既有 `SourceApproval`/`approve` operation 承载答复。问题版本进入请求签名和稳定操作身份，源端验证每个答案和原问题。活动 turn 使用原生 `turn/steer`，空闲时使用 `thread/queue/add`；原生输入携带 Codex 支持的 `send_user_message_question_reply` envelope。外层及原生 receipt 防止双击、多个 Pane 或不确定结果重发。原生明确拒绝后才可重试；不确定结果只核对原操作。问题的提交不会把 Codex 激活成普通 DSH Agent。

浏览器向官方 `ui-user-questions` 提供 Session `userQuestions` 投影。该组件单独通过公开 Cordis namespace isolation 获得源答复路由，普通 DSH 调用仍委托原 `remote.userQuestions`，未知源不回落到普通 Agent。现有官方卡片、选项、自由输入及草稿恢复直接复用。原生菜单文字不在正文重复显示；显式答复使用官方 `user-question-reply` 事件呈现问题及人类答案，原生 XML/JSON envelope 不作正文。原生历史投影版本为 8；源历史未被改写。升级仅迁移 v7 已收到的阻塞问题证据键，要求完整源身份、旧 projection epoch 和原生 generation/cutover 一致，再由原 daemon、精确 native anchor 和当前等待状态重新验明；它不把历史问题猜成新 RPC。官方“跳过”提交明确的空答案，按同一原生 reply 身份结算该项，历史显示为已跳过。

2026-11-12 跳过恢复修正：明确 Skip 的空答案已经获得源端持久 accepted receipt 后，用户已完成这次决定，无需等待模型消费或原生 `userMessage` 才撤掉原问题卡。恢复读取须同时匹配原 source/thread、question ID、revision、原 channel 的 operation ID，以及完整空答案 payload fingerprint；旧 accepted Skip 同样恢复。该决定按精确 callId 持久记录，目录刷新、Pane 重开及迟到恢复不能复活同一修订；新 question ID 或实际 revision 仍可显示。accepted 普通答案、拒绝、缺失或不确定回执不由此结算。receipt 的新 stored 读取只校验持久快照，不等待 in-flight 操作、不 reconcile、不执行原生写，避免在操作恢复内等待自身；原 lookup/run 语义不变。此处只确认用户跳过，既不声称模型已收到，也不修改原生历史、队列或 HHPI wire。

本轮验证分层：真实 0.165 CLI、隔离 CODEX_HOME 与 loopback Responses model 执行一次真实 async 内建工具，验证运行中 steering、跨回合/重连待答、逐项结算、空闲队列及模型实际收到选项和自由文本各一次。未知 `hhpi-fixture` 模型族不声明此工具，测试使用原生支持的 `gpt-6.1-sol` 模型族，模型服务仍为本机 fixture。公开 Cordis/Loader 契约另覆盖源和普通 DSH 路由、未知源拒绝；投影故障检查确认正文保留且不写源。浏览器使用已安装官方图、候选 HHPI 字节和隔离源 read/operate 边界，验证官方卡片、刷新草稿、两类提交与人类答案历史。生产真实问题的只读卡片检查在发布后执行，不替用户提交答案；这些证据不合并声称真实用户已经作答。
