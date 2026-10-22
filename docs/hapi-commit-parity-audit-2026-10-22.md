# HAPI 提交目的与 hapi-dsh 对照审计

基线：HAPI `55166cf8d87814ccfb383b538a8e8c55283bed81`；hapi-dsh `d628377`。这是后续修复前的快照。

按用户更正，以首个 hongwen000 提交 `61ab8968` 为起点，不按作者过滤。主线区间 `61ab8968^..55166cf8` 共 **171 个提交**，包含 Shinn、机器人和合并提交。逐项记录目的；合并提交不当作另一项功能。未合入分支和 stash 另列。HAPI 的未提交工作树未纳入基线，也未修改。

方法：核对提交说明、变更文件与 diff，并对影响职责判断的实现读取当前调用路径。下表“已有对应接入路径”表示源码存在对应能力，不表示每个历史竞态均已在真实设备复现通过。未运行浏览器；用户给出的截图也是现存体验问题证据。不能将本报告解读为 171 项生产验收全部通过。

## 本轮修复进展

以下 G1–G5 保留的是审计时的基线问题；本轮代码已补上这些适配路径，设备体验仍由用户手测。

- G1：公开 execution 投影保留容量恢复阶段、次数、等待时间及原因，在 Pane 状态入口显示；取消走原 Session.cancel / 原生 Agent，不另建重试器。
- G2：将 Edit、MultiEdit、CodexPatch、apply_patch、Write、Read、read_file、Grep、ripgrep、Glob 映射到实际注册的官方工具组件，并解包 PowerShell 命令。保留源错误和输出；只含路径的 patch 不伪造旧内容或已应用 diff。
- G3：官方文档侧栏和产物预览增加文字选区引用。先按源会话保存待引用内容，再通过官方 insertText 和 draftRev 追加，保留已有附件和引用。未挂载或忙碌时保留待插入内容。普通预览器未公开版本时明确标为 not reported；产物使用已有版本字段。PDF 区域、Office 单元格及代码行范围仍依赖官方公开选区接口，不能把文字选区等同完整格式化选区。
- G4：由适配服务反查显示 seq 对应的原始消息 ID，书签按源会话身份保存；跨 display generation 用原始消息重新定位。保留旧书签解析。未取得源映射的节点仍只能按原显示位置恢复；DSH 编辑器内部字符位置不在本插件中重写。
- G5：`b1ec203` 已发布移动布局第一批。收起桌面侧栏占位、保留单行 Pane 标题、合并底部 Pane/Window 导航，并压缩 composer 操作行；没有运行浏览器验收。
- 输入法组合期间 Escape 不再关闭本插件的模型弹层和 Pane 状态面板。

本轮逻辑测试使用源协议 fixtures、真实固定版本 DSH Session / SlotCore 和纯函数；不将其报告成端到端或真机验收。性能部分仍需独立记录实际测量，不能由本轮功能补齐推导达标。

## 属于适配层的明确缺口

### G1 原生容量恢复的用户可见状态缺失

HAPI `4b9039a2` / `cd58ebfa` 的后台重试仍由原 Runner 负责，不能在 hapi-dsh 再建重试器。缺的是接收并展示 `capacityRecovery` 的阶段、次数、等待和取消能力。

证据：HAPI `shared/src/schemas.ts` 的 NativeRuntimeStateSchema 含 capacityRecovery，`web/src/components/AssistantChat/CapacityNotice.tsx` 消费它；hapi-dsh `src/codex/projection-types.ts` 的 execution schema 没有该字段，客户端也没有对应消费者。入口解析虽然 passthrough，最终展示协议仍会丢失它。

### G2 原生工具到官方组件的语义适配尚不完整

hapi-dsh `src/client/source-command-view.tsx` 只为六类 shell 别名注册官方 Bash 组件。`CodexPatch` / `apply_patch` 虽有名称常量，但没有对应专用注册。原生投影 `src/codex/projector.ts` 保留原工具名称和原始 JSON，因此“可以看到原始结果”不等于已映射成官方补丁、搜索等结构化视图。

HAPI `c88d53fd` 的原生工具详情和 `2a1e907e` 的命令结果解析更完整。`6eb74668` 还能解包 PowerShell 启动包装；当前 `source-command-model.ts` 只解包少量 POSIX shell argv。需要补参数／结果映射，继续使用官方工具组件，不能重新造一个泛用工具渲染器。各工具以真实发布的 slot 和数据契约为准；不能把不存在的专有组件当成已有。

### G3 文档选区到原会话草稿的语义桥未实现

HAPI `d38a9f09` 的 `web/src/documents/selectionDrafts.ts` 能保留源文件、版本、行号／单元格／页码／区域和引用文字，先加入草稿而非直接发送。hapi-dsh 已有源文档预览、授权下载、编辑和相对路径，但未找到对应结构化选区引用链路。

缺口是把官方预览器公开的选区事件绑定到正确的源会话和草稿。PDF／Office 渲染、编辑器选区算法属于官方组件，不应复制 HAPI 的整套文档渲染器；无公开选区接口的格式应列为上游接口依赖，而非私自补丁。

### G4 阅读状态跨显示代际不完整

当前 `src/client/reading-anchor.ts` 仅保存 key／seq／offset；`reading-view.ts` 用 host、pane、display session ID 作存储键。显式消息导航可以沿源消息定位，但普通阅读锚点不能可靠迁往新的 display generation。HAPI 的 `0fb37bf6` 还支持代码字符级位置。

适配层应负责稳定源身份与锚点迁移。代码编辑器内部字符定位及触摸尾部跟随由官方 DSH 负责；不能为追求 HAPI 完全相同的内部算法修改 DSH。此前文档已说明公开事件缺少可靠映射，这一限制要如实保留，不能用合成事件测试宣称已完成。

### G5 移动 workspace 布局仍不合格（用户新截图确认）

手机仍常驻桌面侧栏；Pane header 换行；Pane 与 Window 导航叠两层；composer 工具行多次换行，正文被挤窄。这是本插件自己的 shell／CSS／slot 组合问题，不能推给 DSH Web。相关历史目的来自 `1ae47c24`、`ce1a7ab9`、`5e4970fb`。需要修布局组合，保留官方输入框和可用触控入口。

## 有实现但不能宣称已经达标

- 生产加载／长会话性能：已有共享 graph、受限预热和隐藏引用释放；`d628377` 修复了 trace 证明的同步重入冻结，但不代表可见长 turn、Host CPU／内存、冷启动、13 Pane 恢复均达标。适配层的同步循环、投影成本和引用管理归本项目；官方可见内容虚拟化不应私改。
- 外观和手机键盘／旋转：默认 glass、滑杆、独立 Pane header 已有实现；最新截图说明移动效果不合格，不能以构建成功关闭。
- 原生异步问题、审批、队列已有持久化与对账；真实插话、附件编辑、操作回执的设备端体验尚未逐项验收。不能再写成完全没实现，也不能把单元测试等同生产验收。
- OS Push 和跨设备跳转已有入口，真实设备验收仍开放。
- 原生与普通 DSH 执行所有者不同。团队／自动授权／Ralph／worktree 等插件不能仅凭前端开关注入 Codex 执行。

## 已有对应路径，不应再次列作缺失

| 能力 | hapi-dsh 当前证据 |
|---|---|
| 全源目录、原生历史和双身份 | `src/client/native-library.tsx`、`src/hapi/native-library.ts`、`src/client/source-discovery.tsx` |
| 账号、Home、启动 Key Profile、迁移 | `src/client/native-library.tsx`、`src/client/new-session.tsx`、`src/client/source-history.tsx`、`src/hapi/native-launch-options.ts` |
| Fork 的持久回执和丢响应对账 | `src/hapi/native-control.ts`、`src/client/native-control-state.ts`、`tests/codex-controls.test.ts` |
| 已读／手动未读跨设备同步 | `src/workspace/read-sync.ts`、`src/workspace/sidebar-state.ts` |
| Recent／文件夹语义位置和列表虚拟化 | `src/workspace/sidebar-bookmarks.ts`、`src/workspace/sidebar-range.ts`、`src/client/ui.tsx` |
| tmux 布局、移动 W/P、焦点会话窗口名 | `src/client/ui.tsx`、`src/workspace/presentation.ts` |
| 原生 Goal、模型、effort、权限 | `src/client/native-library.tsx`、`src/client/native-controls.tsx`、`src/client/native-composer.ts` |
| 草稿／附件／引用保留与交接 | `src/client/composer-autosave.ts`、`src/client/draft-handoff.ts`、`src/client/draft-handoff-receiver.tsx` |
| 原生队列取消确认后编辑 | `src/client/source-queue.tsx`、`src/client/source-queued-edit.tsx` |
| 文件编辑与源地址／相对链接 | `src/client/source-file-actions.tsx`、`src/client/source-markdown.tsx` |
| 预览转换独立于原文件下载 | `src/client/artifact-preview.tsx` |
| 终端游标与断流恢复、手机按键 | `src/client/workbench-model.ts`、`src/client/source-terminal/` |
| DSH 外部子代理记录 | `src/client/source-dsh-child.tsx`、`src/hapi-agent/subagent-controller.ts` |
| 一键发布 | `scripts/deploy.mjs`、package.json 的 deploy／deploy:host |

## 不该重复实现的部分

DSH 官方 Conversation 的 Markdown、Process 分组、普通消息／工具布局、输入框编辑与自动增高、普通 DSH 队列、插件管理、通用文档渲染和可见内容虚拟化由 DSH 负责。适配层负责把真实源数据和状态映射进去，以及自身布局、导航、持久化和授权路由。

Windows Rust 宿主、原生管道、Qoder／DSH ACP 执行、容量恢复、原生迁移执行、安全分享网关继续由已有 HAPI 后端负责。Android／iOS 壳的签名、原生更新和 WebView 设置不属于 hapi-dsh 插件。依赖更新／测试维护／发布文档不逐一移植为产品功能。

## 主线逐提交清单

“混合／待核对”保留多功能提交的范围；它不是全缺失。G1–G5 详见上文。每条链接指向实际 commit，便于查看完整 diff。

| # | Commit | 目的 | 对照结论 |
|---|---|---|---|
| 1 | [61ab8968](https://github.com/dqtz5vpvj9-create/hapi/commit/61ab8968b634b437b5de5b9d304ec7591dee7fff) | 把原生 Codex 子代理归入父会话，并提供子代理历史入口。 | 已有对应接入路径 |
| 2 | [ab8330fb](https://github.com/dqtz5vpvj9-create/hapi/commit/ab8330fbde796529a9671263255644bae3af415a) | 把原生子代理后端安装到实际运行快照，避免源码有功能而运行包缺模块。 | 原 HAPI 后端负责，继续复用 |
| 3 | [db37f01e](https://github.com/dqtz5vpvj9-create/hapi/commit/db37f01e1d12295f5483db2d9fa5307e280d11c0) | 以原生 Codex 活动时间排序会话，避免旧 Hub 时间造成 Recent 错序。 | 已有对应接入路径 |
| 4 | [06f30c31](https://github.com/dqtz5vpvj9-create/hapi/commit/06f30c31bc34a355a0bdfdb9060c68f2b387a626) | 向每个绑定会话发布原生活动时间，避免同源绑定不同步。 | 已有对应接入路径 |
| 5 | [20d5652e](https://github.com/dqtz5vpvj9-create/hapi/commit/20d5652ef862ae3d6e39cabb98e370d9b8be23cf) | 集中保存原生连接、历史、队列、权限以及 WebUI 改进，形成后续拆分基线。 | 混合功能，部分细节／体验仍待核对 |
| 6 | [aa3ae5ec](https://github.com/dqtz5vpvj9-create/hapi/commit/aa3ae5ec2d4d28fe2db59550d0ce6ef1754ee21e) | 整合分页历史、原生会话恢复和独立 Goal 控件，修复停止及消息对账链路。 | 混合功能，部分细节／体验仍待核对 |
| 7 | [64ab894a](https://github.com/dqtz5vpvj9-create/hapi/commit/64ab894a3be8dfcd8d6e52d25969d49e3680d3d6) | 打通原生多模态资源协议、授权读取和生成图片内联展示，并同步移动端协议。 | 已有对应接入路径 |
| 8 | [ebda1b15](https://github.com/dqtz5vpvj9-create/hapi/commit/ebda1b15c60c473cf28d414c02f445945c1891a7) | 为终端加入可配置手机按键、组合键、触摸和选区交互。 | 已有对应接入路径 |
| 9 | [938b4b92](https://github.com/dqtz5vpvj9-create/hapi/commit/938b4b924b749a5ab8f51f42e47d1a46bc49cdcb) | 加入 Codex glass 外观、响应式主题入口与阅读位置保护。 | 混合功能，部分细节／体验仍待核对 |
| 10 | [8cd47a34](https://github.com/dqtz5vpvj9-create/hapi/commit/8cd47a34ac76b88576f1b9d60be3b4ffbc1e463f) | 显示真实执行状态、活动工具及运行定位，同时保持阅读锚点。 | 混合功能，部分细节／体验仍待核对 |
| 11 | [1ae47c24](https://github.com/dqtz5vpvj9-create/hapi/commit/1ae47c24b80c225d586d7e4343f94a6b6db4fec7) | 压缩手机 composer 与列表布局，整理 Goal、模型、权限、附件及发送入口。 | 混合功能，部分细节／体验仍待核对 |
| 12 | [88ea01e9](https://github.com/dqtz5vpvj9-create/hapi/commit/88ea01e97358e57dfa92cb1b0e2681da5899c360) | 把文件、项目终端、diff 等工具组织到响应式 workspace，保留聊天状态。 | 已有对应接入路径 |
| 13 | [cbe6fc4b](https://github.com/dqtz5vpvj9-create/hapi/commit/cbe6fc4b17ccf5cd9b7e1b6fe5082fe5c27a6d57) | 让旧 Fork 从自己的 rollout 读取历史，避免误读父线程。 | 原 HAPI 后端负责，继续复用 |
| 14 | [cdcb12a8](https://github.com/dqtz5vpvj9-create/hapi/commit/cdcb12a854a0816c20e053d9016329ce4ef49e67) | 用 Windows 计划任务监督原生 Codex 与 HAPI 后台进程。 | 原 HAPI 后端负责，继续复用 |
| 15 | [1e12fbfc](https://github.com/dqtz5vpvj9-create/hapi/commit/1e12fbfc00a74f42b59c60184b4e7ad5f096a0fa) | 同步原生标题，并恢复保存过的线程。 | 已有对应接入路径 |
| 16 | [c24c1b58](https://github.com/dqtz5vpvj9-create/hapi/commit/c24c1b58580753a2439d8fa41e0f24798fc1e50c) | 为原生历史增加分页搜索和 HAPI／原生双身份显示。 | 已有对应接入路径 |
| 17 | [5f618198](https://github.com/dqtz5vpvj9-create/hapi/commit/5f618198a82601b6046132281f89bb9907ff51ac) | 整理 Codex 桌面导航和正文阅读布局。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 18 | [72ce7163](https://github.com/dqtz5vpvj9-create/hapi/commit/72ce71630b318da7aab83f05a9f89e40ca6f40e9) | 进一步收拢桌面导航、机器筛选及浮动控件。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 19 | [46c80a5e](https://github.com/dqtz5vpvj9-create/hapi/commit/46c80a5e31c5889c11c09dae320c046ef775215d) | 恢复流式桌面正文宽度，消除布局约束导致的空间浪费。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 20 | [59eba809](https://github.com/dqtz5vpvj9-create/hapi/commit/59eba809ee6bc02eb7d255595f3c6eb275d58065) | 将 glass 标题收敛为会话名与设备名。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 21 | [4294edb6](https://github.com/dqtz5vpvj9-create/hapi/commit/4294edb68bb59d088d6e07ff6109f4719238b25b) | 建立原生执行、workspace、文档和终端的共享协议契约。 | 已有对应接入路径 |
| 22 | [14c55fc5](https://github.com/dqtz5vpvj9-create/hapi/commit/14c55fc5f940591cbbcfbbab533fb53320fe49f1) | 减少 Windows 阻塞式进程探测，修正机器活跃判断与原生目录读取。 | 原 HAPI 后端负责，继续复用 |
| 23 | [2e493eaa](https://github.com/dqtz5vpvj9-create/hapi/commit/2e493eaa372b9e7dda9dd169a3e9a16d98b37b83) | 保留线程／轮次／工具身份和异步问题语义，修复中断及历史元数据。 | 已有对应接入路径 |
| 24 | [b4386db5](https://github.com/dqtz5vpvj9-create/hapi/commit/b4386db5e50de47108a7f75fc1dffeb2fb342d52) | 建立由机器持有、可独立于聊天视图存活的终端基础设施。 | 已有对应接入路径 |
| 25 | [ce1a7ab9](https://github.com/dqtz5vpvj9-create/hapi/commit/ce1a7ab95b68d31a0b614d0e9ac3df33207ed62f) | 加入同步的 tmux 窗口／Pane、导航、受限视图生命周期和移动控件。 | 已有对应接入路径 |
| 26 | [7e8383e0](https://github.com/dqtz5vpvj9-create/hapi/commit/7e8383e0cb617e3cfaa4b7ec72b4db2f9668d0ba) | 整理原生消息投影、滚动协调、历史窗口和预热，稳定初次展示。 | 混合功能，部分细节／体验仍待核对 |
| 27 | [d38a9f09](https://github.com/dqtz5vpvj9-create/hapi/commit/d38a9f098c626cbf8da85b0a5b5ccd0ae6b7b085) | 加入文档 Pane、版本检查编辑、多格式预览及选区提问草稿。 | 缺口 G3：文档选区到源草稿 |
| 28 | [dfa2ad25](https://github.com/dqtz5vpvj9-create/hapi/commit/dfa2ad251407ed8ea886cba18dccd306e7d8029e) | 修整模型／Goal、异步答案草稿、附件跨 Pane 和媒体布局。 | 已有对应接入路径 |
| 29 | [c5a1adc7](https://github.com/dqtz5vpvj9-create/hapi/commit/c5a1adc7d9665bc44ec81a14f271accc193bb54f) | 记录交付边界与未完成项，补历史和 workspace 回放工具。 | 工程／测试／文档，不是产品缺口 |
| 30 | [f2f7168c](https://github.com/dqtz5vpvj9-create/hapi/commit/f2f7168c5006a59fe00dfa3a59db66e806ca51a0) | 完善安装引导、离线诊断、SQLite 备份恢复及路由懒加载。 | 混合功能，部分细节／体验仍待核对 |
| 31 | [0c471cbd](https://github.com/dqtz5vpvj9-create/hapi/commit/0c471cbd1193bd148a57bb8a09232d4395d36051) | 恢复 Fork、插话及暂存列表的异常路径，避免重复发送和确认竞态。 | 已有对应接入路径 |
| 32 | [f25ce655](https://github.com/dqtz5vpvj9-create/hapi/commit/f25ce655c07070e8365ca2318b52ccb3d1e97ac6) | 将 Codex 命令压成单行摘要，详细结果留在展开区。 | 缺口 G2：工具语义适配不完整 |
| 33 | [1beac515](https://github.com/dqtz5vpvj9-create/hapi/commit/1beac5153350ca8fc3c70cc718e49fc57ecb8380) | 让 tmux 成为持久显示模式，并修复可移植 CI 测试。 | 已有对应接入路径 |
| 34 | [51178180](https://github.com/dqtz5vpvj9-create/hapi/commit/51178180bb3079bc43e37a8271be25628f0570f0) | 新增独立的代理工作流桌面／手机回归套件。 | 工程／测试／文档，不是产品缺口 |
| 35 | [6eb74668](https://github.com/dqtz5vpvj9-create/hapi/commit/6eb746689a89fa10b1fe97cbc8208531bba36331) | 补充 PowerShell 等命令摘要解析，并加强 UI 属性测试。 | 缺口 G2：工具语义适配不完整 |
| 36 | [8cbd64ce](https://github.com/dqtz5vpvj9-create/hapi/commit/8cbd64ce0f89bc9d2f13ae4c8e96a0897a81188a) | 让并发文档保存测试接受任一合法获胜者，同时要求另一写入冲突。 | 工程／测试／文档，不是产品缺口 |
| 37 | [f74e4046](https://github.com/dqtz5vpvj9-create/hapi/commit/f74e404656d7e45d94311861db2e00dc79958ab5) | SSE 恢复存在缺口时重新读取暂存列表。 | 已有对应接入路径 |
| 38 | [ccb319d8](https://github.com/dqtz5vpvj9-create/hapi/commit/ccb319d89354f616fab34d458d0119a8165db581) | 防止断线后的旧队列响应覆盖更新的实时队列状态。 | 已有对应接入路径 |
| 39 | [feb5fe9c](https://github.com/dqtz5vpvj9-create/hapi/commit/feb5fe9caf3a87eb0a574a273f4757a6b032b2fe) | 为重连队列读取加生命周期与取消，防止旧请求持续污染新状态。 | 已有对应接入路径 |
| 40 | [12b114ef](https://github.com/dqtz5vpvj9-create/hapi/commit/12b114ef6ab7f22fb3cb164bab49d859f598cd94) | 保证短屏上的 Codex 会话选择对话框操作按钮可见。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 41 | [9c7568e6](https://github.com/dqtz5vpvj9-create/hapi/commit/9c7568e6560562ac3af29ea8be85fb95a179f404) | 避免重复写入无变化的阅读书签和存储状态。 | 混合功能，部分细节／体验仍待核对 |
| 42 | [a23e9ece](https://github.com/dqtz5vpvj9-create/hapi/commit/a23e9ececa797803be48abde6a63db1338eb5954) | 保留的 workspace 重新显示时同步虚拟列表偏移。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 43 | [f26544fd](https://github.com/dqtz5vpvj9-create/hapi/commit/f26544fd2cd9f2764be05f5024f20f84945d6712) | 原生视口程序化导航后同步虚拟列表观察器。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 44 | [8ece654a](https://github.com/dqtz5vpvj9-create/hapi/commit/8ece654ae823686562888251f6b1d79cc620828e) | 将 Recent 根会话虚拟化，限制滚动时挂载范围。 | 已有对应接入路径 |
| 45 | [a1d178bb](https://github.com/dqtz5vpvj9-create/hapi/commit/a1d178bbe61da05012c549f571c5a0ca5b17b47c) | 显式重排会话后保留首个可见会话的位置。 | 已有对应接入路径 |
| 46 | [b2975af6](https://github.com/dqtz5vpvj9-create/hapi/commit/b2975af693f9ad09fd666f3bff2d6015bed4f187) | 保留可移植的 Recent 浏览器回归及性能分析工具。 | 工程／测试／文档，不是产品缺口 |
| 47 | [6fd0a66b](https://github.com/dqtz5vpvj9-create/hapi/commit/6fd0a66b0938211d04ffffbd394154ac6624b642) | 滚动时复用未变化的 Recent 行内容。 | 已有对应接入路径 |
| 48 | [81af6674](https://github.com/dqtz5vpvj9-create/hapi/commit/81af66743b99911994eddcea913307f319d8f56c) | 让会话行共享持久化已读快照，减少重复读存储。 | 已有对应接入路径 |
| 49 | [4ec89cf6](https://github.com/dqtz5vpvj9-create/hapi/commit/4ec89cf69b6886a15d200c38b93ac4fbf9ab8293) | 减少 Recent 滚动时重复测量外边距。 | 已有对应接入路径 |
| 50 | [11c5382b](https://github.com/dqtz5vpvj9-create/hapi/commit/11c5382bb8a7208725e9d78541a8bfffb09e7292) | 其他标签清空本地存储后重新同步未读状态。 | 已有对应接入路径 |
| 51 | [4a1a65cf](https://github.com/dqtz5vpvj9-create/hapi/commit/4a1a65cf52d700390692011eab16cb1e1b722694) | 打开保存的原生历史时重新连接原 Codex 会话。 | 原 HAPI 后端负责，继续复用 |
| 52 | [a2150ef2](https://github.com/dqtz5vpvj9-create/hapi/commit/a2150ef272f13df2f84e23018ff77bebe3d0965b) | 统一原生执行、活动时间和跨设备已读状态，避免旧补丁覆盖新事实。 | 已有对应接入路径 |
| 53 | [1c0cf831](https://github.com/dqtz5vpvj9-create/hapi/commit/1c0cf831e921292c1ca1ef90be04b9b3f5d662af) | 合并 fork/main 的 Recent 与聊天可靠性修复。 | 合并记录，不重复计算功能 |
| 54 | [325abda5](https://github.com/dqtz5vpvj9-create/hapi/commit/325abda535edbad7336f4a43fa31302fe267a20e) | 新增有界长历史夹具和可复现构建，区分合成结果与生产性能。 | 工程／测试／文档，不是产品缺口 |
| 55 | [390fa4ae](https://github.com/dqtz5vpvj9-create/hapi/commit/390fa4ae31db430dca0aae297fbeb455645d32bf) | 复用不变的会话成员和运行层级投影，降低列表父级刷新成本。 | 已有对应接入路径 |
| 56 | [2e3741aa](https://github.com/dqtz5vpvj9-create/hapi/commit/2e3741aac192e455e4df7b4edf1e119249f34ccc) | 原生聊天跳过不再使用的旧渲染数据预处理。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 57 | [1d577268](https://github.com/dqtz5vpvj9-create/hapi/commit/1d577268cf5a1bfc8d84888dcbf92d2c40be17f5) | 批量 Recent 快照下仍保留远端手动未读标记。 | 已有对应接入路径 |
| 58 | [b9c37697](https://github.com/dqtz5vpvj9-create/hapi/commit/b9c37697ac2c90363be509ebd346bdee81d3e3b8) | 保存长历史测量流程，并将辅助脚本契约纳入 CI。 | 工程／测试／文档，不是产品缺口 |
| 59 | [936a3ac7](https://github.com/dqtz5vpvj9-create/hapi/commit/936a3ac76844e96d0590ef06c049e361ce5a81cf) | 历史尚未到达时保留用户开场滚动意图，布局就绪后只消费一次。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 60 | [e15a127e](https://github.com/dqtz5vpvj9-create/hapi/commit/e15a127e793c6d3b6af15c5d01d1e4b0d812762f) | 继续合并 fork/main 的历史、列表及性能修复。 | 合并记录，不重复计算功能 |
| 61 | [8a3ed6b8](https://github.com/dqtz5vpvj9-create/hapi/commit/8a3ed6b8fc90b978290b01f0c21b5165776ef6ef) | 防止 Windows 原生管道耗尽导致会话掉线。 | 原 HAPI 后端负责，继续复用 |
| 62 | [fc259963](https://github.com/dqtz5vpvj9-create/hapi/commit/fc259963dac0026c20eaaf971316b032bcc8b016) | 记录 fork 整合与生产发布验证证据。 | 工程／测试／文档，不是产品缺口 |
| 63 | [610a0f64](https://github.com/dqtz5vpvj9-create/hapi/commit/610a0f6445b0310a9f97ced1df77dbfd212fe78d) | 隐藏视口不再依据几何信息预取历史。 | 已有对应接入路径 |
| 64 | [9257ffac](https://github.com/dqtz5vpvj9-create/hapi/commit/9257fface6964a24c8570ad1129b91a56c073ad8) | 增加历史延迟加载回归，并纳入预取布局 CI 检查。 | 工程／测试／文档，不是产品缺口 |
| 65 | [f56997ed](https://github.com/dqtz5vpvj9-create/hapi/commit/f56997edb8a31ecc3825bba0aba363c6ff54ffe3) | Recent／文件夹视图之间恢复语义会话位置，而非仅复用像素偏移。 | 已有对应接入路径 |
| 66 | [c50547bf](https://github.com/dqtz5vpvj9-create/hapi/commit/c50547bf88ae142276ee244aa615a2ca9a07a344) | 让标准会话列表也显示未读结果。 | 已有对应接入路径 |
| 67 | [67d5bbc1](https://github.com/dqtz5vpvj9-create/hapi/commit/67d5bbc1cc33e0267803fcdf40a6e550f13b88c3) | 加入 Windows Rust 后台宿主，替代较重的常驻启动链。 | 原 HAPI 后端负责，继续复用 |
| 68 | [1651d58d](https://github.com/dqtz5vpvj9-create/hapi/commit/1651d58dcfb8b1de571fef8eaeecc7af3cf64c12) | 记录 Rust 宿主生产资源收益与尚存恢复缺口。 | 工程／测试／文档，不是产品缺口 |
| 69 | [c10cb7a7](https://github.com/dqtz5vpvj9-create/hapi/commit/c10cb7a7a2c7599dd29ae0da8146ebf1d4940717) | 未读／运行筛选按主会话计数，避免子代理放大数量。 | 已有对应接入路径 |
| 70 | [c87d0129](https://github.com/dqtz5vpvj9-create/hapi/commit/c87d0129217e7b92a2e3dc680e81ad0539140c72) | 原生 Fork 请求使用紧凑响应，避免一次搬运完整历史。 | 原 HAPI 后端负责，继续复用 |
| 71 | [b6b52fb8](https://github.com/dqtz5vpvj9-create/hapi/commit/b6b52fb8a311867174485234c096a74725561b06) | 持久化原生 Fork 操作回执，支持迟到结果、重连对账和显式恢复。 | 已有对应接入路径 |
| 72 | [1c8e58f2](https://github.com/dqtz5vpvj9-create/hapi/commit/1c8e58f26a59bd19b021a811708b2ca659b8e181) | 保存文件后使旧读取失效，防止旧内容反向覆盖成功保存。 | 已有对应接入路径 |
| 73 | [9082210e](https://github.com/dqtz5vpvj9-create/hapi/commit/9082210e8bb7e8c755d21e18c5944972331c6ec4) | 确认取消后使旧队列读取失效，避免已取消消息复活。 | 已有对应接入路径 |
| 74 | [1d4849af](https://github.com/dqtz5vpvj9-create/hapi/commit/1d4849aff9312c66d027a0c528cefb66ec31b8d3) | 终端按 epoch／游标续传，避免重复回放，并显示不可恢复的缺口。 | 已有对应接入路径 |
| 75 | [233ba76c](https://github.com/dqtz5vpvj9-create/hapi/commit/233ba76c446b7b046b6bf1cd2027631b1357da5f) | 关闭分享预览后取消过期的图片操作与完成回调。 | 已有对应接入路径 |
| 76 | [5aed19e1](https://github.com/dqtz5vpvj9-create/hapi/commit/5aed19e145d4c1f34fd1a82d755a89a2e70f7f0f) | 连同展开的子会话一起虚拟化，限制大树 DOM 数量。 | 已有对应接入路径 |
| 77 | [b250b928](https://github.com/dqtz5vpvj9-create/hapi/commit/b250b928c5898e46f735439331e130a15404009e) | 嵌入式文件 diff 返回原进入视图。 | 已有对应接入路径 |
| 78 | [ef57f30d](https://github.com/dqtz5vpvj9-create/hapi/commit/ef57f30d106dc1f37405ce05d8099fea71831b37) | 展示源确认的 Fast 状态与语义化会话颜色。 | 已有对应接入路径 |
| 79 | [b83095d3](https://github.com/dqtz5vpvj9-create/hapi/commit/b83095d3a243f292373fcc8a082caffdec373755) | 隐藏文件不执行高亮，并限制大文件自动高亮成本。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 80 | [4b9039a2](https://github.com/dqtz5vpvj9-create/hapi/commit/4b9039a231c84b2bbe8d709dd755587bb72698ff) | 容量失败按有界退避恢复，并续接原生 Goal；界面显示重试阶段及取消入口。 | 缺口 G1：容量恢复状态 |
| 81 | [3038ccdc](https://github.com/dqtz5vpvj9-create/hapi/commit/3038ccdced53c09a5e1f392931a91b56eacd866c) | 离线／重连／更新横幅出现时仍保证导航可访问。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 82 | [5b921007](https://github.com/dqtz5vpvj9-create/hapi/commit/5b921007296f15089958871fb8b96ea038ce01a0) | 跨会话导航保留权限操作 pending，直到源事实确认。 | 已有对应接入路径 |
| 83 | [cd58ebfa](https://github.com/dqtz5vpvj9-create/hapi/commit/cd58ebfa36ab5f6af2e7c483dfc1c756a7421b5a) | 同一轮接受新输入后恢复容量重试资格，避免旧取消状态永久抑制恢复。 | 缺口 G1：容量恢复状态 |
| 84 | [616dcc3a](https://github.com/dqtz5vpvj9-create/hapi/commit/616dcc3a5cf36a5a2671ee3a92bfcd77ea1893d1) | 无法直接预览的文件链接转到文件管理器并定位目标。 | 已有对应接入路径 |
| 85 | [6cca0019](https://github.com/dqtz5vpvj9-create/hapi/commit/6cca00196ec299706d5531e62a53fac63f18c737) | 重做紧凑新任务 composer，并用持久创建回执保证首次发送可恢复。 | 已有对应接入路径 |
| 86 | [f913205a](https://github.com/dqtz5vpvj9-create/hapi/commit/f913205a796d916d38c0faa5a6e7378fe8c06dbc) | 将 CLI 的 ws 升级到 8.21.0。 | 工程／测试／文档，不是产品缺口 |
| 87 | [2d14a428](https://github.com/dqtz5vpvj9-create/hapi/commit/2d14a42806c2db84448b7e7b1c6be4f3aa4f1d31) | 安排 Bun 依赖更新，并为依赖变化建立 UI 回归流水线。 | 工程／测试／文档，不是产品缺口 |
| 88 | [04f36a8a](https://github.com/dqtz5vpvj9-create/hapi/commit/04f36a8ae1efa815b9177237f3e9dae866edd19c) | 更新 React、React DOM 及对应类型依赖。 | 工程／测试／文档，不是产品缺口 |
| 89 | [170d0612](https://github.com/dqtz5vpvj9-create/hapi/commit/170d0612a047550f98389c88c803a7ddf1e6beb1) | 更新 assistant-ui 相关包。 | 工程／测试／文档，不是产品缺口 |
| 90 | [4a7a47de](https://github.com/dqtz5vpvj9-create/hapi/commit/4a7a47de2d2146eb6d36f0a37127f42546534a5b) | 更新 Radix UI 组件依赖组。 | 工程／测试／文档，不是产品缺口 |
| 91 | [2cfc7ffa](https://github.com/dqtz5vpvj9-create/hapi/commit/2cfc7ffaa750b48c3191b0a7f58ed365eef0c929) | 更新 Tailwind 及构建插件。 | 工程／测试／文档，不是产品缺口 |
| 92 | [24e27aa2](https://github.com/dqtz5vpvj9-create/hapi/commit/24e27aa2c239c17238e53e02480945d42e50dacf) | 更新 TanStack Router 依赖组。 | 工程／测试／文档，不是产品缺口 |
| 93 | [b3d3ecbd](https://github.com/dqtz5vpvj9-create/hapi/commit/b3d3ecbd2949632d2ae86247ba52912badeb3e48) | 更新 vite-plugin-manus-runtime。 | 工程／测试／文档，不是产品缺口 |
| 94 | [0d6839d8](https://github.com/dqtz5vpvj9-create/hapi/commit/0d6839d8a105f1f490b80e7e91722e13501e9f6d) | 更新 Playwright 测试依赖组。 | 工程／测试／文档，不是产品缺口 |
| 95 | [7c952304](https://github.com/dqtz5vpvj9-create/hapi/commit/7c952304f0b84da4dbf2690124fafa16980a4eb7) | 升级 tailwind-merge 到 3.7.0。 | 工程／测试／文档，不是产品缺口 |
| 96 | [6a3b7187](https://github.com/dqtz5vpvj9-create/hapi/commit/6a3b71874286f98de03bbcdb6f82b7d8fa2130d2) | 升级 workbox-window 到 7.4.1。 | 工程／测试／文档，不是产品缺口 |
| 97 | [96b698e7](https://github.com/dqtz5vpvj9-create/hapi/commit/96b698e75a91fb812e49d3c6a50f3bc6312aca25) | 升级 Vitest 到 5.0.4。 | 工程／测试／文档，不是产品缺口 |
| 98 | [3b4a544f](https://github.com/dqtz5vpvj9-create/hapi/commit/3b4a544fcb4624247bbf21e5c34b1baeb8afc0c9) | 合并 ws 依赖升级。 | 合并记录，不重复计算功能 |
| 99 | [4968ab06](https://github.com/dqtz5vpvj9-create/hapi/commit/4968ab065881f6f804f756f7c78928b71ddf0fe8) | 合并 React 依赖组升级。 | 合并记录，不重复计算功能 |
| 100 | [5516358e](https://github.com/dqtz5vpvj9-create/hapi/commit/5516358e188d9957a67833f4260908039dacc40d) | 合并 assistant-ui 依赖组升级。 | 合并记录，不重复计算功能 |
| 101 | [b98660f5](https://github.com/dqtz5vpvj9-create/hapi/commit/b98660f59e7fa3c78e644b595530391246abca9e) | 合并 Radix UI 依赖组升级。 | 合并记录，不重复计算功能 |
| 102 | [13ba61ae](https://github.com/dqtz5vpvj9-create/hapi/commit/13ba61aeae1f92c04c0639ffc6cd9bd1b2d01fd3) | 合并 Tailwind 依赖组升级。 | 合并记录，不重复计算功能 |
| 103 | [a3f1acdc](https://github.com/dqtz5vpvj9-create/hapi/commit/a3f1acdcf64a0c5e8f3a74c27bc2774a0831fc07) | 合并 TanStack Router 升级。 | 合并记录，不重复计算功能 |
| 104 | [79c6d041](https://github.com/dqtz5vpvj9-create/hapi/commit/79c6d04110e8c091da79808624d1e98a1ac619f1) | 合并构建插件依赖更新。 | 合并记录，不重复计算功能 |
| 105 | [06fb9841](https://github.com/dqtz5vpvj9-create/hapi/commit/06fb98417726c8530231fa396f2304147873c513) | 合并 Playwright 升级。 | 合并记录，不重复计算功能 |
| 106 | [cad39250](https://github.com/dqtz5vpvj9-create/hapi/commit/cad39250faafe245343d377752ab882a1a8ed300) | 合并 tailwind-merge 升级。 | 合并记录，不重复计算功能 |
| 107 | [e250c43b](https://github.com/dqtz5vpvj9-create/hapi/commit/e250c43bea4c51f5857b4d02012dc0679a0d95f3) | 合并 workbox-window 升级。 | 合并记录，不重复计算功能 |
| 108 | [3c6469c4](https://github.com/dqtz5vpvj9-create/hapi/commit/3c6469c4c4e3ccdfe6086ed5a3a0d203e3efa498) | 合并 Vitest 5.0.4 升级。 | 合并记录，不重复计算功能 |
| 109 | [04f8106c](https://github.com/dqtz5vpvj9-create/hapi/commit/04f8106cc1c1c89eff53e185dd47859c2b690b63) | 整理工作区依赖锁，并延续本地 UI 补丁。 | 工程／测试／文档，不是产品缺口 |
| 110 | [f72cc057](https://github.com/dqtz5vpvj9-create/hapi/commit/f72cc05751cc49ce2d3c76b2a9c9d6c00efe7a3a) | 附件菜单关闭时仍保留文件选择器，避免选择中途被卸载。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 111 | [2c283a24](https://github.com/dqtz5vpvj9-create/hapi/commit/2c283a249505cf4650c52136da687ab1c73752c4) | 修正 Pi 压缩完成后模型缺省状态的测试断言。 | 工程／测试／文档，不是产品缺口 |
| 112 | [dbd5d7dc](https://github.com/dqtz5vpvj9-create/hapi/commit/dbd5d7dca2d2f4b5efd9852ac99a10946a9aaf88) | 使工作集基准与新的窗口标签语义一致。 | 工程／测试／文档，不是产品缺口 |
| 113 | [ca049b88](https://github.com/dqtz5vpvj9-create/hapi/commit/ca049b88540d16d5a59ce8b1d2a915c690966692) | 清除失效旧实现，同时保留仍有效的回归测试及原生运行链路。 | 工程／测试／文档，不是产品缺口 |
| 114 | [2a1e907e](https://github.com/dqtz5vpvj9-create/hapi/commit/2a1e907e8aaeab75584a6ccd5345f6e83e38f11f) | 提供命令摘要、内联详情和输出头尾预览，规范失败结果解析。 | 缺口 G2：工具语义适配不完整 |
| 115 | [59aaaf54](https://github.com/dqtz5vpvj9-create/hapi/commit/59aaaf546b1fe842da888cbbb8b9b343848e9a9f) | 合并旧代码与测试审计。 | 合并记录，不重复计算功能 |
| 116 | [0313bb50](https://github.com/dqtz5vpvj9-create/hapi/commit/0313bb50b38f72074764c8da0f30bbd536c1657c) | 合并命令摘要和详情展示。 | 合并记录，不重复计算功能 |
| 117 | [7763a568](https://github.com/dqtz5vpvj9-create/hapi/commit/7763a56873b85bf061a3eba82086fba023a90e77) | 加入复用 Web UI 的 Capacitor 移动壳与原生附件能力。 | 原生移动壳负责，不是本插件职责 |
| 118 | [6e6b3113](https://github.com/dqtz5vpvj9-create/hapi/commit/6e6b3113c82cefed4a7e0bb916d36bdb8b800212) | 移动壳通过原生 Web 更新保留 Update HAPI，并保护更新前草稿。 | 原生移动壳负责，不是本插件职责 |
| 119 | [0fb37bf6](https://github.com/dqtz5vpvj9-create/hapi/commit/0fb37bf6e14376b7acc2cc8559adcf8146c9eab4) | 重载或 Pane 重排后按代码字符位置恢复阅读，防止旧编辑器注册干扰。 | 缺口 G4：阅读位置映射 |
| 120 | [742ba115](https://github.com/dqtz5vpvj9-create/hapi/commit/742ba115abeceff65622989d25c0c89f7ac3edf1) | 合并 Capacitor 移动壳。 | 合并记录，不重复计算功能 |
| 121 | [7d52055c](https://github.com/dqtz5vpvj9-create/hapi/commit/7d52055cb7e3ca1ccfe028a912564300e749d779) | 使 CI Android 签名与本地安装一致，避免无法覆盖升级。 | 原生移动壳负责，不是本插件职责 |
| 122 | [4112582f](https://github.com/dqtz5vpvj9-create/hapi/commit/4112582f1a76fba72e6d3dc9f633b891262f3619) | 移动壳加载配置的网站，不再内置一套独立 UI。 | 原生移动壳负责，不是本插件职责 |
| 123 | [138469f4](https://github.com/dqtz5vpvj9-create/hapi/commit/138469f4056137ede2f16eb1c149daf8396bb95c) | 加入排队附件预览，并修正 Android 文本缩放。 | 混合功能，部分细节／体验仍待核对 |
| 124 | [c88d53fd](https://github.com/dqtz5vpvj9-create/hapi/commit/c88d53fd97fa737cd3ddf1bac1992674c059f3e1) | 加入文件工作台、安全文件操作和草稿恢复，丰富命令／补丁／搜索／子代理信息。 | 缺口 G2：工具语义适配不完整 |
| 125 | [5cdc1d02](https://github.com/dqtz5vpvj9-create/hapi/commit/5cdc1d02e63deff9b0247707e2aa4282ce6c8df8) | 命令浏览器测试跟随头尾预览规则。 | 工程／测试／文档，不是产品缺口 |
| 126 | [aad58d7f](https://github.com/dqtz5vpvj9-create/hapi/commit/aad58d7f5b7b11f316de4e5e4e01c2db4d176e88) | 合并文件工作台与原生代理详情。 | 合并记录，不重复计算功能 |
| 127 | [a9d5037d](https://github.com/dqtz5vpvj9-create/hapi/commit/a9d5037d29acff573f817105b91e58d971e662ee) | 简化手机文件导航和文档工具条，保留上下文操作与草稿。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 128 | [ecfe61a0](https://github.com/dqtz5vpvj9-create/hapi/commit/ecfe61a05f1530142997caaf8616e02036f55777) | 合并手机文件工作台布局修正。 | 合并记录，不重复计算功能 |
| 129 | [4e7bff2e](https://github.com/dqtz5vpvj9-create/hapi/commit/4e7bff2eb9ab0ce1a9b0182dfa331fd66c341d80) | 按官方 ACP profile 启动 DSH，并解释代理可用性与配置优先级。 | 原 HAPI 后端负责，继续复用 |
| 130 | [64904a13](https://github.com/dqtz5vpvj9-create/hapi/commit/64904a13f5ea10e375d105ec0af761620e4ea226) | 合并 DSH 官方启动器与可用性诊断。 | 合并记录，不重复计算功能 |
| 131 | [4fcc70b5](https://github.com/dqtz5vpvj9-create/hapi/commit/4fcc70b5edcdc97738754dd06386f598936d7be0) | 从 UI 恢复已归档 DSH 会话时正确取回源会话 ID。 | 已有对应接入路径 |
| 132 | [b5204aac](https://github.com/dqtz5vpvj9-create/hapi/commit/b5204aac8b028cadbce4de3b40d9fc4f538b41f7) | 加入 Codex Homes、账号／Key Profile 和原生线程迁移及相应入口。 | 已有对应接入路径 |
| 133 | [c1d798f0](https://github.com/dqtz5vpvj9-create/hapi/commit/c1d798f0266455f8fbc7d1531462b17726d57bcb) | 加强 DSH ACP 控制、bundle 管理和子代理历史／操作支持。 | 已有对应接入路径 |
| 134 | [2fdd51e1](https://github.com/dqtz5vpvj9-create/hapi/commit/2fdd51e1196b139642eec51a4816db6863363ae8) | 加入 Qoder 引擎类型、启动器和模型目录。 | 原 HAPI 后端负责，继续复用 |
| 135 | [ecde857f](https://github.com/dqtz5vpvj9-create/hapi/commit/ecde857f287f389260f4e0dbe53624ce231646ec) | 增加受 namespace／权限范围约束的分享网关与辅助工具。 | 原 HAPI 后端负责，继续复用 |
| 136 | [51b30c20](https://github.com/dqtz5vpvj9-create/hapi/commit/51b30c2066d5e1a884d783ec531a1d293731cad2) | 同步 Windows 宿主改进和原生移动客户端代理目录。 | 原 HAPI 后端负责，继续复用 |
| 137 | [6dda2fa6](https://github.com/dqtz5vpvj9-create/hapi/commit/6dda2fa6f577af9d6ec23438f43a88dba228328b) | 建立生产部署计划、来源管理和发布脚本。 | 工程／测试／文档，不是产品缺口 |
| 138 | [087abf72](https://github.com/dqtz5vpvj9-create/hapi/commit/087abf72cc2cf37bb7cb78be09f58224d1314b8a) | 统一多引擎远端启动生命周期、传输及机器文件处理。 | 原 HAPI 后端负责，继续复用 |
| 139 | [018e8175](https://github.com/dqtz5vpvj9-create/hapi/commit/018e817579ecc0af5a1c3d6d62a43a7bc524c90d) | 增强目录选择、工具名、子代理、批量会话操作、附件及 PWA 导航。 | 混合功能，部分细节／体验仍待核对 |
| 140 | [40d390b1](https://github.com/dqtz5vpvj9-create/hapi/commit/40d390b13bf3648c3455251393e02f839245deb0) | 修复文件管理提示和模型选择器禁用语义。 | 已有对应接入路径 |
| 141 | [7e235e2c](https://github.com/dqtz5vpvj9-create/hapi/commit/7e235e2cbed4359669e35b3907201396aff4558d) | 懒加载 Home 迁移对话框，使首包维持构建预算。 | 工程／测试／文档，不是产品缺口 |
| 142 | [de9ab38e](https://github.com/dqtz5vpvj9-create/hapi/commit/de9ab38e7ae62a379440069f7d118f4eaa70d154) | 补缺失文案、修正模型控件和 Service Worker 导航，并稳定测试。 | 混合功能，部分细节／体验仍待核对 |
| 143 | [b08026c5](https://github.com/dqtz5vpvj9-create/hapi/commit/b08026c54349b4576fcd3505253d4760546f27dd) | 补齐 Service Worker 导航辅助函数类型。 | 工程／测试／文档，不是产品缺口 |
| 144 | [10fc78db](https://github.com/dqtz5vpvj9-create/hapi/commit/10fc78db40e644a11bb02718d7e7414e2a79b3b5) | 给原生历史向前读取测试足够完成时间。 | 工程／测试／文档，不是产品缺口 |
| 145 | [f5ab361a](https://github.com/dqtz5vpvj9-create/hapi/commit/f5ab361a4f67a32005a895af034047fb1b9dc28a) | Office 原文件下载不再等待预览转换完成。 | 已有对应接入路径 |
| 146 | [8e0e5263](https://github.com/dqtz5vpvj9-create/hapi/commit/8e0e5263f0e20dfd257eb66be2a5413c8eb37504) | 使迁移恢复、停止会话与 provider／model 更新严格绑定正确所有者。 | 原 HAPI 后端负责，继续复用 |
| 147 | [e7d3a985](https://github.com/dqtz5vpvj9-create/hapi/commit/e7d3a98524042bfd1ca387773135c1afc042435d) | 修复 ACP 取消与重试竞态，并防止子代理请求在丢响应后重复执行。 | 原 HAPI 后端负责，继续复用 |
| 148 | [299c1be3](https://github.com/dqtz5vpvj9-create/hapi/commit/299c1be389319b5c4f4b4a37331d03c2e4b54ee0) | 机器／Home 切换时校正账号选择，保留显式默认选择并清除无效账号。 | 已有对应接入路径 |
| 149 | [3f411a40](https://github.com/dqtz5vpvj9-create/hapi/commit/3f411a4094d81095fcd91c3d9db059bdd95897cc) | 折叠已完成 DSH 命令，只突出当前执行命令。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 150 | [25cca669](https://github.com/dqtz5vpvj9-create/hapi/commit/25cca6699864220574c14b3d44d09251bfcfd737) | Qoder 默认选择账户有权限的模型，并解释无权限错误。 | 原 HAPI 后端负责，继续复用 |
| 151 | [5c738d57](https://github.com/dqtz5vpvj9-create/hapi/commit/5c738d57ffcdd6796b152a4f684652be55dc8082) | 通过 ACP config option 切换 Qoder 模型，而非不支持的 set_model。 | 原 HAPI 后端负责，继续复用 |
| 152 | [3d5a3a92](https://github.com/dqtz5vpvj9-create/hapi/commit/3d5a3a92118271a5df6158c79b87ba0ed6cb9344) | 发布模型目录前保存用户启动意图，避免默认模型覆盖显式请求判断。 | 原 HAPI 后端负责，继续复用 |
| 153 | [d37af329](https://github.com/dqtz5vpvj9-create/hapi/commit/d37af329c54195eeab206905932c9ac2f8dd8876) | 没有最近目录时默认机器 Home／workspace root，并解释无法创建原因。 | 已有对应接入路径 |
| 154 | [e2544f80](https://github.com/dqtz5vpvj9-create/hapi/commit/e2544f8027987a3de7aef892ff0eb02ba13d1d43) | 部署预检正确遵守 skip-windows。 | 工程／测试／文档，不是产品缺口 |
| 155 | [adc23a3a](https://github.com/dqtz5vpvj9-create/hapi/commit/adc23a3af426210e3253f8469211b863f3d99638) | 显式展示新建会话的引擎、模型、权限、机器、目录和会话类型。 | 已有对应接入路径 |
| 156 | [f692c419](https://github.com/dqtz5vpvj9-create/hapi/commit/f692c41921c6efda3a0a11377261a58341b36f3c) | 收紧新建会话控件的布局、字体与响应式尺寸。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 157 | [879ebb4f](https://github.com/dqtz5vpvj9-create/hapi/commit/879ebb4f80d58a230b94c1d4aad21559a2ce0a7e) | 从父日志重建外部临时子代理的任务和结算记录，使其有可查看历史。 | 已有对应接入路径 |
| 158 | [d4f2cd4b](https://github.com/dqtz5vpvj9-create/hapi/commit/d4f2cd4bc16e4359686602692ad205afd3dbe035) | 记录外部子代理部署与生产验证。 | 工程／测试／文档，不是产品缺口 |
| 159 | [a07da096](https://github.com/dqtz5vpvj9-create/hapi/commit/a07da0962bda1d3fe2e0704aee27f220bd50eca6) | 把已完成 DSH 轮次的工具过程折叠为 Process，保留答案和待处理控件。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 160 | [455ec0fd](https://github.com/dqtz5vpvj9-create/hapi/commit/455ec0fd0cd1f1dcede250cd49ec281f05c9e6fd) | 运行中的 Process 也维持折叠，并保留用户展开状态。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 161 | [50f33fee](https://github.com/dqtz5vpvj9-create/hapi/commit/50f33fee4525e1f6e91793df5da504c64642250b) | 允许不填初始任务创建空会话，避免发送空消息。 | 已有对应接入路径 |
| 162 | [292e3551](https://github.com/dqtz5vpvj9-create/hapi/commit/292e35519e88238cbc99af1338d4ab50e1040b65) | 文档内相对路径基于当前文件解析，并在阅读器旁打开目标。 | 已有对应接入路径 |
| 163 | [44921517](https://github.com/dqtz5vpvj9-create/hapi/commit/449215173209a1e856b0980bbf1d29f0d7dff477) | 为桌面列表增加刷新入口，复用已有拉取及重排逻辑。 | 已有对应接入路径 |
| 164 | [a847aed2](https://github.com/dqtz5vpvj9-create/hapi/commit/a847aed2e4cce4388a7e4984db7fcb92664b30c0) | 把思考过程从工具 Process 中分离，保留独立实时行。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 165 | [dbae48cf](https://github.com/dqtz5vpvj9-create/hapi/commit/dbae48cf0c932a44fdc7f30fd63d18e730b000cd) | 每轮只形成一个 Process，并与思考行对齐。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 166 | [1bdbb780](https://github.com/dqtz5vpvj9-create/hapi/commit/1bdbb780f3142aa0f109f51506f30a0001c518d5) | 压缩思考和 Process 的行高及间距。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 167 | [5e4970fb](https://github.com/dqtz5vpvj9-create/hapi/commit/5e4970fb23f218193361bb59a3224e5731d9c5ba) | 窗口标签显示焦点 Pane 会话名，手机显示 W／P 位置并保持当前窗口可见。 | 已有对应接入路径 |
| 168 | [f3c658e9](https://github.com/dqtz5vpvj9-create/hapi/commit/f3c658e9f446a78f42c0d93535ccb9eb68095e20) | Process 单行显示最新工具摘要，并覆盖缺失 flavor 的旧会话。 | DSH Web／官方组件负责，不移植旧渲染器 |
| 169 | [0f8ef697](https://github.com/dqtz5vpvj9-create/hapi/commit/0f8ef6970884c92fb2ddca3070be2ec56cb50333) | 记录窗口标签语义的发布证据。 | 工程／测试／文档，不是产品缺口 |
| 170 | [e684e9d9](https://github.com/dqtz5vpvj9-create/hapi/commit/e684e9d9b511dc1b8a63349bf557dd7d5bfbcd61) | 用活动轮次事实维持思考的实时状态，避免后续工具／答案使其提前静止。 | 混合功能，部分细节／体验仍待核对 |
| 171 | [55166cf8](https://github.com/dqtz5vpvj9-create/hapi/commit/55166cf8d87814ccfb383b538a8e8c55283bed81) | 触摸底部时不误退出跟随；只有真实跳转才取消，尾部书签仍视作跟随态。 | DSH Web／官方组件负责，不移植旧渲染器 |

## 当前 refs 中未合入主线的后续提交

这些是待合并分支的工作，不把它们算作当前 HAPI 已交付功能。

| Commit | 目的 |
|---|---|
| 1ff887a7 | 为 DSH 修复准备隔离的离线测试工作区。 |
| 08b318d0 | 将每个离线测试产物限制在 90 MiB。 |
| fe79a8ca | 更新 MCP server 与 e2e 依赖。 |
| 9aed71cc | 更新 Mermaid。 |
| 03ececdc | 更新 pnpm。 |
| 77b7b696 | 更新 lucide-react。 |
| 78ab16ae | 更新 grammy。 |
| 171a0033 | 更新浏览器语言检测依赖。 |
| 26c782a3 | 更新 Radix UI 依赖组。 |
| 660a143f | 更新 react-day-picker。 |
| a2528d04 | 更新 React Query devtools。 |
| 7b60664f | 更新 ws 及类型。 |
| f051f82c | 更新 socket.io。 |

## 最初作者检索还发现的旧分支对象

以下 4 个对象未纳入当前主线，和主线是否已有等效修复要分开判断；不据此宣布线上缺陷。

| Commit | 目的 | 边界 |
|---|---|---|
| 7dcc88b7 | 失败的停止请求允许重试。 | 原生停止适配需保留失败可重试；普通 DSH 交互属于官方。 |
| 0e75bc2f | Escape 先关闭 composer 设置，再考虑停止运行。 | 本插件新增的 popover 也应遵循该交互，待独立核对。 |
| 58faa21e | 一轮结束后清除过期停止错误。 | 以源执行事实驱动，不应永久显示过期错误。 |
| 4a7f1549 | 输入法组合期间 Escape 不触发 composer 设置／停止操作。 | 官方编辑器负责 IME；本插件不得添加绕过 IME 的全局拦截。 |

## Stash 和未提交文件

`02ae9cc8` 是 2026-10-15 合并前的工作区 stash；`b928bfd0` 是其 index 快照；`814dde39` 是其未跟踪文件快照。它们不是三项独立发布，不从这些快照推断“功能已经交付”。当前 HAPI 脏工作树的 ACP／连接等改动也不计入。

本次只读审计未替用户合并或修改 HAPI 仓库。后续实现按上文缺口更新独立修复记录，保留本审计基线。
