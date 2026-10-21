# 可复现验证与验收边界

这份记录区分原始 HAPI/Runner 协议 fixture、真实传输、未修改的官方 DSH 进程、真实浏览器与实际账号执行。某一层通过不能替代下一层。功能和 UX 尚未等价的项目继续列在 [功能对照表](feature-parity.md)，不因构建或单测通过而自动标成完成。

## 当前代码验证

运行环境为 Linux、Node 24.19.0，DSH 固定 `0.2.1-rc.2`。上游源码与已发布 bundle 均未修改，具体来源见 [UPSTREAMS.json](../UPSTREAMS.json)。浏览器测试使用 Playwright 1.64.1 与 Chrome for Testing 156.0.8078.4；后者具备固定上游 PDF.js 所需的原生浏览器 API，没有给上游加 polyfill。

| 检查 | 本轮结果与边界 |
| --- | --- |
| Host TypeScript | `npx tsc -p tsconfig.host.json --noEmit` 通过 |
| Client TypeScript | `npx tsc -p tsconfig.client.json --noEmit` 通过 |
| E2E TypeScript | `npx tsc -p tsconfig.e2e.json --noEmit` 通过 |
| 全部代码与传输测试 | `npm test` 实际执行 633 项，632 通过，0 失败，1 项官方进程测试按设计等待显式启用 |
| 显式官方 federation 集成 | 独立启用后 1 项通过，0 跳过；运行原始官方 Web profile、配对 Runner、bundle/Session RPC/事件流 |
| 构建 | Host、Client、CLI、Runner、五个 source-aware providers 与类型声明构建通过 |

`npm test` 使用 Node 的 `--test-isolation=none`，报告的是实际 case 数；测试文件进程退出成功不作为其内部断言已执行的证明。测试绑定本机回环端口，需要运行环境允许本地监听。官方进程集成单独使用 `HAPI_DSH_OFFICIAL_TESTS=1`，不能把默认 skip 写成已通过。

### 已在实际官方浏览器中确认的交互

这一组测试加载官方 DSH 页面、原始插件 Loader 和官方 Conversation / Files / DocumentPreview / Terminal。它们运行本仓库的生产插件和真实本地网络通道，HAPI、Runner 文件/PTY与模型返回值由测试中明确命名的协议 fixture 提供。

| 专项 | 实际界面确认的行为 |
| --- | --- |
| `workspace.spec.ts`，5 条 | 统一侧栏和两类官方 Conversation、tmux 几何与刷新、跨机器官方插件/Settings、原生设置/精确历史分支/创建、普通 DSH 新建首次发送、计划实施丢回执不重复。 |
| `draft-handoff.spec.ts`，2 条 | 真实源恢复接口返回新 source ID 后，原文字和 File 对象明确交接；原草稿按 revision/identity CAS 清理，Done 前完成持久屏障，刷新恢复原字节。目标已有草稿仅显式追加，同窗口 ready 分享跟随新源，零聊天提交、零重放。 |
| `sidebar-actions.spec.ts`，3 条 | 鼠标、真实键盘焦点和移动触摸长按；准确身份复制、两种置顶、下方分屏与原草稿保留、标题建议与源 JSON 导出。重启/删除先确认，取消不提交，导航零聊天写入、零页面异常。 |
| `appearance.spec.ts`，1 条 | 原偏好迁移、OLED/色板/气泡色、两 pane 页头字段与真实 xterm 9 px；实际 reload 保留。MutationObserver 断言源会话恢复期间没有短暂挂载 Hub 本机 opener，页面及控制台无错误。 |
| `admin.spec.ts`，1 条 | 同一源机器 CPU/RAM/负载/运行时长在统一侧栏与官方 Settings 正确显示；机器改名、源 profile、重启丢 ACK 后仅查询、用量与真实 SQLite 下载路径。 |
| `file-references.spec.ts`，1 条 | 官方 `@文件` 菜单、引用 chip、带空格文件精确提交与目录钻取；两个源机器不互串候选，源身份精确。 |
| `incoming-share.spec.ts`，3 条 | fragment 分享隐私、已有草稿追加与不同 pane 隔离；真实 Service Worker multipart Share Target、原始 File Blob 恢复；取消新建保留分享、随后明确交接到新会话。官方 Settings 的“保存草稿后刷新”实际 reload 后恢复原附件字节及两个独立草稿，均未自动发送。 |
| `cursor-launch.spec.ts`，1 条 | 原 Cursor base / variant 双选择、未完成选择刷新保留；改目录保留模型、换 Runner 清除旧模型；最终 source spawn 保留精确 wire ID。 |
| `plugin-workspace.spec.ts` 的 source file actions | 官方文件树与文档扩展入口中的搜索、Git diff、创建/复制/重命名/移动/删除、上传与 hash CAS 编辑；另一个机器不变。保存回执丢失后实际 reload 仍保留原正文、原 hash 与未知状态，没有重新写源文件；未保存关闭被否决。 |
| `legacy-terminal.spec.ts`，1 条 | 原 SessionTerminal 的同一 source/terminalId、双排键盘、一次与锁定修饰键、原 `terminal:write` 命令、隐藏宏与共享字号；reload 无输入重放。关闭仅 detach，没有 `terminal:close`、没有新 machine TerminalHost 请求。 |
| `queued-edit.spec.ts`，3 条 | 源排队编辑的竞争窗口、取消确认后显式恢复草稿、跨 pane 绝对定时草稿恢复；未知取消结果只读取源确认，不重新发送操作或自动覆盖输入。 |
| `plugin-workspace.spec.ts` 的 trusted terminal touch | 实际触摸 9→18 px 与 PTY grid、600 行历史拖动/惯性、ACK 和屏幕模式切换停止；TUI 仅发送合法 SGR wheel，不产生惯性残留输入；移动端 Close pane 不终止原 PTY，不创建替代 shell。 |
| `dsh-children.spec.ts`，3 条 | HAPI DSH 子会话在原官方 Conversation 中保留真实 parent/child 身份；显式 `/child` 与 `/child-steer` 走实际源操作回执；丢 ACK 刷新不重发；空 child 首次输入。普通 DSH 的子代理行为继续由官方服务承担。 |

这几项定向结果不代表整套 Playwright 在本轮每次修改后都重跑过。其余已验证产品路径、具体测试文件与仍缺少的验证在功能对照表及各专项文档逐项记录。最后一项生产增量是菜单完成可见布局后再聚焦，三条侧栏用例已在该构建独立通过；此前通过的 handoff 生产逻辑未随该修复变化。

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
