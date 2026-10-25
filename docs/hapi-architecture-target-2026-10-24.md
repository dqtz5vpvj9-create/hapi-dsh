# HAPI 架构对照：稳定会话与按需历史

这是源码调查，不是产品验收通过报告。规范以 [完整会话 spec](dsh-repair-spec-2026-10-24.md) 为准。DSH subagent 收集了源码位置；父线程复核关键路径，并否决其“全量归档完成后才 ready”的建议。该建议把交互完整误解成历史全量驻留，会继续增加打开延迟，未被采纳。

## 版本与证据

HAPI 源码 HEAD 为 `55166cf8d87814ccfb383b538a8e8c55283bed81`，工作树含未提交修改，不能把 HEAD 单独当成整个运行版本。父线程逐字节比对了下表涉及的八个主要文件与 `/mnt/cache/build-cache/hapi-production/current/source`，结果一致：`SessionChat.tsx`、`NativeCodexThread.tsx`、`useMessages.ts`、`message-window-store.ts`、`SessionPaneController.tsx`、`useConversationOutlineHistory.ts`、`messageService.ts`、`nativeHistoryIndexed.ts`。这只证明这些文件与部署快照一致，不代替当前线上资产和同条件性能实测。

HAPI-DSH 产品基线为 `a32125b`，文档基线为 `b424185`；官方依赖固定 `0.2.1-rc.3`。父线程已核对线上既有构建标识并精确定位 `CURRENT_REPORTED_SESSION`，目录显示源活动、Hub 已连接；真实身份保存在 spec 引用的私有清单。没有将其他同名会话用作目标。

## HAPI 已实现的边界

以下行号对应本次读取的源码，路径以 `/mnt/cache/src/hapi` 为根。HAPI 有正常网络/错误状态；“没有分阶段问题”指普通打开和补页不需要另造一个业务会话，不是声称任何故障都不会出现。

| 边界 | 当前实现依据 | 对 HAPI-DSH 的要求 |
| --- | --- | --- |
| 会话详情独立于消息页 | `web/src/components/SessionPaneController.tsx:84` 附近独立读取 session 和 `useMessages`；`:484` 仅在缺少 session 时显示详情错误/加载 | 目录/历史进度不能使已有效的源控制器失效 |
| 编辑器独立于正文窗口 | `web/src/components/SessionChat.tsx:2019` 附近正文组件与 `:2110` 的 `HappyComposer` 分开；`:2123` 使用源 session key；`:2134` 禁用来自发送/会话操作，而非全量归档 | 保持唯一有效操作 owner、草稿和编辑器实例；补页不禁用输入 |
| 有界尾页与历史页 | `web/src/lib/message-window-store.ts:50`：visible 400、history 600、初始页 20、普通页 200；`web/src/hooks/queries/useMessages.ts:61` 激活窗口，`:70` 同步 tail，`:89` 读更早页 | “初始 20 行”可以完整可用，前提是源历史游标和分页路径真实存在；不能只把 20 行塞进一个没有更早日志的显示会话 |
| 正确的历史范围 | `message-window-store.ts:818` 合入 `hasMore`、epoch、next cursor；`:1412` 的 `fetchOlderMessages` 用原 cursor/epoch 读取；`hub/src/sync/messageService.ts:318` 按 epoch 和方向分页，`:352` 附近构造页边界与 snapshotHead | hasMore 指源端历史范围，不是本地已物化日志范围。源仍有更早数据时不能显示 exhausted |
| Native 历史按索引读取 | `cli/src/codex/shared/nativeHistoryIndexed.ts:221` 的 read/synchronize/page/context/outline 路径；`:244` 区分 append 和结构 reset；`hub/src/sync/syncEngine.ts:4809` 调原 Runner 历史接口 | 原生身份及历史 epoch 有明确语义，正常更早分页不能被误判成 rewind |
| 按节点订阅与阅读接续 | `web/src/components/AssistantChat/NativeCodexThread.tsx:24` 的 `NativeSeat` 按 ID 订阅；`:63` 的 `NativePageCommit` 在 DOM 修改前采旧阅读位置；`:141` 附近绑定 viewport；`:204` 有界补足视口 | 优先可见局部和有限预取，位置由稳定节点锚定，不建立第二套相互争抢的滚动控制 |
| 目录与正文分离 | `web/src/hooks/useConversationOutlineHistory.ts` 独立获取目录；`HappyThread.tsx:2205` 附近按需打开 outline | 轻量导航索引与正文页分离，不为 minimap 读取所有工具输出和全文 |
| 增量而非换会话 | `web/src/App.tsx:362` 附近处理 native-history invalidation，`:483` 合入 incoming messages；`web/src/hooks/useSSE.ts` 管理事件和重连 | 增量在当前窗口/owner 中收敛，不让每次后台补齐触发用户可见的 Session 换代 |

HAPI 的呈现标记不是“全历史下载完成”。`useInitialChatPresentation` 检查当前窗口、布局和定位；历史、目录继续按需读取。可复用的架构是**完整交互能力 + 有界数据**，不是照抄一个 presented 布尔值，也不是让 DSH 等到所有历史变成一个完整 seed。

## HAPI-DSH 的断裂点

路径以下以本仓库为根。

1. `src/index.ts:535` 附近为两种源适配启用 `fastHistorySeed`。`src/codex/agent.ts:314` 附近只取最新源页，`:343` 附近以该页创建官方 Session seed；observed 路径在 `src/hapi-agent/agent.ts:198` 附近相同。源页外的旧历史没有因此成为该 Session 的可分页内容。
2. `src/client/session-opening-stream.ts` 将首次官方 follow 窗口限制为 20；这是合理的传输窗口限制，但不能修补 Host 日志没有旧历史的缺口。两个“20/尾页”不是同一个分页层，必须测源游标贯通。
3. `SourceHistoryOrder.needsReseed`（`src/codex/history-journal.ts:167`）遇到未见过且排在已有尾部之前的记录就返回 true。`src/codex/agent.ts:716` 将普通补齐抛成 `NativeHistoryChangedError`；后台 `sync` 的 `:643` 回调 `onHistoryChanged`。这把数据窗口扩展升级成显示生命周期替换。
4. `src/codex/service.ts:303` 和 `src/hapi-agent/service.ts:276` 的 `replaceDisplay` 推进 displayRevision，先 dispose 旧 Agent，再构造新 Agent。创建全量 seed 的 CPU、内存、IO 等成本都落在这个间隙，前端还要再次 retain/mount。
5. `src/client/surface/generation-handoff.ts:40` 附近将旧画面 inert、新画面透明准备；`replacementReady` 只检查 reference/open/content/editor/reading。保留旧像素没有保住旧交互，不能算解决不可用。

这条源码链与用户描述一致，但不是完整线上 trace 的替代。父线程的只读代理诊断中看到最新正文和 `Session unavailable` 同屏；代理还拦截了自动已读/布局等写入，故该样本只能作诊断，不能作为无干预生产性能或完整因果验收。

## 官方 DSH 的导航与不可用条件

必须按当前安装包读取，不靠组件名称猜测：

- `node_modules/@deepseek-ai/dsh-session-turn-outline/lib/index.js:4` 的注释和 `:77` 的 projection 定义表明，`turnOutline` 折叠的是官方 Session 已有日志。它并不知道 HAPI 页外的所有原生历史。临时 seed 只有末尾 turn 时，whole-log outline 也只有这些 turn。
- `node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js:419` 在 `items.length < 2` 时不渲染 `TurnNavigator`；`:427` 附近是导航 `nav`。`:192` 的 CSS 在容器宽度 ≤900px 时隐藏 rail。因此桌面大 pane 必须检查用户指出的 minimap；窄屏不要求强行显示桌面 rail，但历史分页与适用的阅读导航仍应有效。
- 同包 `mergeTurnRailItems` 合并已加载与 outline 中的 turn；仅添加空导航 DOM、假 turn 数、强设 hasMore 都不构成修复。导航定位必须能映射回真实源消息，按需取得目标页。
- `node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:18940` 的 `InputBar`、`:19003` 的 disabled 计算及 `:19155` 的 placeholder：`removed || inert || !live || blocked || parentOffline` 等条件会禁用，live 要求 input、keyboard 和 inputActions 存在。**它不是简单地由 openState 控制。**必须记录哪一项断裂，不能删掉安全门或只改错误文案。

## 为什么原验收没有约束这个问题

`scripts/cold-opening-observer.mjs` 在 sample 中记录编辑器属性，但 `coldOpeningIssues` 最终只检查标题退化、正文消失/陈旧和最终 ready。它既没有把中途编辑器禁用作为失败，也没有实际操作源历史或导航。

父线程将以下轨迹输入当前函数：100ms 最新正文与编辑器可用，500ms 正文仍在但编辑器不可用，25000ms 编辑器恢复，最终 stableForMs=1000。函数返回 `[]`。证据为私有 release 目录 `observer-false-pass.json`。因此“记录了一些状态”并不意味着“对所有失败作了断言”。后续必须验证失败判定自身，最终恢复不能抹掉退化。

## 实施需要先证明的接口能力

目标是稳定源 owner 下的有界窗口，而不是增加 `archiveComplete && seedComplete` 这样的全量就绪门。`conversationUsable` 只用于验收推导，不要求再增加一套业务状态机。

实施者须先用 pinned 官方公开扩展点完成最小纵向用例：源实际有旧历史、Host 只保留有限窗口；首次会话能够编辑、向前分页和按目录定位；补页不创建新源 owner，不 dispose 旧编辑器，不依赖全量种子或归档下载。对每个扩展点给出导出 API、所实现的 adapter 与官方 Host 用例，不能只画架构图。

当前源码调查尚未证明 pinned rc.3 的哪个公开 provider 能在不全量填充官方日志的情况下完成所有源历史/outline 映射。这是需要解决的具体接口缺口，不是改回全量等待的理由。若无法实现，交付最小限制复现、可选公开扩展方案及未满足要求，由父线程作架构决策；不可暗改上游、复制通用 renderer 或声称已达标。

本轮仅完成调查与 spec 纠正。完整交互观察器、稳定源窗口改造、同条件 HAPI 性能基线和当前真实会话的最终生产通过，均未完成。
