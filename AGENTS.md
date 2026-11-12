# HHPI remote agent access

## Goal

Build HHPI as a distributable remote-agent-access plugin for DSH Web. Current source paths are local ordinary DSH, officially paired remote DSH, and native Codex; other engines need their own source adapter. Preserve one cross-machine sidebar, workspace panes, official DSH Conversation, and each source's execution ownership. The package and technical identifiers remain `hapi-dsh` until an explicit rename task.

Runtime work follows [the current architecture](docs/architecture.md): native DSH uses its original protocol; Codex uses its original app-server and explicit source OS resource owners. HAPI runtime login, Hub APIs, observer/display execution and SessionTerminal compatibility are retired. Read old HAPI material only for offline recovery, source attribution or historical evidence. Preserve original records and exact identity aliases; do not start replacement execution to make a migration appear complete.

## Constraints

- **本次长流程的 DSH 修改授权（用户指令，2026-11-07）**：当前 HHPI 完整交付目标内的所有 DSH 修改均已自动批准，覆盖必要的扩展包及契约调整；实施中不再逐包请求批准。本次目标完成后统一复审全部修改，再恢复下述逐包批准规则。继续记录包、契约、必要性、影响及验证，保留默认路径、ADR、契约测试、上游 PR 草稿、版本归档，以及现有认证、数据安全、原生执行归属和发布要求；该授权不包含向第三方上游推送。
- **DSH 扩展修改须先获用户首肯（2026-11-04）**：先列明具体包、契约和必要性，获得明确批准后再改源码；不得从 HHPI 修复任务推定授权。本次已批准 `session-persistence`、`session-persistence-jsonl` 的可选有界页面、依赖查询与稀疏索引，以及 `session-format-v3-to-v4` 的流式校验入口。2026-11-05 另批准 `client-ui-chat` 的补页几何读写批处理和按需布局测量，须保留官方阅读提交、锚点恢复与 80ms 验收门槛。其他 DSH 包仍需另行批准。批准后的补丁须为通用能力、默认路径不变、可独立关闭，并带 ADR、契约测试与上游 PR 草稿；禁止运行时拦截和修改编译产物。每个上游 rc 一套补丁并存档，Host 与所有 Runner 使用同一套 ext 版本。详见 `dsh-ext` 仓库与 `docs/` 中的 ext 规格。
- 其余情况下优先使用受支持的插件注册、provider、slot 与 profile 配置；不得用补丁绕过认证、审批最终裁决、执行所有权、队列或数据格式。
- Preserve native Codex thread identity, original execution ownership, native queue, final approval resolution, and reconnection semantics.
- Closing a pane releases a view and must not terminate its native execution.
- Keep all engines and machines in one sidebar. Do not use separate machine applications or an iframe per machine.
- **用户信息层级（2026-11-09）**：默认界面围绕用户任务组织。普通工具失败、后台重试、同步、保存回执和恢复账本留在内部或已有过程详情，不另加正文块、横幅、toast 或重复摘要；改成折叠块也不算解决。只有实际影响用户任务或需要用户处理的状态，才在对应消息/入口说明影响与可用动作。
- **原生展示与状态终点**：排队、编辑、插话、审批和过程折叠接入现有 DSH 组件；同一消息在队列到正文之间连续可见，不重复显示“原执行端已保存”等内部回执。每个临时提示必须有具体消失条件，已到达、已接管或已恢复时移除。
- **新增提示、错误处理、恢复 UI 或状态展示前**，执行 [默认界面与恢复状态规则](docs/hhpi-proactive-ui-review.md#ui-state-contract)。判断依据是用户影响与实际下一步，不能因为后端新增一个状态就新增一个 UI 区块；同一功能负责人检查默认画面与恢复后的画面，沿用现有有界验证，不新开手机任务或通用测试矩阵。
- Reuse official DSH Conversation and plugin infrastructure; do not create another generic chat renderer or plugin manager.
- No secrets, user data, installed credentials, or private configuration in source, examples, tests, commits, or logs.
- A claimed integration must execute against the pinned upstream version; tests using fakes must be identified as such.
- The user explicitly authorizes implementation, a new public GitHub repository, and publication of the result. HHPI 可设计自己的远程接入协议，并复用、修改或替换本机 HAPI 相关实现；接入目标是 DSH Web，无需维护 HAPI Web 或兼容其架构。向第三方上游仓库推送仍需另行授权。

## Testing and experience validation (user instruction, 2026-10-27)

- 修改 UI、接入二级面板或声明功能完成前，执行 [UI 交付要求](docs/hhpi-proactive-ui-review.md#ui-delivery-contract)：复用 pinned DSH 基础组件，按用户任务组织默认信息，并由同一功能负责人实际查看受影响界面、检查操作与返回。交互成功与视觉合格分别记录；已有适用证据复用，不按设备复制功能任务。当前停止手机验收与帧率调优，范围以[主计划的最新用户指令](docs/hhpi-product-change-plan-2026-11-07.md)为准。
- 新增或修改测试、选择验证范围、排查测试失败、执行发布 UI 验收前，阅读 [docs/testing.md](docs/testing.md)。方法依据见 [docs/testing-evidence.md](docs/testing-evidence.md)；旧六门禁及已删除的 e2e 命令只作历史记录，不沿用其通过结论。
- 日常采用 `node:test` 单元测试、进程内 Host/HHPI/federation 契约测试，以及 Vitest + jsdom + Testing Library 组件行为测试。浏览器只用于有界的发布体验检查，不恢复整应用 Playwright e2e 或整夜测试流程。
- 开发内循环优先执行 `npm run test:changed -- --list` 检查选测范围，再运行 `npm run test:changed`；跨模块回归用 `npm run test:fast`。未知依赖、配置及锁文件变更按选择器规则回退全量；选测不能代替发布检查。纯文档修改检查内容、链接与 diff，无需重跑代码测试。
- CI 和发布保留 `npm run check`，或发布脚本中等价的类型检查、全量测试和对应构建；相同代码及环境下已通过的检查可复用。测试数量与耗时以本次实际结果为准，不把文档中的历史测量当作承诺。
- 回归测试必须覆盖可观察的失败行为，例如草稿丢失、误发送、迟到响应覆盖、重复操作、跨 Pane 串状态和历史缺口。使用生产组件及状态逻辑，只在远端 RPC、编辑器等明确边界使用 fixture，并说明其范围；通过可控时钟和 Promise 制造竞态，不靠长时间 sleep、实现镜像或大块快照凑覆盖。
- 历史阅读以连续内容和阅读位置为契约：预算内补页保留已读消息；超预算保护所有可见读者；普通增量不触发重连恢复。修改这些路径时运行 `npm run test:history`，并用 `npm run test:faults` 确认已知故障命中指定行为断言。删测注明被替代的行为或已失效的边界，按证据删减，不按数量定额。
- 修改体验测试及其对应保护逻辑时，运行相关行为用例；涉及现有故障演练的保护时执行 `npm run test:faults`，CI 保留该检查。故障必须触发指定行为断言；加载失败、语法错误、超时、未选中测试均不能算检出回归。
- 遵守 runner 的阶段超时，失败后定位原因，不靠重试到绿或延长至整夜来验收。无改动、仅列清单、跳过和未测都明确标为未执行；性能测试串行运行，复用已有环境。
- UI 验收由 Agent 执行，受影响的发布浏览器场景每条最多 60 秒，最多两条；范围按当前用户指令选择，旧手机视口与性能安排不自动恢复。失败保留证据并定位；浏览器不可用或场景未执行时报告未验证，不转交用户代测，也不声称通过。
- 自动与手动翻页共用官方导航、读者提交与位置恢复。历史发布检查执行 `npm run test:smoke:history`：连续六段向上阅读均须获得更早正文，覆盖第二、第三次及继续翻阅；往返检查锚点，再回到底部上滑已加载区间，确认不重新取页。任意失败事件、页面异常、内容跳变或未执行均不通过。原始数据页计数、游标推进、一次滑动和截图不能代替这些结果。
- 截图使用 `webshot` 技能的固定命令，实际查看图片后才能报告视觉结论。会话截图等待同一 Pane 的正文与编辑器出现；工作区外壳出现或截图成功不能证明会话可用。DOM、截图、真实浏览器交互和物理设备结果分别报告，jsdom 不证明布局、真实滚动或软键盘行为。
- 发送、取消、审批与断网仅在合成会话执行，生产探针保持只读；保留认证、数据安全、原生执行及发布保护。

## Complete conversation contract (user correction, 2026-10-24)

- 打开目标以所属来源的真实长会话为基准。第一次目标画面就具备其能力范围内的正文、输入、历史滚动、阅读导航和实时能力；正常补页/同步在同一会话中完成。验证方法和预算以本文件的 Testing and experience validation 为准；`docs/dsh-repair-spec-2026-10-24.md` 保留早期问题证据，不恢复其中已退休的运行链路。
- 打开只有完整可用这一个成功条件。先显示但无法操作、随后不可用、最后才完整的路径直接失败；首次正文、最终恢复、其他会话通过均不能代替本目标验收。现有观察器仍有漏判，新增断言实际执行前不得声称已覆盖。
- 完整可用以来源实际声明的能力为准：合法只读会话必须可阅读和导航，不能因输入框禁止发送而拒绝正文。分别记录正文读取、位置恢复和写入能力的状态；写入错误、目录未齐或可选预取不得撤销已接纳的有效正文。

## Collaboration responsibilities

- 开始 HHPI 功能实施、续接长任务或改进 Agent 工作流时，按 [开发 profile 与 harness 改进](docs/development-profile-rsi.md) 创建或续接执行记录，加载当前任务的策略与 scope，记录实际验证和新增缺口。调度由现有 Agent 工具按完成/阻塞事件驱动；RSI 对照实验已取消，复用经验与执行入口见 [开发经验](docs/development-practices.md)，发布要求保持不变。
- 续接本轮开发前，先读该文的“减少重复验证与完整路径交付”：产品开发已由用户恢复，按一条可用用户路径组织工作，组件完成与产品交付分开；已有适用检查直接复用，重复失败先查原因。用量缺失不阻止开工，不根据缩减并发声称节省 token。

- 修改远程接入、正文读取或 Pane 生命周期前，读取[当前架构](docs/architecture.md)。核对旧数据迁移时再读 [V4 历史记录](docs/source-view-architecture.md)；追溯设计取舍时读[原目标方案](docs/hhpi-remote-access-design.md)。原生 DSH 转发原协议，非 DSH Agent 在源端适配一次，浏览器消费同一官方读者。保持源执行、队列与审批归属，历史改写撤销旧版本读取；回归覆盖消息修订、迟到响应和跨 Pane 行为。
- 调整连续阅读架构时按 [连续历史设计](docs/continuous-history-design.md) 区分消息窗口、展示投影和官方阅读提交；`historySource`/`windowCommit` 只有实际安装、接入并通过契约后才算具备，设计文档或能力声明不能代替接通证据。

- Work only in the files assigned to your task; coordinate shared contracts with the root agent.
- Leave each component typechecked and tested for its meaningful failure modes.
- Keep dependencies exact and record upstream provenance and licenses.

## Immediate publication (user instruction, 2026-10-24)

- 本项目每次修改完成后立即发布到当前线上站点，发布属于任务的一部分；用户已持续授权，无需再次确认。
- 使用与修改匹配且已通过验收的构建，发布后核对线上版本和实际界面。已有历史缺口尚未清零，不是将已验证修复留在本地的理由。
- 保留现有认证、原生执行和发布保护。发布需要时可以重启显示 Host，包括仅前端改动，无需再次确认；重启前检查运行中的普通 DSH 会话，并保留旧构建供失败时恢复。
- 发布或验收失败时继续处理并报告真实状态，明确区分已提交、已上线、已验证和仍未解决。
