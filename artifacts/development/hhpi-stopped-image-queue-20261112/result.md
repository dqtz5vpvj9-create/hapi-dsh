# 停止后的原生图片队列

已随 SDK .29 发布，并完成官方桌面 UI 的隔离原生验证。原生队列现在提供“发送此条并继续队列”；点击才启动原项，随后由 native 顺序处理剩余队列。合法排队问答回复使用官方 Inbox 类型，让原生问题卡让出默认输入/队列入口，不提前标记源问题已回答。

最终中央 release `83bd91924835bd2f28b7ac655d54e535a8544bfccb3de120f0d87d36660e403a`，Host `faba20d64fb2765c73543e060c84504f2acbfacd053248e080cee57473fea26f`，main `167041130c66` / provider `fb3e665f7b93`。安装、类型与实际模块字节证据由 publisher 的 [publication.json](publication.json) 记录；本报告仅给本负责人已执行的路径。结果摘要见 [acceptance.json](acceptance.json)。

实际只读结果：来源在线、idle、没有 activeTurn；上一原生 turn 为 interrupted，历史明确是用户停止。原生队列确有两项：一项含两张有效 JPEG，另一项为同一原异步问题的合法 typed reply，问题 ID/标题/immutable control operation identity 全部匹配。两者均未在本轮重发、改写、删除或启动。异步问题本身不阻塞原生执行；停止后的 native queue 不自动消费，不能据它尚未消失认定上传失败。

缺口位于 HHPI `remote-native-queue.ts`：只提供 active-turn Steer，未将已经支持的 native `thread/queue/start` 接入官方 QueueDock。修复新增可选 source start 动作，点击才使用原 queuedSubmissionId；不新增 HHPI 协议字段，不触发自动 resume，不改变 running Steer。普通 DSH 缺少该能力时保持原动作，普通 server 收到 start 会在解析/唤醒 Agent 之前拒绝。行按钮文案为“发送此条并继续队列”，因为 native 会先启动选定项，正常完成后再继续其余队列。

队列移行至正文到达期间在同 Session 保留原内容，不另造正文/回执块；未知 ACK 只查原记录、不重复启动。typed question reply 仅以原问题/答案展示，底层 envelope 与原身份不变，inline 文本编辑不会破坏原问题 owner；正文的 user-question-reply 也按原 rpcId 接管。

源中两张 JPEG 分别66×2048及83×2048，字节可完整解码，均已亲自查看；没有原上传前图片，本轮不推断是谁缩小，也不把有效图片解释为上传仍在进行。这不影响已经证实的停止队列入口缺口。

验证分层：

- Session/queue 5个针对case通过，最终 span `bda074b2-2b43-4e69-8d96-e47ffb9425cb`：结构化图片及 typed reply保留、explicit start、运行中/旧 transfer恢复不回退、移行/body关联、未知不重发。
- 原生 Codex CLI0.165.0 app-server + 既有 synthetic Responses model：1个关键语义case通过，span `0f639e67-d581-4138-bd00-f4d2206cbb0d`，2.46秒总计。中断后入队两项不自动消费；显式选定 ID只先启动该项，正常完成后处理其余队列。零外部模型、零原用户写操作。
- 原官方 QueueDock / ordinary queue command 两个既有spec，57/57通过，span `81150afb-dcae-4218-8df5-df2c33e3620c`。产品冻结不变。此前新root共享deps两次和alias配置均为0case环境失败，保留记录；最终使用publisher核准的canonical完整SDK source/deps。
- 完整旧Session文件22case中17通过，5个既有官方Chat fixture因`window is not defined`未进入行为断言（`b9d5faf4-0002-43e4-93aa-f10c990ea215`）；未为本次功能扩修。最初raw Node调用不支持parameter properties（`a5a8514c-dfa3-4a16-8fb1-1b4e18ca438e`），纠正为现有tsx loader后执行上述case。
- 最终 Host/Client/experience 类型检查、正式 carrier 与 SDK .29 安装由 publisher 在冻结合批输入上执行；不重复运行本路径已通过的检查。

冻结：`/mnt/cache/data-cache/hhpi-stopped-image-queue-20261112/sdk-freeze.json`（SDK两包5生产叶、2spec、2README）、同目录`hhpi-freeze.json`（HHPI1生产叶+2测试+ADR/PR）。HHPI生产 before 与修复前正式 stage 逐字节相等。后续 typed Inbox 增量以 v2 冻结为准。

## 正式 UI 发现的同路径缺陷与后续收敛

`.29/dd4fa` 首个原目标只读场景没有通过：`22a95e2e-eb29-4551-aa4b-11453721ce08`（26.3秒）中 editor 已挂载但不可见。5.86秒只读续段 `63b3984c-6b57-4f71-a088-b6304ad914d1` 精确证明：1149px原生问题卡可见，默认 composerStack 父级 `display:none`，连带 QueueDock 为0×0；并非错误的会话/窄Pane。两个阶段均0源写、0fence阻断、0pageerror。原问题已存在合法排队答复却仍占默认输入，属于实际产品缺陷。现场固定 webshot `stopped-queue-hidden.png` 已亲看；其原正文图片在离线静态图未加载的范围单列，不归因源图片损坏。

最初拟在 HHPI 过滤active问题，已撤回未发布。复查 pinned `ui-user-questions` 的319–329行，已有官方规则会识别 Inbox 中 `source.kind=user-question-reply`、对应callId并让出continued卡；HHPI漏发了这条原生语义。最终 follow-up v2 只改 `remote-native-queue.ts`：原生队列合法typed reply与问题ID/标题/当前revision的canonical控制rpcId精确一致，才投影为正式 `user-question-reply` source，并保留真实rpcId/body交接。userQuestions.active与native pending原样，取消排队即由官方规则恢复卡；普通文本/错rpcId/旧revision不会抑制。

v2 Session六例通过 `319e2da0-3f50-4969-b2a9-903f03423458`；未为官方消费者另造镜像UI测试。旧方案六例 `044bda3a...` 不作为最终实现证据；其首次早读投影失败 `c6bad01e...` 保留。v2冻结为同private目录 `question-followup-v2-freeze.json`/`.patch`；remote-sessions.ts恢复原字节，SDK.29无需变化。

## 正式版本的两层实际结果

原用户目标的只读场景保留未通过：`0152f464-3150-4df5-8df0-e2a1b847fab0`（26.7秒，83bd/faba）等待 plain editor 可见超时，0源写、0阻断、0pageerror。随后同源只读确认原队列已经为空、来源 idle、最近 turn completed，原图片 clientID 在当前正文页恰好一次；原 typed-control clientID 在该页为0，但 `hasBefore=true`，其全历史消费状态未知，不能据此称丢失或未消费。旧问题仍 pending，此时已经没有“队列存在且合法回复应让出卡片”的原始复现前提，plain editor 可见也不再是合法问题卡的就绪要求。本轮没有补回、重发、编辑、删除或启动用户队列，也没有再次打开原目标浏览器。

隔离实际官方 UI 场景通过：`bba845d4-f325-4329-8f67-f62214aff1c7`，交互8.471秒，profile总11.885秒。浏览器加载正式83bd模块；唯一替换边界为本任务自有 source 的 HTTP/changes 路由，接到真实 Codex CLI0.165.0 + DirectCodexAdapter，模型为本机 synthetic Responses。无外部模型调用、无原用户执行/队列写入、无用户布局写入。

1. 自有 native turn 中断后，两原始队列项保留：两张自有图片及标记、同问题的合法 typed reply。原生问题仍 pending，官方 Inbox 消费者让出默认问题卡，QueueDock 两行和完整 editor 可见。
2. 点击原行“发送此条并继续队列”，仅发生一次 `thread/queue/start`，使用原 queuedSubmissionId。实际模型输入收到原标记和两张图片，原项离开 native queue，剩余1项。
3. 第一项完成后，native 自行消费第二条合法问答回复；模型实际收到该答案，源问题 pending 数变为0、native queue 为空。原图片 clientID 正文恰好一次，官方队列退出，两条确认正文及完整 editor 可见；0pageerror、0fence阻断。

实际 DOM/CSS 快照经固定 webshot 渲染，以下两图均已亲看：

- `/mnt/cache/data-cache/hhpi-stopped-image-queue-20261112/owned-idle-before.png`：原生队列两行、完整输入区，问题卡已让出。初始图片队列行两个 `Image attachment` 占位文本直接拼接，这是已观察到的缩略图/附件展示缺口，仍需后续修复；本次 start 路径通过不代表完整附件 UI 视觉交付。
- `/mnt/cache/data-cache/hhpi-stopped-image-queue-20261112/owned-idle-final.png`：两张自有蓝色小图、图片消息与可读问答回复及两条确认正文可见，无剩余队列/旧问题卡，输入区完整。

截图是已保存实际交互 DOM/CSS 的离线渲染；实际点击、native 消费、clientID 对账来自上述浏览器/真实隔离源记录。没有逐帧采样来声明零空档，未新增坏网场景；未知 ACK 不重发沿现有 source 回归证据。所有浏览器、隔离 app-server、synthetic model、stream 与临时 CodexHome 已释放。
