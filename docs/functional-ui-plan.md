# 功能与 UI 计划实施记录（2026-10-22）

> 恢复来源说明：以下正文是中断的在线任务留在 JSON 中的历史记录，包含当时环境的测试和端点状态，不代表本地恢复已经验证。当前恢复范围与本地检查结果见 [local-recovery.md](local-recovery.md)。

本记录对应本轮自包含计划的全部 ID。它记录当前工作树的实现、已完成的专项验证与边界，不是发版通过声明。**本轮尚未部署；当前生产端点探针返回 HTTP 503，不能进行生产验收。** 已确认的浏览器结果列在下方；最后一轮 gate 和新增修正仍在验证，最终构建、微测、浏览器账本和提交号由 [validation.md](validation.md)记录。

固定上游保持 DSH `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`，HAPI 参考 revision 保持 `55166cf8d87814ccfb383b538a8e8c55283bed81`。没有修改、嵌入或补丁上游实现。所有自动化源记录均为明确的合成 fixture，不对用户真实会话执行验证写操作。

## 逐项状态

“新增”表示本轮改变了代码，“复用”表示现有功能链继续承担该项；两者都不表示生产验收通过。浏览器结果来自固定官方运行时与合成源 fixture，以下区分已通过的专项和之后仍待验证的修正。

| ID | 目标与当前实现 | 实现/复用状态 | 已确认验证与剩余边界 |
| --- | --- | --- | --- |
| **P0-1** | 普通侧栏点击替换当前 pane；显式新开/右键动作才增加窗格。不弹会话命名框。关闭只释放 view，不 abort 原任务。隐藏 pane 不获取焦点、不标已读；保存窗口、分屏比例与草稿恢复身份。 | 新增选择/焦点修正；复用布局、草稿存储与 view 生命周期。聊天统一为每 Host 一个 graph，移除 `hapiGraph` URL 分支。 | workspace-chrome **2/2** 通过，覆盖桌面布局恢复与 390px；workspace-navigation **2/2** 通过普通 latest 与明确阅读目标。不同 session 草稿独立；同一 session 的两个 occurrence 共享官方 draft。旧 per-pane rich draft 自动迁入共享 graph 仍有缺口。 |
| **P0-2** | 模型、权限、本插件 overflow 放在一个右侧 source controls 组；离散 effort，确认值打勾，pending 独立展示；动作始终属于原 session/pane。 | 新增公开 list-slot 组合与响应式 popover；复用 Native/Observed control ledger 和源 settings RPC。 | 原 picker 两场景 **2/2** 通过；随后新增的“关闭已加载 picker 后源端单独改变权限/协作/服务档位、解除只读”断言正在新 core 批次验证。未广告能力不伪造，不承诺“下轮生效”。 |
| **P0-3** | 审批与待回答项跨断线/重载持久保存；空 requests、断线和 YOLO 权限变化不能抹掉旧请求。源最终 completed fact 才结案。 | 新增 durable approval journal v2 和缺失待确认状态；保留源操作差异。 | source-action-recovery **3/3** 通过，其中验证审批以源最终事实结案。Codex once/session/deny/abort/skip 有明确映射；其它引擎未证明的 Always/wider scope 隐藏。合成源通过不替代生产源验收。 |
| **P0-4** | 投递 Unknown、Queued、Received、Sent、Failed 与执行状态分列。已确认失败有 Retry/Discard；Unknown 不自动重发。编辑队列不覆盖现有草稿。 | 新增 rejected-only 幂等恢复操作、当前错误就地显示及显式 Append；复用取消后安全恢复链。 | source-action-recovery **3/3** 通过，包含 Unknown 不重发与 Failed Retry/Discard。随后修正的队列 Append 保留 `@` 引用语义仍待最终验证。HTTP 接收和 Sent 不等于执行完成；只有真实可操作队列才启用 cancel/edit/steer。 |
| **P0-5** | 初始优先当前轮和上一轮的实际输入；上翻沿用官方锚点/失败恢复。显式消息搜索、deep link、审批定位优先于 latest；普通点击去 latest，同 generation reload 保留阅读锚点。 | 新增 turn-aware seed、较大有界初始展开、per-pane reading intent 和 reload anchor；复用手势分页。显式 intent 在 display successor 变化时保留，导航专项已通过。 | workspace-navigation **2/2**、同规模 initial-turn-context 独占复跑 **1/1** 通过。长 turn 用例约 1.3 分钟，先前 120 秒超时与长时间无帧仍是性能问题，见下文。两层 20 页上限不等于无限完整；跨 generation 的 rich draft/附件/阅读位置原子迁移仍未完成。 |
| **P1-1** | 新建源会话沿用实际 machine、目录、agent 选择/默认值；创建草稿和附件可恢复；首次发送/附件失败可在同一已创建 session 重试。 | 复用创建回执、durable launch draft/attachment bytes、immutable first-task 恢复链；未另造创建接口。 | 各 engine 可继承字段受源能力约束，不能用别的 engine ID 代替未知值。当前单测覆盖同身份恢复，浏览器 reload/附件路径待统一验收。 |
| **P1-2** | 全源目录参与元数据搜索，不先截取 200 条；180ms debounce；按用户 preview 步长增量显示并滚底追加。标题优先，保留 pin/archive/pending 筛选；详情区分 display、Hub/source、native 身份，Resume 路由原来源。源菜单可复制经核实的 Codex/Claude CLI 恢复命令，并注明原 machine/cwd。 | 新增独立 `sourceDiscovery` 摘要目录与 attach 分离、恢复命令 helper 和 Copy 菜单；复用统一侧栏、标题权重和真实源 Resume。 | source-discovery **1/1** 通过：第 350 条、三个 ID 与 resume clipboard。未发布 metadata 明示未知。命令仅支持已核实 engine、真实 native UUID、源机器与绝对 POSIX cwd；其它 engine/Windows 暂不可用。官方正文搜索仍是 20 匹配 + hasMore、无公开 continuation cursor。 |
| **P1-3** | 中性用户消息，10px 圆角、10×14px padding、桌面 88%/小屏 96% 宽度、15px 起/1.6 行高、22px 回合间距，无蓝影/渐变/尾巴。主 toolbar 为品牌、当前标题、工具三段，不加横条。 | 新增默认中性色与旧蓝色偏好迁移；保留其它自定义值。移除过期的 routine 源信息与 composer 统计展示，审批、错误、恢复仍在。 | appearance **4/4** 通过，包含 1440/390px 中性消息截图、OLED 与 Glass；最后 gate 仍由 validation 记录。截图结论不扩展为所有设备和辅助功能组合均已验收。 |
| **P1-4** | 360/390px 只显示 focused pane，底部切 pane；回桌面恢复原布局比例。源 popover 小屏为底部 panel，随 visualViewport 调整；触控目标至少 44px。 | 新增可见性/viewport 适配，复用原持久布局；自有 controls 可换行，不挤占 Send/附件，不搬第三方按钮。 | workspace-chrome **2/2** 已覆盖 390px 与回桌面恢复；原 picker **2/2** 包含 360/390px 命中、panel 边界和无横滚。新 picker 状态修正仍在复跑。viewport resize 不等于真实软键盘、旋转、缩放及附件组合实机验收。 |
| **P1-5** | 文件、diff、产物和 Terminal 路由原机器/源会话，可并排、保存资源导航并恢复；dirty close 可取消，关闭不杀任务/PTY。 | 复用公开 provider、源身份校验、CAS 文件保存、pane `beforeClose` guard 和 Terminal lease；本轮补充 focused Host 的工具路由。 | 新增 focused Host tools 代码待最终验证。Files/Document 等非 conversation plugin view 仍保留兼容 graph。源 terminal 无逐条 ACK 的旧协议限制未改变；不能把局部审计写成文件/Terminal 全套浏览器已重测。 |
| **P2-1** | 通知携带原 Hub/source 和具体 message/request，统一 pending 入口可定位审批或失败投递；隐藏 pane 不因挂载或刷新清 unread。 | 新增精确导航 payload、pending target 与阅读意图；复用通知权限和投递机制。 | 无 request ID 的摘要只能先解析来源，不能猜目标。真实 OS push、跨设备唤醒和权限限制仍需实机验收，当前只声明代码路径。 |
| **P2-2** | Glass 为非默认外观选项，首屏读取持久偏好；不支持/无效时保持实体背景，reduced-transparency/forced-colors 禁用 blur；focus 保留。 | 在既有 appearance 中新增 Glass palette，约 90% 实体底色 + 14px blur，仅 chrome/sidebar 等表面使用。正文、composer、popover 保持不透明。 | appearance **4/4** 中的 Glass 场景已通过；最终 gate 与精确检查账本见 validation，不扩展为全部 accessibility 组合已覆盖。不承诺 60fps，不把开启 Glass 与官方 Host theme 改写绑定。 |

## P0-2：公开组合与源确认

实现入口是 [composer-picker/index.tsx](../src/client/composer-picker/index.tsx)。只向 `conversation.input.right` **list slot** 注册一个 `hapi.source-controls` contribution，三个触发器位于同一 `div.hapi-source-controls`：

- `button.hapi-model-trigger`：模型与所有明确非默认 effort，包括 Low、Medium；Fast/其它服务档位按源能力展示。
- `button.hapi-permission-trigger`：仅在源提供权限选择能力时挂载。没有选择能力时仍可显示真实权限或只读标签，不伪造按钮。
- `button.hapi-overflow-trigger`：只管理本插件自己的工具和暂存草稿入口。

`hapi.source.composer-actions` 是由该 contribution 的公开 `children` 声明建立的 session-scoped 自有 child slot。它保留原 parking 控制器及附件的生命周期。没有 takeover `conversation.composer`，没有抢占官方 model/permission single slot；普通 DSH 不渲染本源 controls，保留官方控制。重复官方 model、permission、plan cell 只在包含本源组的 composer 内隐藏。第三方 contribution、Stop、Send 和官方编辑器 DOM 不被移入本插件菜单。

effort 按用户 2026-10-22 的最终选择使用滑杆，刻度只包含源模型支持的档位；拖动预览，松手或键盘调整后提交，也可点击刻度文字。Standard 只省略服务档位标签，不隐藏权限与只读。模型/权限勾选和触发器始终取源确认值；待确认目标以“正在确认”单独列出，RPC 请求发出、按钮点击成功或网络返回不直接改为已确认。失败保留旧确认值及操作旁的错误。

执行中仍可查看设置；选项可提交性取决于源广告能力、只读/锁、当前控制操作与 ledger pending。缺少延迟生效契约就不显示“下轮生效”。Native Fast 和 observed Fast 分别按其真实服务档位协议判定，不能用一个装饰开关伪装通用能力。

popover 使用发起动作的 session/pane scope，不从全局 focused pane 猜归属。桌面优先向上并按触发器起始边对齐，以 pane 与 visualViewport 的交集为边界，留 12px 安全距离；宽度不超过 320px，高度取 480px、可见高度的 70% 和可用方向空间三者的最小值。上方不足而下方足够时翻到下方，两侧都不足时在空间较大一侧滚动；小屏为底部 panel，分屏变化由 ResizeObserver 更新位置。Escape 归还原触发器焦点，pane 隐藏即关闭。布局允许组内换行，并保持真实 hit-test 可点击；只升 z-index 或 force click 不作为验收方式。

原 picker 浏览器场景 **2/2** 已通过两个 pane 发出的 settings RPC 来源归属、独立草稿、离散设置与 360/390px 命中，后端仍是合成源 fixture。随后 review 发现已加载 controller 快照在弹层关闭后，可能遮住新到达的权限/协作/服务档位或只读投影；本轮补齐 Native/Observed 的刷新依赖，未加载设置仍不增加 settings RPC。新增“关闭后外部源逐项更新”的浏览器断言正在新 core 批次运行，不能以之前 2/2 替代这一修正的验证。

## P0-3 / P0-4：最终事实与可恢复动作

详细协议见 [action-recovery.md](action-recovery.md)。审批 journal 保存原 request payload 和源的最终结果；部分 snapshot、断线、Host 重启和权限变化都不是完成证明。较旧 pending snapshot 也不能重开已完成请求。Codex 的“本会话允许”与 Always 不混为一谈；本轮未能从固定 HAPI revision 核实其它 engine 的 wider/Always 语义，因此不对它们宣称等价。

失败恢复要求原 Hub/source、原 local message ID、真实 rejected 状态和显式 recovery operation ID 同时匹配。Retry 复用原 payload/identity，并持久记录操作避免重复发送；Discard 只撤下本地已拒绝回执，不假装终止源执行。Unknown/queued/accepted/invoked 不走此 rejected-only 路径，刷新和重连不自动调用恢复。

队列编辑先取得真实取消证明；仅在原 editor capture 未变化、目标为空且无附件时自动恢复。已有新草稿时保留当前内容，提供显式 Append，不替换它。review 进一步发现原 Append 的纯文本 `setDraft` 会移除 `@` 引用语义，本轮已补修正，其最终验证仍待完成。晚到的 invoked 事实优先于旧取消/unknown 响应。执行状态单独显示，投递 Sent 只证明交给执行链，不证明工作完成。

source-action-recovery 浏览器专项 **3/3** 已通过审批最终事实、Unknown 不重发与 Failed Retry/Discard；它不代替上述后加的队列引用修正验证，也不是生产 HAPI/Codex 数据验证。

## P0-5：初始上下文、成本与导航优先级

### 两层预算

[readNativeHistoryTail()](../src/codex/history.ts) 在 Native 冷读时按真实输入边界补当前轮和上一轮。Native execution/turn ID 可用时使用原身份；没有它的来源按已有源解析器的 invoked 输入/响应分组。排队输入、child trace、steer 或合成 `turn/start` 不能单独证明两轮齐全。

每个稳定 pass 最多 **20 个 200 行数据页，保留最多 4,000 源行**；跨页后检查最初 head 的 epoch，后续 caller 再叠加 live journal。遇到 epoch reset 最多尝试四个 pass，因此 20 页不是所有失败重试合计的网络请求上限。返回的 opening context 明确分为 `previous-turn`、`history-start`、`limited`。全历史 `complete` 是另一个事实。

warm cache、live-first 接收/缓冲和异步全历史对账保持现有路径；初始两轮在预算内时不等待全量 history，也不依赖后续 `replaceDisplay` 才出现。旧的不完整缓存仍可能先显示较短内容，超长两轮也可能达到上限，这些不写成已完整恢复。

Client [initial.ts](../src/client/seamless/initial.ts) 在首屏绘制机会后调用官方 `loadOlder()`，目标是最新两组 Turn 的真实输入均已进入 retained window。它和上翻手势共用 Host/session **20 页自动预算**及 document gate，单 SessionFace 的多个 occurrence 共用计划。composer 输入不打断它；读者在 transcript 内接管后停止继续自动翻页，隐藏时暂停。`ready`、`exhausted`、`limited`、`error` 不混用，失败保留官方手动/手势入口。上翻原有锚点与冷却规则见 [seamless-history.md](seamless-history.md)。

### 更完整上下文的代价

| 明确合成的 reader 场景 | 原单页方案 | 当前 turn-aware 方案 | 可得结论 |
| --- | ---: | ---: | --- |
| 7,010 行、十轮各 701 行 | 1 次源请求、最多 200 行 seed | 8 数据页 + 1 head 校验 = **9 次请求**；1,600 行 seed | 多次源往返换取完整前轮，不能说首屏更快 |
| 新浏览器 fixture：10,408 行，最近两轮共 2,602 行 | 单页不足以包含前轮 | 预期 14 数据页 + 1 head 校验；同规模独占复跑 **1/1** 通过，用例约 **1.3 分钟**、整次约 **1.5 分钟** | 测试刻意阻塞全量 backfill，检查首代前轮、草稿及 reload；功能可完成不等于首屏或渲染性能达标 |

CPU-only reader 测试不含生产隧道 RTT。新浏览器用例分别记录 seed publish、首次正文、前轮上下文和请求数量，精确分段数字由最终账本补入；未完成的生产测量继续保留为空。扩大 seed 不能同时作为加载提速的证据。

同规模用例先前在负载重叠运行中达到 **120 秒超时**；当时记录到客户端 **30.25 秒无帧**、一次 next-page 等待约 **61 秒**，DOM 达 **24,273 个节点**。这些失败与诊断保留，不因独占复跑通过而删除。负载重叠是运行条件，不能把全部延迟归因于 CPU 竞争，也不能把大 retained window 的渲染/分页成本写成已解决。独占通过证明在不依赖全量换代的条件下能取得前轮与完成 reload，尚未证明 HAPI 级加载延迟。

### 阅读意图

`reading-intent` 按 pane 保存显式 latest/message/approval/delivery 目标及 revision。搜索、deep link 和具体审批定位具有明确目标；源 live 更新或单纯 focus 不生成新的 latest 导航。普通点击会话才要求 latest。请求完成时核对 pane、source 与 revision，不能将已过期异步结果送到新的 focused pane。

同 generation 的 reload anchor 保存行身份、公开 sequence 和相对偏移，不保存聊天文本；reload 后通过公开 `loadThrough` 和官方行 DOM 恢复。显式定位优先于 reload anchor。折叠 reasoning/tool 通过既有公开 disclosure 展开。定位失败有就地 retry，不能静默跳到最新。

workspace-navigation 浏览器专项 **2/2** 已通过：显式 deep link 在 live 更新及 display successor 变化时保留原 intent，普通点击转 latest，同 generation reload 恢复锚点，并展开目标 reasoning/tool。这里验证的是阅读目标及其 revision 的迁移与定位，不是整个编辑器/阅读状态的原子搬迁。后台 tail-to-full 换代的 rich draft、语义引用、附件和阅读位置仍缺完整的安全迁移协议；现有 [live-history.md](live-history.md) 与 [one-graph-spike.md](one-graph-spike.md) 的该项缺口未被删除。

## P1：复用链、目录和小屏

创建与文件/Terminal 能力主要是复用。现有创建链保存原机器、路径、agent、创建回执以及首任务的不可变身份；文本与原附件字节可恢复。文件 provider 校验准确 Hub/source/machine，保存用 CAS，关闭通过 pane `beforeClose` 保护 dirty 内容。终端视图关闭只 detach；旧 SessionTerminal 没有逐条输入 ACK 的限制仍在。不能把这次审计写成全新实现或全套浏览器重测。

源发现的新增边界见 [source-discovery.md](source-discovery.md)：`catalog.sourceDiscovery` 保存 Hub 返回的全部摘要，与实际 attached display 分开。不造 DSH session ID，不用 original source ID 调用 `retain`；打开时先解析真实绑定。350 条 fixture 证明搜索在 preview 之前进行。失败保留上次成功目录和原 observedAt，missing metadata 保持未知。滚底追加是本地已收到列表的增量渲染，并非新增上游分页 API。

### 复制原生 CLI 恢复命令

[source-resume-command.ts](../src/client/source-resume-command.ts) 与 [source-resume-menu.tsx](../src/client/source-resume-menu.tsx) 在三个 Copy ID 菜单项后增加 **Copy resume command / 复制恢复命令**。该操作只有 clipboard port，不调用源 RPC、不启动 CLI。命令与机器/目录取自打开菜单的原 row，而非后续 focused pane。

2026-10-22 核对的主源是 [OpenAI Codex CLI reference 的 resume 章节](https://developers.openai.com/codex/cli/reference/#codex-resume)（当前重定向到官方 ChatGPT Learn）和 [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)。分别使用 `codex resume <native UUID>` 与 `claude --resume <native UUID>`，不添加 prompt、fork、权限覆盖或“最近一次”参数。两者的命名会话/其它入口不用于构造恢复命令，避免名称歧义。

命令先进入已发布的源 cwd；若 Codex projection 发布了 `nativeHome`，则将同一现有目录作为该命令的 `CODEX_HOME`。cwd、home 和 ID 都按 POSIX shell 参数处理，单引号、空格、美元符号和反引号不得产生额外命令或展开。菜单直接标出源机器 ID/名称、cwd 和已知 Codex home，并注明应在原机器、原 CLI 账户/会话存储中使用；不会构造未经确认的 SSH 目的地。

缺少原生 UUID、机器或 cwd，目录不是支持的绝对 POSIX 路径，或引擎未核实（目前包括 Gemini 及其它 engine）时，按钮禁用并显示具体原因。HAPI session ID、DSH display ID、serving Host 和 child 的 parent ID 均不能替代缺失身份。CLI 版本不由本插件固定，文档核实不构成对每台 Runner 的实际命令执行验证。

窄屏只改变当前可见 pane 与操作布局，不重写持久化 split tree。回到桌面宽度应恢复原比例；当前 viewport 适配使用 `visualViewport` resize/scroll 处理可用高度。模型、权限、工具 panel 保持可关闭、可滚动，来源控件触控区至少 44px。真正的键盘遮挡、附件预览与旋转/缩放需要设备或对应浏览器证据，不能只用 390px 截图判为全部通过。

中性用户消息作为默认样式生效，不依赖开启 appearance。旧蓝色 bubble 偏好迁为默认，仅删除旧 userBubble 自定义项，保留其它合法或未知偏好。Glass 是可选 chrome 外观，正文/输入/弹层不透明，并有不支持 backdrop-filter、降低透明度和 forced-colors 的实体背景路径。性能目标不包含未经测量的 60fps 承诺。

## 分批计划与验收账本

原计划分组仍保留：Batch 1 为 P0-1/3/4/5，Batch 2 为 P0-2 与 P1-3，Batch 3 为 P1-1/2/4/5，Batch 4 为 P2。当前工作树包含跨组变更；此分组表示需求范围，不表示四次发版已完成。

| 验收项 | 当前记录 | 最终结果位置 |
| --- | --- | --- |
| 源 picker 单测 | 后续定位规则补充后的定向 16/16；协议/静态 React/几何测试，不能代替真实点击 | `tests/client-composer-picker.test.ts`；最终 gate 见 validation |
| turn-aware reader 与初始 retained-window | 本轮相关纯测试 58/58，实际 pinned Native Agent 定向 3/3；均使用合成源传输 | 历史分页、seamless、native tests；最终 gate 见 validation |
| 审批/投递与既有 Agent/queue | 定向 state 33/33、Agent/queue 23/23，未计作生产源验证 | `action-recovery.md`；最终 gate 见 validation |
| 创建/首任务/文件身份复用审计 | 所选既有测试 32 项通过；此轮未据此宣称全 browser 回归 | 原创建、初始任务、源文件 tests |
| CLI 恢复命令与来源身份 | 定向 8/8、Client 类型检查通过；真实 POSIX shell 的只 echo 函数验证参数不展开，无真实 CLI/source 执行；source-discovery 中 clipboard 已通过 | `tests/client-source-resume-command.test.ts` 与 `e2e/source-discovery.spec.ts` |
| 完整微测、build 与 e2e 类型检查 | 前一轮完整 micro：**1,012 pass、1 skip、0 fail**。后加修正后的最后 gate 仍待根代理完成；不沿用旧轮次作最终通过声明 | [validation.md](validation.md) |
| 两 pane picker / 360–390px | 原场景 **2/2** 已通过；已加载 picker 关闭后的源更新新断言正在新 core 批次运行 | `e2e/composer-picker.spec.ts`；最终构建与命中结果见 validation |
| 1440/390px 中性消息、OLED、Glass | appearance **4/4** 已通过，含对应截图与 Glass 场景 | `e2e/appearance.spec.ts` |
| 桌面布局恢复与 390px | workspace-chrome **2/2** 已通过 | `e2e/workspace-chrome.spec.ts` |
| 深链/live、普通 latest、reload 锚点、reasoning/tool 展开 | workspace-navigation **2/2** 已通过；不等于跨 generation 的全部 rich state 原子迁移已实现 | `e2e/workspace-navigation.spec.ts` |
| 长前轮首代上下文与 reload | 同规模独占复跑 **1/1**，用例约 **1.3 分钟**、整次约 **1.5 分钟**；先前重叠负载 120 秒超时、30.25 秒无帧、next-page 61 秒与 24,273 DOM 节点记录保留 | `e2e/initial-turn-context.spec.ts`；精确分段与失败账本见 validation |
| 审批最终事实 / Unknown 不重发 / Failed Retry/Discard | source-action-recovery **3/3** 已通过；后加的队列 Append 引用保留修正待最后验证 | `e2e/source-action-recovery.spec.ts` 与 queued-edit 专项 |
| 全源目录、精确身份与恢复命令 | source-discovery **1/1** 已通过：第 350 条、三个 ID、resume clipboard | `e2e/source-discovery.spec.ts` |
| focused Host tools 与队列 `@` 引用修正 | **待最终验证**，不能归入此前专项通过次数 | 最后 core 批次与 [validation.md](validation.md) |
| 生产部署与真实冷/热耗时 | **未部署；当前 GET 503，无法验收** | 后续部署/生产探针记录 |

常驻 Host/browser 的快速检查继续复用 [warm-validation.md](warm-validation.md)，但八检查点 smoke 不等于八份完整 spec。历史冷启动/点击/heap 测量仍保存在 [startup-feedback.md](startup-feedback.md) 和 [one-graph-spike.md](one-graph-spike.md)，不得转记成本轮最终版本或生产达标数字。

## 2026-10-22 后续快速发布

以上表格保留原验收快照，不代表当前部署状态。当前阶段按 [AGENTS.md](../AGENTS.md) 由用户手测界面，Agent 只做相关逻辑、类型、构建与 HTTP 检查。

- 用户最终确认：保留每个 Pane 的独立标题栏；effort 改为滑杆；Codex glass 立即设为默认。新的默认覆盖上文旧计划中的 radio 与非默认 Glass 选择。
- 没有已存外观偏好时，首屏启用 Codex glass；已有明确主题选择或关闭外观的设置继续生效。OLED 黑色背景、降低透明度和 forced-colors 的降级路径保留。外观与 picker 定向逻辑测试 13/13、Client 类型检查通过，界面交由用户手测。
- CodexBash 的通用摘要原先优先取参数中的 `thread_id`，掩盖了已存在的 `command`。通过公开 `tool.call.toolview` 为 CodexBash、Bash、shell_command、run_shell_command、exec_command、local_shell 注册紧凑命令视图：命令在下一行截断，展开后显示完整命令、stdout/stderr 和原始记录；非零退出码并入同条状态。官方工具树、子调用、定位和自动审批拒绝展示仍由官方插件负责。中间输出默认折叠。6 项合成记录逻辑测试与 Client 类型检查通过；这不表示任意第三方工具都已有专用视图。
- 模型面板在 Pane 显示时预取设置，已有设置在后台刷新期间继续可用。Native/Observed 设置读取使用独立的源快照，不再等待正文历史、子会话发现和投递对账。Native 模型目录与源快照并行读取，并按 Hub、机器、Codex home 缓存 60 秒、合并并发请求；身份不完整时只在原源会话内复用。修改默认 effort 时仍读取最新目录，写入与确认协议不变。相关 48 项定向逻辑测试及 Host/Client 类型检查通过；首次未缓存账户仍需实际读取目录，界面耗时交由用户手测。
- 源会话的底栏通过公开 `conversation.composer.dock` 读取原生 usage：Codex 有 total 时显示累计 token，否则标明最近上报；缓存命中按协议区分输入已包含缓存与缓存另计，当前上下文与累计用量分开。点击查看明细，未上报的字段不显示。隐藏源会话中 DSH 适配事件产生的轮数/步骤与速度，普通 DSH 的官方统计保留。27 项定向逻辑测试及 Host/Client 类型检查通过。生产只读探针确认当前会话的 usage 为 null；尚不能宣称该会话已有可见统计，也不推算源端未提供的 tok/s。
- 输入框移除本地 92px（约四行）高度上限，以及正文最小高度、行高、字号和占位文字位置的压缩覆盖。沿用官方编辑器随内容增高、到 336px 后框内滚动的行为，字体大小继续跟随 DSH 设置；紧凑工具栏保留。当前阶段按规则只做 Client 类型检查、构建与 HTTP 检查，实际输入体验由用户手测。

- `118c33c` 已构建发布：初始补历史最多两页，窗口达到 1500 个事件后停止继续预取；预热缓存超过同一预算时只释放缓存自己的 reference；Conversation 外层不再因正文流和每次草稿更新而重新渲染。50 项相关逻辑测试、Client 类型检查通过。
- 待回答表单按 Hub 和原始源会话、request ID 保存身份，display generation 改变时继续复用答案与本页的提交回执。未提交的选项、文本及当前问题写入浏览器存储，刷新后恢复；源端确认请求已结束才清理，不自动提交或重发。相关 9 项逻辑测试和 Client 类型检查通过。
- 上述表单恢复不等于完整编辑器迁移：富草稿、附件、阅读位置的跨 generation 原子迁移以及活跃历史窗口 trim 仍未实现。性能改动也不代表生产 p95 目标已经达标。
