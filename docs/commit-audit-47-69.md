# HAPI-DSH 提交审计：47–69

审计基线为 `6d540ca58d7b1b84cdcbe4ab7faeeda416a2bc20`，编号对应[完整提交清单](commit-audit-manifest.json)。本段覆盖 23 个主线提交。逐项读取了实际代码 diff、相关测试断言，并沿后续提交追到基线；大型提交中的文件搬移和生成 lockfile 按模块、依赖版本及调用链核对，不将其表述为逐行形式化证明。

审计阶段没有运行构建、逻辑测试、浏览器或性能实验。下文“测试覆盖”指读到了相应设置和断言，不表示本次执行通过。当前工作区另有正在验收的修复，不能倒算为基线已修复，更不能据此声称线上版本已经更新。本段没有逐提交核对执行模型的原始工具日志，Agent 归属均为 **unknown**；Git 作者不构成模型归属证据。整体报告中另有直接日志支持的局部归属，不受本段这一证据边界影响。

## 基线中仍需处理的问题

### 1. 缓存首开会绕过源端最新尾页

**P1。** 基线 `src/codex/agent.ts:313–324` 在 opening cache 存在且具有 epoch 时，直接用缓存创建初始展示；只有缓存条件不满足才调用 `readNativeHistoryTail(..., 1)`。`src/hapi-agent/agent.ts:197–205` 的 observed 路径也有相同问题，而且只要求缓存存在。两条路径会设置 stale/fault，因此不是把缓存伪装成已经同步；问题在于用户首先看到的正文可能很旧，最新内容要等后台归档同步才能补上。

缓存优先的原始条件来自本段以外的 `9e459db3`。本段 **51 / `9be022b1`** 增加 Codex 缓存 epoch 条件，**56 / `c366dad5`** 将其改为小 opening cache，并将无缓存时的读取缩为一页，但都没有要求有缓存时也先读最新尾部。epoch 可证明历史结构身份，不能证明普通追加的消息已经进入缓存。

可核验的触发序列是：持久化较旧 opening cache；源端追加消息而 epoch 不变；重新创建 Host 或重新 attach 该源；观察初始展示与完整归档完成之间的正文。仅在同一已 attach Host 上 reload 浏览器不能可靠触发该分支。修复应先获取有界最新尾页，源不可读时再明确回退到 stale cache，并用历史 checkpoint 合并并发增量。根线程正在修复两条路径，此处记录的是基线缺陷。

### 2. 设置插件第一次加载失败后，重新打开也不会重试

**P2。** 基线 `src/client/deferred-plugins.ts:98–100` 在开始前把 `started` 永久设为 true；第 110–126 行的 graph 请求、资源装载或官方 entry reconciliation 失败时，第 129 行只记录错误，没有释放该状态。第 139–143 行在下一次打开 Settings 时调用 `start()`，会被第 99 行直接略过。一次 bootstrap 503、网络错误或 JSON 解析错误，足以让剩余插件本次页面生命周期内无法再加载。

这一锁存始于 **56 / `c366dad5`**；**65 / `301c1526`** 改为显式 Settings 需求后，用户重开入口也受它影响；**66 / `67375a05`** 将同样策略用于远端 Host。已有 `client-deferred-plugins.test.ts` 测试阶段同步、下载期间手势与取消，没有测试安装函数的失败后重开；`cold-boot.spec.ts` 延迟 Account 下载，但没有让首次 graph 请求失败。

最小验收需要真实 Settings 第一次 bootstrap 503、关闭重开后成功，以及同一进行中请求和成功后的重复打开不重复加载。已另读 pinned rc.3 的公开 loader：`ClientEntries.sync` 会对同 revision 的缺失/FAILED entry 再次 reconcile，`ClientModuleSystem.loadShared` 在 finally 清除 pending transport，importErrors 仅记录诊断而不缓存 rejected Promise。因此可以沿原公开同步路径重试，不需要修改上游或自行清模块缓存；这项静态结论仍需真实失败加载的浏览器回归验证。

### 3. 标为只读的冷开探针仍允许写操作

**P1，影响探针的生产安全边界。** 基线 `scripts/probe-cold-open.mjs:15–23` 把 `dynamicCordisRunner/syncInspectManifest` 和 `hapi/sourceSessionResolve` 放入 HTTP 允许列表。前者同步 inspect manifest，后者可能创建新的 display/attach，并非纯查询。第 28–40 行只拦截 HTTP RPC，没有限制 WebSocket 的客户端命令，因此“生产测量不写入”的注释并未由完整传输边界实现。

探针在 **51** 引入；后续增加 HTTP 拦截仍留下这些入口。**66** 新增的 `probe-federated-cold.mjs` 已有 WebSocket allowlist 和拒绝 client item 的处理，说明不必放开命令才能测量已有会话。正确行为是在未 materialize 的会话被只读边界阻断时报告 blocked/unverified，不能为了获得耗时而悄悄创建它。

当前工作区已删除这两个 HTTP 例外，并为旧探针补上同等 WebSocket 限制；该变更不在审计基线中，本段没有执行生产探针。

### 4. 首次出现正文不等于最新正文持续可读

**P2，验收盲区，会掩盖 P1 体验问题。** 基线 `e2e/ui-acceptance.ts:25–40` 在某次采样看到匹配正文就记下首次 body，在另一次看到 editor 就记下首次 editor，两者一旦都曾出现便完成。它没有要求二者同一时刻可用，也没有记录随后消失、标题回退或源端最新水位。旧 `probe-cold-open` 同样在任意正文和 editor 首次出现后停止 RAF；`scripts/probe-federated-cold.mjs:101–106` 还把“不包含目标 ID 的任意非空标签”算作标题就绪，因此 `Pane: Untitled` 也可能通过。

首次命中指标始于 **51**，**66** 的远端探针沿用这一模式。`src/client/surface/pane-opening.ts` 原本注明是 DOM mount timing，这类埋点对 breakdown 有价值，不能单独充当新鲜度或阅读连续性验收。已有冷开测试也大多 reload 同一个运行 Host，没有覆盖“旧持久缓存 + 新源尾页 + 重新 attach + 阻塞归档”的完整组合。

测试应从 navigation 开始记录源端独立给出的最新标记或 sequence、标题的每次变化，以及真实可见且可交互的输入框，并持续观察归档替换后的稳定窗口。工作区正在实现该测试；其中已经定位的 live Range 在 DOM reparent 后塌缩属于观察器误报，不能算作产品正文消失的证据。

### 5. 手机加载边界的特定用例仍可能漏掉瞬间跳动

**P2，测试缺口，不等同于已证明的当前产品 bug。** 基线 `e2e/mobile-scroll.spec.ts:648–672` 在放行历史页后等待高度增加，再等待 80 ms，才验证同一旧行仍在、插入量和最终 offset。逐帧样本只检查 blankFrames，没有在这四条边界路径上检查固定旧行的每帧偏移。正文先跳到另一处、80 ms 内又回到正确位置，可能通过最终断言。

**60** 增加持指和松手的加载边界场景，**61** 增加手动请求与反向滑动，但此处仍检查最终位置。**68** 的桌面对应场景已经逐帧检查同一旧行，移动用例没有同步这一验收。不能概括成“所有手机测试都只看最终状态”：其他连续手势用例有帧时间和运动指标，这里缺的是这几条精确边界路径的固定锚点。

根线程已在当前工作区补上这四条路径的逐帧断言，并报告 4 项通过、四张截图已查看，采到的提交帧分别为 6/9/9/9，最大漂移均为 0 px。本段没有重跑；这是本轮修复后的独立验收记录，不是基线原有证据，也不代表物理手机验收。

## 已追到修复的历史问题

| 问题 | 本段的修复与基线状态 |
| --- | --- |
| 温缓存淘汰导致整页无响应 | **48** 修复在活 Map 上迭代时同步 release 重入 update 的循环。先提交完整 next selection，再释放旧快照；基线保留。它与后端 V8 OOM 是不同问题。 |
| unknown 回执被显示成可编辑排队 | **47** 仍把 accepted、dispatching、indeterminate 视为队列；**55** 改为只有 queued 才进入输入区。未知回执仍可检查，未被伪装成功；**64** 再移入既有菜单。 |
| 命令摘要都是 shell 包装字符串 | **47** 改用官方 Bash component；**50** 扩充官方工具 alias；**55** 利用源 command_actions 和安全解包生成短标题，展开保留完整命令和输出。 |
| 移动顶部条、单 pane P1、常驻感叹号 | **49** 只是缩小控件；**63** 才隐藏手机 pane header、仅多 pane 显示 P 标签并加底部返回；**64** 将回执入口移入现有 ⋯。不能把早期 CSS 改动当作全部要求已完成。 |
| 同步布局反复提示冲突 | **62** 增加基于已确认版本的三方 rebase、等价 binding 判定及有界重试。互不冲突的编辑不再弹横幅；真正冲突保留用户选择，未丢掉未保存布局。 |
| 累计文本切片和 ScopeIndex 保存原始行导致内存保留 | **67** 复制独立 UTF-16 delta，**69** 只保存 scope 所需元数据。隔离负控针对具体保留链，不能据此宣布整个 Host 已有内存上限或长期 OOM 全部解决。 |

## 逐提交覆盖

表中“保留”指基线仍存在相应实现，不只是提交仍为祖先。全部 Agent 归属为 unknown，理由见开头。

| # / 提交 | 实际目的及主要代码变化 | 基线状态、风险和已读测试边界 |
| --- | --- | --- |
| 47 `c694b02` | 删除自绘命令组件，native shell alias 到已注册官方 Bash view；只有真实 exit code 才生成对应成功/失败状态，未知结果保留通用 inspect。队列增加附件缩略图、紧凑按钮与折叠；图片仅走对应来源的受鉴权 artifact 路径，失败回退文件名。完成时间与侧栏状态取源事实。 | 官方视图复用、附件和源状态仍保留。此时 editableSourceQueue 包含 accepted/dispatching/indeterminate，是历史错误，55 已纠正；工具语义在 50/55 扩充。读到 adapter、附件、队列归属及侧栏测试，不能据此推断所有引擎视觉一致。 |
| 48 `d628377` | `session-warmup` 先提交完整下一组选中项，再遍历旧快照 release，阻止 release→catalog→warmRecent→update 重入活 Map；只温存明确 recentlyViewed，不自动预开无关最近会话。 | 修复保留。回归通过 release 回调同步重入并限制调用次数来捕捉原死循环；代码证据具体。文档同时区分用户 trace、协议测试和服务端 RSS，未将这次修复误称为所有内存问题解决。 |
| 49 `b1ec203` | 手机隐藏折叠左栏、压缩顶部与底部高度，输入工具保持单行；隐藏冗长 picker 标签和默认协作标签，pane 导航移入 footer。 | 该版本仍有顶部条和单 pane P1；后由 63 完成更精确行为。涉及官方类名的 CSS 依赖需随版本升级验收；此提交未增加完整移动浏览器断言。 |
| 50 `a37ef84` | 接入 native capacityRecovery，取消仍调用原执行所有者；补 Read/Write/Edit/MultiEdit/Grep/Glob/Patch 到官方工具组件的语义映射。文档选区通过官方 editor 插入，草稿以原始 source 身份保存，恢复不自动发送。源消息 ID 与 display seq 映射用于跨代阅读锚点；新增 parity 文档。 | 映射、恢复及源身份仍保留。多编辑按官方块展开、未知原始 inspect 保留；capacity state 需对应当前 turn，未复制执行引擎。阅读恢复随后由 59/63/64 补齐分页等待和精确 pane 查找。文档的功能盘点不能代替当前浏览器验收。 |
| 51 `9be022b` | 每次 stream start/chunk/end 推进投影 revision，修正相同 revision 使增量丢失；实时尾部与归档读取分开，checkpoint/epoch 合并避免归档覆盖更新。增加小 recent-view 池、Host foreground boot 排队、可见区有界锚点定位、懒加载语音/capture，并增加 UI acceptance 和生产冷开探针。 | 核心保留，后续继续收紧工作量。recent-view 池受数量和事件数限制，不等于所有 Host 历史都有字节预算。缓存 epoch 条件未解决事项 1，first-hit 验收存在事项 4。测试含增量未完成可见、源离线、审批归属、关闭不 abort、队列编辑保留独立草稿及 360/390 px 布局；合成会话和同 Host reload 不能代表真实长归档冷开。 |
| 52 `5cda786` | 仅记录 UI 测量与尚未完成事项：83/86、三个滚动失败，以及 CPU 限速冷开结果和一次回滚。 | 无运行代码。文档明确没有全量通过，并保留物理键盘、惯性、多 pane 和长期内存的未验证边界；这些历史数字不是本审计的当前结果。临时证据路径有保留期限，不能当作永久可复核附件。 |
| 53 `e9ffa4e` | 发布 0.1.1；新增交互隐藏输入/管道 login、凭据私密写入与校验，CLI 通过 realpath 支持 npm symlink。打包包含全部懒加载 chunk 和安装指引；干净 tarball 安装在含空格路径运行，并新增 Linux/Windows/macOS CI 矩阵及 release 门槛。 | 安装机制保留，65 升到 0.1.2 并校准旧 buildinfo 版本。smoke 真实安装包、调用 shim、验证 login 不输出 secret，并启动官方 Host 验证 HTTP admission；Runner 部分使用合成 invitation，不证明真实远端配对或原生执行。CI 配置存在不代表本次已在三种系统执行。 |
| 54 `fd57928` | Windows credential 原子 rename 遇 EPERM/EACCES/EBUSY 时有界退避重试，保留 fsynced 临时文件与原目标，不先删除目标；其他错误和平台不盲重试。同时更新 HAPI revision pin。 | 实现保留，保护原子替换语义。测试注入 move 失败，验证次数和错误类别，不等同于真实 Windows sharing violation 实测。 |
| 55 `431c659` | 源队列仅保留 queued；root 与 remote 使用统一 native actions，补齐检查/恢复入口；检查回执可从其他客户端提交的真实源行关联，只有明确 invoked 才移除，缺席不推断成功。命令短标题利用 command_actions，安全解 shell 包装，完整内容留在展开区。 | 保留，64 进一步整理入口。E2E 实际构造 unknown 回执、reload 和检查，断言没有隐式 send/cancel；真实 queued 编辑仅取消相应消息。命令用例包含非零退出与未知退出、窄屏和完整展开输出；不能把缩短摘要当作所有工具皆已等价映射。 |
| 56 `c366dad` | 原生/observed 目录按需 attach，不为全目录拉历史；小 opening cache 存末尾 200 行，无缓存只读一页。状态与 notice 发布拆分，官方初始 follow 限 20。固定 revision 的 JS/CSS 长缓存、官方承载 WebSocket 压缩与流量背压、初始图裁剪和延迟插件，并加强部署静态资源/协议探测。 | 大部分保留；57 再减少 execution watermark 帧，65 收窄延迟集合。未解决有缓存时旧正文，且引入事项 2 的 latch。压缩承载保留 origin/auth/heartbeat/cancel；仅静态检查不能保证长期没有连接保留。按需 attach 只降低首次成本，不会自动回收已访问源的投影历史。 |
| 57 `212afb` | durable 状态升级并拆开 session-state、execution、notices；wire 忽略仅 execution.sequence 改变，保留实际执行事实，减少不变投影和完整状态复制。支持旧状态格式，WeakMap memo 以不可变对象为键。 | 保留。测试比较实际值、durable sequence 和旧格式，并非仅测试通知次数。减少分配频率不等于解决累计字符串保留；后者由 67/69 处理。 |
| 58 `feaefd` | native 与 asset 测试使用平台临时目录，替代 Linux 固定路径。 | 仅测试可移植性，无产品行为变化；没有增加新功能验收。在本机仍应遵循既有 TMPDIR/临时目录约定。 |
| 59 `2a044ef` | 连续触摸、惯性、嵌套滚动与正在加载的历史页共同管理锚点，页插入补偿计入读者自身位移；等待官方分页 flight，防止恢复调用被无声略过。抑制根文档下拉刷新而不禁止正常触摸/缩放。将 admin/native/session panels 懒加载，通过公开 editor 与 utility pane 复用；构建和安装检查新增 chunk。 | 主路径保留；60/61 补加载边界和手动请求的遗漏。前景活动阻止无关插件/Host 工作，但网络到达期间新手势还需 61 再次检查。测试使用真实 CDP touch、延迟分页、展开工具和 overscroll 检查；移动断言的特定盲区见事项 5。大量 panel diff 是搬到懒加载文件，不是另建执行器。 |
| 60 `c5af894` | pending 页期间在上边界松手，保留旧行直到插入；只有仍在边界且浏览器未自动补偿时才补 scrollTop，不覆盖读者已经离开的定位。 | 保留。新增持指/松手两种 600 ms 网络门和从加载控件起手的用例，验证真正插入更早内容以及最终旧行 offset。未逐帧核对固定旧行，见事项 5。 |
| 61 `5b6ff47` | 区分自发自动分页和已经存在的官方手动请求，观察后者不重复点击、不消耗自动页预算；支持松手/反向移动。插件先 preload 下载，再 task yield 并重新检查前景，避免资源下载结束正好打断新手势。 | 阅读行为保留；65 改为 Settings 显式需求，但下载和激活分离仍在。测试补手动/反向边界与预算，也修正触摸测量首帧、嵌套工具 hit test 等伪通过来源；事项 5 仍是独立缺口。 |
| 62 `25bc000` | 用最后确认的 syncBase 做布局三方 rebase；独立窗口/pane 编辑可合并，等价 source/display generation binding 不构成冲突，远端回声不回写。真正资源冲突保留选择，有界三次 retry 和本地未决副本避免忙循环/丢布局。 | 保留，不是简单隐藏报错。双 context 用例实际检查普通 reload 不写 revision、一次编辑一次写、移动写失败后与桌面独立修改合并及多次 reload 保持。冲突必须有明确语义，不能为了“像 HAPI”无条件覆盖一端。 |
| 63 `4764ae0` | 手机断点统一为 640，隐藏上方 pane header，底部左端返回打开 session picker；一个 pane 不显示 P1，多 pane 保留选择。picker 焦点回到返回控件而非强开搜索键盘；重新选择当前会话只关 picker，保留阅读意图。回执定位缩到本 pane/footer。 | 保留，满足用户明确的移动导航结构；64 再修 footer 外层菜单展开。协议测试检查租约/阅读状态，mobile chrome 用例检查控件存在与可见；本审计未看新截图，不作主观视觉已通过结论。 |
| 64 `3199931` | 去掉常驻红色感叹号，将原生回执放入桌面和手机已有 ⋯ 菜单；unknown 检查后仍明确未确认。显式定位回执时打开本 pane 自己的内外 details，不查询兄弟 pane，保留局部 MutationObserver。 | 保留。DOM fixture 验证外层菜单展开和作用域；它不改变投递事实，也没有增加自动重发。紧凑样式、44 px 操作区域需对应版本视觉验证。 |
| 65 `301c152` | 精确升级官方依赖 rc.3，版本/NOTICE/buildinfo 更新为 0.1.2。初始 catalog 未绑定前暂缓 workspace/follow，避免空布局抢恢复；远端官方 panel 在 React mount 前选中，防止隐藏会话抢焦点。entry-customization 通过公开 workspace 方法保留 preset/append，图中保留所有会影响已显示 UI 的 provider，仅 Account/HMR 等显式延迟。 | 基线为 rc.3。延迟需求减少后来全局 provider 激活造成的长任务，但失败 latch 仍在。测试验证入口、菜单、workspace 恢复、Account 延迟下载等；同一 revision 安装包与在线 Runner 的兼容升级仍需生产编排，Git diff/锁文件不能证明已部署。 |
| 66 `67375a` | 远端 graph 采用同一初始插件策略和本 Host 的延迟 transport；不可变资源允许命中缓存，移除重复 catalog refresh；每个地址仅首次 session/follow 限 20，重连保留读者要求的较大 window。新增远端冷开探针。 | 保留。E2E 检查一轮目录、初始无可选资源、reload 相同资源 transferSize=0、草稿与断线后 500 条 follow 保持。它覆盖普通远端 DSH，不覆盖 native 旧缓存重新 attach。探针的 WS 只读边界较完整，但 Untitled/首次正文问题见事项 4。 |
| 67 `5784b23` | 两个 projector 用独立 UTF-16 delta 替代累计字符串的 slice，避免小子串保留完整父串；observed commit 同时更新 live.text，防止重复 final tail。增加实际 projector 的 GC 隔离负控与线性预算测试。 | 保留。代码保留代理对和未配对 code unit；测试覆盖 live/durable delta 拼接、reasoning 和大文本。负控比较 512/1024 累计快照，产品预算按最终文本长度；这是特定保留链测试，不覆盖所有 Host 队列、已 attach 历史或长期生产工作集。 |
| 68 `a5073b2` | 桌面 wheel 在自动/手动历史加载时保留旧行锚点，边界等待与反向滚动重新取位置，避免 page arrival 弹跳。 | 保留。三种桌面 gate 场景除最终位置外，逐帧检查同一旧行 offset ≤ 2 px；这是手机边界用例原先缺失的断言。截图在另一个可视 replay 产生，瞬间状态应依据测量 JSON/trace，不以最终截图替代。 |
| 69 `6d540ca` | ScopeIndex 的 fact 不再持有完整原始消息，只保存 lineage、tool/agent card、label、状态等实际归属所需字段，阻断累计正文的另一条保留链。保留嵌套 scope、prompt/tool 匹配与 terminal 状态语义。 | 保留。元数据仍按源行增长，并需要排序/处理，因此没有变成全局常数内存。测试覆盖归属和终止后 bookkeeping，以及 512/1024 行负控的原始正文保留；没有把降低 body 保留量宣称为所有后端 CPU/内存已受限。 |

本段最重要的区别是：工具、排队、移动导航和若干滚动错误确实有后续修复；冷打开的新鲜度、完整过程验收和首次插件失败恢复却仍有基线缺口。继续改进应围绕这些可定位路径补证据，而不是把测试总数、热 reload 或静态资源 HTTP 成功当作整体体验已经达到 HAPI。

## 审计后授权修复的状态

本轮工作区已对事项 2 作最小修复：只有非取消失败才释放 `started`，进行中和成功状态仍去重；下一次 Settings 打开重新取得当前 Host graph，继续调用官方 `entries.sync`。没有后台无限重试，也没有替换官方 loader。

`e2e/cold-boot.spec.ts` 新增 bootstrap 503 和 Account script 503 两种真实浏览器故障注入。后者阻断该次加载的所有 Account 请求，不能仅让 preload hint 失败后又由官方加载器悄悄成功。两例检查首次失败不标 ready、关闭后不自行重试、重开成功、重试进行中再次开关去重、成功后去重、原 editor 与草稿保留且没有发送。成功态截图是 fresh replay，不能代表故障发生的中间画面。落盘时仅 `git diff --check` 已通过，实际浏览器和构建由根线程串行验收；本段不预先填入通过结果。
