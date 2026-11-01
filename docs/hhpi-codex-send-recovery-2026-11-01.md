# Codex 历史会话发送恢复

日期：2026-11-01，Asia/Shanghai。问题表现为官方输入框仍允许提交，但 HHPI 客户端随后返回 `The source does not support send.`。

## 原因

`DirectCodexAdapter` 原先把默认/shared 来源的发送能力绑定到当前 app-server 的 `thread/loaded/list`。持久化历史可以正常读取，但不在该进程内存中的线程被标为 `send=false`，显式发送也没有恢复路径。这个列表只表示当前进程已加载的线程，不能代表一个历史线程永远无法继续。

客户端还有两个相关缺口：官方 composer admission 没有读取 HHPI 的发送能力；历史更新只通知当前 Session face，没有同步 canonical 列表。先发后到的 catalog 响应还可以覆盖较新的能力状态。因此会出现可点击的发送按钮与实际 source 能力不一致，以及状态恢复后仍沿用旧限制的问题。

## 发送与执行归属

已加载线程继续通过配置的原生 app-server 控制。对于未加载的 shared 历史，仅在握手确认服务端为稳定版 Codex 0.165.0 或更新版本时，允许一次显式 send 调用同一 app-server 的 `thread/resume`，并核对返回的原生 thread ID。随后才提交原消息的 `turn/start`。打开、翻页、follow、重连、steer 和 cancel 都不会触发冷恢复。

这个判断以固定版本 `rust-v0.165.0`、commit `360319d8dee62d87e2d59fc0c21805d79519cfed` 的原生实现为依据：

- 默认 app-server 使用非 ephemeral 的 Local 存储。冷恢复经过 `LiveThread::resume`，在重读权威历史、创建 recorder 和启动执行循环前，取得 `<CODEX_HOME>/thread-writer-locks/<ThreadId>.lock` 的独占文件锁。参见 [Local writer](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/thread-store/src/local/live_writer.rs#L75-L170) 和 [writer lock](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/rollout/src/writer_lock.rs#L42-L85)。
- 另一个进程仍持有 writer 时，原生恢复返回 `-32600`，原因是 `already has an active writer`。HHPI 返回 rejected，不发送 prompt，不替换 owner，也不创建分叉线程。参见 [rollout 初始化错误](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/session_rollout_init_error.rs#L8-L25)。
- 版本来自初始化 `userAgent` 首段的服务端构建版本。后面的客户端 suffix 不能证明服务端能力。实际固定版本握手为 `hhpi/0.165.0 (Ubuntu 24.4.0; x86_64) dumb (hhpi; 1)`。参见 [原生 user agent](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/login/src/auth/default_client.rs#L152-L178) 和 [initialize](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server/src/request_processors/initialize_processor.rs#L212-L218)。

共享同一 home 的进程必须都参与兼容的 writer-lock 协议。对新进程的版本判断不能让一个不使用该锁的旧进程自动遵守它。未知、旧版、预发布 shared 运行时保留已加载线程的控制，但不获得冷恢复能力。已有 `exclusive` 配置仍表达操作者分配的独占 home，并保留原显式恢复策略。

暖恢复和冷恢复继续遵循原生审批、队列及 interrupted turn 语义。HHPI 不迁移另一个进程的活跃审批，也不重新解释原生 durable queue 的先后关系。`turn/start` 的原生 start-or-steer 行为保持不变。

空白消息现在在恢复前拒绝。原生明确拒绝被记录为 rejected；恢复或发送的回执丢失仍记录为 indeterminate，并保留原 operation ID。跨重连和 adapter 重启不会自动重发不确定的操作。

## 已完成回复的尾部同步

真实 app-server 验证还捕获了一个已有竞态：原生已发出 `turn/completed`，但 HHPI 没有产生 `turn/end`。可控 RPC 回归确认，`thread/read` 先返回 idle、紧接着的 `thread/turns/list` 仍是空页或仅含更早的已完成轮次时，一次刷新会消费 dirty 标记；空闲来源随后停止轮询，遗漏本轮的正文收尾。

来源现在保留待同步的完成轮次。收到完成通知后，持续读取原生尾部，直到对应终态 header 和 item 页都已接纳，再发布结束事件并清除待同步项。仅看见 turn/start 不再被当作已索引的终态边界。完成通知也把持久化 checkpoint 标为 building，避免重启采用尚未完成的缓存；同步完成后，空闲来源停止轮询。

## 客户端状态与输入框

接受的 history metadata 同步更新 canonical session、当前 face 和列表。catalog 请求记录开始时的观察序号；响应仅可覆盖请求期间没有收到新 history observation 的来源。能力变化无需依靠秒级 `updatedAt` 排序，迟到响应中的遗漏也不能把已恢复来源重新标为 offline。

官方 composer 的 admission 现在订阅 HHPI 状态。来源 offline 或 `send=false` 时禁用提交并显示原因；能力恢复时移除本插件自己的限制。其他插件拥有的限制、每个 Pane 的草稿和既有 HAPI durable-send 行为保持原语义。恢复能力本身不提交任何草稿。

## 回归与验收

本次运行使用 Node 24.22.1、固定官方 DSH 0.2.1-rc.3 扩展以及独立安装的 Codex 0.165.0。新增测试均使用合成内容；未向生产会话发送消息。

- 源端 adapter 与真实 WebSocket 握手：23 项通过，其中 adapter 12 项、握手 11 项。adapter 测试仅在原生 RPC 边界提供可控 fixture；握手测试启动真实 loopback WebSocket。覆盖同 ID 恢复、明确拒绝、回执丢失、重启去重、版本边界以及读取无写入。originator 内伪造版本、伪 OS 信息和完整伪 native 前缀的三个反例也完成红转绿。
- canonical 能力与 catalog 竞态：4 项新增用例完成红转绿；与既有操作、目录用例合计 17 项通过。用受控 Promise 产生迟到响应，相同 `updatedAt` 下仍可区分新观察。
- composer admission：相关 9 项通过。新增 2 项在旧实现分别命中应禁用和应保留其他插件限制的行为断言。
- 官方组件 DOM：5 项通过，约 6.4 秒。桌面与手机模拟 DOM 中挂载生产 admission，验证真实发送按钮随能力禁用/恢复、双 Pane 可见草稿保留、恢复不写入，并保留六段历史阅读断言。jsdom 不证明真实布局或软键盘行为。
- 完成事件与落后历史页：2 项通过。虚拟轮询和受控 Promise 分别返回空页、仅更早的终态页，随后确认目标 turn 的最终正文与唯一结束事件可见；同步结束后继续推进 5 秒虚拟时间，没有多余读取。两例在旧生产逻辑下均命中实际结束事件数量 `0 != 1` 的断言。
- 真实 Codex app-server：2 项全部通过，0 跳过，总计 6.721 秒。原有创建、8 轮发送、流式正文、6 页历史、steer、interrupt 用例通过；新增双进程用例确认另一个 writer 存活时得到真实 `-32600`，原进程退出后按同一 thread ID 恢复。新旧用户正文和助手正文各 2 条，重复提交只启动 1 次新 turn，读取、分页和 follow 没有恢复执行。仅外部模型 Responses HTTP 是合成边界，原生进程、存储与跨进程文件锁均为真实实现。

- `npm run check` 全部通过：Host、Client、体验测试类型检查；1,974 项 Node 测试通过、0 失败、3 项可选集成跳过；35 项组件测试通过；6 项注入故障均命中指定行为断言；完整构建成功。Node 阶段 141.29 秒，组件阶段 15.50 秒。默认跳过的真实 Codex 已按上一项单独执行；未修改的官方 federation 集成由发布后的 CI 单独开启。
- `npm run test:history`：5 项通过，7.415 秒，覆盖连续补页、往返、工具密集段和重叠/不相交尾部区间。

- 真实 Chromium 141.0.7390.37 浏览器：限定的两条场景全部通过，桌面 35.406 秒、390×844 手机视口 53.888 秒，各自低于 60 秒上限。每条包含连续 13 段实际滚动输入、阅读锚点、已缓存区间往返、双 Pane 草稿、官方键盘合成发送以及 Codex pretty 展示；页面错误和意外外网请求均为 0。使用官方组件与合成源，未连接线上站点。物理手机、系统 IME、软键盘和截图视觉复核未执行。

## 发布范围

`HHPI backend contract` 现在也由 `main` push 触发，并安装与其他检查一致的官方扩展和测试缓存目录。该 workflow 单独安装固定 Codex，执行真实 app-server 的发送、分页、steer、interrupt 及双进程 writer 交接用例。

当前工作环境没有线上 Host/Runner 配置、服务或部署目标。代码发布及 CI 不能证明截图中的线上站点已经更新；生产部署、线上只读历史验收和物理手机/软键盘检查需分别记录结果。
