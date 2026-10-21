# 可复现验证与验收边界

这份记录区分原始 HAPI/Runner 协议 fixture、真实传输、未修改的官方 DSH 进程、真实浏览器与实际账号执行。某一层通过不能替代下一层。功能和 UX 尚未等价的项目继续列在 [功能对照表](feature-parity.md)，不因构建或单测通过而自动标成完成。

## 当前代码验证

运行环境为 Linux、Node 24.19.0，DSH 固定 `0.2.1-rc.2`。上游源码与已发布 bundle 均未修改，具体来源见 [UPSTREAMS.json](../UPSTREAMS.json)。浏览器测试使用 Playwright 1.64.1 与 Chrome for Testing 156.0.8078.4；后者具备固定上游 PDF.js 所需的原生浏览器 API，没有给上游加 polyfill。

| 检查 | 本轮结果与边界 |
| --- | --- |
| Host TypeScript | `npx tsc -p tsconfig.host.json --noEmit` 通过 |
| Client TypeScript | `npx tsc -p tsconfig.client.json --noEmit` 通过 |
| E2E TypeScript | `npx tsc -p tsconfig.e2e.json --noEmit` 通过 |
| 全部代码与传输测试 | `npm test` 实际执行 768 项，767 通过，0 失败，1 项官方进程测试按设计等待显式启用 |
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
