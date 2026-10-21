# HAPI 功能与交互对照表

这份表按原 HAPI 的实际页面、组件和行为测试核对功能，作为 drop-in 替代的开发与验收清单。**目前尚未达到完整 HAPI 功能和 UX 的超集。** 表中的“已实现”只覆盖该行写明的范围；存在浏览器测试并不等于连接真实模型、真实账号或所有第三方插件均已验收。

基线固定为 [HAPI `55166cf8`](https://github.com/dqtz5vpvj9-create/hapi/tree/55166cf8d87814ccfb383b538a8e8c55283bed81) 与 [DSH `687f282e` / `0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)。下表的 HAPI 路径均相对前一个固定提交，项目路径相对本仓库。上游保持只读，来源与许可证见 [UPSTREAMS.json](../UPSTREAMS.json) 和 [NOTICE](../NOTICE)。本轮暂停发行与安装器扩展，优先完成产品功能。

## 状态与验收口径

- **已实现**：生产代码已有真实调用和可用入口；测试只证明注明的边界。
- **部分**：核心路径已有，但该行列出的原功能或 UX 尚有缺口。
- **待补**：原 HAPI 有明确实现或行为测试，本项目尚无等价入口或契约。
- **适配中**：在原有公开 DSH 插件机制上实现，未以静态演示冒充完成。

每项“浏览器”都指未修改的官方 DSH Web、官方插件 Loader、真实 Host/Runner 通道和本项目生产插件。测试中的模型、HAPI 会话及 Runner 数据来自显式 fixture，不代表实际用户账号或模型服务的验收。仅模型、控制器、投影或 API 单测通过的项，不能升级成整条浏览器流程已通过。

## 必须保持的组合边界

工作区拥有窗口、几何、焦点、统一目录和视图租约。所有聊天使用官方 Conversation；普通文件、文档和终端使用所属 Host 的官方插件。每个窗格运行其所属 Host 的独立官方 Client graph，传入该 graph 自己 retain 的 SessionReference；外层只保留一个跨机器、跨引擎的侧边栏。各机器共享同一应用外壳，不嵌套机器网页；HTML 文档使用官方沙箱预览。聊天渲染和插件加载均使用 DSH。

官方 `sidebarRightTabs`、`TabDomain`、资源地址、navigation params、store handle、slots 和关闭语义必须保留。隐藏、移动、关闭工作区视图不应触发官方终端的显式终止动作。第三方插件的私有编辑状态不自动承诺跨设备同步。HAPI 的原生执行、审批、排队和设置结果始终以源端事实为准。

每个窗格保留完整的官方 `main.conversation`，包括 header、lineage、actions、utilities、视图切换和 composer；工作区不再用单独的 `conversation.content` 代替整棵主视图。源连接、审批和队列作为公开 `conversation.input.dock` 贡献，已有真实源 state records 同时支持可选的“源会话状态”业务视图。它不制造聊天历史、执行状态或本地 Workspace。`workspace.spec.ts` 已通过空原生线程首次发送、普通 DSH 首次发送、远端设置和插件页返回；`collaboration.spec.ts` 通过真实第三方 header utility 入口；完整主树恢复后的官方 Files/Terminal 与 legacy Markdown 资源回归也已通过。这些结果不替代对任意第三方插件私有状态的单独验收。

## 1. tmux 工作区与布局

主要来源：[WorkspaceShell.tsx](https://github.com/dqtz5vpvj9-create/hapi/blob/55166cf8d87814ccfb383b538a8e8c55283bed81/web/src/workspace/WorkspaceShell.tsx)、`web/src/workspace/workspaceStore.ts`、`workspaceSync.ts`、`windowIdentity.ts`、`shared/src/workspaces.ts`。

| 编号 | 原 HAPI 行为 | 当前实现与状态 | 剩余验收或差距 |
| --- | --- | --- | --- |
| W01 | 多窗口、新建、重命名、切换、关闭、恢复关闭窗口 | **已实现**：`client/model.ts`、`ui.tsx` | 模型单测；基础窗口/恢复已有官方浏览器流程 |
| W02 | 横向/纵向任意分屏、拖动分隔条、键盘调整比例 | **已实现**：同上，复用 HAPI 几何规则 | `workspace-model.test.ts`、基础浏览器 resize/刷新恢复 |
| W03 | 窗格焦点、方向选择、循环、放大/恢复 | **已实现**：`shortcuts.ts`、`model.ts` | `h/j/k/l`、方向键、`o/z`；移动端与输入焦点需继续专项浏览器验收 |
| W04 | `Ctrl B` 前缀后 `%`、`"`、`c/w/n/p/o/x/z`、数字和方向键；双前缀透传 | **已实现**：按固定原源码使用 1.5 秒前缀寿命，未知后缀消耗、IME/repeat 不打断；额外帮助和恢复键 | `workspace-model.test.ts` 覆盖 1499/1500ms 边界与双前缀；`workspace-interactions.spec.ts` 真浏览器通过未知后缀不进草稿、前缀到期后正常键入、数字选窗 |
| W05 | 窗格跨窗口移动、不重建聊天草稿和执行 | **已实现**：窗格 graph 与 DOM 随视图保留；移动只换位置 | 单测验证引用不变；真浏览器验证跨窗拖动时同一个官方 DOM/editor 与草稿保留，重载后草稿恢复；移动时各第三方弹框仍需专项验收 |
| W06 | 从侧栏拖入会话、窗格拖动 docking | **已实现**：原 session MIME、四边 docking、空窗格填充、窗格和窗口 tab 拖放；占用中心不覆盖 | `workspace-drag.test.ts` 验证真实 resource/occurrence 和 close guard；`workspace-interactions.spec.ts` 原生 HTML dragTo 验证侧栏到边缘、窗格换轴、跨 window tab，不合成假业务事件 |
| W07 | 相同会话/文档/终端的资源去重、已有窗格定位 | **已实现**：`resourceKey`、`sessionDestinations` | 真源 identity 和 Windows 路径规则有单测；旧终端使用 Hub + 原 source session + terminal ID，不合并不同源的同名终端，display successor 保持原资源；插件视图保存真实 occurrence |
| W08 | 自动窗口名称、手工名称、W/P 位置和最强活动状态 | **已实现**：`workspace/presentation.ts` | 覆盖错误、审批、输入、运行等优先级；仍需完整视觉回归 |
| W09 | Hub 共享布局，浏览器本地焦点/zoom；CAS 冲突 | **已实现**：`persistence.ts`、`workspace/legacy.ts` | 原 HAPI workspace API 不接受 DSH ID，因此插件用独立 CAS 文档；不写坏原数据 |
| W10 | 原 schemaVersion 2 chat/terminal/document 几何恢复 | **已实现**：首次安装只读导入、保留原 source ID、未知会话不删窗格；精确源解析不等待全目录 | 154 源与跨 Hub 先到/迟到有定向回归；`catalog-source-recovery.spec.ts` 实际 404→用户重试→原聊天和文档恢复，保留身份及 3:2 几何，零模型启动/写入；旧 artifact 与旧 terminal 的具体 renderer 见文件/终端表 |
| W11 | 窗口切换、插件页面切换时保留隐藏视图 | **已实现**：`federation.tsx` 停放已挂载 DOM，graph 不重建 | 官方插件 settings/返回聊天已有浏览器路径；各插件自行管理私有 state |
| W12 | 关闭文档时不丢未保存内容 | **已实现**：`hapiWorkspacePane.registerCloseGuard`、源编辑器草稿保护与刷新检查点 | 官方 source actions 浏览器通过关闭否决、丢保存 ACK 后真实 reload 保留正文/原 hash/未知结果且不再写源；IndexedDB、双窗口 CAS 和草稿对比有 6 项定向回归 |

## 2. 统一侧边栏与信息层级

主要来源：[SessionList.tsx](https://github.com/dqtz5vpvj9-create/hapi/blob/55166cf8d87814ccfb383b538a8e8c55283bed81/web/src/components/SessionList.tsx) 及同目录的 `SessionList.*.test.tsx`、`SessionListScrollAnchor.tsx`、`RecentSessionList.tsx`、`lib/sessionListSearch.ts`。

| 编号 | 原 HAPI 行为 | 当前实现与状态 | 剩余验收或差距 |
| --- | --- | --- | --- |
| S01 | 所有机器/引擎会话始终在一个侧栏 | **已实现**：`controller.ts` 聚合 Host catalogs，复合身份隔离同 ID | 官方浏览器验证 native Codex 与远端 DSH 同侧栏/分屏 |
| S02 | 最近模式与目录模式，机器独立的同名目录 | **已实现**：`ui.tsx`、`workspace/sidebar-state.ts` | 模式和目录展开/顺序本地保存；目录身份含 Hub/机器 |
| S03 | 搜索标题、目录、机器、引擎、原生身份 | **已实现核心**：原加权排序、词边界、标题短语加分、多词 AND、整字段 `*`/`?`、源 summary/worktree/subagent 白名单；收起/展开、查询标签、清空回焦点与机器/引擎筛选 | `workspace-sidebar-search/controller.test.ts` 验证精确字段权重、Unicode 与原机器目录；`sidebar-details.spec.ts` 真浏览器通过排序、多词/通配符源搜索、折叠标签、清空焦点及原 worktree base 目录新建上下文 |
| S04 | 日期范围、日历两次选取起止日期、清空回焦点 | **已实现核心**：本地日历、两次顺序点击选范围、反向/同日范围、月份切换、源活动日期标记；保留可访问的精确日期输入 | 单测验证严格日期、含完整结束日、第一次点击不提交与反向范围；`sidebar-details.spec.ts` 真浏览器通过源活动点、反向两次选取、第一次点击不改结果、清空与焦点恢复 |
| S05 | 已读、手动未读、全部已读、可见焦点窗格已读 | **已实现**：`sidebar-state.ts`、`read-sync.ts` | 原 Hub read-state CAS，冲突重基、离线 outbox；隐藏窗格不 mark seen；子 transcript 不冒用父状态 |
| S06 | 运行/注意/未读过滤、审批/输入/错误/后台状态 | **部分**：主要过滤和优先级已实现 | 原后台任务/compacting 全来源状态与所有引擎仍须补齐和真实源验收 |
| S07 | 全局置顶与项目内置顶分层 | **已实现**：`source-pin.tsx` + catalog `pinMode` | 单击只按真实源 receipt 更新；unknown 不乐观置顶；新源全局模式可在会话工具选择 |
| S08 | 单独“进行中”和“活跃”分组，可关闭自动浮顶 | **已实现**：`sidebar-sections.ts` 复用源 active/lifecycle，working/pending/active/idle 与 project/global pin 分开；迁移原两项偏好 | 单测及官方浏览器通过真实 active/lifecycle 分组、project pin 保留、active-only 保留选中 inactive、原偏好重载；隐藏/离线状态不假装 source connected |
| S09 | 父子会话树、展开、搜索时显露、孤儿/循环不丢会话 | **已实现结构**：`sidebar-tree.ts` | SDK/agent-run 源子会话绑定适配中；独立 child 必须只读且不调用父操作 |
| S10 | 列表实时更新不跳动；刷新才重新排序 | **已实现**：源 HAPI 的冻结 recency 时间、今天/昨天/日期分组、提交前滚动锚点补偿 | 单测覆盖旧行流式更新、旧历史插入、刷新重排；真浏览器通过 74 条 source catalog 日期分组与两视图语义锚点恢复；原虚拟化仍另列 |
| S11 | 长目录按配置数量展开/收起、必要行保留 | **已实现**：原 `sessionPreviewLimit` 1–99、分批 more/fewer、选中及待审批分支保留 | 原 key 偏好迁移及 required rows 单测通过；官方浏览器验证 4→8→4、待审批/选中行不被截掉与重载恢复；目录内全部移入活动分组后仍保留 New here |
| S12 | 大量会话虚拟化、按筛选视图恢复滚动书签 | **已实现核心**：官方 TanStack recent 窗口、非递归父子树、固定视口预算、selected/focus/press/drag/menu 保活；recent/folders 独立语义书签，筛选改变清空 | 单测覆盖 10,000 层与 100,000 项预算；官方浏览器以 182 项验证有限 DOM、原选中/menu DOM 保留、两视图切换、前插 20 项位置不跳、身份搜索回顶部。移动端隐藏/重显与极大真实目录仍需专项浏览器 |
| S13 | 目录标题按钮：复制目录、在该机器/目录创建会话 | **已实现**：目录菜单、`controller.creationContext` 与全部源表单接入；Host 与 HAPI machine 身份分开 | `workspace-interactions.spec.ts` 官方浏览器通过 alpha/beta machine+cwd、从源目录选择 DSH 进入该 Runner；单测验证 fresh 入口清空、未知机器不猜 first Runner。此专项检查创建上下文且未发 spawn，实际源创建另见 N03/N07–N10 |
| S14 | 原 `SessionRowSummary` 的来源、worktree、相对时间、任务/定时状态、详细/标准模式 | **已实现核心**：来源、真实 worktree、相对时间、todo/FAST/审批/后台/未来定时状态；原标准/详细窄屏偏好及跨页 storage 同步，桌面始终详细 | 未知源计数保持 `null`，不从 queue 猜定时数；`workspace-sidebar-row/view.test.ts` 验证数值、时间阈值与原偏好；`sidebar-details.spec.ts` 真浏览器通过手机详细/标准切换、原键重载、任务/待批始终保留及桌面详细状态 |
| S15 | 行菜单 rename、pin、archive/reopen、fork、delete/export | **核心动作与源交接已实现**：统一右键/键盘/500 ms 长按、current/beside/below、三种准确身份、project/global pin、源标题/摘要/迁移、原 JSON/Markdown 导出、生命周期确认 | `sidebar-actions.spec.ts` 三条真实浏览器通过，覆盖键盘实际焦点、移动兼容点击、下方分屏保留草稿、准确导出与取消确认。不同 source ID 的 confirmed reopen/migration 使用官方 input、原 File 字节与 IDB 事务，目标非空明确追加，旧草稿仅在绑定/版本/附件 CAS 后清理，未知不重放，Done 前做共享持久化 prepare/verify；`draft-handoff.spec.ts` 两条真实浏览器通过并实际刷新恢复附件。见 [侧栏动作专项](feature-parity-sidebar.md) |
| S16 | 原 `/sessions/:sourceId` 深链和生成替代会话定位 | **已实现基础**：query source ID 等 catalog 再定位 | generation 变化保留 source identity；child 不抢父链接；原分享/文件深链另列 |

## 3. 新建、恢复和机器上下文

主要来源：[NewSession/index.tsx](https://github.com/dqtz5vpvj9-create/hapi/blob/55166cf8d87814ccfb383b538a8e8c55283bed81/web/src/components/NewSession/index.tsx)、`NewSession/index.test.tsx`、`preferences.ts`、`newSessionFormDraft.ts`、`newTaskDelivery.ts`。

| 编号 | 原 HAPI 行为 | 当前实现与状态 | 剩余验收或差距 |
| --- | --- | --- | --- |
| N01 | 所有新建入口进入同一流程 | **已实现**：官方 sidebar/logo/New Session 与配置快捷键接统一 chooser | 普通 DSH 新建 + Workspace 成员关系已有官方浏览器流程 |
| N02 | Codex 原生创建，机器、目录、home、model、reasoning | **已实现**：`new-session.tsx`、持久 creation receipt | 接受后 metadata 暂不可见只读取，不重启；空线程可从官方 composer 首次发送 |
| N03 | Claude/Pi/ACP 等原 HAPI 引擎创建 | **已实现核心**：`source-session.tsx`、`source-creation.ts` | `source-engines.spec.ts` 已通过官方 DSH 浏览器与明确标注的 HAPI source fixture；动态机器/引擎/cwd options、Pi provider/model 身份保留。各真实外部 CLI 环境验收仍需 |
| N04 | 各引擎实际权限、effort、model variants、Copilot mode、PTY/remote | **已实现参数边界** | 仅显示源声明；不把 Codex enum 套给别的引擎；unit coverage 不替代各 Runner 实测 |
| N05 | Git worktree 与可省略的自动名称 | **已实现** | 原始意图冻结，空名称由源生成；worktree 错误 UX 还需按原测试核对 |
| N06 | 动态模型可用性、来源标记、自定义 ID、过期请求抑制 | **已实现核心**：Runner/HAPI preset 区分；Cursor 原 base/variant 规则、ACP 与 CLI SKU 独立、未选变体持久化、换 Runner 清旧选择 | 16 项 catalog/表单专项通过；`cursor-launch.spec.ts` 真官方 Web 通过原模型双选择、未完成选择刷新保留、目录变化保留模型、换机器不串目录、精确 wire ID 创建。各引擎全部特殊错误组合仍须逐项验收 |
| N07 | 默认机器/home/共享项目目录、存在性检查、创建缺失目录确认 | **已实现核心**：`source-directory.tsx` 使用真实 Runner 目录、workspace roots、存在性检查和二次创建确认；普通 DSH 保留官方目录服务 | `initial-task.spec.ts` 浏览器通过机器选择与缺失目录首次不 spawn、确认才创建；所有共享目录选择与错误组合仍须验收 |
| N08 | 新任务首条文本、附件、仅附件；创建后发送失败复用同会话/消息 | **已实现核心**：`initial-task.ts`、`initial-task-ui.tsx` 持久任务/附件与原 creation/localId，ready 后走真实官方上传与源队列 | `initial-task.spec.ts` 两条官方浏览器通过：文本+附件跨关闭/重载、丢回执不重发，以及 Claude 仅附件；明确 HAPI 协议 fixture，不代表真实模型执行 |
| N09 | launch 初始 Codex account、权限、plan mode、fast tier | **已实现参数与入口**：源 accounts/key profiles/home/models，冻结 launch 意图 | 同浏览器验证 read-only、plan、fast 到原 spawn 请求及成功偏好；真实账号登录/付费模型没有被 fixture 冒充验收 |
| N10 | 关闭/重启恢复表单草稿、成功后保存 machine+agent 偏好 | **已实现核心**：`launch-drafts.ts` 与 initial-task 分开保留未提交字段、附件、未知 intent，成功清任务并保存选项 | 两条 `initial-task.spec.ts` 官方浏览器通过；未知 intent 不因重开表单产生新会话/新消息 |
| N11 | 原生历史搜索/分页、批量导入、直接连接既有线程 | **已实现核心**：原生 library 与 source history/migration tabs | `history.spec.ts` 三条官方浏览器已通过 Pi 导入丢 ACK 后恢复同一分支、Codex home 迁移未知结果不冒充成功、Cursor 精确源拒绝及明确迁移；真实历史库和账号仍须部署验收 |
| N12 | 在线/离线机器、Runner 版本差异、机器健康/受限根目录 | **已实现主要信息与兼容提示**：源 health 白名单、CPU/RAM/负载/运行时长/采样时间、离线最后数据、Runner 版本/根目录；按真实能力显示根工作区 banner，保留最小化与一小时隐藏 | `runner-skew.spec.ts` 两条与 `admin.spec.ts` 在同一官方 UI 检查点 3/3 通过；覆盖移动布局、原偏好、回滚、仅符合条件的 Restart、与 Settings 共享未知结果且只读核对。源和 supervisor 为明确 fixture，原平台 haptics 与全部 shared-root 交互仍未声称等价，见 [专项说明](runner-compatibility.md) |

## 4. 聊天、原生控制与历史

主要来源：`AssistantChat/HappyComposer.tsx`、`HappyThread.tsx`、`NativeCodexThread.tsx`、`QueuedMessagesBar.tsx`、`ToolCard/*Footer.tsx`、`SessionHeader.tsx`、`SessionActionMenu.tsx`。通用聊天显示层由官方 DSH 负责；以下列的是 HAPI 特有语义和 UX，而非要求复制旧渲染器。

| 编号 | 原 HAPI 行为 | 当前实现与状态 | 剩余验收或差距 |
| --- | --- | --- | --- |
| C01 | 消息、流式最终回答、工具调用、历史翻页 | **已实现核心**：native/observed Agents 发布官方事件，官方 Conversation 渲染 | `codex-conversation-history` 等验证官方 assembler；真实不同引擎历史边缘记录须继续验收 |
| C02 | 原生 `/status`、`/help`、压缩 notice、usage/context/goal | **已实现源投影**：`native-actions.tsx` 与 notices/usage | 无 turn 的源通知不伪装成 assistant answer；剩余专属卡片/来源字段逐项核对 |
| C03 | 原生 slash commands 不跑错 DSH AgentLoop | **已实现适配**：源 command/queue 路径 | 每个 command 的支持取决于源真实协议；不得仅显示列表就声称已执行 |
| C04 | queued/send/steer/cancel/retry 与未知发送结果 | **已实现核心及原队列编辑**：native/source durable localId、取消确认后转入可编辑草稿、跨 pane 共享精确源 schedule draft | `queued-edit.spec.ts` 三条真官方浏览器通过队列 race、跨 pane 绝对计划恢复、unknown→源 cancelled 后显式恢复；不提前取消草稿、不重发操作、不自动覆盖新输入。各引擎真实队列执行仍须部署验收 |
| C05 | approval approve/deny/session scope，最终由源确认 | **已实现**：pending/submitted/resolved 分开 | 基础及 `source-engines.spec.ts` 官方浏览器已验证源审批协议；unknown 不自动重发；不将 fixture 视为真实外部 CLI 验收 |
| C06 | 多问题、单选/多选/Other、必填、上一题/下一题、skip | **已实现**：`native-input.ts`、`native-actions.tsx` | skip 走真正 deny，不把空答案伪装 approve；Pi editor/prefill 保留 |
| C07 | 源 URL 确认、弹窗阻止处理 | **已实现** | URL 在用户确认动作后打开；须补真实移动端 popup/keyboard 验收 |
| C08 | 各引擎模型/推理/权限/service tier/控制模式 | **已实现核心**：native 与 observed 分开；保留源模型身份 | source submitted ≠ applied；断线只查询；标准 DSH source option mutation 被拒绝 |
| C09 | Codex plan proposal 的真正“实施计划” | **已实现**：独立 source API + plan ID，非模式开关 | 基础官方浏览器验证 reload 不重复实施 |
| C10 | 原生分支、指定历史边界分支、回退 | **已实现 native/source contracts 与 UI** | 官方 message ID/seq 精确映射源边界；native 浏览器主流程通过，所有 observed 引擎仍待真实验收 |
| C11 | 清空/归档/恢复/重启/删除、能力与确认 | **已实现源会话工具** | 原 sidebar 快捷入口/批量动作体验部分；archive 不被误作隐藏 display bookmark |
| C12 | title rename、自动建议标题、summary/pin | **已实现核心** | 真源 rename、summary、pin 及独立源标题建议已接；`title.spec.ts` 通过官方浏览器与明确源 fixture，真实模型建议质量未由 fixture 验收 |
| C13 | SDK subagent/agent-run transcript、父子导航、子代理输入 | **已实现源能力适配**：SDK 只读 child 与 HAPI DSH continuable child 分开；后者用可见 `/child`、`/child-steer` 和真实源收据 | `dsh-children.spec.ts` 三条官方浏览器通过 parent/child 归属、精确发送/steer/中断、丢 ACK 刷新不重发、空 child 首条输入；原 API 无 rpcId 的命令入口差异见 [源子代理说明](source-children.md)，不能称普通 Send UX 已完全等价 |
| C14 | JSON/Markdown 完整导出、截断后显式导出全部 | **已实现**：真实源 export + official HAPI history tab | 新官方浏览器已走 JSON 下载；Markdown/大历史边界继续验收 |
| C15 | 对话大纲、精准历史定位、加载目标旧页 | **已实现**：messageId→当前 generation seq→官方 loadOlder→own row anchor | 原 renderer 保持原样；新官方浏览器已覆盖定位可见消息 |
| C16 | 分享一个 turn、截图与元数据、分享种子进入新会话 | **已实现核心与原分享选择器**：官方回合 action/PNG/剪贴板，原 fragment/ShareSeed/IDB、真实 Share Target worker；固定首次会话快照、原预览数量/日期/搜索、文字与文件预览 | 原回合 PNG、fragment 隐私、原 Blob、刷新恢复及草稿交接已通过；`share-picker.spec.ts` 三条加新建取消、后继会话交接两条，在主题修复后合计 5/5 真浏览器通过。覆盖 source/remote/local DSH 精确目标、源故障可用性和日历实际样式，全部不自动发送。见 [分享选择器专项](feature-parity-sharing.md) |
| C17 | 消息时间/状态、Codex review、生成媒体/附件专属呈现 | **已实现主要类型**：源字段、review findings、生成图片/视频/opaque artifact 复用官方内容与资源路由 | `codex-review.spec.ts` 两条通过 review 保留 raw Copy、源文件定位及 Pi/普通 DSH 不误判；`generated-media.spec.ts` 三条通过原图片、缺失资源明确不可用、视频预览/原件下载与重载；实际源媒体接口由显式 fixture 提供，未声称所有未来消息类型已认证 |

## 5. 备忘录、附件、定时与输入

主要来源：`AssistantChat/ScratchlistPanel.tsx`、`ScratchlistMigrationBanner.tsx`、`ScheduleTimePicker.tsx`、`RichComposerInput.tsx`、`SortableComposerAttachments.tsx`、`lib/scratchlistAttachmentFlow.ts`。

| 编号 | 原 HAPI 行为 | 当前实现与状态 | 剩余验收或差距 |
| --- | --- | --- | --- |
| I01 | Hub scratchlist 创建/编辑/重排/删除与附件 | **已实现基础**：`session-extras.tsx` + HAPI source API | 未提交草稿恢复；新浏览器已走真实 notes API |
| I02 | 备忘录放入当前 composer，附件用真实上传流程 | **已实现**：`source-composer.tsx` 使用官方 attachment callbacks | 新官方浏览器已验证正文+附件到真实 composer；不伪造 private input face |
| I03 | 原 local scratchlist 迁移、附件恢复冲突与迁移 banner | **已实现**：`note-migration.ts` 与 notes banner；窄 root bridge 只读取原 source key，保留原数据 | 8 项迁移单测及 `notes-migration.spec.ts` 真浏览器通过非空 Hub 合并、附件下载、冲突保留两份、丢回执只读恢复与重载不重发；0 chat 提交；storage 读取失败明确反馈 |
| I04 | 定时消息创建、源状态、取消、未知请求恢复 | **已实现核心**：真实 source queue 与同一 localId；+5m/+30m/+1h/+4h 在点击提交时计算，绝对时间及 7 天边界校验 | `session-tools.spec.ts` 官方浏览器已验证重载不重复提交、源状态与取消；相对时间/持久失败有专项单测，原完整日历 picker 的交互仍需核对 |
| I05 | 粘贴/拖附件、多窗格只进入目标 composer | **已实现隔离**：`pane-input.ts` 路由真实 document 事件 | 两 pane router 单测；需官方附件拖放的真实浏览器覆盖 |
| I06 | source 附件准入、上传、错误、下载 | **已实现核心**：官方附件流程 + HAPI attachment adapter | 原生平台附件 picker、文件夹共享、相片/图片等端差异未全覆盖 |
| I07 | Rich composer 文件/skill/command mention、selection 编辑和 parking | **部分**：官方 composer + source parking 与源 `@文件` provider 已接；候选菜单、chip、目录钻取继续由官方插件渲染 | `composer-parking.spec.ts` 与 `file-references.spec.ts` 真实浏览器已通过：两机器候选隔离、带空格文件引用、目录钻取和精确源提交；公开 provider 早启动/卸载/恢复有生命周期回归。skill/command 的全部原特殊 selection identity、输入展开布局仍须逐项适配 |
| I08 | Enter 发送偏好、IME、恢复输入、发送错误可见 | **已实现偏好与原编辑器交互**：共享原 Enter key，换行交给浏览器和官方编辑器，Ctrl/Cmd+Enter 走普通队列；候选、IME、readonly、附件状态保留原 owner | `composer-enter.spec.ts` 两条真浏览器通过选区/撤销、文件 chip 后精确换行、Chromium composition、长按单投递、上传中/失败可见反馈、local/remote 两 pane 偏好与刷新后的精确源正文。16 项定向测试通过；真实 OS 输入法、各外部引擎全部错误组合仍需部署验证，见 [输入专项](composer-enter.md) |

## 6. 文件、文档、终端与插件兼容

主要来源：`routes/sessions/files.tsx`、`routes/sessions/file.tsx`、`SessionFiles/*`、`Artifacts/*`、`Terminal/*`、`workspace/WorkspacePane.tsx`。DSH 依据是 `packages/client/ui-sidebar-right`、`ui-sidebar-files`、`ui-sidebar-documentpreview`、`ui-sidebar-terminal` 与 `api/workspace-files`。

| 编号 | 原 HAPI 行为 | 当前实现与状态 | 剩余验收或差距 |
| --- | --- | --- | --- |
| F01 | 机器正确的文件树、文件元信息、文本/二进制读取 | **已实现官方 provider**：`hapi/workspace-files.ts`；文档遵循原 Runner browse roots，管理操作保留 cwd/active 契约 | 官方 Files 双源读取/刷新恢复；inactive 源的授权目录外 Markdown/相对图片/PDF、下载原字节、自动更新与拒绝范围有实际浏览器验证，见 `source-document-policy.spec.ts` |
| F02 | 官方 plugins 可替换文件树/preview/terminal，并在 pane 打开 | **已实现组合**：`pane-bridge.tsx`、真实 tab occurrence、view 资源 | `workspace-plugin-views` 单测；需实际安装不同第三方插件验收，不预先保证所有插件 |
| F03 | preview 多 renderer、tab params、keepMounted/multiple、菜单扩展 | **已实现公开机制** | 不复制 provider 私有状态；header 菜单 stacking 修复后官方 Files/Terminal 浏览器通过 |
| F04 | 文件搜索、git status/diff、编辑 CAS、上传、创建/复制/移动/删除 | **已实现官方扩展与持久操作回执**：真实 source API + 官方 files/document slots；写操作先持久化，原 Hub/session/machine 共享 journal | 既有 source actions 真浏览器通过搜索/Git diff、创建/复制/重命名/移动/删除、子目录上传和编辑；`source-file-recovery.spec.ts` 两条验证实际旧 graph 断开后换代恢复、reload、仅检查与本地 review，源 mutation 始终一次。写操作要求 IndexedDB 和 HTTPS/localhost Web Locks；源文件系统为显式 fixture，见 [恢复边界](source-file-recovery.md) |
| F05 | 未保存文件、hash 冲突、unknown save、关闭保护 | **已实现**：草稿/source CAS、公开 pane close guard、文件管理未知回执跨 graph 与刷新恢复 | source actions 浏览器通过 expectedHash 保存、并发冲突、ACK 丢失仅一次投递、拒绝关闭并恢复草稿；管理回执通过同源 Web Lock 与 revision CAS 防止跨窗口覆盖。unknown 不显示已保存、不自动重发，本地 review 不冒充源 ACK |
| F06 | HTML/PDF/image/code/markdown/Office/Excel 普通文件 | **已实现官方 renderer 组合** | 实际源 workspaceFiles provider；各种格式的源路径及依赖文件读需继续浏览器覆盖 |
| F07 | `session-file:` artifact →真实文件，opaque Codex artifact | **已实现适配**：严格 UTF-8/base64url 真路径解析，opaque resource 保留原 ID；复用官方 PDF/Text/HTML bodies 与 ImageLightbox/CodeBlock/MarkdownText | `artifact-plugins.spec.ts` 两条真浏览器通过 source Markdown 相对/绝对图片、拒绝无基址 opaque 图片、PDF/Image/Code/sandbox HTML、Office 转 PDF 后原件下载、布局重载；实际 Office 转换服务在 fixture 中显式替代，不冒充真实转换引擎 |
| F08 | 下载、打开本机应用、路径复制的机器正确性 | **已实现 guard**：source open-in-app 不调用 Hub 桌面，文档改为认证源下载；普通 DSH opener 保留 | 官方 slots/快捷键与下载回归通过；`appearance.spec.ts` 真实 MutationObserver 验证 source 投影尚未恢复时也不短暂挂载 Hub desktop opener。源端系统桌面打开不被伪装为 Hub 桌面打开 |
| F09 | 新终端真实 PTY、多 viewer、输出游标、断线恢复 | **已实现官方 terminal provider**：`machine-terminals.ts`、`terminal.ts` | Gateway/WS 测试已过；双源浏览器输入、重载和 pane 关闭保留 PTY 已通过 |
| F10 | 关闭 pane 只 detach，显式关闭终端等待退出 ACK | **已实现语义** | 不调用官方 tab close hook 来关闭工作区视图；不能用发出 terminate 冒充已终止 |
| F11 | 原 v2 terminalId 继续连同一旧 SessionTerminal | **已实现官方模型与视图适配**：独立公开 kind、真实 `ClientTerminals` / Terminal body/title、10,000 行滚动缓冲；旧自绘 renderer 已移除 | `legacy-terminal.spec.ts` 最终同一构建连续 2/2 通过：原输入/拒绝保草稿/复制/字号/宏、两源同 ID 隔离、官方改名、旧 tab→文件→刷新→旧 tab→聊天→刷新→文件、原资源与 1:2 几何、关闭零 kill。Host 13 项原协议、Client 12 项和 Controller 33 项定向通过。原协议 attach-or-create、无 Runner 输入 ACK、有限 replay 仍保留；一次未定因测试 Host 退出及复测结果见[视图记录](legacy-session-terminal.md)，协议见[说明](legacy-terminal-protocol.md) |
| F12 | 移动端 terminal touch bar、键组合编辑、选择覆盖、手势 | **已实现主要输入/复制/手势适配**：公开 Terminal body + 原 `view.write` owner、双排键盘/锁定修饰/长按/宏/偏好、源只读快照；实际终端 view 的缩放和滚动 | 原420px输入/宏/复制/重载与450行快照浏览器已通过；新增可信触摸真浏览器通过9→18px/PTy grid、600行拖动/惯性、ACK与mode切换停止、TUI合法SGR wheel、移动Close pane保留原PTY。具体平台边界见 [专项说明](feature-parity-workbench.md) |

## 7. 移动端、外观和页面级行为

主要来源：`hooks/useNarrowViewport.ts`、`HappyThread.mobile-scroll.test.tsx`、`workspace/WorkspaceShell.tsx`、`routes/settings/display.tsx`、`routes/settings/chat.tsx`。

| 编号 | 原 HAPI 行为 | 当前实现与状态 | 剩余验收或差距 |
| --- | --- | --- | --- |
| U01 | 640 px 窄屏单焦点窗格、窗口列表、底部 pane 切换 | **已实现**：`workspace/viewport.ts` 与 `ui.tsx`；Host 工具进入当前 pane 的底部菜单 | 保留已访问 DOM、hidden/inert 防隐形输入；420 px 实际官方浏览器验证正文高度、菜单/Settings/插件入口和暂存草稿，无水平溢出；真实设备旋转/软键盘验收仍需 |
| U02 | 移动端统一会话选择层和安全区域 | **已实现基础** | 浏览器窄屏覆盖未完备；旧列表快速切换与返回手势仍需对照 |
| U03 | CN/EN 与浅/深色主题 | **已实现核心外观适配**：原 18 色板/按模式七色自定义/OLED/80–120% 字体/9–17 px 终端字号，公开 ThemeRuntime 与原 Terminal hook | 原键读取、真实 ThemeRuntime/SlotCore 单测及 `appearance.spec.ts` 真官方浏览器通过；跨 pane 色板、16.8 px 聊天字体、真实 xterm 四种字形 9 px 与 reload 保留均有断言。见 [外观专项](feature-parity-appearance.md) |
| U04 | 页面级 modal/focus trap/Escape 与 pane 隔离 | **已实现核心**：官方 AppFrame/overlay 保留，各 pane graph 独立 | Remote Settings/Escape 已过官方浏览器；同时多 pane modal/第三方 portal 继续验收 |
| U05 | Composer toolbar 重排、工具折叠/推理折叠、用户气泡色 | **部分**：原用户气泡 preset/custom 已经公开 token 接原 renderer；其他旧键保留 | toolbar 重排/隐藏不能夺取其他插件控制权；独立推理/探索/工具折叠及 tool-group 色尚未精确映射，不以 DSH 大范围 transcript 预设冒充。已按原 child ownership、common inject 与实际 SlotCore 检查，独立推理默认展开没有当前可用的公开入口，见 [公开接口边界](dsh-disclosure-boundary.md) |
| U06 | header 字段显示开关、链接新窗口偏好 | **已实现**：10 个原字段开关、真实源时间与 worktree/tier；原同页/新页链接偏好迁移，另可明确跟随 DSH 插件设置 | `appearance.spec.ts` 通过两 pane 页头更新/刷新；`workspace-links.spec.ts` 通过官方 Markdown 新页无 opener、同页导航前即时草稿保存、真实离开后恢复两 pane 原草稿。只处理工作区内普通 HTTP(S) 链接，修饰键、下载及插件显式原生导航保留；私有编辑状态须接公开保存准备。见 [链接导航](workspace-links.md) |
| U07 | PWA 安装、更新提示、原生 update 草稿事务、平台附件 | **Web 核心已实现**：原 dismiss 偏好、installprompt/appinstalled、worker 更新、所有已打开编辑器 prepare/verify 与附件原 Blob 恢复 | 安装及通知实际浏览器已过；更新拒绝存储失败/未完成提交/变化的 worker、超时不刷新有定向回归；官方 Settings 的“保存草稿后刷新”已通过真实 reload、原附件字节及两个 pane 各自草稿恢复。新 worker 控制权更换仍以定向回归为证；原 Capacitor 二进制更新与原生平台 picker 不等同于 Web PWA |

## 8. 账号、机器、设置、通知和语音

主要来源：[settings/categories.ts](https://github.com/dqtz5vpvj9-create/hapi/blob/55166cf8d87814ccfb383b538a8e8c55283bed81/web/src/routes/settings/categories.ts)、`settings/general/display/chat/voice/machines/storage/usage/about.tsx`、`components/settings/*`、`realtime/*`、`shared/src/voice.ts`。

| 编号 | 原 HAPI 行为 | 当前实现与状态 | 剩余验收或差距 |
| --- | --- | --- | --- |
| A01 | Codex accounts/home 列表、导入、device login、切换/重命名/删除 | **已实现真实源工具**：`native-library.tsx` | 源操作回执/unknown 保护；实际账户登录无需也未被测试 fixture 冒充 |
| A02 | session account 选择、home 迁移、Pi 导入 | **已实现源契约与入口**：native session account、home migration 与 Pi history tabs | 与 N11 共用真实源身份/持久操作回执；三条 history 浏览器已通过。未知迁移结果不能仅凭目标 metadata 出现就宣称确认，真实登录环境未由 fixture 验收 |
| A03 | 机器重命名、最后在线、codex homes、DSH bundles 管理 | **已实现核心**：官方 Settings 的源 Hub section 与原 native library | `admin.spec.ts` 真浏览器通过机器改名、源 DSH profile、supervisor restart 丢回执只读恢复；真实部署 Runner 版本差异仍需验收 |
| A04 | Hub summary contract/in-chat 偏好、SessionBulkActions | **已实现核心**：Hub summary 偏好共享 scope；源摘要为官方 turnTail/actions 贡献；批量 Standard/暂停使用最新源清单与持久回执 | `notify-summary.spec.ts` 与 `source-bulk.spec.ts` 官方浏览器通过：最新源会话范围、精确 Standard、排除待审批目标、abort 丢 ACK 后未知及刷新不重放。accepted 不冒充执行已停止 |
| A05 | 存储统计、组成图、Hub backup 下载 | **已实现核心**：`source-admin.tsx` 原 Hub storage 分项/占比与流式 SQLite 下载 | `admin.spec.ts` 真浏览器验证原 Hub 二进制备份内容与下载，原数据来源由显式 fixture 提供 |
| A06 | token/cost 统计按日期、模型、agent、会话聚合 | **已实现核心**：官方 Settings source usage 页按日期/agent/model 展示 | `admin.spec.ts` 真浏览器通过范围和用量；全量历史、所有价格来源与原图表细节仍需逐项核验 |
| A07 | 通知权限、Push、App Badge、断线/同步/版本告警 | **已实现通知核心**：root-only 官方 settings/overlay、原 Push API、真实 presence、App Badge 偏好与 sidebar read-state 桥 | 实际浏览器 2 case 通过 VAPID 503 下 SSE→WS→overlay→精确 beta 导航、worker 注册/Hub 握手、不自动权限请求、hidden presence、PushManager/OS Badge 显式 fixture 和 unknown 不重放；真实账号 OS 投递未实验。初始链接保留 Hub+source 身份；版本更新草稿事务另列 U07 |
| A08 | 语音听写：standard/realtime、多 provider、browser-local | **已实现核心**：原多 provider 协议、实际 MediaRecorder/multipart、实时连接、本地识别准入、官方草稿 revision-CAS、取消与恢复、共享偏好 | `voice-plugins.spec.ts` 标准录音/音频上传/保留草稿/无凭据落盘及 browser-local API fixture 的并发草稿冲突和无上传已过；实际第三方账号、音质与物理设备未验，详见 `feature-parity-voice.md` |
| A09 | 实时语音助手三 backend、声音/人格/上下文、工具审批 | **已实现核心**：原 ElevenLabs/Gemini Live/Qwen 协议、人格与声音、源/DSH 独立上下文、真实 call ID、精确审批、全工作区单麦克风 owner | 完整官方浏览器复测已通过 Gemini alpha 精确审批、Qwen beta、同 ID 去重/同参数新 ID 允许、跨 pane 停止交接、普通 DSH 自有历史与发送、关闭释放所有 tracks。提供方为明确协议 fixture，没有真实第三方账号/音质验收 |
| A10 | Companion pairing、共享访问/权限、Share 入口 | **Companion 已实现，共享授权仍部分**：官方 Settings 显式显示原 HAPI 配对 QR/链接，本地生成，原 Hub token/namespace 保留，严格 owner 准入 | `companion.spec.ts` 三条通过实际 QR 解码、剪贴板、迟到回包/隐藏/关闭清理及无兼容 HTTPS 地址时禁用。未实际配对手机；原 Companion 直连原 HAPI，不因此获得跨 DSH Host 目录。尚无新增的逐会话限权、到期或撤销邀请。见 [Companion 协议与边界](source-companion.md) |
| A11 | Team 成员/任务/消息、工作图和 source agent-run 导航 | **已实现核心**：真实 source Team/work ledger，正式官方 tab 与 session header utility 入口；保留源独立水位与 live clear | `source-collaboration-types.ts`、`SourceCollaborationPanel`；`collaboration.spec.ts` 真浏览器通过完整官方页头入口、独立 source watermark/clear、精确 beta 导航、保留 alpha 草稿且没有 chat 写入 |
| A12 | About/version/legal 与原浏览器偏好迁移 | **已实现核心**：官方 Settings 显示版本、构建内容指纹、上游来源和许可；已列明旧偏好读取/迁移 | 新产品内版本区域待本轮浏览器验证；未映射的原偏好继续保留并在 U05/U06/I08 列明，不静默替换成含义不同的 DSH 选项 |

## 当前优先级与完成条件

1. **先保证官方插件组合正确。** 完成 Files/Terminal 真实浏览器验收、source path guard、编辑关闭保护、artifact 官方 renderer 适配。所有同名路径必须仍指向正确源机器。
2. **补齐日常 workspace/list 交互。** 侧栏拖入/窗格 docking、目录预填新建、日期筛选/滚动书签/虚拟化/preview batching、原信息密度和用户偏好。
3. **补齐创建与原生输入。** 首条任务和附件事务、表单草稿和成功偏好、机器健康/目录验证、Codex launch 全部源选项。
4. **完成原产品独立能力。** 语音、通知、Team/工作图、usage/storage/backup、分享/companion/PWA 与旧数据迁移。已有官方插件可承担的渲染和交互优先交给其公开扩展点。

每个待补项关闭前需要：保留固定 HAPI 来源路径或行为测试；生产代码入口；真实 source API/资源归属说明；关键失败模式单测；受影响的官方 DSH 浏览器流程。未知结果只读恢复、隐藏窗格不写已读、关视图不终止执行、相同路径跨机器不串读，属于持续门槛。不能靠删掉原入口、修改测试放宽断言或只写能力说明来关闭差距。

## 功能验证入口

- `tests/workspace-model.test.ts`、`workspace-controller.test.ts`：几何、租约、恢复竞态、Host 身份、创建成员关系、close guard。
- `tests/workspace-parity.test.ts`、`workspace-read-sync.test.ts`：legacy source 保留、W/P、活动、读状态 CAS、child/root 边界。
- `tests/workspace-source-creation.test.ts`、`workspace-source-pin.test.ts`、`workspace-source-paths.test.ts`：真实输入契约、unknown 不重发、源 pin authority、Host opener guard 与 source download。
- `tests/workspace-runtime-store.test.ts`、`workspace-plugin-events.test.ts`、`workspace-pane-input.test.ts`：隔离 storage、Host 共享 HMR 原始事件、断流新 generation、跨 pane drop/paste。
- `e2e/workspace.spec.ts`：统一侧栏、native/remote Conversation、布局刷新、审批、设置/分支/创建、官方 New Session、原生 plan。
- `e2e/plugin-workspace.spec.ts`：官方 Files/Document/Terminal 跨源资源与 PTY 生命周期、source file actions、420px mobile terminal 三条实际浏览器均通过；源协议 fixture 与覆盖边界详见 [专项说明](feature-parity-workbench.md)。
- `e2e/session-tools.spec.ts`：官方 HAPI tabs、notes 附件入真实 composer、源历史定位、JSON 导出与 schedule 重载/取消，本轮整条通过。
- `e2e/initial-task.spec.ts`：两条通过，覆盖首条文本+附件跨表单重开/浏览器重载、丢回执复用、仅附件源任务、缺失目录确认；CLI/模型仍为明确的源协议 fixture。
- `tests/workspace-drag.test.ts`、`workspace-sidebar-view.test.ts`：来源一致的 docking、日期排序与滚动语义，不代替真实浏览器拖动与布局验收。
- `e2e/artifact-plugins.spec.ts`：两条通过，原 source 身份下的 Markdown 图片、PDF/Office/Image/Code/HTML 官方预览及原件下载/布局恢复；运行官方 CFT 156，未注入上游兼容补丁。
- `e2e/workspace-interactions.spec.ts`：五条通过，真实拖放、同 editor DOM/草稿与 reload、prefix 行为、74 条 source catalog 日期/范围及 Recent/Folders 独立滚动恢复、两个源目录的 New here 创建上下文。S08/S11 原活动分组、preview batching、必需行与原偏好重载均已通过；S12 的 182 项虚拟列表在前插 20 项后保持位置，selected/menu 保留原 DOM，无聊天发送。
- `e2e/title.spec.ts`、`composer-parking.spec.ts`：源标题建议与原备忘录 parking 已通过官方浏览器；`notify-summary.spec.ts` 验证官方 chat 附加摘要呈现与 Hub 偏好。
- `e2e/admin.spec.ts`：官方 Settings 内源 Hub 选项、机器改名/Runner profile、restart 未知结果恢复、usage 与 SQLite 下载整条通过。
- `e2e/runner-skew.spec.ts`：两条通过，根工作区兼容提示、原偏好、在线能力判断、回滚与受监督重启、共享未知结果核对。
- `e2e/legacy-terminal.spec.ts`：真实官方 Terminal body/title 与原 SessionTerminal 适配的两条完整流程通过，包含非活动 tab 恢复、保留插件导航和原 terminal 资源身份。
- `e2e/source-file-recovery.spec.ts`：两条通过，真实 graph 断开/源 display 换代与页面刷新后保留同一未知回执；源只写一次，无 Web Locks 时明确拒绝写入但保留读取/检查。
- `e2e/notes-migration.spec.ts`：原 local notes 合并到已有 Hub notes、附件、冲突、丢 ACK 恢复及重载不重发通过；0 chat 请求。
- `tests/workspace-ui-bridge.test.ts`：scope 对麦克风占用的互斥、异步停止/失败、不会释放另一 pane 的 owner；固定原 notes key 只读迁移与存储拒绝。音频回调为显式 fake，不代表语音提供商已验收。

测试结果按实际运行提交更新；这个矩阵不沿用旧发行文档中的“已完成”表述来推断新增功能的状态。
