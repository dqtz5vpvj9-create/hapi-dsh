# 源文件与终端插件适配

本页记录文件、终端的实际适配边界和验证证据，服务于 [功能对照表](feature-parity.md)。它不是全产品成熟度声明。DSH 固定 `0.2.1-rc.2`，HAPI 固定 `0f8ef6970884c92fb2ddca3070be2ec56cb50333`；上游实现未修改。

## 官方插件保留的职责

普通文件树、文档预览、终端渲染和它们的 tab 生命周期由所属 Host 的官方插件负责。工作区保存官方 resource address、tab occurrence、navigation params 与宿主身份，每个 pane 使用独立官方 Client graph。文件树没有被另一个通用文件浏览器替换，浏览器终端没有额外的 xterm renderer 或第二条输入连接。

原官方 package-root Loader 行保持启用，以保留 Client bundle 的公开发现机制。Host 服务通过 Cordis 行 `isolate` 保存在独立服务域，适配服务使用 `officialProviderContext(currentInvocationContext, id).get(serviceKey)` 逐请求委托普通 DSH 会话。这样保留原用户配置、原 Remote 元数据及权限检查，也避免复制原构造器造成重复 namespace 注册。Native/observed 命名空间里无法解析来源的 ID 明确失败，不会回退到 Hub 本机文件或终端。

对应代码：`src/shared/official-provider.ts`、`src/hapi/workspace-files.ts`、`src/hapi/terminal-controller.ts`、`config/cordis.patch.yml`。

### 文档读取与目录管理的区别

原 HAPI 的 `/api/sessions/:id/file`、`/file-info` 是文档读取接口。Hub 根据原 session 找到所属机器，Runner 在其 browse roots 内授权读取；会话 cwd 用于解析相对路径，并不是所有文档的唯一可读根。聊天进程已离线时，所属 Runner 仍可提供已授权文件。

官方 WorkspaceFiles 的文档 `stat`、`read`、`readBytes` 和文件变化订阅现使用这一原读取契约。之前先调用 `/filesystem/entry` 再 `/filesystem/download`，误用了要求会话在线且限定 cwd 的管理契约，导致旧工作区的合法外部文档显示 Access denied。现在文件元数据先检查传输上限，内容按原 hash/大小验证；Markdown 相对图片使用源返回的规范文件路径解析，仍逐文件交源授权。预览和下载不访问 Host 文件系统。

目录树、`@文件` 候选及写操作保留各自原接口的范围。离线文档可以读取，但不会显示可提交的编辑权限。二进制读取上限仍为 64 MiB；原读取协议不支持 range，适配器有界解码后向官方 viewer 返回请求窗口。短期缓存只保留最多 16 MiB / 8 个已完成的小文件读取，避免 `stat` 和内容读取立即重复传输；它不改变源归属检查。

相应的源授权、离线读取、Windows 路径、字节/哈希不一致、源拒绝及取消回归见 `tests/hapi-workspace-files.test.ts`、`tests/hapi-workbench.test.ts`。真实官方 Markdown/PDF 与刷新验证见 `e2e/source-document-policy.spec.ts`，源磁盘数据和权限由明确 fixture 提供。

### 输入框的 `@文件` 发现

`@文件` 不经过 `workspaceFiles`。固定 DSH 的官方 `fileReferences/list` Remote 会把已授权的精确 Agent 交给 `ctx.fileReferences`；原 `file-reference-local` provider 直接访问 Host 文件系统。因此仅适配 Files 面板，不能保证原生会话的输入候选来自源机器。

`src/hapi/file-references.ts` 单独组合这个公开 provider。原 `file-reference-local` Loader 行保持启用，隔离其 `fileReferences` 服务；普通 DSH 的查询、取消信号、调用者上下文、原配置和缓存原样委托。原生 Codex 与 observed 根会话使用原 Hub/session/machine 绑定，通过 `NativeWorkbench` 调原 HAPI `/directory` 和 `/files`；不会读取 Hub 的 `workingDirectory` 或文件系统。目录候选保留源平台的路径语义，拒绝越界路径、符号链接和不兼容返回；旧 Agent、未映射子会话、离线或换机器的源明确失败。并发查询被取消时，原 GET 使用相同取消信号，结果发布前还会复核 Agent 身份。

源全局搜索保持原 HAPI ripgrep 的匹配和 ignore 规则，最多接收 500 条候选，再按原 provider 的结果上限、排除目录和隐藏项规则筛选；它不声称拥有官方本地 provider 的 50,000 条模糊索引。空查询与路径钻取读取源目录，顶层空目录仍能选择。官方候选菜单、引用 chip、插入、撤销和文件打开行为保持原插件。

`tests/hapi-file-references.test.ts` 的 9 项定向回归使用真实 Cordis、官方 LocalFileReferenceService、SessionFileReferences、Typert Gateway 与访问控制，HAPI HTTP 响应为显式 fixture。已验证同路径双机器、Windows/引号/点文件、上游配置、取消、失效和子会话拒绝、加载/卸载依赖，以及非 owner 的精确会话授权。就绪回归特别先启动官方 SessionFileReferences，再提供源适配器，验证公共子插件会正确唤醒既有消费者，并在原 delegate 卸载/恢复时同步停用/恢复。和配置、Workbench 回归合跑为 28/28。

`e2e/file-references.spec.ts` 已通过实际未修改的官方 Web 与 Chromium 156（1 passed，17.6s）：两台机器各自的 `@` 文件候选、带空格的官方引用 chip、精确源会话单次发送、`@src/` 目录钻取，以及所有目录/搜索请求的机器和路径归属。没有文件写入，浏览器无 `pageerror`，截图已人工检查。源文件和原生消息投递仍为明确 HTTP fixture，不声称已读取真实用户目录或调用真实模型。

| 输入命名空间 | 此项改动的边界 |
| --- | --- |
| `fileReferences/list` | 路由源文件与目录发现；官方 Remote 授权和 UI 不变 |
| `workspaceFiles` | 独立的文件读取、预览和目录资源 provider；之前的适配继续生效 |
| `sessionReferenceResolver` | 会话引用解析，独立于文件发现；本次不替换其会话语义 |
| `skills` / 原 HAPI `sourceSkills` | 技能目录与执行约定不同，不会因 Files 或 fileReferences 适配自动变成源技能 |
| `commands` / source child 命令 | 保留各自公开注册与源执行适配，不由文件候选 provider 代为执行 |

## 源文件操作

`source-file-actions.tsx` 在官方 `sidebar.right.tab.files.actions` 和 `sidebar.right.tab.document.actions` 列表 slot 中添加动作。官方树和 preview 保持原实现。所有路径包含源 Hub、HAPI session 与机器归属，由 `NativeWorkbench` 转发给原 Runner。

| 行为 | 当前实现 |
| --- | --- |
| 文件名搜索 | 源 `files` 接口；文件结果交官方资源路由，目录结果进入明确的源目录操作 |
| Git 状态和差异 | 源 `git-status`、`git-diff-numstat`、`git-diff-file`；复用官方 `CodeBlock` 显示文本 diff |
| 文本编辑 | 读取源 hash，保存提交 `expectedHash`，保留 BOM 和换行格式；不是另一套文档 renderer |
| 保存冲突/未知回执 | 保留草稿，先读取当前源版本；显式选择保留草稿并使用新基线，或接受源内容；不会自动重发 |
| 创建文件/目录 | 明确路径、单个合法名称、源端 no-clobber |
| 重命名/移动/复制/删除 | 先检查目标并提交源 revision；删除目录需要明确递归确认，保存部分成功证据 |
| 上传 | 明确显示 Upload directory，逐文件上传；源未知回执后停止后续动作 |
| 关闭保护 | 源操作未结束时保留视图；未知文件管理结果需核对；未保存草稿由公开 pane close guard 保护 |
| 下载和打开本机应用 | 源文件从已认证 Host 桥接下载；源路径不会交给 Hub 的桌面应用打开器 |

创建、复制、移动、重命名、删除和上传现在把原请求及有界回执先提交到 IndexedDB，再向源端发送。共享 owner 按原 Hub/session/machine 定位，不随某个窗格 graph 销毁；源历史更正引起 display generation 更换后仍能读取原操作。Web Locks 与存储 CAS 共同保护同一浏览器来源的多个窗口。恢复只检查原路径与目标路径；用户明确核对可以解除本地阻挡，但不被标记成源端确认，不自动重发操作，也不保存另一份上传文件字节。

文件写操作需要可用 IndexedDB 和受信 HTTPS/localhost 上的 Web Locks；不具备条件时显示原因，源文件读取、预览、下载和直接检查仍可使用。这一边界、不同设备之间的限制及未知回执的处理见[文件操作恢复](source-file-recovery.md)。

官方 Files 是会话 `cwd` 的页面，公开定义明确不声明资源地址。创建子目录后不伪装成已改变官方树根；操作对话框会切到该明确子目录，上传目的地独立显示。文件依然由官方 preview 打开。

### 文件验证

`e2e/plugin-workspace.spec.ts` 的 source file actions 用例已经通过未修改的官方 DSH Web：CAS 保存、并发冲突、保存 ACK 丢失后单次投递、拒绝关闭并恢复草稿、复制/重命名/移动/建目录、子目录双文件上传、创建/编辑/删除、搜索及 Git diff。它核对所有写入的源 session/机器身份，第二台机器的数据不变，浏览器无 `pageerror`。

该用例中的 HAPI 文件和 Git 由 `e2e/workbench-fixture.ts` 显式模拟；运行的浏览器、官方 Loader、官方文件插件、插件 Remote 与 HTTP 通道是真实实现。它不证明任何真实用户仓库已经执行过写入。纯模型回归在 `tests/client-source-file-edit.test.ts`、`tests/client-source-file-management.test.ts`。

## 终端

新终端通过原 HAPI machine TerminalHost 协议运行。Runner 持有 PTY、屏幕、输出游标和控制 lease。适配器映射为官方 `TerminalView` 所需的 snapshot/output/state/ACK，输入序号归当前 attachment 所有。断线、未知 ACK 或 lease 改变不会重放输入，也不会重新创建一个替代 shell。

关闭外层 pane 只释放 view；终止必须通过原终端的明确关闭动作，并等待源退出确认。原 schemaVersion 2 的 SessionTerminal 与新 machine TerminalHost 协议不同，旧 ID 保留原恢复路径，不静默改 ID 或生成新 shell。

旧 SessionTerminal 也进入官方 `ClientTerminals.view()`、Terminal body/title 与原 tab 生命周期。原自绘浏览器 xterm 和独立输入路径已经移除；Host 适配器把原 Socket.IO 回放转成官方帧，并保留原 10,000 行 scrollback 默认值。旧终端使用独立的公开 `hapi-legacy-terminal` kind，避免普通终端 tab 的显式 close 语义终止旧 PTY。它复用共享触控栏、自定义键与宏、锁定修饰键、命令输入、复制和原字号偏好；原协议验收、稳定地址恢复与具体限制单独记录在[旧会话终端兼容说明](legacy-session-terminal.md)，不与下述 machine TerminalHost 测试合并计数。

对应代码：`src/hapi/machine-terminals.ts`、`src/hapi/terminal-controller.ts`。适配器归属及生命周期回归见 `tests/hapi-machine-terminals.test.ts`，真实 Socket.IO ACK/断线测试见 `tests/hapi-machine-terminal-transport.test.ts`。官方 Files/Terminal 双机器浏览器用例已验证输入、重载保留原 PTY、关闭 pane 不发 terminate。用例的 PTY 为显式模拟，不执行系统 shell。

### 移动键盘附件

`source-terminal-actions.tsx` 通过公开 keyed slot 组合原 Terminal body。原组件的 inject、locale、状态、原 xterm、输出确认和 mount/dispose 保留。只有传给原组件的公开 `view.write` 能力增加了原 HAPI 的一次/锁定修饰键处理。所有硬件输入、触摸键、连发、宏、command 输入与粘贴最终调用同一个官方输入 owner。

已实现原 HAPI/Haven 双排布局、对齐导航键、inline/uniform 布局、宽度设置、长按连发和滑动取消、Ctrl/Alt 锁定、自定义组合键/转义宏、片段、JSON 导入导出、拖动/键盘重排，以及原两项浏览器偏好共享。失去输入权、窗口失焦或视图隐藏会停止继续输入；偏好保存失败会明确反馈，同时保留当前页面编辑。

相关单测覆盖公开 SlotCore 的注册/热重载/卸载恢复、共享偏好与浏览器配额失败、编码和模式识别、断线不补发、关闭附件不终止 PTY。`e2e/plugin-workspace.spec.ts` 的移动专项用例已使用真实官方 DSH Web、Chromium 156 和 420px 触摸视口通过（1 passed，33.4s）：Ctrl 与硬件输入、长按连发停止、自定义宏、command 输入、bracketed paste、重载不补发及另一台机器共享偏好均有源 wire 断言，浏览器无 pageerror。已人工查看浅色主题下的终端和复制对话框截图。

### 只读文本快照

标准 copy 事件保留官方选区。源终端无选区时，新的 `nativeTerminalText` Remote 验证原 Hub/session/机器归属后，单独连接 HAPI `/terminal`，只发送一次 machine `attach`（不带 `afterSeq`），要求完整 retained-screen replay、精确 terminal ID 和一致 seq。 pinned HAPI `TerminalHost.execute('attach')` 只读取回放；输入权由另一条 `claim` 命令管理。此读取器从不发送 claim、create、input、resize、release 或 terminate，也不调用会夺取控制权的 DSH `terminal.attach`。

Host 使用 `@xterm/headless@6.0.0` 的公开 buffer API 解码源自己的序列化屏幕，没有连接源输入的回调。浏览器只显示复制用的文本，复用原 HAPI 的换行拼接和 200 行逐页展开行为，不新增终端 renderer。对话框关闭、pane 隐藏和卸载通过官方 Remote cancellation 取消读取。读取失败有明确错误，用户可主动重读；不会降级为控制 attachment。

源回滚历史有自己的保留上限，却没有“是否曾丢弃更早内容”的事实，因此响应始终标记 `sourceHistory: 'bounded-unknown'`，界面明确说明这一点。本地最多解码 5,000 屏幕行或 2,000,000 个 cell，并返回最多 2 MiB UTF-8 文本；达到容量时展示 `localLimitReached`。超过 16 MiB 的源序列化屏幕直接失败。该接口不能恢复源已经丢弃的输出，也不把快照称为终端的完整历史。

`tests/hapi-terminal-text.test.ts` 的 6 个回归已通过：真实 Socket.IO 上的两 viewer 归属、读取后原 lease 继续输入、错误 replay 不接管、取消/卸载只关闭读取 viewer、跨机器/Hub 拒绝、公开 headless buffer 的 ANSI/换行和截断。源 TerminalHost 状态仍是明确协议 fixture，不是实际 PTY。`tests/client-terminal-snapshot.test.ts` 的 4 个回归覆盖官方选区、精确源地址和取消信号、错误不降级、过期回执丢弃。上述移动浏览器用例已通过视口之外的 450 行源输出读取、200 行分页展开及真实剪贴板复制；读取前后没有 claim/create/input/resize/release/terminate，原 lease/version 不变，关闭复制视图后原 owner 继续输入成功。

普通 DSH 终端仍保留官方选区和明确标注的“可见终端行”回退。原官方 Terminal body 未公开 xterm buffer；这里不读取私有 `_core`，也不把可见画面当成未渲染的 scrollback。

### 触摸缩放与滚动

`source-terminal/gestures.ts` 适配原 HAPI/TermBeam 的 4px 延迟捕获、9–32px 双指缩放、50ms 缩放去抖和普通缓冲区惯性。缩放只组合此 occurrence 的公开 `useTheme`，由原官方 Terminal body 更新真实字体、网格和原输入 owner 的 resize；不覆盖浏览器保存的字体偏好。触摸滚动以标准 WheelEvent 进入原屏幕 DOM，视口滚动或 TUI 鼠标/方向键编码仍由原 xterm 决定。新触摸、失焦、隐藏、取消及卸载均停止惯性。

模式判断使用公开输出 frame，并等待原 renderer 对同一 revision 的 ACK。未确认的输出、未知超长控制序列、alternate buffer 都不能接收普通历史滚动遗留的惯性。轻量模式识别器已与固定 `@xterm/headless` 的公开 modes/buffer API 做对照：分片 CSI、OSC/DCS 的真实 ESC 终止、前导零、子参数、CSI 内 C0、32 项参数边界、鼠标协议和 reset。未知超长控制序列会阻止手势，直到完整 reset/snapshot 恢复已知状态。

固定官方组件没有公开 `scrollLines`。当程序在普通缓冲区启用鼠标滚轮报告时，标准 WheelEvent 会成为程序输入；此时界面明确提示触摸历史滚动不可用，并消耗拖动而不发送它。普通缓冲区未配置 scrollback 时也不合成滚轮。alternate buffer 的拖动使用官方鼠标/方向键编码且不启动惯性。原 HAPI 能直接调用 `scrollLines` 的这一个组合尚不能通过固定版本的公开接口完全等价实现。

`client-terminal-gestures`、`client-terminal-input`、`client-terminal-slot` 共 9 项定向回归已通过。`e2e/plugin-workspace.spec.ts` 的 trusted-touch 用例已在真实官方 Web、Chromium 156、420px 触摸视口通过（1 passed，13.4s）：可信 CDP 触摸把 9px 字体缩放为 18px 并改变源 grid；600 行普通历史真实滚动且抬手后继续惯性；模式切换立即停止惯性；TUI 只收到官方编码的 SGR 滚轮输入，抬手后无继续输入；普通缓冲区鼠标报告时显式阻断手势。通过原移动 pane 菜单关闭后没有补发输入或 terminate，只有一次 create，源 PTY 仍运行，浏览器无 `pageerror`。截图已人工检查；PTY 与输出为明确源协议 fixture，不是物理触摸设备或真实系统 shell。来源和许可证见 `src/client/source-terminal/UPSTREAM.md`、`HAVEN.md`、`NOTICE` 与 `docs/licenses/TERMBEAM-MIT.txt`。
