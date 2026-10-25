# HAPI-DSH 提交审计：24–46

审计基线为 `6d540ca58d7b1b84cdcbe4ab7faeeda416a2bc20`。编号来自已固化的[提交清单](commit-audit-manifest.json)，本段 23 个提交均在主线。审计阶段逐项读取了实际 diff，并读取基线源码及相关后续修复，没有运行构建、逻辑测试、浏览器或性能实验。文中的“已有测试”只表示读到了相应断言，不表示审计阶段执行通过；后续授权修复的实际测试另列补充。工作区正在进行的冷打开修复不计入已解决项，更不代表已上线。

本段主要把源设置、草稿、队列和工具接入官方 Conversation，同时收紧历史预读和启动调度。已有改进确实保留下来，但三个层次要分开：有些错误后来被明确修复，有些性能限制只是减少工作量，还有一处同源草稿 owner 移交缺口仍在基线代码中。

## 当前需要跟进的事项

### 1. 同源的新 Composer 关闭后，旧 Composer 不会重新取得自动保存权

引入提交为 **36 / `806b1f0`**。基线 [`composer-autosave.ts`](../src/client/composer-autosave.ts) 第 65–84 行只保存 `key → 当前 Composer`，新对象在第 72 行覆盖旧 owner；最后一个使用者离开时，第 83 行直接删除 owner，没有选择仍存活的旧对象。第 91–92 行随后会静默跳过旧对象的保存。这里和“同一个 Composer 有两个 pane”不同：后者有 `users` 计数，已有测试覆盖。

可核验的协议序列是：以同一原始 `hubId + hapiSessionId` 注册 A；再注册不同的 Composer B；释放 B；继续编辑 A。A 仍有订阅，却不再满足 `owns()`，其新文字不会进入本地备份。相同来源跨 display generation 的两个对象是该键设计明确允许的情况；共享 graph 的旧视图停放路径见基线 `federation.tsx:623–629`。**这是由代码可推导的丢失持久化风险；本次还没有在浏览器证明用户可以沿哪条导航序列停留在该状态，因此不把线上触发频率写成事实。** 一旦发生，刷新或关闭会丢失最后一次成功备份之后的编辑。

现有 `client-composer-autosave.test.ts` 覆盖了旧代关闭、新代继续输入，未覆盖相反顺序。最小修复应在相同 source key 内保留活跃 Composer 的归属次序，owner 离开后把保存权交还仍存活的对象；它只恢复保存权，不能把旧文字强行覆盖到另一个正在编辑的输入框。还应覆盖三代交错关闭、同 Composer 重复 pane，以及其他 Hub 的隔离。

### 2. 每次输入状态通知仍同步序列化整个草稿

同样始于 **36 / `806b1f0`**。基线 `composer-autosave.ts:91–101,127` 在官方 input store 的每次通知中构造全部引用数组、`JSON.stringify` 整份草稿，再比较字符串；只有比较以后才能略过相同内容的 `localStorage.setItem`。因此非正文变化的通知也可能付出整份草稿的序列化成本，真正编辑还会同步写浏览器存储。

这是明确的主线程工作范围，不是已测得的超时，也不能据此解释本次 Host OOM。长粘贴、很多引用和连续输入应加入输入延迟测试；如果测量超预算，再围绕草稿 revision、批合并及离页落盘调整。不能为了性能简单取消持久化，或把未落盘窗口隐藏起来。第 46 项新增的恢复副本会在冲突时读取并序列化完整副本列表（第 108–113 行），也应纳入同一测试，而不是另建一套草稿所有者。

### 3. 原有 opening 指标不是“最新正文可读”的验收信号

**27 / `1ebe52e`** 新增 pane 的 reference/content/composer 计时，**45 / `ccfddeb`** 补上 Host 资源、graph、UI、catalog 阶段。这些指标对 breakdown 有用，且代码本来就注明是 DOM mount timing。

但基线 [`pane-opening.ts`](../src/client/surface/pane-opening.ts) 第 65–69 行只要看到任意 `[data-chat-node-key]` 和 `[data-composer-input]` 就记录 mounted；第 61–63 行再过两次 RAF 将 `data-hapi-pane-opening` 标为 ready。它没有验证源消息水位、最新尾部、旧缓存替换，也没有证明内容可交互。缓存正文先到、归档后来替换时，该指标可以已经成功，而阅读连续性仍失败。不能把这个信号单独当作 HAPI 所要求的冷打开验收。

对照原 HAPI `docs/chat-experience-contract.md:42–46,76–89`，已有正文不应退回空白，晚到更新不应重新初始化阅读，测试必须检查中间帧。本项记录的是验收边界，不把“埋点未实现 fresh-tail 检查”误写成埋点创造了历史替换错误。当前工作区的新冷打开观察与 handoff 修复尚不属于本基线。

### 4. 安装文档仍把部分 UI 验收留给用户

**24 / `5d1ef8d`** 在既有 DSH Web 接入说明结尾写了“界面由用户手测”，基线 `docs/install.md:172` 仍保留。它与基线 `AGENTS.md:20–24` 的现行要求冲突：UI、性能及视觉检查由 Agent 完成，并分别报告逻辑、浏览器、生产和真机证据。早期 `functional-ui-plan.md` 的逐次工作记录也有类似历史措辞，不应作为当前发布豁免。

这属于现行说明需修正的事项；历史记录可以保留当时未测的事实，但安装、发布指引应指向当前自动化验收流程。

## 已追到后续修复的问题

| 历史问题 | 本段位置与引入方式 | 基线中的处理 |
| --- | --- | --- |
| 源端结果未知也显示为排队 | **37 / `2f2b887`** 的 `editableSourceQueue` 纳入 `accepted`、`dispatching`、`indeterminate`，最初测试也把 unknown 算作队列；**44** 仅改样式，未改这个语义。 | `431c659` 改为只接受 `queued`。基线 `source-queue-ownership.ts:7–10` 明确把未知/失败回执留在状态入口。因此不能说第 44 项已修复“假排队”，也不能把旧实现继续列为基线未修。 |
| 自绘命令行偏离复用原生 DSH 工具视图的目标 | **30 / `fdb6f8c`** 用自绘两行命令与原始输出，**46 / `1c19245`** 又加自绘通用工具及事件发现。 | `c694b02` 删除这些组件及发现订阅，使用已注册的官方 Bash component；`a37ef84`、`431c659` 后续扩充语义映射。基线 `source-command-view.tsx:14–33` 是 alias 到官方组件，不再逐项自绘那套工具卡片。 |
| 跨作用域 `setOptionsOpen` | **40 / `09e77df`** 在 `WorkspaceRoot` 的原生历史回调误用只属于 Sidebar 的 setter。 | **41 / `ed507ba`** 立即撤回该回调修改。它是历史提交缺陷，不是基线现存错误；CSS 调整本身不能说明当时整项功能已验收。 |
| 自行包装官方 session slot 来绑定草稿 writer | **36** 同时新增 `composer-persistence.ts`。 | **37** 删除该文件、安装及对应测试，改为直接观察公开 input store。基线已无这一额外 writer 包装层。 |
| 温缓存淘汰重入导致页面卡死 | **25** 所在版本继承了遍历活 Map 时同步 `release()` 的逻辑；不能把整个设计归因于 25。 | `d628377` 用完整 next selection 先提交、再释放旧引用；基线 `session-warmup.ts:114–124` 保留修复。后续测试模拟 `release → catalog → update` 重入。此项已经修复，仍需区分它和后端 OOM。 |
| 手机仍有顶部 pane 条、工具挤成多行 | **40/41/44** 主要压缩边栏、背景、队列，并未完成后来的手机导航要求。 | 基线 `styles.ts:283–307` 已有手机无 pane header、单行底栏和收拢输入控件；不能据早期几次 CSS 提交认定当时已完成手机验收。视觉质量仍应以对应版本截图为证据，本次没有新截图。 |

## 逐提交覆盖

下表的“仍影响基线”按实际保留的行为判断，不能把“提交仍在祖先中”等同于实现未变化。全部 Agent 归属均记为 **unknown**：本次未把实际写入工具调用逐项对应到模型会话，Git 作者及提交时间不构成模型证据。

| # / 提交 | 实际目的和非 UI 改动 | 仍影响基线、后续变化与审计结论 | 读到的验证范围 |
| --- | --- | --- | --- |
| 24 `5d1ef8d` | 补既有 DSH Web 安装 Runner 插件、独立配对、回环监听、HMR 与 idle restart 的说明；不另开进程占用同一 data dir。 | 既有 Web 接入文档仍在。执行与凭据边界合理；末尾“用户手测”已过时，见事项 4。无运行代码。 | 文档 diff；基线安装与 AGENTS 交叉检查。 |
| 25 `118c33c` | 初始历史预读上限从 20 页降到 2 页，新增 1500 event 上限；warm lease 超限释放，保留可见 pane 自己的引用；Session shell 减少大对象订阅。 | 限制仍在 `seamless/initial.ts:7–8,59` 和 `session-warmup.ts:54,82–95`。减少不必要工作，但事件条数不能约束单条巨量工具输出的字节/解析成本，也不是 viewport virtualization。温缓存重入后来另修，见上表。 | 页上限、event 上限、隐藏窗口、warm lease 释放与不立即重取的协议测试。未覆盖大正文主线程成本。 |
| 26 `92df62f` | 问答草稿与审批提交状态用原始 Hub/source session 加 request ID 定位，避免 display-rN 更换丢失；未提交回答写 localStorage，已解决请求才清理。 | `native-state.ts` 与 `native-actions.tsx:194,220,243,271` 仍使用原始身份。恢复只恢复答案，不自动重新提交；已有来源隔离和字段校验。没有发现该 diff 造成跨源共享的证据。 | display generation、reload、Hub 隔离、过期题目字段与不可读 storage。 |
| 27 `1ebe52e` | 增加 pane reference/content/composer 三段耗时和 incomplete 原因；只进 diagnostics，不额外常驻 UI。 | `surface/pane-opening.ts` 仍使用这些定义。只说明挂载，不能证明新鲜内容与连续阅读；见事项 3。 | 时钟可控的 timing 类测试、重复/关闭/空会话分支；没有冷开中间帧断言。 |
| 28 `08c8823` | 原样打包官方 module loader，为每个 graph 提供 style 查询作用域；不同 DSH build 不再误共享样式去重/HMR 清单。 | `graph-document.ts:7,17`、`federation.tsx:231–235` 仍在用。限定 style 查询，普通 DOM 查询仍全 document；没有修改官方 loader 字节，也不能据此声称所有跨 graph DOM 焦点都隔离了。 | pinned loader、CSS 查询 facade 的测试。没有把模拟 DOM 当浏览器样式证据。 |
| 29 `c4a7d40` | 默认开启外观层并使用 glass；OLED glass 黑底；推理强度只显示源支持的离散档，拖动预览，松手/键盘/失焦才提交。 | 默认 glass 仍在 `appearance/preferences.ts:23–24`；picker 后续拆分，但源能力与确认值原则保留。配色变化本身不能证明布局或移动性能达标。 | 默认值、显式关闭、OLED 与支持档位逻辑；文档当时未声称浏览器视觉通过。 |
| 30 `fdb6f8c` | 增加 dsh-client-ui-tool 直接依赖；解析 shell 参数、stdout/stderr/退出码；6 类源工具自绘命令/结果，避免把 thread ID 当命令。 | 参数语义处理继续演进；自绘组件已被 `c694b02` 的官方 alias 替换。初版仅对 argv shell 包装有拆解，string 包装等可读性不足不能因有单测就算解决。 | 命令与传输 ID 区分、argv、输出/退出码、准备中参数。 |
| 31 `c7430d3` | 设置读取不等待全历史同步；snapshot/model catalog 并发；按 Hub/machine/home 缓存模型 60 秒并合并在途请求；当时加入可见 pane 预读设置。 | 核心仍在 `hapi/native-control.ts:130–158`；未知 home 退回 source-specific key，防止借错账户。当前 picker 已改为按需首次加载，而已有数据在源状态变化时刷新，不能说当年的 eager preload 全部原样存在。 | 设置不调用 transcript refresh、并发模型读、账户隔离、TTL 与失败重试。 |
| 32 `2bab966` | 原生统计用真实源 usage，区分 cache 已包含/额外计数、累计/当前 context；没有数据时不造 token/s 或 DSH 活动量。 | `source-usage.tsx:55–68`、`source-usage-model.ts` 保留该路径，只对源会话隐藏不适用的统计。原生统计语义与普通 DSH 分开，没有发现该改动越过执行边界。 | 多种计数口径、未知 cache 口径、零值与实际传输 shape。 |
| 33 `8304f2c` | 删除本地 92px 输入高度上限及文字/placeholder 尺寸覆盖，恢复官方自增长与上限。 | 当时的强制上限已删除；后续手机 CSS 仅压缩 card/toolbar 等，不应把这项归为另写编辑器。仍需长输入实测，文档中的用户手测不是验收。 | 样式与说明 diff，没有新增交互测试。 |
| 34 `33b18b2` | 删除把 projection.readOnly 直接印为“只读”的附加标签；源连接/权限变化触发设置刷新，保留实际权限值。 | 冗余标签已移除。它当时还没有完全解除 settings picker 对历史 fault 的锁定，35 和 43 才补足；不能单算 34 已修完“源允许却禁用”。 | 样式、picker 和 presentation diff。 |
| 35 `35a930e` | 把 history read fault 与真实来源故障分开；轻量设置读取前后核验 source identity，成功只清历史读 fault；设置确认和库读取不再强迫同步全历史。 | `codex/agent.ts:614–624,808–814` 及 observed 对应实现仍保留。保留 identity guard，历史碰撞不能覆盖真实错误；没有发现“刷新设置绕过授权”的证据。 | 历史错误后读写设置、真实 fault 不被遮蔽、source 更换不得清错。 |
| 36 `806b1f0` | 按原始来源持久化文字/引用/命令 token；通过公开 editor verbs 恢复；跨 pane 共用订阅，并阻止旧代清理覆盖新代；同时曾加入 session slot writer 包装。 | 自动保存仍在，writer 包装在 37 删除。owner 关闭无回交与每通知整份同步序列化是当前事项 1、2；其余引用、正在提交时不恢复、命令恢复不执行等边界保留。 | 同对象双 pane、旧代关闭、刷新恢复、引用、命令、storage 失败。缺失“新代先关、旧代继续”分支。 |
| 37 `2f2b887` | 接管源队列编辑/删除/插话；编辑先得到原生取消确认，再恢复正文及附件路径；移除额外的官方 composer writer 包装。 | 确认后恢复的逻辑仍在；队列筛选把 unknown 算排队是本提交明确引入、后来 431 修复的问题。恢复附件路径并非把附件字节重新伪造成上传成功。 | 取消确认、正文空白/换行、附件路径、slot owner、普通 DSH 委托；初始队列测试也编码了错误 unknown 计数。 |
| 38 `da3a4ba` | 修上一项 slot 测试 fixture 的 owner props，用正确的 root 空渲染替代错误 renderSlot。 | 仅测试代码，无产品行为改变；不能单独作为队列浏览器可编辑的证据。 | fixture 层。 |
| 39 `37d0629` | 所有 queued-edit 恢复回执都已恢复时收起恢复详情；未完成/错误仍可见。 | 相应恢复状态入口仍保留；它不处理未知消息是否已送达，也不改变原生取消动作。 | 单点 UI 条件 diff，未新增浏览器测试。 |
| 40 `09e77df` | 边栏新建/插件/自动任务压缩；筛选、归档和机器等移入列表选项；状态合并到会话第二行。 | 整体方向保留，后续 rc.3 More 独立窄按钮修复见 `styles.ts:260–264`。同时引入越作用域 setter，41 已撤回。筛选挪入选项只改变可发现性，不等于后台丢失 Codex 目录。 | 代码/样式 diff；当时的布局说明不是视觉验证。 |
| 41 `ed507ba` | 减轻 glass 底色、边界与 focus 样式，主区/输入区宽度扩展；撤回 40 的错误 callback。 | 配色/布局经过后续迭代，基线仍以轻边框与充分可用宽度为主。修回 setter 是实际功能修复；“像 HAPI/美观”不能由这些 CSS 数字单独确定。 | palette 与样式测试；历史 diff 对照确认 callback 撤回。 |
| 42 `0de4244` | 官方 session/updateQueue 的 steer 对源会话转到原生 inbox；按 message/local ID 找已 queued 回执；失败按真实结果报错，普通/child DSH 仍委托官方实现。 | `codex/session-controller.ts:117–131` 保留路由；不因为点击插话就制造本地成功，也不自动重发 unknown。必须与 37 的队列显示错误分开看。 | 原生路由、普通路由、失败不转成功、call ID 与非 queued 拒绝。 |
| 43 `f2301fd` | 设置控件不再由 transcript readOnly 一票锁死；只在 input 提交/裁定阶段锁交互，各选项由新鲜 capability 决定。 | `composer-picker/index.tsx:178–218` 保留该区分；实际源 mutation guard 仍在服务端。不可用说明改为当前快照暂缺能力，允许重查。 | 两文件 diff；与 31/35 的定向测试共同约束，但本项没有独立浏览器过程证据。 |
| 44 `db4be94` | 队列默认折叠、限宽/限高、透明浅边框、SVG 图标，粗指针按钮 44px。 | 折叠与 compact 样式仍演进保留。只改展示，不修 unknown 语义，不修源端确认；旧截图中“又排队”的原因不能归结为图标是否已发布。 | 样式与初始化状态 diff；未新增行为断言。 |
| 45 `ccfddeb` | 前景 Host 分批加载，启动不顺带预热五个无关会话；pane ready 后再调 warm；记录资源/graph/UI/catalog 耗时；新增只读传输探针。 | `federation.tsx:447–483,933–939` 当前只预热用户明确访问/悬停过的会话。Host timing 保留，但真实 UI 完成仍需事项 3 的更强观测。探针只是传输元数据，不是浏览器冷开。 | Host 计时测试；文档有传输体积/时延历史样本并明确 UI 尚未闭环，本审计不把历史数字当当前结果。 |
| 46 `1c19245` | HostBootQueue 前景优先并限制并发；空闲且无草稿/附件/审批的隐藏大历史才释放；新建继承当前目录/机器，机器按真实 ID 去重；草稿冲突副本、附件持久化 ownership、显式跨代恢复；原生 Goal editor；工具摘要/发现；部署脚本与兼容矩阵。 | 大部分保留。工具自绘发现后被 c694 删除；Goal 仍用源操作，不伪造 prompt；跨代手动恢复核对原始源，隐藏历史释放见 `controller.ts:405` 与 `history-retention.ts`。附件使用可移交的 `DraftOwnership`，不等于文字的 `ComposerAutosaves` 已同样移交。发布脚本后来扩充，不能只按此版 idle guard 评价现行发布。 | Host 队列、隐藏历史保护、归属移交、冲突追加、显式跨代恢复、语义摘要、新建上下文等逻辑测试；无相应移动连续手势测量。 |

## 范围结论

这 23 项不能概括成“完全没修”或“已经全好”：真实源设置和身份恢复等改进仍有效；假队列、自绘工具和 warm eviction 重入有明确后续修复；输入持久化移交仍有代码缺口，输入长文本成本与冷开 freshness 则缺少原有测试所能提供的证据。页数/event 数限制、类型检查、构建成功和 HTTP 探针，各自只证明它们实际覆盖的层次。

后续若修事项 1，应把负向复现及修复后的逻辑结果作为独立补充，不能回写成基线本来就正确。其它 Agent 正在审计的冷开缓存、lease handoff、后台投影和发布路径，不在本文件中重复认领结论。

## 审计后授权修复与验证

事项 1 已在工作区修复，尚未在本任务中构建或部署。`ComposerAutosaves` 现在记录各活跃 Composer 的 source key，当前 owner 的最后一个使用者关闭后，选择同源最近注册且仍存活的 Composer 继续保存。恢复归属时不立刻落盘旧输入，不改变任何 live editor 的文字；等待该 Composer 的下一次草稿 revision 变化才重新写入，同时清除上一归属期的写入去重缓存。这样既恢复后续自动保存，也避免用户未编辑旧窗格、直接关闭时把较新的备份覆盖掉。

实际命令为 `node --import tsx --test tests/client-composer-autosave.test.ts`。在原产品代码上加入前三项回归后，13 项中 11 项通过、2 项失败，耗时 540 ms。两个失败分别为继续编辑旧 generation 后备份仍停在新 owner 的文字，以及中间 generation 已关闭、仍有重复 pane 时保存权没有交回。日志保留在 `/mnt/cache/data-cache/hapi-dsh-draft-owner-negative.log`。

修复后再补“连续关闭两代应依次回到最近存活者”的断言，共 14 项全部通过，耗时 538 ms；覆盖未编辑即关闭不覆盖新备份、同对象多 pane、跨 Hub 隔离、返回旧的相同文字后正确落盘，以及原有引用/命令/提交中/存储错误恢复。日志为 `/mnt/cache/data-cache/hapi-dsh-draft-owner-positive.log`。本次 `git diff --check` 也通过。以上是使用官方 snapshot store 的逻辑回归，不是浏览器导航复现或生产验收；同步整份草稿的成本没有在此次最小修复中调整。

根线程另行修正了现行安装文档的“用户手测”措辞；本文件对第 24 项的描述仍针对原审计基线。
