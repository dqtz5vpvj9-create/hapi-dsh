# 可复现验证与验收边界

这份记录区分原始 HAPI/Runner 协议 fixture、真实传输、未修改的官方 DSH 进程、真实浏览器与实际账号执行。某一层通过不能替代下一层。功能和 UX 尚未等价的项目继续列在 [功能对照表](feature-parity.md)，不因构建或单测通过而自动标成完成。

## 开发回路与发版回路

日常开发只跑 **micro**：`npm run test:micro`（三份 tsc + `npm test`，约 30 秒）。`npm run test:release` 只做 typecheck、单测和构建，不跑 Playwright。完整 E2E 每个 spec 都要启动未修改的官方 DSH 进程、配对 Runner 和浏览器，耗时以分钟计，**不再进入任何自动回路**；需要时按受影响范围手动跑定向 spec（例如 `npx playwright test e2e/pane-surface.spec.ts`），全量套件只在专门的验收窗口手动执行。

E2E 的官方 profile 现在按构建产物缓存到系统临时目录：第一次运行生成模板（约 13 秒），之后每个 spec 只复制 profile 树并启动自己的 DSH（约 8 秒），不再为每个 spec 重复 `dsh plugin add` 的 pnpm 安装。可用环境变量：

- `HAPI_DSH_E2E_CACHE=/path`：缓存目录（默认 `$TMPDIR/hapi-dsh-e2e-cache`）。
- `HAPI_DSH_E2E_TIMING=1`：打印 template/copy/start 分阶段耗时。
- `HAPI_DSH_E2E_WORKERS=N`：本地并行 spec 文件数（默认 1；缓存热后可用 3–4）。
- dist 重建会使缓存键变化，下一次 E2E 自动重建模板。

## 当前代码验证

运行环境为 Linux、Node 24.19.0，DSH 固定 `0.2.1-rc.2`。上游源码与已发布 bundle 均未修改，具体来源见 [UPSTREAMS.json](../UPSTREAMS.json)。浏览器测试使用 Playwright 1.64.1 与 Chrome for Testing 156.0.8078.4；后者具备固定上游 PDF.js 所需的原生浏览器 API，没有给上游加 polyfill。

| 检查 | 本轮结果与边界 |
| --- | --- |
| Host TypeScript | `npx tsc -p tsconfig.host.json --noEmit` 通过 |
| Client TypeScript | `npx tsc -p tsconfig.client.json --noEmit` 通过 |
| E2E TypeScript | `npx tsc -p tsconfig.e2e.json --noEmit` 通过 |
| 全部代码与传输测试 | `npm test` 实际执行 864 项，863 通过，0 失败，1 项官方进程测试按设计等待显式启用（`npm run test:micro` 同一套） |
| 显式官方 federation 集成 | 前一检查点独立启用后 1 项通过，0 跳过；运行原始官方 Web profile、配对 Runner、bundle/Session RPC/事件流。本轮未重复该独立用例，实际官方浏览器仍运行同一传输链路 |
| 构建 | Host、Client、CLI、Runner、五个 source-aware providers 与类型声明构建通过 |

`npm test` 使用 Node 的 `--test-isolation=none`，报告的是实际 case 数；测试文件进程退出成功不作为其内部断言已执行的证明。测试绑定本机回环端口，需要运行环境允许本地监听。官方进程集成单独使用 `HAPI_DSH_OFFICIAL_TESTS=1`，不能把默认 skip 写成已通过。

### 实际截图反馈后的专项

本次生产修复后，以单 worker 执行以下 **16 条实际官方浏览器流程，16 通过、0 失败**。它们检查正文、文件字节和操作效果，不以登录或目录非空代替功能验收。中文截图环境补充了系统缺失的 CJK 测试字体，产品继续使用系统字体回退，没有改上游字体或 renderer。

| 专项 | 实际结果 |
| --- | --- |
| `source-conversation-history.spec.ts`，2 条 | 精确 indexed wire 的 180 轮、4500 步 native 历史在官方 Conversation 中出现用户正文和最终答案，实际分页并刷新；observed shared Codex 正文可见，生命周期不再变成 JSON 通知，原错误详情可展开。**修复前投影器也通过了长历史复现，不能据此宣布线上全空白已定因。** |
| `source-document-policy.spec.ts`，1 条 | inactive 原聊天、cwd 之外但在源 browse roots 内的 Markdown、相对图片和 PDF 正常显示；下载与原字节一致，刷新恢复、源变更自动更新；拒绝目录仍由原源拒绝，零文件写入。 |
| `artifact-plugins.spec.ts`，2 条 | opaque artifacts、旧 session-file 地址、相对图片和原机器身份、Markdown/PDF/Image/Code/静态 HTML 的官方 viewer；Office 使用明确的转换结果 fixture，下载仍为原件。 |
| `workspace-chrome.spec.ts`，2 条 | 2048 px 桌面与 420 px 触屏；统一侧栏、完整官方标题和正文、紧凑菜单内原 Host/插件/Settings 操作均可达；手机实际暂存草稿并清空已确认原输入，长机器名不挤掉引擎名；无自动安装浮卡。 |
| `plugin-workspace.spec.ts`，4 条 | 官方 Files/Terminal 资源与 PTY 身份、跨 pane 与 reload；源文件管理/CAS 编辑/丢回执恢复/搜索/Git/上传；移动按键、宏、字号；可信触摸缩放、历史惯性停止与 TUI 输入。 |
| `legacy-terminal.spec.ts`，2 条 | 旧 SessionTerminal 同一个原 terminalId，官方 body/title、控件与持久字体；两个原源同名终端不串线，旧 tab→文件→刷新→聊天→文件恢复，关闭仅 detach。 |
| `source-file-recovery.spec.ts`，2 条 | 文件操作丢 ACK 后，真实 graph 换代及页面刷新保留同一操作和未知状态，源只写一次；Web Locks 不可用时原读取仍可用，新写入明确拒绝。 |
| `catalog-source-recovery.spec.ts`，1 条 | 一个始终不列入源发现列表的归档 Codex，旧 chat/document 双窗格先遇到真实 HTTP 404；仅解除源故障并点击 Retry 后，两窗格恢复官方正文与原文件。精确原 Hub/session/machine/path 和 3:2 几何保留，原会话与数量未变，零创建/恢复进程、聊天、文件写入与终端操作。 |

首轮文档专项暴露了一个测试前提错误：固定官方 `SettingsRoot` 只在主会话为空时启动自动 onboarding，恢复已有源会话不会产生 Preview Notice。helper 现区分 fresh blank 与 existing-session，前者仍严格等实际确认，后者只处理真实出现的弹窗；没有预写确认配置或删除弹窗。修正后以上文档、旧终端与 artifact 流程均通过。

最后一次仅修改英中文案，将历史离线会话的“正在重新连接”改为“尚未连接，草稿已保留”，状态和准入逻辑未改。重新构建后的 `catalog-source-recovery.spec.ts` 再次通过，并增加实际占位文案及显式恢复入口断言；没有把这次重跑重复计入上述 16 条。

本环境没有连通用户的 Tailnet 站点，因此这 16 条不包含线上账号、私人磁盘、真实 Codex app-server 或实际部署验收。加强后的 `live-site.spec.ts` 需要另外指定一个已存在且有正文的源会话，必须实际打开正文并刷新，而不再将 availability smoke 当作聊天完成度。详见[现场修复与剩余问题](live-site-fixes.md)。

### 已在实际官方浏览器中确认的交互

这一组测试加载官方 DSH 页面、原始插件 Loader 和官方 Conversation / Files / DocumentPreview / Terminal。它们运行本仓库的生产插件和真实本地网络通道，HAPI、Runner 文件/PTY与模型返回值由测试中明确命名的协议 fixture 提供。

| 专项 | 实际界面确认的行为 |
| --- | --- |
| `workspace-links.spec.ts`，1 条 | 原链接偏好进入官方 Markdown：新页打开时无 opener；同页跳转先持久化点击前的即时编辑，真实离开后恢复两个 pane 的原官方草稿，零聊天提交。目标页面由明确浏览器 route fixture 提供。 |
| `companion.spec.ts`，3 条 | 官方 Settings 显式揭示原 HAPI 配对信息、本地 PNG 实际解码和剪贴板；隐藏/关闭/切换后迟到 Remote 回复不恢复秘密，无存储残留；HTTP 源没有 HTTPS alias 时禁用。未连接实际手机或该保留域名。 |
| `share-picker.spec.ts`，3 条，以及受影响交接 2 条 | 首次真实目录屏障、固定快照、共享预览数量、源时间与 inactive/日期搜索；真实 SW 原 Blob 预览/下载/插入，原生和 remote/local DSH 的准确目标；新建取消及后继会话已有草稿时明确追加。主题修复后的同一构建合计 5/5，通过实际日历背景/活动日/选中底色断言，零聊天写入。 |
| `composer-enter.spec.ts`，2 条 | 修正实际尾端换行缺陷后，官方 Lexical 选区/撤销、文件 chip 后精确 LF、Chromium composition、长按单次提交、默认发送恢复；pending/failed upload 保留草稿并显示反馈，成功后只提交一次；local/remote 两 pane 偏好与刷新后真实源 payload 均通过。组成事件由 Chromium 协议驱动，不代表手动验收所有系统输入法。 |
| `workspace.spec.ts`，5 条 | 统一侧栏和两类官方 Conversation、tmux 几何与刷新、跨机器官方插件/Settings、原生设置/精确历史分支/创建、普通 DSH 新建首次发送、计划实施丢回执不重复。 |
| `draft-handoff.spec.ts`，2 条 | 真实源恢复接口返回新 source ID 后，原文字和 File 对象明确交接；原草稿按 revision/identity CAS 清理，Done 前完成持久屏障，刷新恢复原字节。目标已有草稿仅显式追加，同窗口 ready 分享跟随新源，零聊天提交、零重放。 |
| `sidebar-actions.spec.ts`，3 条 | 鼠标、真实键盘焦点和移动触摸长按；准确身份复制、两种置顶、下方分屏与原草稿保留、标题建议与源 JSON 导出。重启/删除先确认，取消不提交，导航零聊天写入、零页面异常。 |
| `appearance.spec.ts`，1 条 | 原偏好迁移、OLED/色板/气泡色、两 pane 页头字段与真实 xterm 9 px；实际 reload 保留。MutationObserver 断言源会话恢复期间没有短暂挂载 Hub 本机 opener，页面及控制台无错误。 |
| `admin.spec.ts`，1 条 | 同一源机器 CPU/RAM/负载/运行时长在统一侧栏与官方 Settings 正确显示；机器改名、源 profile、重启丢 ACK 后仅查询、用量与真实 SQLite 下载路径。 |
| `runner-skew.spec.ts`，2 条 | 官方根布局中的能力缺失提示、最小化与一小时关闭偏好；只有在线、二进制变更且支持受监督重启的源机器显示重启入口。与 Admin 专项在同一界面检查点合计 3/3，重启丢回执只查询，页面无异常。 |
| `file-references.spec.ts`，1 条 | 官方 `@文件` 菜单、引用 chip、带空格文件精确提交与目录钻取；两个源机器不互串候选，源身份精确。 |
| `incoming-share.spec.ts`，3 条 | fragment 分享隐私、已有草稿追加与不同 pane 隔离；真实 Service Worker multipart Share Target、原始 File Blob 恢复；取消新建保留分享、随后明确交接到新会话。官方 Settings 的“保存草稿后刷新”实际 reload 后恢复原附件字节及两个独立草稿，均未自动发送。 |
| `cursor-launch.spec.ts`，1 条 | 原 Cursor base / variant 双选择、未完成选择刷新保留；改目录保留模型、换 Runner 清除旧模型；最终 source spawn 保留精确 wire ID。 |
| `plugin-workspace.spec.ts` 的 source file actions | 官方文件树与文档扩展入口中的搜索、Git diff、创建/复制/重命名/移动/删除、上传与 hash CAS 编辑；另一个机器不变。保存回执丢失后实际 reload 仍保留原正文、原 hash 与未知状态，没有重新写源文件；未保存关闭被否决。 |
| `source-file-recovery.spec.ts`，2 条 | 文件操作意图先持久化，再发送源请求；丢回执后同一 operation ID 穿过旧 pane graph 实际断开、重建与 reload。源写入精确一次，无自动重试；检查源与目标后显式本地确认。缺少 Web Locks 时拒绝新文件写操作，原读取与预览仍可用。与 source file actions 合计 3/3 后，增加实际旧 graph 断开断言的恢复专项再次 2/2。 |
| `plugin-workspace.spec.ts` 的官方 Files / Terminal | 同一统一侧栏中的两个源、官方文件与终端 pane、输入隔离与实际 reload；关闭 pane 仅 detach。最终生产构建定向 1/1，页面无异常。 |
| `legacy-terminal.spec.ts`，2 条 | 原 SessionTerminal 使用官方 Terminal body/title 与原 source/terminalId；按键、宏、修饰键、拒绝输入后保留草稿、450 行只读历史复制、共享字号及 reload 无输入重放。两个源的同名终端不串线；终端→Files/文档→刷新→非当前旧终端标签→Conversation→重新展开文件与再刷新，每步保留原 resource/target 和 1:2 分屏比例。关闭仅 detach，没有 `terminal:close` 或 machine TerminalHost 请求；最终同一构建连续 2/2，页面无异常。 |
| `queued-edit.spec.ts`，3 条 | 源排队编辑的竞争窗口、取消确认后显式恢复草稿、跨 pane 绝对定时草稿恢复；未知取消结果只读取源确认，不重新发送操作或自动覆盖输入。 |
| `plugin-workspace.spec.ts` 的 trusted terminal touch | 实际触摸 9→18 px 与 PTY grid、600 行历史拖动/惯性、ACK 和屏幕模式切换停止；TUI 仅发送合法 SGR wheel，不产生惯性残留输入；移动端 Close pane 不终止原 PTY，不创建替代 shell。 |
| `plugin-workspace.spec.ts` 的移动终端控件 | 官方 Terminal 上的双排按键、命令输入、宏、修饰键、共享字号及关闭行为；与 trusted terminal touch 和普通 Files/Terminal 在同一界面检查点合计 3/3。 |
| `dsh-children.spec.ts`，3 条 | HAPI DSH 子会话在原官方 Conversation 中保留真实 parent/child 身份；显式 `/child` 与 `/child-steer` 走实际源操作回执；丢 ACK 刷新不重发；空 child 首次输入。普通 DSH 的子代理行为继续由官方服务承担。 |

这些结果不代表整套 Playwright 在本轮每次修改后都重跑过。最新生产构建的范围以上方“实际截图反馈后的专项”为准，包括普通 Files/Terminal、旧 SessionTerminal、源文件操作与恢复，以及移动控件和可信触摸。Runner 提示、Admin、链接、Companion、输入换行与分享主题等先前证据按各行范围保留。其余产品路径与尚缺的验证在功能对照表和专项文档逐项记录，不扩大成任意第三方插件兼容的证明。

旧终端此前一次最终批次中，第一条通过，第二条输入途中测试 DSH Host 停止接受连接；当次没有留下足以定因的进程退出日志，尚不能宣称根因已修复，也没有依据归因为 OOM。相同生产构建随后严格单跑第二条通过，再连续跑两条均通过。测试 harness 现记录进程 exit code/signal，并始终附带脱敏 Host 日志；详见 [旧终端专项](legacy-session-terminal.md)。

## 验证层次

| 层次 | 真实运行的部分 | 明确替代的部分 | 能证明的边界 |
| --- | --- | --- | --- |
| 状态与协议测试 | 生产投影器、CAS、队列、草稿、资源地址、布局与源控制状态机 | 已标注的源事实输入 | 给定事实下的身份、请求、持久化和错误行为 |
| 官方接口组合 | 固定版本 Cordis、SlotCore、ThemeRuntime、Remote gateway、Source / Session / Subagent 等公开服务 | 不需要模型的会话事实 | 公开接口准入、原 principal/权限传递、依赖启动/卸载/重新提供和服务生命周期 |
| Hub/Runner transport | TCP、HTTP、WebSocket、真实生产反向通道 | 小型源业务服务器 | 字节与子协议保真、认证隔离、撤销、超时、断线不盲目重放 |
| 官方 federation 集成 | 官方 npm 进程、Web profile、plugin CLI、生产 Runner | 简单 Hub 路由与测试身份 | 未修改官方运行时的插件图、bundle、Session RPC 与事件通道 |
| 官方浏览器 | 原始 Web、Loader、renderer、生产插件、真实浏览器输入 | HAPI/Runner/model 协议 fixture；媒体/系统 API fixture 均逐项注明 | 页面组合、独立窗格状态、真实交互、刷新与跨窗格行为 |
| 实际账号部署 | 用户的 HAPI Hub/Runner、Codex app-server、提供方账号、真实磁盘与 PTY | 无 | 指定环境能完成真实任务；本地协议 fixture 不构成此层证据 |

源操作坚持以下边界：提交不等于应用，接受不等于执行完成，取消发出不等于源队列已移除，丢回执不是自动重发的理由。草稿迁移必须由源确认的新会话身份触发；无法确认时保留原数据和未知状态。

## 运行命令

```bash
npm ci
npm run typecheck
npm test
HAPI_DSH_OFFICIAL_TESTS=1 node --import tsx --test --test-isolation=none tests/federation-official.test.ts
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

需要使用指定的 Chrome for Testing 时，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chrome-headless-shell` 运行 `npm run test:e2e`。测试默认单 worker，浏览器输出目录可以通过 Playwright `--output` 设置。不要在实际浏览器流程运行期间重建其共享 `dist`。

本轮优先完成产品代码，没有重新执行 tarball 打包、干净安装 smoke 或把它们计入产品功能完成度。已有安装说明仍可参考，但发行包版本和当前源码验收不是同一个结论。

## 已知上游日志与实际部署范围

固定 DSH 的 sidebar 在异步 retain 尚未完成时被正常释放，可能输出 `Sidebar Session opening failed: … is released`。这与真正的会话打开失败必须按发生时点和可见结果区分；不能吞掉全部 console error。本项目不为消除它而修改官方代码。

未使用用户的 Codex 登录、实际 app-server 或第三方模型/语音账号完成线上任务验收，也不预先宣称所有第三方 DSH 插件兼容。实际部署需覆盖：原生 turn 与最终审批、真实排队/steer/cancel、网络中断恢复、不同机器同名路径、旧终端原 ID 恢复，以及将要分发的插件在自己的 Host、Session 和官方设置页中运行。提供方数据和账号凭据不得进入公共测试产物。

## 2026-10-21 线上反馈后的第二批修复

这一批全部由实际部署截图和站点探针触发，构建后只跑 typecheck、单测（864 项 / 863 通过 / 1 项 opt-in skip / 0 失败）与定向 e2e，不重跑全量套件。

| 问题 | 修复与边界 |
| --- | --- |
| Codex 长历史只显示最近一页、两条 `HAPI request returned HTTP 400`、加载更早失效 | 根因是我们把第一页的 `untilAt/untilSeq` 当快照锚点发给 HAPI；HAPI 要求 until 搭配 after 游标，第二页起全部 400。现在读取一个 **epoch-stable pass**：首頁取 `page.epoch`，每个 backward page 带同一 epoch，遇到 `reset`/epoch 变化或游标不前进即重开（最多 4 次），最后一页后再用 snapshot head 游标做一次 epoch 校验；只发布完整 pass，失败保留调用方旧缓存。真实 Hub 验证：indexed 会话 19 页 / 3754 行、native 会话 60 页 / 2096 与 2005 行，全部 200 且 epoch 稳定；页面内点“加载更早”后锚点从 104 增到 216，无 400。 |
| “Codex 计划”面板常驻、重复红卡错误 | 计划面板只在源端真的发布 `planId` 或存在 pending/durable receipt 时渲染，后台刷新失败只进诊断层；重复 source error 折叠成一行 `源错误 · N`，展开仍是原始事件；approvals、submitted-but-unresolved answers、indeterminate receipts 与可操作失败保持可见。 |
| 需要可复制的调试输出层 | 页面级内存环形缓冲（300 条），只存 allowlist 字段：时间、method、sanitized path-only route、status/code/requestId/outcome、duration、timeout/abort、retry-after、连接变化、分页 direction/cursors/epoch/reset/hasMore、build 与 hub/session/source-session/machine/engine 身份；不存 body、prompt、文件内容、cookies、authorization、URL query/fragment、console 原文。`诊断 N` 入口 + 抽屉 + 复制全部/清空；live 探针中止一次 `hapi/nativePlan` 后入口出现，抽屉显示 build/版本/身份，复制按钮可用。 |
| Codex “只读” 输入框 | 这是错误实现：`readOnly` 曾把 `!active`、`!connected`、历史 `fault` 和引擎独占都算进去。现在消息准入只阻止 disposed 与 observed 引擎独占输入；原生 Codex 的 inactive/history/disconnected/fault 都接受 durable journal 提交，投递前按 HAPI 语义 resume 原会话（single-flight、校验 native identity、rebind 并持久化通知），只有明确 rejected 的 409/session_inactive 允许一次 resume+retry，timeout/丢 ACK 仍是 unknown，不重发不换 id。live 探针打开 inactive native 会话：composer 可编辑、无只读提示、无计划面板。 |
| 启动慢、`DSH · Connecting…` | 只 boot 可见窗口的 pane graph：本轮实测恢复 13 pane 时 4 booted / 9 deferred，活动窗口 ready 6.5–8.1s（基线 14.6s），parked window 首次激活 1.9–5.2s，切回已 boot 窗口 0.7–1.2s，草稿跨窗口与 reload 保留；4-pane retained heap 77.84MB（同方法基线 77.32MB，噪声级）；54 个 row bundle 改为 bounded shared-cache prefetch（并行度 1.51–2.34，仍记录 maxQueued 51 的突发风险）。远端 Host pane 仍受 Hub 隧道影响，列为 residual risk。 |
| 窗格“额头”与底部窗口列表 | 删除桌面 pane header，底部状态栏改为 window 列表（每项显示 window 名 + 该 window focused pane 的 session name，仅 >1 时显示窗格数），窗格几何动作收进底部 Pane actions 菜单；window 右键/长按/Shift+F10 菜单支持 rename/new/close/move，move 使用该 window 自己的 focused pane。移动端保留既有底部 pane bar。定向 `workspace-chrome.spec.ts` 与 1600px/420px 实际截图核对。 |
| DSH“加载更早”体验差 | 新增 `src/client/seamless/**` 页面级插件：发现官方 Conversation 的 `[data-conversation-scroll]`，在向上意图接近顶部时自动驱动官方 Load earlier 控件，复用上游 beginPaging/preserve 锚定；单飞、burst 3 页/1200ms、12s 超时、失败冷却与 3 次 suspend、每 host+session 自动页上限 20、manual 按钮始终保留；`data-hapi-seamless`（error/suspended/limit）与 `hapi-dsh:seamless-history` 事件进诊断。定向 e2e 5/5（自动翻页、锚点 |Δ|≤2px、慢页单飞、失败恢复、reload 无重复请求）；live 探针一次向上手势自动加一页。DOM 兼容边界与触摸惯性/双 pane fairness/远端 pane 见专项文档。 |

### 上游版本记录修正

部署中的 HAPI Hub 构建自 `55166cf8d87814ccfb383b538a8e8c55283bed81`（`/mnt/cache/build-cache/hapi-production/20261020T204939Z-55166cf8d8`），此前 `UPSTREAMS.json` 与部分文档记录的是更早的 `0f8ef697`。已核对：历史窗口、分页、阅读锚点与 `hub/src/sync/messageService.ts` 在两个 revision 之间字节一致，仅 `HappyThread.tsx` 有一处 touch tail 修复；因此本批契约结论对两个 revision 都成立。`UPSTREAMS.json`、文档基线与 `HAPI_SOURCE_REVISION` 已更新为部署 revision；源码里标注 `0f8ef697` 的类型注释保留为**适配来源**，不再当作运行版本。

### 定向 e2e 结果边界

- `e2e/seamless-history.spec.ts`：5/5 通过（chat-core 在本构建上执行）。
- `e2e/pane-surface.spec.ts`：功能断言通过；console 验收项 `Session reference … is released` 未归零，已确认是官方 sidebar-view retire/ready 竞态日志（eager 基线同样存在，启动阶段 2→0–1，切窗时每次 re-open 出现最多 5 条），按“已知上游日志”处理，不作为本批失败项。
- `e2e/workspace-chrome.spec.ts`：2/2 通过（2048px 桌面与 420px 触屏；spec 已对齐 v2 的真实 13px 标题/11px 状态字号与官方 header 紧凑 cluster 的可访问名称）。
- `e2e/pane-surface.spec.ts`：3/3，`e2e/seamless-history.spec.ts`：5/5。
- 全量 Playwright 套件没有在本构建上重跑；上表各项按定向 spec 与 live 探针的实际范围记录，不扩大成全产品回归证明。
- 已知缺口（未在本批修复）：pane 切到官方 Plugins 等 main panel 后，官方 header 被面板页替换，当前没有从该面板直接回到 Conversation 的固定入口；用户可重新从侧栏打开会话或换 pane。列为后续可用性项，不阻塞本批。

## 2026-10-22 架构 A 与 source history / live 连续性（`9e459db` 检查点）

本节记录 `9e459db` 检查点，保留当时的 opt-in / 完整 history 默认和验证边界。后续 `58800d1` 已将共享 graph 与生产 tail-first seed 设为默认；下文的历史测量不能自动视为这些新默认的验收。架构 A 使用固定 DSH `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317` 的公开 `SessionProvider`、`conversation.content` factory 与 Host shell 扩展点；没有修改或嵌入上游实现。实现细节和当前条件见 [one-graph-spike.md](one-graph-spike.md)，后端语义见 [live-history.md](live-history.md)。

### 本次修复的实际边界

实际代码核查修正了交接中的一项归因：两种 source service 在 catalog discovery 之前就已经订阅全局 HAPI SSE，并非每个 pane 读完 history 才开始订阅。需要修复的是**收包之后、Agent 发布之前以及异步 history 合并期间的窗口**。原路径缺少 initial attach 的 live suffix 合并、失败缓存的自动对账，并让完整 history refresh 占用 source 事件队列；资源导入等后续 `await` 也可能跨过 rewind、删除或 source identity 变化。

| 实现 | 本次行为与限制 |
| --- | --- |
| 每 Host 一个官方 Client graph | 共享 conversation 路径用显式 session reference 挂载各 pane，关闭仅释放 view/reference；Host chrome、settings 和官方右栏仍是共享资源。非 conversation plugin-view 保留原兼容路径。共享模式须显式选择 `?hapiGraph=shared`，普通 URL 仍走原路径。 |
| 接收时 journal | 服务在进入异步队列前同步记录事件。每 source 最多 1,024 条事件、8 MiB 序列化正文，另有最多 4,096 条固定大小的已逐出 identity 证明。预算不等于整个 Host 的堆上限，不包含完整历史、官方 Session、内容资源或在途工作。journal 在内存中，Host 重启仍依赖源历史。 |
| 历史与 live 合并 | 按源序号/时间排序，以 stream id、localId 或原 row id 去重；保留读取期间到达的更新以及尚未被 REST 索引的 live 行。final/invoked 不被 provisional/queued 回退，同一 provisional stream 不被较短旧前缀截断。允许源对最终内容作合法修正，不能仅按正文长度判断任意改写的新旧。 |
| generation 与 source lifetime | invalidation、删除和已知 reconnect gap 使旧 checkpoint 失效；异步内容准备完成后和 Session 发布前再次核验。删除立即退休旧 lifetime，慢 attach 不能复活已删除源；remove/add 使用新 incarnation 和 display revision。 |
| writable owner 与替换失败 | display 替换先退休旧 Agent，再创建新 Agent，避免同一源的 delivery/approval durable journal 出现两个可写 owner。替换重试属于 service，不依赖已销毁 Agent；瞬时准备失败后没有新 SSE 也能继续恢复。pane 关闭不停止 native 执行。 |
| stale 与后台对账 | history refresh 脱离 live 队列，按 source 单飞，并共享四个后台刷新槽位。cache fallback 明确 stale；失败以 1 秒起、最多 30 秒的退避自动只读重试。逐出证明不足时仍保持 stale，不把无法证明连续的 snapshot 标为完整。普通 metadata 更新不再无条件重读完整历史。 |
| 初始 seed 的保守默认 | `fastHistorySeed?: boolean` 是 agent/service 的内部构造参数，默认 false；生产 composition 未传入，配置 schema、CLI 和环境变量均未新增启用入口。默认初次 attach 仍等完整 epoch-stable history，journal 保留其间 live。实验性 cache/latest-200 首屏只能显式启用，不能据此宣称默认首屏已经不受历史读取阻塞。 |

关闭 fast seed 的原因是固定 DSH 的追加式 display：后续补入更早历史可能必须创建新的 `-rN` display。相同 source 换代前的 rich draft、reference/command chips、附件恢复和滚动锚点尚缺安全迁移事务。现有跨 source handoff 不能替代它。默认全量 seed 避免正常打开都发生这种换代，但不解决既有 rewind、identity 变化或不完整缓存恢复所需的换代风险。

本次还修正了四项共享、卸载与界面集成问题：

- 旧 Terminal slot 跟随器通过公开 Context/Fiber 生命周期判断 owner 已退休，在异步 unload 的订阅清理前停止新注册；不再向 inactive Context 创建 effect。仍使用官方 leaf 和原服务 receiver，没有复制 store/children，也没有过滤全部页面异常。
- 原 `NativePlanControls` 组件在既有生产 dock 中漏挂载。现恢复到其他 action gate 之外，让首次只读查询可以找回已经消费 proposal 的 durable receipt；无真实 plan/receipt 时仍返回空结果，不恢复 routine 行或空 dock。浏览器用例保留 pane 启动期间立即送入 proposal，未用等待 pane ready 掩盖竞态，并检查实施一次、消费 proposal 后 reload 恢复同一 receipt。
- 共享 Host API 的诊断身份改为有界 session 索引，并在调用时复制准确身份。只检查请求自有的 `sessionId` 数据字段，不执行 getter、不遍历正文；Host 级和未知身份请求不借用最后一个 pane。并发切换、迟到失败和索引逐出不会改写在途请求身份，原返回值、异常和 API receiver 保持不变。
- 窄屏 composer 的 overflow 菜单此前被工具行裁切：`overflow-x:auto` 同时令纵向 overflow 成为 auto，菜单虽然有布局尺寸，点击却落到背后的正文。现在仅在 ≤420px pane 的菜单打开时让该行 `overflow:visible`，并把菜单锚定到入口左侧；关闭时保留原横向滚动。未移动官方 composer 节点，也未提高全局层级。专项同时验证面板左右边界、三个实际命中点以及真实点击后的暂存回执与零发送。

### 本次提交的验证范围

以下严格区分已完成检查点。用户要求先提交当前版本，因此最终类型检查与构建完成后停止追加浏览器批次；尚未执行的复跑明确保留。后续三条 diagnostics 回归没有重新计入先前完整 micro 报告。

| 检查 | 已取得的结果 |
| --- | --- |
| 完整 `npm run test:micro` | 922 项：921 通过、1 项按设计 opt-in skip、0 失败；包含 Host/Client/E2E TypeScript。随后 `npm run build` 通过。 |
| 最后的 diagnostics 调整 | `tests/source-diagnostics.test.ts` 9/9 通过，Client 与 E2E TypeScript 通过；其中新增 3 条。**未重跑包含这三条的完整 925 项 gate**，不把数量相加写成完整套件已通过。 |
| 最后一次构建 | diagnostics 修改后的 `npm run build` 通过；窄屏菜单 CSS 修复后的最终 E2E TypeScript 与 `npm run build` 也均通过。 |
| 前一构建的定向浏览器 | `composer-enter` 2、`pane-surface` 3、`queued-edit` 3、`sidebar-details` 2，共 10 个不同用例通过。这是前一检查点的范围，不视为最后构建全部重跑。 |
| 共享 runtime 检查点的 18 个定向浏览器用例 | 初轮 15 通过、3 失败、0 跳过，耗时 611.3 秒。失败分别是 rewind 的第二次鼠标分页被官方滚动锚点处正文拦截、shared composer 的测试 Host 在用例执行前启动超时，以及移动端沿用旧按钮高度断言。同一生产构建上，定向复跑的 rewind 与 shared composer 通过；移动端高度断言修正后进一步暴露了实际的菜单裁切问题，随后按上文修复。完整范围：`live-history` 2、`native-history` 4、`one-graph` 2、`shared-composer` 1、`shared-restore` 1、`source-engines` 1、`workspace-chrome` 2、`workspace` 5。 |
| 菜单 CSS 修复后的浏览器范围 | 独立的官方运行时/合成 source 探针通过：修复前命中正文，修复后三个点均命中 Park 按钮，真实点击暂存一条笔记、清空 editor、零发送、零页面异常。最后构建的 `workspace-chrome` 桌面/移动端正式 spec 尚未复跑；按用户“先提交一版”的要求保留该项，不把探针写成正式 spec 已通过。 |

后端回归覆盖 initial attach 中 live 到达、history 阻塞期间继续投影、重叠去重、旧前缀、epoch/generation 屏障、异步资源准备时 invalidation、stale 无后续 SSE 重试、pending attach 删除、立即 remove/add、失败替换重试、writable owner 退休和 journal 字节/证明上限。相关用例执行固定官方 Session/Agent/projection 接口，source 与资源内容为明确的协议 fixture。

本批浏览器运行的是未修改的固定 DSH 进程、官方 Loader/AppFrame/Conversation 和本仓库生产插件；HAPI、源文件/PTY、模型及 provider endpoints 为合成协议服务。浏览器为 **Chrome/HeadlessChrome 145.0.7632.6，单 worker**，不同于前文旧批次所用 executable。没有使用真实账号、真实 source 会话写操作或生产部署来验证这些流程，也没有把完整 Playwright、tarball 打包、干净安装或 npm package gate 列为本轮已执行项。

### 浏览器夹具与既有 UI 断言修正

本次失败分析区分了产品问题与不成立的测试前提：

- `addObserved({ rows })` 现在先采用调用方提供的行，不再预先通过 SSE 发出随后被替换掉的默认 answer/ready。旧行为会制造真实源不会承诺的“历史中消失、却已收到”的幽灵消息；journal 正确保留未索引 live 后，这个夹具问题才变得可见。
- Codex 活动流用例使用正确的 `nativeExecution`、独立 turn id 和 native terminal；含 execution 生命周期的 observed 历史中，答案与 terminal 归属同一 turn。通用 Pi 消息不能直接冒充 native Codex 输入；缺少 execution 的答案也不能作为 terminal 排序证明。
- 官方初始 retained window 有界。rewind 用例先验证剩余末尾和被删除末尾，再驱动公开 `Load earlier` 验证最早正文；不要求全部历史初始就在 DOM 中，也不通过私有接口展开历史。
- rewind 的第一轮鼠标分页已成功将正文从 250–274 扩展到 225–274；第二次按钮点击受官方保留滚动锚点影响，被正文拦截。历史数据用例改用该官方按钮的焦点与键盘 Enter 激活，并等待实际行数增长，继续验证最早的 `Bulk answer 0`。没有强制鼠标点击或调用私有分页接口，也不把鼠标 hit testing 与锚点的交互列为已修复。
- `source-engines`、`workspace-chrome` 和相关 workspace 断言与已经交付的 R8/R8b 紧凑 composer、routine 行移除相符，真实审批、计划和异常仍保留。“暂存草稿”已在 overflow 菜单中，触屏下沿用既有 44px 最小点击区域；测试不再要求旧 inline 按钮的高度小于 40px，这个高度规则没有改变。之后发现的菜单裁切问题有独立 CSS 修复和实际命中检查。官方 Plugins 面板替换 header 后缺少固定返回 Conversation 入口仍是已记录缺口；测试不把不存在的 header 控件当作返回路径。

### 性能与 rollout 尚未完成的条件

最近一次无 CPU profiler 的性能检查点随上述定向批次在 2026-10-22 02:35:15 UTC 启动；`one-graph` 的本地与远端两条均通过。它位于最后的窄屏打开菜单 CSS 修复之前；该 CSS 修复后没有再次测量性能。以下是已准入、已建立测试 catalog 的本地合成结果，不是生产 fresh browser / 冷隧道测量：

| 指标 | 最近性能检查点的结果 | 边界 |
| --- | --- | --- |
| warm 点击到内容元素 / 实际正文 p95 | **101.8 / 101.9 ms** | 10 次交替绑定，nearest-rank p95 即该组最大值；本轮低于 150 ms，元素与正文差最多 0.2 ms。 |
| whole-page used heap，0 / 1 / 2 / 4 pane | **65.83 / 68.95 / 70.28 / 74.02 MiB** | 显式 GC 后的 Chromium 堆；1→2 增加 1.33 MiB，2→4 增加 3.74 MiB，不是固定 per-pane 成本。 |
| 本地新增 pane / 重绑定的 graph 请求 | **0** | 统计 bootstrap / plugin 行请求，基线为已经 ready 的 Host。 |
| 远端首个 view 之前 / 第二个 view 新增请求 | **7 / 0** | 首个计数受 harness 的准入与缓存状态影响，不能当作完整冷 Host bundle 数量。 |
| 13-pane 恢复的 workspace / 活动正文 | **6,170 / 6,896 ms** | 首次 4 view、9 deferred；窗口激活新增 graph 请求 0；启动匹配请求 4。布局预先建立，不能推算生产 17.41 秒的改善幅度。 |

13-pane 浏览器用例还确认第一次激活其他窗口后分别保留 9、13 个 view，切回与 reload 保留原草稿和分屏比例，关闭/切换没有发送 native abort。两种 source 的 live-history 用例确认 attach 期间与被阻塞 refresh 期间的 live suffix 正文各出现一次，后者在历史读取放行前已经可见，刷新后仍不重复。

前一无 profiler 检查点的 warm p95 为 **273.9 ms**，四 pane 堆为 **73.89 MiB**，0-pane 基线则为 41.53 MiB。两轮存在时序/采样状态差异；最后一轮达到本地阈值不构成跨轮稳定性或生产 p95 保证，也不能与交接中另一机器的 77.8 MB 直接作严格内存优劣比较。完整样本和较早诊断分析保留在 [one-graph-spike.md](one-graph-spike.md)。

缓存恢复正文 <500 ms 仍未验收。每 Host graph 复用本身不消除首次 Host boot、源全量历史读取和隧道成本，不能据此宣称生产恢复 13 pane 已摆脱 17 秒级首屏。共享路径继续 opt-in；改默认前仍需旧 per-pane storage 中的 rich draft 迁移、同一 source display 换代保护及实际生产冷/热测量。Phase 2 的 warm reference 数量有界并不等于官方 retained history window 已 trim；固定公开接口没有安全原地 trim 能力，该项仍未完成。P1/P2 composer parity 也不因本次共享 graph 与连续性修复自动完成。

## 2026-10-22 六项反馈的增量修复（继 `58800d1`）

本批建立在 `58800d1` 的共享 graph / 生产 tail-first 默认之上。实现范围和计时定义见 [startup-feedback.md](startup-feedback.md)。**新 pane 首开和真实冷启动仍未达到目标**：最近会话与 hover/focus 预热、HTML 布局预览已实现，但不能用预览出现替代真实 workspace、正文或 composer 就绪。

### 实现和验收边界

- 隐藏且尚无 reference 的 pane 显式标为 `deferred`，不渲染 loading 占位；已经挂载的隐藏 view 保留草稿与滚动。共享恢复用例覆盖 13 pane、首次 4 个 view / 9 个 deferred、后续 deferred 9→4→0，以及隐藏 loading 始终为 0。
- 首屏后通过公开 Session `loadOlder()` 有界带出上一轮，与向上手势共享单飞和页数预算；自动读取不执行官方按钮附带的 `pauseFollowing()`。最多补两页，不能保证超过两页的巨大 Turn 或尚未进入 Host journal 的更早历史全部出现。
- source composer 使用真实模型/权限 capsule：模型列表与勾选、effort stops/滑杆、能力允许时的 Fast 和独立权限弹层。写操作沿用 source control ledger，弹层与来源 pane 绑定。普通 DSH 保留官方控件与语义，完整 voice / Schedule / Goal 等功能对齐仍未完成。
- 新增可常驻的官方 Host / Chromium 开发验证实例，客户端重建后等待官方 HMR 发布再重载。它提供八检查点 smoke；没有把原来的八份完整 spec 合并，也不声称完整回归现在只需十余秒。

### 实际执行的检查点

下表按构建检查点列出，未将不同检查点拼成“最终构建完整六用例一次全绿”。本批没有重跑全量 Playwright，也没有部署到生产或写入真实用户会话。

| 检查 | 结果和范围 |
|---|---|
| 完整 `npm run test:micro` | **948 项，947 通过、1 项设计内 opt-in skip、0 失败**，包含 Host / Client / E2E TypeScript；测试报告耗时 39.674 s。该检查点之后只修正了 composer 布局 CSS、浏览器用例的上下文定位/实际命中断言及文档，没有重新宣称完整 micro 在最终字节上执行。 |
| 最终完整构建 | 最后一次 composer CSS 和浏览器用例调整后的 `npm run build` **通过**，重新生成 Host / Client 产物与类型声明。最后两个定向用例在相同源码的独立 Client 构建上通过后完成这次完整构建。 |
| 上一轮与阅读锚点（composer 最后两次 CSS 修正前） | `seamless-history` 两条通过。三个合成 Turn、每轮 520 条 assistant 行的用例自动补两页，上一轮输入和末尾正文出现，保持 tail-follow，零 source 发送。向上手势用例锚点 **44 px→44 px**，自动一页且 source REST 计数不增加。 |
| 共享 13 pane 恢复（同一检查点） | `shared-restore` 通过：workspace **4,087 ms**、活动正文 **5,636 ms**；启动匹配 graph 请求 4，激活其他窗口新增 graph 请求 0；隐藏 loading 0，draft / pane 几何 / reload 与无 abort 断言通过。仅为已准备 catalog 的本地合成场景。 |
| 兼容模式窄屏（最后一次 source capsule 换行修正前） | `workspace-chrome` 的 420 px 用例通过；明确在 `?hapiGraph=legacy` 下检查其完整官方 header。真实 overflow 命中、暂存草稿与移动工具入口通过，关闭上一检查点未正式复跑的这项缺口。它不代表 shared pane 具有 legacy header。 |
| 最后一次 source capsule CSS 后 | E2E TypeScript 通过；客户端独立构建通过；`composer-picker` 与 `source-engines` **2/2 通过**，单 worker 总计 77.303 s。picker 检查双 pane 独立 draft/focus、两页模型弹层、effort/Fast/权限三次写入都只指向 beta、零发送；420 px 下两个 capsule 及官方 attach/send 都通过三个实际命中点检查，弹层没有越界或被裁切。原始 Claude 用例检查设置、最终审批、队列、pin、fork 与 launch 仍归属原 source。 |

这次定向回归暴露并修复了两个实际布局问题：共享 embedded Conversation 不在旧 per-pane AppFrame 下，旧 CSS 未隐藏对应官方模型/权限 cell；窄屏下 R8 的单行布局与 capsule 固有宽度叠加又使按钮重叠。修复仅作用于带 source capsule 的实际 composer card，分别隐藏被替代的公开 cell、让工具组自然换行并允许 capsule 文本收缩；没有移动官方编辑器、attach、Stop 或 Send 节点。浏览器断言验证实际命中，不能只以元素可见当作可点击。

另外两处失败属于共享默认后的测试上下文：Session tools 作为独立 plugin pane 打开，标题区是 tools 区的同级区域；legacy 用例若只给一次性 launch URL 附加 query，准入 303 会丢弃该 query。现分别在原 source 的 tools pane 内定位，以及先准入、再显式打开 legacy URL。没有通过强制点击或切换 source 测试到 legacy 来规避共享行为。

### 常驻验证和性能仍未完成的部分

warm 检查点发生在最后两次 composer 布局修正之前；完整命令和范围见 [warm-validation.md](warm-validation.md)。`check → rebuild-client → check` 两轮均 **8/8**，耗时 **11.633 s / 14.930 s**，始终复用一对 Host / Chromium，新增 split graph 请求 0、页面异常 0。客户端编译 **1.349 s**，含官方发布确认与 reload **4.288 s**。最初准备测试环境 **23.283 s** 单独记录；首轮曾与一次 E2E 类型检查短暂重叠，第二轮没有该并行工作。常驻实例已在测量结束后正常关闭。

第二轮新 browser context 的布局标记 / FCP / 实际 workspace 分别是 **84.7 / 308 / 5,965.4 ms**；保存布局 reload 则是 **154.8 / 200 / 2,164.3 ms**。首次 session transcript/composer 检查点两轮分别为 **430 / 2,347 ms**，包含 Playwright actionability、点击与断言，没有拆成 click→body 和 click→composer。较慢结果保留，不能用第一轮或预览标记宣布首开/冷启动已修复。

最终发布仍保留这些条件：生产新 split、冷 Host 与远端隧道的分项测量；缓存恢复正文 <500 ms；跨轮稳定的 warm p95 <150 ms；共享模式旧 rich draft 迁移、tail-to-full display 换代时的附件/draft/scroll 保护，以及公开接口下的 retained window trim。本批未改变上游代码，也未把合成源端测量当作生产站点验收。
