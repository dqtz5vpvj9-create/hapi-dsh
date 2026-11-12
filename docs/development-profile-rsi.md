# 开发 Agent 的 profile 与 harness 改进

2026-11-08 用户取消 RSI 对照实验。保留 profile、历史结果和基于真实开发证据的流程改进；不再启动父/候选 worker，不再把 S2 作为交付条件。`rsi evaluate` 命令及底层执行函数均已停用。旧运行记录保持历史原貌，当前计划已移除 S2；历史记录只读保留。

## 每次实施的最短路径

### 减少重复验证与完整路径交付

额度中断后的首次修订只处理计划和 harness；用户随后已明确恢复完整 HHPI 产品开发。当前执行采用以下两项改进，不再沿用当时的暂停状态；不增加“缺预算或用量过期就禁止工作”的规则，也不把减少并发当作节约 token 的证据。

**减少重复验证。** 一个检查通过后，只要相关代码、依赖和环境没变，就用原结果。`profile run` 可用 `--kind product-test --check <稳定检查名> --inputs <代码及环境版本>` 记录适用范围：同一检查和版本已通过时返回 `executed:false` 与原 span；正在执行时等待并共享同一结果（包括失败）；连续两次失败后不再原样启动第三次。需要调查时直接读错误、改代码或检查环境；确有重跑理由，用 `--reason` 简述本次要验证的原因，无需用户批准或另写报告。

`inputs` 由执行者据实际修改维护，不能仅用未提交修改期间不变的 HEAD；可用“提交号＋本轮变更编号＋环境版本”。换了相关代码或环境就更新它。此外自动校验命令、工作目录和环境摘要；任一变化使旧结果失效。缺少这些信息时正常执行，但不猜测可复用。该处理只管理包装过的具名检查；裸 shell 命令仍靠执行者遵守同一规则。发布保护照旧，整个发布流程和有副作用的命令不作结果缓存。

**按完整路径交付。** 每批先选一条用户实际要用的路径，把入口、源操作、结果展示和失败后的恢复交给同一负责人；尽早实际走一次最短路径，再完善细节。例如附件是“选择 → 上传 → 发送 → 对话里打开”，文件是“目录 → 打开 → 编辑 → 保存 → 源端读回 → 返回会话”。开发中的组件任务照常结束，进度分别报告“组件完成”和“这条路径可用”，不要求每个小任务重跑整条路径。对应的 `user-workflow` 观察复用同一次实际操作的证据，不为填表重复操作。

这些指令已接入 `profile context`，只返回当前节点及公共检查，减少每个子代理重复读取全局清单。现有任务完成条件不增加新的结项门槛。RSI 对照已取消，不再为评价流程额外运行模型任务。

### 主代理按事件介入

root 负责拆出完整路径、分配唯一写入责任、裁决跨路径冲突、审阅交付结果。子代理负责入口接通、组件修改、源操作和必要验证；I 类集成节点不再一律归 root。没有独立工作时使用原生代理等待，收到完成或真实阻塞再处理；不轮询进度、不反复读整份日志、不重新做一遍子代理实现。进程驻留不等于模型推理，后台采集由普通进程运行。

每次交接只给目标、相关文件与接口、已知失败和可复用证据，返回结果以改动、可用路径和未决问题为主；共享文件仍只有一个写入者。小任务不拆成连续的微型咨询，也不设置常驻审阅代理。保留必要的独立验收，复用仍适用的结果。

旧 run 的 DAG 保持开工时的定义；后来决定交给子代理时，root 用显式指派记录负责人，不改写历史 `executor`。正在运行的节点须先由当前负责人登记 `blocked` 并交还实际资源；已完成节点不能重新指派。指派本身不领取节点，实际领取仍检查依赖、起止门槛、文件/资源冲突和并发槽位。`profile context` 显示最新指派，原始 DAG 仍可查，审计保存于 `task-assignment` span，不改变 blocked 等待时间。

```sh
node scripts/development/cli.mjs profile task --run delivery-001 --node I6 --assign reader-agent --agent root --reason "原负责人已交还运行环境，阅读路径整体交接"
node scripts/development/cli.mjs profile task --run delivery-001 --node I6 --state running --agent reader-agent
```

指派与状态转换是两个独立动作；原负责者不能代替新负责者完成任务。需再次交接时，仍先退出 running，由 root 重新指派并保留前一负责人记录。

### 把确定性工作交还脚本

已接入现有执行入口，具体行为和验收记录见 [开发经验](development-practices.md#本轮验收)：

- `npm run typecheck` 使用实际安装的 TypeScript，保留每项目增量状态，自动核对编译器实际读过的源码、依赖、配置、缺失解析候选及目录；一次返回全部项目诊断。相同请求跨进程共享结果。相关输入变化或状态损坏后失效，检查中输入变化不缓存成功。
- `prepare.mjs` 按固定上游与补丁复用源目录；已有源码被改动或损坏时保留现场，不重置覆盖。可用 `DSH_SOURCE_REFERENCE` 指定现有 checkout 的 git objects，减少拉取。
- `build-extension.mjs` 验证 lockfile、包管理器、Node、平台和依赖实际内容；相同依赖环境共享。保留 TypeScript 增量，源码修改按包依赖闭包重建。普通变化不默认 force；输出损坏、工具链变化或内容变化却保留旧 mtime 时采用必要的强制重建。
- Typert 按保守源码输入集（TS/JSON）失效，生成结果按内容核对；尚未精确缩到最小契约依赖。打包缓存核对产物字节，最后仍生成并校验完整 20 包与来源清单。
- `install-extension.mjs` 将已安装文件与已验证归档逐一核对；相同完整输出跳过 npm install，丢失、损坏、输入变化时重新安装，保留项目 lockfile。构建、安装共用系统持有的互斥锁，进程退出自动释放。
- 失败不当作成功缓存；实际等待同一次执行的调用者共享该次失败，后续调用可正常恢复。发布副作用仍由原发布入口执行。一条路径负责人消费共享产物并完成实际入口检查，root 复用其证据。

开始功能切片时，先创建或续接同一个 run。主 Agent 负责保存这个 run 的 ID、数据库绝对路径和每个子任务的 node ID，交接时一起传递。一个 run 固定开工时的 Git revision、改动文件、DAG、预期行为和策略版本。恢复旧任务使用原 run；采用新策略则开新 run。

```sh
# checks.json 由本切片的可观察行为组成，例：
# [{"requirement":"B0-write-ownership","layer":"review","node":"B0"}]
npm run agent:profile -- start --id delivery-001 --dag docs/hhpi-development-dag.json --checks /mnt/cache/data-cache/checks.json
npm run agent:profile -- next --run delivery-001
npm run agent:profile -- context --run delivery-001 --node B0
```

把 `context` 返回的目标、scope、策略和证据状态交给执行者；模型必须实际读到这些内容，环境变量本身不会改变模型行为。节点名使用当前 DAG 的实际 ID。小修改可以省略 `--dag`，使用默认 `work` 节点，仍应给出所需行为证据。

领取任务用 `task --state running --agent <执行者>`。`context.reporting` 返回所属 agent；给子代理的命令设置该 `HHPI_PROFILE_AGENT`，或在 `profile run` 显式传 `--agent`，普通进程会向下继承它。SQLite 事务会检查依赖、四槽上限、协调者节点、文件和独占资源；完成前检查 finish gates。依赖满足时自动记下 ready 时间。阻塞必须带原因，暂停写入后再标记 blocked，它会释放资源；恢复时重新领取。只有当前执行者能结束或阻塞运行中的节点。调度器给出可领取列表，由现有 Codex subagent 工具负责真正派发；它不会绕过会话中的委派授权。

```sh
npm run agent:profile -- task --run delivery-001 --node B0 --state running --agent root
npm run agent:profile -- run --run delivery-001 --node B0 --label targeted-check --kind product-test --check profile-contract --inputs change-1-node24 --timeout 120000 -- npm run test:changed -- --files scripts/development/profile.mjs
npm run agent:profile -- observe --run delivery-001 --requirement B0-write-ownership --layer review --status passed --evidence artifacts/review/ownership.json
npm run agent:profile -- task --run delivery-001 --node B0 --state done --agent root
npm run agent:profile -- report --run delivery-001 --output artifacts/development/delivery-001.html
```

上面的源码路径和节点是命令格式示例，应替换为实际切片。发布仍走现有 `npm run deploy`，可用同一个 `profile run` 包裹；不会额外跑一套重复发布测试。已有测试运行器会在带 profile 环境时自动记录选测理由、文件清单、阶段耗时和结果，普通调用行为不变。

`finish --status completed` 要求全部节点完成、所需行为通过、没有未结束的 span。缺少设备、浏览器或源端证据时使用 `incomplete`，报告保留未知项。没有 checks 的 run 只表示执行记录完成，不能用来宣称产品验收。gate 的 evidence 是实施者对既有条件的记录，不产生新授权，也不代替原发布程序。

## 观测什么，如何解释

| 记录 | 用途与边界 |
| --- | --- |
| 实际命令 span、父子调用、agent/node | 定位工具、构建、验证和协调的时间；直接 argv 执行，保留退出码、超时与中断，不记录参数、环境或输出内容 |
| 任务 ready、running、blocked、done | 区分依赖尚未满足、已就绪但未领取、显式阻塞；排序采用后继依赖深度，目前没有伪装成实测关键路径估计 |
| 经过时间、span 并集、各类累计时间 | 并发和嵌套不能重复算成交付时间；未观测区间保持未知，不能直接称为模型思考时间或浪费 |
| requirement / layer / evidence / discoveredBy | 分开组件、原生、浏览器和设备结果；支持 independent-review 和 user 来源，交付后可以追加用户补报 |
| 新发现的用户路径 | 开工清单外的实际结果可以直接记录 passed、failed 或 unknown，并追加到覆盖表；有结果须附证据。不得为了登记通过而先编造失败。原清单和历史观察保留，新增路径不能替代原有未完成要求 |
| 版本与策略 | 新 run 读取 active policy；旧 run 保持原版本，比较时能区分策略变化与代码变化 |

`observe` 记录的是有定位依据的观察，并非工具自动证明截图正确。报告给出的重复验证、缺失证据和失败路径只是假设入口，Agent 仍须读相应证据再决定改什么。用户补报次数是观察条数，不能直接当作独立缺陷数量。

需要补充 Codex 工具轨迹时，明确指定当前 run 对应的 JSONL 文件；不会扫描全部会话，也不保存用户正文、推理正文、工具参数和返回内容：

```sh
npm run agent:profile -- import-codex --run delivery-001 --node B0 --file /absolute/path/to/rollout.jsonl --until 2026-11-07T12:00:00Z
```

时间范围必须落在 run 内；边界时间使用实际已完成调用的时间。相同文件与窗口重复导入按 call ID 去重。导入的调用完成只记为 observed，成功与否仍未知。Token 优先按 `token_usage_record.response_id` 去重求和；旧格式退回累计计数差，缺计数或重置时保持未知。reasoning output 属于 output，不再加一次。用量总是覆盖 run 起点至 until，缩小工具窗口不会清零之前用量，导入较旧快照不会覆盖新快照。不推算 Pro 周额度或美元成本。多个 node 共用原始会话时导入到 run 层。数据库、轨迹和报告留在本地，label 和 evidence 也不能包含私密内容。

活动分类按用途填写：产品测试用 `product-test`，构建用 `build`，调查用 `investigation`，类型检查用 `typecheck`、依赖安装用 `install`、生成用 `generate`；历史 RSI 标签只读保留。并发和嵌套只影响时间聚合，不决定类别。旧 `verification` 混有多种活动，保留原记录，不把它的累计占比当作测试占比。看板的“记录跨度”含中断等待；“命令覆盖时长”只对完整命令区间取并集，两者之差不等于浪费。

## 原生日志回填与持续时间采集

`profile collect --run <id> --sources <manifest.json> --once yes` 读入已有 Codex JSONL；去掉 `--once yes` 后持续增量读取。manifest 指定 `sessionsDirectory` 与 `sources: [{file, agent, parent?}]`。来源按会话 metadata 和工作区校验；字节游标只跨过完整记录，重启和重复导入按条目/响应 ID 去重。已登记子代理分开记录，原始命令、提示词、输出和凭据不复制进 profile。

原生 `task_started/task_complete` 提供轮次边界，`item_completed` 提供命令、推理条目、回复、文件操作等生命周期，`token_usage_record` 提供逐响应用量。条目存活期间可能包含等待，轮次跨度也不是模型计算时间。已知额度停顿等用 `profile state --state paused --at <真实时间> --evidence <依据>` 标记；恢复讨论用 `discussion`，产品实施用 `development`。显式暂停从覆盖时间中扣除，即使后台命令对象直到恢复后才收到结束事件；原始起止保留。

看板首页给出已复核的工作归因：具体工作、执行时间、产出和证据。每轮的 `artifacts/development/<run>/work-attribution.json` 保存固定时间范围的归因摘要，逐条索引关联原始 span 与日志偏移。原始命令和会话内容不进入页面。类别按实际执行内容确定，不能沿用混合的 `verification` 标签；同类区间取并集，不把类别间的并行时间相加为总工时。

时间戳覆盖另列在采集详情：有条目记录、轮次内待归属、有依据的暂停、轮次外待归属。四者之和等于选定记录跨度，但“有时间戳”不表示已查清工作内容，更不表示有效产出。后台服务器、隧道存活只证明进程存在；推理条目未关联具体任务时明确保留未归因。不得再用“活动已定位”代替定位结果。

请求级缺口通过 Codex 原生 OpenTelemetry 补采：本机 collector 只监听 `127.0.0.1:4319` 的 `/v1/logs` 与 `/v1/traces`，只接受已登记会话，持久化时间、事件类型和关联 ID；正文、参数、headers 和错误原文被丢弃。配置关闭 prompt/response/tool-result 内容导出。Codex 的 API 请求和 SSE/WebSocket 事件记录用于分析传输等待，不宣称等于服务端推理时间。当前 CLI 的 `timeUnixNano` 可能是 `0`，此时使用 `event.timestamp`，再退回 `observedTimeUnixNano`。

本机 `hhpi-profile-collector.service` 代替原看板轮询器，同时增量导入和更新现有页面。Codex exporter 配置在新进程启动时加载；已有进程未重新启动的请求没有该遥测，不能追溯伪造。原始历史缺少的请求起点、排队/推理分段只能保留未知。依据见 [OpenAI 配置文档](https://learn.chatgpt.com/docs/config-file/config-advanced)。

## 按代理复算时间分布

`profile activity --run <id> --since <ISO> --until <ISO> --output <json>` 直接从已导入的时间戳复算每名代理的轮次窗口、推理条目、命令、后台进程、显式等待、未归属时间以及该窗口的去重 token。每名代理各自求并集；推理条目和命令可能交叠，不能相加成模型工时。没有实际起止的条目计入 unfinished，不补造时间。

后台服务或隧道经命令证据确认后，用 `profile annotate --run <id> --activity <id> --role background --evidence <locator>` 标记；原始记录保留，覆盖时长和代理分布自动排除它。等待同理使用 `wait`，不能凭“运行很久”自动判成浪费。此前已复核的九个常驻进程已接入该机制。新命令继承 `HHPI_PROFILE_AGENT` 和 parent；身份缺失显示 unattributed，不默认归到 root。测试运行器固定记录 product-test，类别另报并集与累计时长。

## 可视化开发与 RSI 进度

`profile dashboard --output <page.html> --plan docs/hhpi-development-dag.json --watch-ms 2000` 持续更新只读看板。默认跟随数据库中最新的开发 run，也可用 `--run` 固定某一轮。进度页包含实际任务与等待、最近调用时间线、行为验收、历史实验、策略谱系和回滚记录；DAG 可切换当前执行和完整产品计划，未关联的计划明确显示为未开始。

页面和相邻的 `.data.js` 一起放在本机受控的静态站点或 Lavish 会话内。使用现有站点访问边界，不把数据库本身发布出去。浏览器每三秒读取快照；没有数据变化时写入器每三十秒更新一次存活时间，超过四十五秒未更新就显示最后记录，避免伪装成仍在线。页面可离线打开查看最后快照，页内没有执行、晋升或回滚按钮。

策略源码、原始轨迹、任务输入不进入页面。进度按数据库中的实际记录显示，确定性示例在独立数据库，不混入项目能力收益。实验执行入口已关闭；流程改进是否有效，由后续真实交付的证据判断。

执行范围改变时保留原始 DAG，用带依据的取消记录解除当前依赖；取消单列，不计为完成。只允许 root 取消尚未运行或已交还资源的任务，`--reason` 和 `--evidence` 必填。当前工作、阻塞和待上线由 `progress` 记录更新；它不领取资源、不改变任务完成状态，也不把构建通过改写为上线。

```sh
node scripts/development/cli.mjs profile task --run delivery-001 --node S2 --state cancelled --agent root --reason "用户取消 RSI 对照" --evidence docs/development-profile-rsi.md
node scripts/development/cli.mjs profile progress --run delivery-001 --title "阅读性能" --node I6 --status waiting --summary "构建完成，待正式性能验收" --evidence artifacts/build.log
```

实际写入器为用户服务 `hhpi-profile-collector.service`；模板修改可原位重新生成 HTML 与 feed，采集器无需重启。首页展示当前工作、具体阻塞、待上线及最新结果，原始任务统计与历史耗时保留在展开项中。

## RSI 历史记录

RSI 实验的 CLI 和 `evaluatePolicy()` 均已停用，直接调用库也不能启动 worker。旧 `evaluations`、`policies`、`promotions`、原始日志和只读看板保留，历史结果比较与回滚兼容继续可读。当前 DAG 没有 S2；旧 run 的冻结 DAG 只表示当时计划，不作为新一轮派工入口。

流程改进直接用于下一批真实工作，依据重复执行数、可用路径、返工和用户补报判断效果。普通脚本行为测试使用本机 fixture，不启动模型对照任务，不把机制测试通过当作产品完整或节省额度的证明。

## 此前 infra 执行记录（2026-11-07，第八次计划修订前）

实际 run 为 `infra-20261107-validation`，采集从启用工具时开始；先前开发时间未回填。默认数据库已导入该 run 对应时间窗的工具调用与累计 token 差值。以下是先前版本的记录，不是本次计划文档或当前线上状态的重新验收；记录保留了发布失败，没有把命令返回或 HTML 生成视为验收通过。

- 发布检查通过类型检查、2127 项 Node 测试、54 项组件测试和既有故障演练；4 项既有可选 Node 测试跳过。新增看板随后通过完整的 10 项 infra 行为测试。完整构建和正式分发打包通过。
- 独立 demo 数据库完成 8 次配对样本执行、晋升、实际采用源码版本及回滚。它是机制演示，不计入真实项目策略效果。
- 当时版本的桌面、390 px 深色手机视口、RSI 二级页和 64 节点 DAG 已通过 webshot 检查并实际看图；浏览器读取了当时的四项通过证据，确认数据刷新。该证据不覆盖本次 66 节点计划图，也不证明物理手机验收。
- 本地实时看板沿用项目 Glass 配色，当时由当前用户的 `hhpi-development-dashboard.service` transient unit 管理；主机重启后须重新启动文档中的 watch 命令。部署地址和会话标识保存在操作者的私有配置中。
- 主站分发安装未完成：官方 registry 的 TLS 连接中断；离线缓存又缺少当前版本的元数据及 supply-chain 检查所需信息。安装器保留旧 active release，未重启 Host。对应日志位于 `artifacts/development/release.log`、`install.log`、`install-offline.log`、`install-locked.log`；后续恢复时仍通过正式安装器和既有发布检查，不降低校验要求。

真实候选 `release-preflight-v1` 已根据上述失败登记，改进发布路径识别与依赖可用性检查；尚未评估或晋升。`baseline-v1` 仍生效。报告、图片、demo 和分发包都在本地忽略目录 `artifacts/development/`，不进入 Git。
