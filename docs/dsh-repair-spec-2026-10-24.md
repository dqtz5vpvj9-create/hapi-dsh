# DSH 接手修复与独立验收 spec

本文件是用户要求的执行交接，不是完成报告。用户要求先提交现有代码，再由 DSH subagent 完成后续工作，Codex 阻塞等待并独立验收。当前产品改动只能称为待整体验收；本文件没有授予重启 HAPI Hub、原生执行、修改上游或使用生产源做写入测试的权限。

## 目标与范围

修复 hapi-dsh 全提交审计中仍存在的打开体验、显示生命周期、事件积压和验收盲区，使新鲜正文、稳定标题、可操作输入框及时出现，并保持滚动、草稿、实时消息和原生执行语义。审计基线是 `6d540ca58d7b1b84cdcbe4ab7faeeda416a2bc20` 的 69 个可达提交（66 主线、3 备份独有），不是整个上游 DSH 的历史。逐项记录见三个 `commit-audit-*.md` 分段及 JSON manifest。

首先收敛和验收当前补丁，再处理已访问显示历史的长期留存及完整归档重建成本。不要改回热切换优先，不要用新的占位屏或 loading 动画遮盖延迟。没有证据的历史问题保留为未验证；不得因为任务较大就从最终矩阵中删除。

必读：仓库 AGENTS.md、docs/ui-acceptance.md、docs/memory-breakdown.md、docs/cold-opening-freshness.md、docs/commit-audit-2026-10-24.md、docs/cold-opening-provenance.md。HAPI 的对照约定在 `/mnt/cache/src/hapi/docs/chat-experience-contract.md` 和 `docs/plans/tmux-workspace-implementation.md`；只读查阅，不改 HAPI。

## 工作边界与环境

- 主仓库 `/mnt/cache/src/hapi-dsh`；不要新建 worktree，不覆盖现有改动。
- 候选副本 `/mnt/cache/data-cache/hapi-dsh-rc3-candidate` 是普通目录，不是部署目录。先检查其状态，再从主仓库同步本轮完整源码/测试/配置；必须用绝对源路径，防止把旧文件复制给自己。构建在候选目录进行，不能先覆盖线上正在使用的 dist。
- Node >=24，DSH 及官方客户端固定 `0.2.1-rc.3`；使用现有依赖。不得改 node_modules、打上游补丁、复制自制聊天渲染器或插件管理器。
- 临时文件在 `/mnt/cache/data-cache`。写权限工作目录可设 `/mnt/cache`，但只允许修改主仓库、本任务候选和本任务临时产物，不得修改其他项目。
- 性能、类型检查、构建、GC 实验和浏览器测试串行。后台服务器可以复用；产品/fixture 变化后须重建并重启对应隔离 Host。不要为每条断言重装依赖。
- 不运行生产部署、不改服务配置、不重启 HAPI Hub/Runner/原生线程、不发送真实消息、不停止真实执行。DSH 交付后由 Codex 先验收，再按已有发布流程决定上线。
- 凭据只在进程内使用。不得输出 launch-url、配置文件、带 token 的 URL、原始生产 Host 日志或真实正文。禁止将私有尾页输入加入 Git、截图提交或公开报告。
- 截图必须遵守 `/home/chris/.codex/skills/webshot/SKILL.md` 的固定命令，并逐张实际查看；命令成功不等于视觉验收。不要直接调用系统 Chrome headless。

## 已有补丁：必须复核，不能仅复述此前通过数

### A. 新鲜正文优先

`src/codex/agent.ts` 与 `src/hapi-agent/agent.ts` 现在先读有界最新尾页，再后台补归档；旧缓存仅在源读取失败时作为明确 stale 回退。epoch 不能证明普通追加已同步。要验证同 epoch 新增、变 epoch、历史重写、最新页与缓存无重叠、归档期间实时后缀及读取失败后的恢复。初始网络门应分别控制 metadata、latest page、archive，不能只阻塞同一个请求。

目前 Native 定向 54 项和 observed 23 项曾通过，但并非最终集成全量结果。源不可读时不得把缓存标成最新、在线或 ready；不得清空未确认投递。

### B. 显示代切换与标题

相关代码：controller、federation、surface/session-view、generation-handoff、workspace/presentation。
只有精确同 Hub、同 source session、同 Host/display 基名的换代能复用旧视图。新官方视图先在最终尺寸下准备，旧视图保留为不可操作阅读面；新正文、Session、阅读定位和唯一可操作输入框全部就绪后切换。不能用 opacity=0 或屏幕外 DOM 欺骗 ready。
最多保留一个旧代。关闭、切源、失败、30 秒超时、Host stop、快速连续换代和回滚都须清 timer/observer/RAF/reference；超时是失败收敛，不是 ready。原生执行所有权不能随视图关闭而停止。已知标题不能回退到 Untitled、未命名或内部 ID；真正新标题仍优先。

### C. 草稿所有权

composer-autosave 已修复同源新对象关闭后旧对象失去保存权。重新取得 owner 时不能立即用旧编辑器覆盖较新的备份；只有实际 draftRev 变化才能保存；无变化关闭也不能覆盖。覆盖三代、同源双 pane、不同 Hub 相同源 ID、仅非文本通知、关闭顺序。旧版负对照曾 2 项失败，新版 14 项通过，仍需与换代浏览器用例合并验收。

### D. 设置插件失败重试

deferred-plugins 失败释放 started，成功和进行中仍去重。cold-boot.spec 新增 bootstrap 503、Account script 503 两条真实官方 loader 回归，尚未执行。必须证明失败后无虚假 ready、关闭后不后台重试、重开成功、进行中再重开无重复请求、成功后不重复加载、输入节点与草稿保留且不发送。不能 mock 官方 loader 成功来替代同 rev 失败恢复。

### E. 源事件队列与背压

新增 event-queue；两个 service、HapiClient、transport contract 已改。预算 128 项 / 8 MiB，含 active 项；超大单帧独占但不截断。仅严格同 thread/turn/item、同生命周期/epoch、相同元数据且 localId=null 的相邻未执行累计前缀能合并。终态、审批、回执、工具、生命周期及未知 provider 必须走有序非丢弃路径，不能跨屏障合并。显式 reconcile 也在同一队列；只有尚未开始的同源 reconcile 可以去重。

必须审查预算计算、等待者自身是否另成无界链、source 删除/Host stop/abort 能否唤醒等待者、consumer 抛错后能否恢复、断线重连与 drain 补齐次数。生产 SSE 必须真正 await 背压；等待本地消费者不能被心跳误判为断线；关闭能取消。限制本地队列不等于整个 TCP/服务端链路全局有界，报告必须区分。

已有独立 GC 负对照：1024 个累计快照旧链 269327336 B，新 native 8492424 B、observed 8490672 B。该指标包含约 8 MiB journal，不是整个 Host RSS。29 项 SSE/内存/队列、88 项相关回归、最终 host types 曾通过；最终集成须重新执行相关回归。

## 剩余资源效率修复

1. 审查 source service 中已访问 Agent、Session.log、projector、scope/index 的持有链。没有可见读者时应能释放重型显示数据，保留轻量源状态、原生执行和未决审批/投递事实。采用公开的引用/订阅生命周期，不猜 DOM 存活，也不把 close view 变成 abort execution。
2. 建立明确的显示缓存和在途归档字节预算；数量上限不是字节上限。预算需说明 active view、warm cache、pending work、single oversized item 分别如何处理。禁止丢正文、截断工具输出、提高 Node heap、定时重启来“解决”内存。无法在官方 API 边界内安全释放的部分必须给出具体持有者和剩余风险，不假称已解决。
3. 全归档不能阻塞最新正文与交互；不要一次同时保留所有 raw rows、完整投影、序列化副本及旧/新 Session。按页和字节限制在途工作，让交互/可见窗口优先。异步/Worker 只有真实降低主线程阻塞才算收益，搬走任务不等于降低总内存。
4. 设计真实生命周期重复实验：固定规模语料，多次打开/关闭不同源，保留一个活动源持续增量，再重新打开已关闭源并验证完整内容、阅读位置、草稿、审批/回执与实时补齐。记录自然状态、独立 GC 后留存、RSS、heap/external、实例与队列计数；这些口径不能相加。重复周期后应进入预算平台，不能随曾访问会话数量增长。用原机制或注入关闭释放失败作负对照，避免空 fixture 或未真正 attach 的“低内存”。
5. 至少运行覆盖此前约 14.4 分钟 OOM 时间窗的隔离持续流式与打开/关闭压力实验，并记录每次采样/重启/错误；短期平台也不能声明生产长期 OOM 已消失。

## 必须执行的验收矩阵

以 docs/ui-acceptance.md 现有数值为门槛，不调宽阈值来过关。稳定数据集冷打开从真实导航或正常 sidebar 点击开始计时；cache/Host/浏览器状态分别标明。每个新失败先保留原始报告，再修复；重试不能覆盖失败记录。

| 场景 | 必须观察 | 错误通过的禁止替代 |
| --- | --- | --- |
| Native 与 observed 冷打开 | 旧 cache、最新尾页、阻塞全归档、新鲜正文+可用编辑器、同源标题、放行后至少 5 秒稳定 | 任意旧正文、骨架、提前 attach、热切换、只看最终 DOM |
| 换代 | 旧正文不消失、只一可操作编辑器、草稿/焦点/锚点、失败和 rollback 释放 | 隐藏/透明节点存在就 ready；30 秒超时算成功 |
| 实时 | 六次增量在完成前出现，逐次延迟 <1500ms；读旧消息不拉回；初始/刷新归档竞争无漏无重 | 只核对最终回答 |
| 分页 | 桌面真实 wheel 三路径、手机 earliest 四路径；同一旧节点每帧漂移 <=2px；普通静止 <=1px | 最终恢复、换一个可见节点、手动 dispatch scrollend |
| 手机 | 360/390 宽无溢出，顶部 pane 栏 0 高，单 pane 不显示 P1，底栏有返回，输入 <=160px、底栏 <=52px | viewport resize 冒充物理手机或 Chrome 刷新验收 |
| Settings | 两类 503 失败→关闭→重开，官方同 rev loader 真恢复，无重复/草稿丢失 | 只测试布尔门闩或 fake sync |
| 事件压力 | 合并条件/屏障、所有非合并事件顺序、128项/8MiB上限、取消/失败/重连/权威补齐 | Map.size=1、丢事件、仅 helper 不穿过真实 service/SSE |
| 内存 | 大正文与多源周期、关闭释放、持续流式、自然/GC/RSS分别报告 | 磁盘当 RAM、shallow 当 retained、短样本证明长期不 OOM |
| 视觉 | 每次关键操作后的 webshot 图实际逐张看，列出内容/输入框/底栏/工具/弹层问题及修复 | 截图命令 exit0 就写已检查 |
| 来源审计 | manifest 69 项在报告中逐一出现；模型归属只用实际编辑调用+model metadata | Git 作者当模型；未找到本地记录就算 GPT PRO |

至少执行：完整 npm run typecheck、npm test、npm run build；native-cold-opening 全部用例（父线程补充后为 10 项）、cold-boot（含两条 retry）、live-history、desktop-history-scroll、mobile-scroll、mobile-chrome、source-presentation、federated-cold-boot 及既有通用 UI acceptance。若文件名不同先用 rg --files 定位，不省略场景。构建和测试均使用同一候选版本，输出实际 exit code。

## 既有证据与已知未通过，不能篡改

- `/mnt/cache/data-cache/hapi-dsh-fresh-opening-native-final.log`：Native 54；observed positive.log：23。
- `/mnt/cache/data-cache/hapi-dsh-draft-owner-positive.log`：14；negative.log：2 个失败。
- `/mnt/cache/data-cache/hapi-dsh-event-queue-*.log`：前述队列/服务/类型结果；读取具体文件不要只引用通配名。
- `/mnt/cache/data-cache/hapi-dsh-audit-cold.log`：2 条 Host 用例和 5 条控制通过，中文 fixture 当时因 data URL 无 charset 失败；修复后 observer-final.log 六控制通过。不能把这两轮写成一次 8/8。
- `/mnt/cache/data-cache/hapi-dsh-audit-ui.log`：手机四路径通过，混跑的中文控制失败；四边界逐帧 max drift 0px，四图父线程已查看。
- `/mnt/cache/data-cache/hapi-dsh-private-tail-replay-localized/summary.json`：保存的真实 26 行尾页隔离回放，桌面/手机 click→ready 624.9/540.6ms，navigation→ready 3438.3/3021.4ms，最长任务 222/185ms。它不包含完整归档、不是用户网络，启动仍有 222ms 长任务，不能宣称所有主线程任务低于 200ms；滚动帧间隔须另测。
- 私有输入 `/mnt/cache/data-cache/hapi-dsh-current-tail.private.json`、脚本 `hapi-dsh-private-tail-replay.mts` 不得提交。可在隔离环境用于复现，但公开产物只能是匿名时序/计数。
- 生产当前版本须父线程重新确认；checkpoint 不代表部署。旧生产已有过 4GiB OOM，不能以重启后基线或 HTTP 200 关闭该问题。

## 交付和父线程验收

新增 `docs/dsh-repair-result-2026-10-24.md`，每个 spec 条目给出：pass/fail/unverified、修改位置、负对照、真实运行命令、版本、样本/环境、原始日志和 JSON 路径、剩余边界。另写一个机器可读 JSON 汇总到本任务临时目录，包含测试开始/结束、exitCode、通过/失败/跳过数、source revision、候选构建身份、截图清单及是否亲自查看。不要新加哈希验证框架。

更新全提交审计、cold-opening、memory-breakdown、UI 文档中的状态；区分基线、checkpoint、DSH 后续修复和部署版，不抹掉负对照及此前失败。发现测试自身错误时，必须证明为何是观察器错误，并保留独立控制；不要只把 flaky 等待调长。

DSH 可提交自己完成且验证的修复，不 amend/rebase checkpoint、不 push、不部署。最终回复简洁列出 commit、关键量化结果、失败/未测和证据路径；报告完整性是交付条件，文字“完成”不是验收通过。

Codex 收到结果后必须亲自读 diff、对照原始日志与断言、看关键截图、独立重跑最可能虚假通过的冷打开/Settings/内存或生命周期用例，手动修复不实断言与遗漏；不能只查 exit0 或照抄子代理总结。确认后再运行正式发布流程、只读生产核验，并准确报告哪些仍未解决。
