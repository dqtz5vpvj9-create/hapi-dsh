# DSH 接手修复与独立验收结果（2026-10-24）

状态：本轮可执行修复已完成并提交；仍是合成源、本机 Chromium、隔离 Host 的验收，不是生产部署，也不是长期生产 OOM 的证明。逐项结论见“验收矩阵”，无法满足的条目明确标为 `FAIL` 或 `UNVERIFIED`。

- 审计基线：`6d540ca58d7b1b84cdcbe4ab7faeeda416a2bc20` 的 69 个可达提交（66 主线、3 备份独有）；交接 checkpoint：`a8bf4aff1b00cb5fc8241cac702d263421240555`。
- 本轮代码提交：`d6193fd`（父提交 `a8bf4af`，未 amend/rebase/push）；文档与验收测试提交：`d1e3f92`；最终 HEAD 以 `git log -1` 为准。
- 候选目录：`/mnt/cache/data-cache/hapi-dsh-rc3-candidate`，普通目录，不是 worktree，也不是部署目录。
- 候选构建：`dist/index.js`/`dist/client.js` 的 source build id 为 `8ac857bc642ec81640eca37728acc44706e1af7090a1b9f502f67436d7c36cd7`；Node `v24.22.1`，DSH `0.2.1-rc.3`。
- 生产约束：未部署、未重启 HAPI Hub/Runner、未发送真实消息、未停止真实执行、未改上游/node_modules/生产服务配置。本报告和截图不含 admission URL、token、生产正文或私有尾页。

## 1. 验收矩阵

| spec 场景 | 结论 | 本轮观察与证据 | 禁止替代的复核 |
| --- | --- | --- | --- |
| A. Native 与 observed 冷打开 | **PASS（合成源）** | `e2e/native-cold-opening.spec.ts` 最终 8/8：2 条真实 Host 用例（390px/1440px）+ 6 条 observer 负控。旧缓存先显示、最新页放行前最新正文与可用编辑器已出现，`archiveReleased=false`；归档放行后继续观察 >=2s，标题/正文不回退，唯一可操作 composer 保留草稿。 | 未用“看到任意正文”、骨架、热切换或最终 DOM 代替；网络门分别控制 metadata/history/archive；源为合成记录。 |
| B. 显示代切换与标题 | **PASS（覆盖路径）** | generation-handoff 单测、observer 负控（透明待切换、inert predecessor、屏幕外 marker、回退）与最终冷打开 8/8 通过；旧正文保持可读且 inert，新正文/输入框/reading 就绪后才提交；标题未被 Untitled/内部 ID 覆盖。 | 30 秒超时路径只在单元/控制夹具覆盖，未在浏览器真实注入 30s 超时；未用 opacity/屏幕外 DOM 判 ready。 |
| C. 草稿所有权 | **PASS（含旧负控）** | 既有 `hapi-dsh-draft-owner-negative.log` 的 2 项旧实现失败保留；positive 14 项保留；本轮 `display-lifecycle` 在 Host 显示退役/重开后仍保留未发送草稿；全量单测通过。 | 未把“同一 Composer 两个 pane”当成不同代对象；未放宽断言。 |
| D. 设置插件失败重试 | **PASS** | `e2e/cold-boot.spec.ts` 最终 4/4，其中 bootstrap 503、Account script 503 两条同 rev 真实官方 loader 失败→关闭→重开恢复；失败无 ready、无后台重试、进行中重开不重复请求、成功后不重复加载、输入节点/草稿保留且不发送。 | 未 mock loader 成功；首次两条失败已保留：`cold-boot.log`/`cold-boot2.log`；原因是测试监听 `ctx.logger` 的内存缓冲，不是浏览器 console；改为浏览器可见 performance mark 后通过。 |
| E. 源事件队列与背压 | **PASS（本地队列）；边界未决** | 128 项 / 8 MiB、active 计数、超大单帧、屏障、取消/失败/补齐、SSE 等待本地消费者等定向测试与全量单测通过；`hapi/client.ts` 在 `publish` 后 await 本地订阅者。 | 只证明本地队列和 SSE 读取背压；TCP 内核/服务端链路的全局有界性未验证，报告不把它写成全局内存有界。 |
| F. 内存生命周期/归档 | **部分 PASS / FAIL** | 浏览器引用租约释放、重开完整内容、草稿、待审批、重开后实时后缀均通过；8 MiB 可丢弃缓存、merge-once、分页 yield 通过。全归档 `readPass` 仍把整个 raw row 数组留在内存，且没有全显示缓存的字节预算；见第 5 节。 | 不把“agents=0”、短样本或磁盘缓存当成全局 RAM 有界；不提高 Node heap、不截断正文。 |
| G. 视觉 | **PASS（图片已逐张查看）** | 本轮关键 webshot 图见第 7 节；每张均实际打开检查正文/输入框/底栏/工具/弹层/溢出。 | webshot exit 0 不算通过；未查看的图不列入通过。 |
| H. 来源审计 | **PASS** | 69 项全部在第 8 节逐一出现；模型归属仅引用实际本地编辑调用/model metadata；Git 作者未当作模型。 | 未把“找不到本地记录”推定为 GPT PRO。 |


## 2. 版本、构建与完整检查

| 检查 | 结果 | 原始日志 |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/final-typecheck.log` |
| `npm test`（最终代码） | 1229 tests，1228 pass，1 skip，0 fail，62.8s，exit 0 | `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/final-unit2.log` |
| 候选完整构建（warm restart 调用 `scripts/build.mjs`） | exit 0，build id `8ac857…`；dist 身份见日志 | `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/warm-restart.log`、`build-identity.log`；早先 `final-build.log` 为同源中间构建 |
| `e2e/native-cold-opening.spec.ts` | 8 passed，36.8s，exit 0 | `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/native-cold-opening-final.log` |
| `e2e/cold-boot.spec.ts` | 4 passed，51.3s，exit 0 | `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/cold-boot-final.log` |
| `e2e/display-lifecycle.spec.ts` | 1 passed，26.7s，exit 0 | `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/display-lifecycle-final2.log` |
| 专项组合（live-history、desktop-history-scroll、mobile-scroll、mobile-chrome、source-presentation、federated-cold-boot） | 23 passed，5.6m，exit 0 | `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/specialized-final.log` |
| 通用 UI acceptance（1 轮） | 22 checks pass，exit 0 | `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/ui-acceptance.log`；报告 `/mnt/cache/data-cache/hapi-dsh-warm-ffc33f041b32/accept-1792897407806.json` |
| 5 轮性能 acceptance | 86 checks pass，5 轮，exit 0 | `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/ui-perf2.log`；报告 `/mnt/cache/data-cache/hapi-dsh-warm-ffc33f041b32/perf-1792897751574.json` |
| 15 分钟持续压力 | 见第 6 节 | `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/stress-15m.log`，`json/stress-15m.jsonl` |

`npm test` 使用 Node 24.22.1、pinned DSH rc.3；单元测试不调用真实模型。浏览器用例使用固定 rc.3 官方 Host/Conversation，源为合成 HAPI wire，不发送真实消息，不操作生产源。

候选同步命令（绝对源路径，避免复制给自己）：

```sh
rsync -rc --delete --exclude node_modules --exclude dist --exclude test-results \
  --exclude .git --exclude '*.tgz' /mnt/cache/src/hapi-dsh/ \
  /mnt/cache/data-cache/hapi-dsh-rc3-candidate/
```

本机 workspace sandbox 下 pnpm 默认 store 在 `/home/chris/.local/share/pnpm`，官方 profile 安装会因 EROFS 失败；这是环境限制，不是产品失败。测试时仅对进程设置 `npm_config_store_dir=/mnt/cache/data-cache/pnpm-store` 与 `XDG_DATA_HOME=/mnt/cache/data-cache/pnpm-xdg`，没有改全局配置。

### 2.1 修改位置

| spec 条目 | 主要文件 |
| --- | --- |
| A 新鲜正文优先 | `src/codex/agent.ts`、`src/hapi-agent/agent.ts`、`src/codex/history.ts`、`src/codex/history-cache.ts` |
| B 显示代/标题/阅读定位 | `src/client/surface/generation-handoff.ts`、`src/client/controller.ts`、`src/client/federation.tsx`、`src/client/surface/session-view.tsx`、`src/workspace/presentation.ts` |
| C 草稿所有权 | `src/client/composer-autosave.ts`、`tests/client-composer-autosave.test.ts` |
| D 设置失败重试 | `src/client/deferred-plugins.ts`、`e2e/cold-boot.spec.ts` |
| E 源事件队列/背压 | `src/codex/event-queue.ts`、`src/codex/service.ts`、`src/hapi-agent/service.ts`、`src/hapi/client.ts`、`src/hapi/sse.ts` |
| 显示生命周期 | `src/codex/display-leases.ts`、`src/client/surface/display-leases.ts`、`src/codex/service.ts`、`src/hapi-agent/service.ts`、`src/client/federation.tsx`、`src/client/surface/session-warmup.ts` |
| 归档开销 | `src/codex/history.ts`、`src/codex/history-cache.ts`、`src/codex/agent.ts`、`src/hapi-agent/agent.ts` |
| 验收工具 | `e2e/native-cold-opening.spec.ts`、`e2e/display-lifecycle.spec.ts`、`tests/source-display-leases.test.ts`、`tests/client-display-leases.test.ts`、`tests/codex-history-cache.test.ts` |

## 3. 冷打开/换代/草稿/设置的实际测量

### 3.1 冷打开

最终 `native-cold-opening` 的 2 条真实 Host 用例都先显示旧缓存正文，然后在归档仍被阻塞时显示最新源尾页和可编辑 composer；`archiveReleased` 在断言时为 `false`。最新正文出现后继续采样，最终状态要求至少 750ms/2000ms 稳定，且没有 transient title、旧正文消失或第二个可操作 composer。6 条 observer 控制分别拒绝：标题/新鲜度回退、屏幕外 latest marker、Untitled pane、隐藏 predecessor、透明 staged successor、同一可见视图重挂载未刷新 range；这些负控证明测试不是只看最终 DOM。

截图（均已查看）：

- `/mnt/cache/data-cache/dsh-repair-2026-10-24/visual/native-cold-latest-before-archive-390x844.png`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/visual/native-cold-latest-before-archive-1440x900.png`

390px 图中最新正文、composer 和单行底栏可读，无顶部 pane 标题栏/P1；1440px 图中 sidebar、pane 标题、正文、composer 均在，无横向溢出。合成源、loopback，不代表用户网络或生产。

### 3.2 设置失败重试（真实失败保留）

第一次运行 `cold-boot` 的 2 条 retry 用例失败，原始日志 `cold-boot.log`/`cold-boot2.log` 保存：bootstrap 用例在 `failures.length` 处等到 0（console 没有 `Deferred official plugins failed to load`），account-script 同样失败；随后同一测试又在“账户插件加载后侧栏 Settings 按钮不存在”处失败。trace 的 network 记录证明 `/hapi-dsh/bootstrap` 返回 503，说明失败请求确实发生；`ctx.logger` 是 Cordis 的进程内 buffer，不写浏览器 console。测试观察器由此修正为读取浏览器可见的 `performance.mark('hapi:deferred-plugins-failed')`，并让 `open()` 在 signed-out 状态下走官方 Account menu → Settings menuitem；这不是放宽产品断言，最终仍要求失败 1 次、`readyCount=0`、无后台重试、重开成功、输入节点/草稿保留。

最终 `cold-boot-final.log` 4/4 通过，初始失败与失败原因均保留。恢复截图：

- `settings-retry-bootstrap-recovered-1440x900.png`
- `settings-retry-account-script-recovered-1440x900.png`

两张图均显示 Settings 完整官方插件列表、无加载失败提示、正文/输入框在后景保留；两张图内容相同（同一个恢复状态）。

### 3.3 草稿与显示代

`display-lifecycle` 在 1600 行合成 observed source 上填入 `Draft survives Host display retirement`，关闭 pane 并经 5 个 filler 源把目标从 5 个 warm 引用中淘汰；Host 在 10s grace 后退役显示。重开后：

- 新 display Session id 与关闭前不同（`sourceDisplayLease` 退役后新 generation）；
- 最新 `Lifecycle answer 1599` 和其前一条问题可见；
- 草稿仍在 composer；
- 待审批事实 `pendingRequestsCount=1` 仍在 catalog；
- 新发 `message-received` 实时后缀可见；
- `aborted` 不含该源，`sent` 为空。

这覆盖“关闭最后一个浏览器引用后释放、重开完整内容/草稿/审批/实时补齐”，但不代表物理手机或真实 HAPI 生产源。

## 4. 事件队列复核

实现与测试覆盖：

- 预算 `128` 项 / `8 MiB`，`pending.items` 含 active 项；单个超大项独占运行，不截断。
- 仅同 Hub/source session、同 thread/turn/item、同生命周期 epoch、同元数据、`localId=null` 的相邻未执行累计前缀可合并；终态、回执、工具、生命周期、审批和未知 provider 走有序非丢弃路径。
- 等待者不额外形成无界 Promise 链：服务队列的 admission 受同一预算和 `progress` 唤醒控制；`dispose()` 会拒绝排队项并唤醒等待者。
- 真实 service fixture（native/observed）验证：累计快照合并、屏障顺序、128 项背压、取消/失败/重连/权威补齐，以及队列 drain 后只触发一次 resync。
- 传输层测试验证 `HapiClient` 在 `publish` 返回 pressure 时真正 await 本地消费者，心跳等待期间不误判断线；关闭时 abort。

边界：这只约束**本地 decoder/consumer 队列**。SSE 读取被本地消费者阻塞时，TCP 内核/服务端 socket 缓冲仍可能积压；WebSocket/服务端全局内存没有本轮的字节上限证据。报告不把 128/8MiB 写成整个链路上限。

## 5. 显示数据生命周期与归档开销

### 5.1 已实现

- 新增 Host 侧 `DisplayLeases` 与 `sourceDisplayLease` remote（`src/codex/display-leases.ts`、`src/hapi-agent/service.ts`、`src/codex/service.ts`、`src/index.ts`）。
- 浏览器 `src/client/surface/display-leases.ts` 按官方 `SessionReference` 精确计数；`session-warmup.ts` 的 warm 引用也镜像同一租约，避免关闭 pane 后 warm 引用还在时误退役。
- 最后一个租约释放后，Host 在 10s grace 后退役对应 observation Agent/Session；`source` 的原生执行、待审批、投递事实不被 abort；重开创建新 display generation。
- 租约 TTL 5 分钟、页面每 60s renew；页面 reload 不主动 `pagehide` 释放，避免旧页 release 与新页 acquire 竞争（第一次 5 轮 perf 的 round 4 打开失败暴露了该竞争，已保留失败报告并修复）。
- 历史缓存：`MAX_HISTORY_CACHE_BYTES = 8 MiB`，超过时只写连续的最新 tail 且标记 `complete:false`；最新单条超大 row 完整保留，不截断。
- 归档读取：`readPass` 每 8 页 yield 一次；`refresh`/`replaceDisplay` 只 merge 一次，避免 raw rows → merged → merge 的重复整数组；重开/退役会删除 journal 和 queue 引用。
- 失败可见性：`deferred-plugins` 失败写 `hapi:deferred-plugins-failed` mark，仍保留 `ctx.logger.error`。

### 5.2 仍然 FAIL 的部分

- `readPass` 仍把完整 archive 的 `rows` 数组保留到一次 `readNativeHistorySnapshot` 返回；`NativeProjector`/`ObservedProjector` 的 seed、`replaceDisplay` 的 rows 和 `NativeHistoryCache.write` 的序列化仍可能在同一时刻共存。没有把“raw rows、完整投影、序列化副本、旧/新 Session”同时存在的峰值消掉。
- 没有全 Host/全显示缓存的**字节**预算；`SourceHistorySync` 的 4 个 slot 是并发数不是字节数，`warm` 的 5 个是数量上限不是字节上限。
- 分页 yield 改善交互让出，但不降低单源全归档的总保留量；异步/Worker 没有使用，因为本轮没有证明它会降低主线程阻塞或总内存。
- 因此本 spec 的“建立明确显示缓存和在途归档字节预算”判 **FAIL**，不是“部分通过”。1b 的 scope 索引字节问题仍按既有报告为线性身份增长，未在本轮新增全局预算。

## 6. 生命周期与持续压力

15 分钟隔离持续压力完成，exit 0，原始 JSON 为 `json/stress-15m.jsonl`：

- 语料：6 个合成 observed 源 × 2,000 行 × 约 1.6 KiB/行；其中一个源每 100ms 追加一次实时事件；循环执行“acquire lease → openSource → settled（全归档）→ release lease → releaseDisplay”。
- 时间：2026-10-25 03:19:37–03:39:42 UTC，900.3s；3,005 个 cycle，2,813 次 resolved，0 rejected，0 unhandledRejection，无重启。
- 自然/GC 分开记录：baseline（首轮归档后）自然 heap 37.18 MiB、GC 后 30.30 MiB、RSS 158.15 MiB、external 2.91 MiB；final 自然 heap 48.996 MiB、GC 后 48.945 MiB、RSS 164.28 MiB、external 2.88 MiB。
- 每分钟 GC 后 heap：首分钟 30.2–44.9 MiB，之后约 0.25–0.35 MiB/min 缓慢上升；最后 5 分钟 47.65→48.98 MiB（+1.33 MiB），最后 2 分钟 47.90→48.97 MiB（+1.07 MiB），没有严格持平。RSS 在 03:31 后基本停在 163.7–164.3 MiB。
- 每个 cycle 后 `agents=0`；3 分钟诊断运行中 `work/journals/releasing/timers/leased/suspended` 均为 0，`revisions` 固定 6，官方 `sessions.store` 为 0。因此已确认的服务/队列/显示持有 map 没有随曾访问源数量增长；但 GC 后 heap 仍有小幅正斜率，不能据此宣称已进入严格预算平台。
- 该实验覆盖此前约 14.4 分钟 OOM 时间窗，但使用合成 Host/源、没有真实模型/网络/生产正文；不能证明生产长期 OOM 已消失。

单次 20,000 行（约 32 MiB 源 JSON）全归档峰值（`json/archive-peak.json`）：101 次分页读取，3.28s；采样 peak heap 81.3 MiB，peak RSS 226.1 MiB；归档完成后 GC 后留存比 baseline 高 84.1 MiB；release 后 GC 后仅高 10.9 MiB（自然 RSS 436.1 MiB，V8 未归还页）。这证明释放有效，也量化了本条 5.2 的 FAIL：全归档期间仍有一次完整 raw rows/投影/序列化并存。

## 7. 视觉检查（逐张）

本轮实际打开查看的关键图：

| 图 | 观察 |
| --- | --- |
| `native-cold-latest-before-archive-390x844.png` | 最新正文、composer、单行底栏；无顶部 pane 标题/P1，无横向溢出。 |
| `native-cold-latest-before-archive-1440x900.png` | 最新正文、pane 标题、sidebar、composer；无重复栏/溢出。 |
| `settings-retry-bootstrap-recovered-1440x900.png` | 恢复后的完整 Settings 插件列表，无失败提示，正文/输入框保留。 |
| `settings-retry-account-script-recovered-1440x900.png` | 同上；与 bootstrap 图为同一恢复状态。 |
| `display-lifecycle-reopened-1440x900.png` | 重开后的完整历史尾部、标题、composer；正文/输入框可读。 |
| `source-receipts-quiet-1440-1440x844.png` | 无独立感叹号；正文与输入框正常。 |
| `source-receipts-expanded-360-360x844.png` | 回执菜单在 360px 内，按钮/文字不越界，底部栏可见。 |
| `mobile-chrome-single-390-390x844.png` | 单 pane 无 P1，正文全宽，输入框和底栏正常。 |
| `mobile-chrome-split-360-360x844.png` | 分屏显示 P1/P2，当前 P2 高亮，输入框/底栏不重叠。 |
| `mobile-touch-reading-390x844.png` | 长历史阅读位置，正文全宽，composer 固定，无空白/溢出。 |
| `mobile-touch-expanded-tools-390x844.png` | 展开工具输出在 390px 内，嵌套输出可读，composer 不遮挡。 |
| `live-history-codex-1440x900.png` | attach/refresh 期间两份实时 answer 均在，正文与 composer 完整。 |
| `desktop-history-manual-reverse-1440x900.png` | 手动分页反向滚动后旧正文仍在，无空白，composer 可见。 |
| `federated-cold-1440x900.png` | 远端 conversation 正文/输入框可用，无重复 sidebar。 |

`webshot` 固定命令由 `e2e/visual-review.ts` 调用；每张图都通过 `read_image` 实际查看，不以命令 exit 0 代替。

## 8. 69 个提交逐一来源审计

审计基线仍是 `6d540ca…` 的 69 个提交；`a8bf4af` 是本轮 checkpoint，`d6193fd` 是本轮后续修复，均不重算成基线已解决。逐项清单见下；模型归属只引用实际本地编辑调用/model metadata，不把 Git 作者当模型，也不把未找到记录推定为某个网上模型。

| # | commit | 分支 | subject | 本轮结论/证据 | 审计 |
| --- | --- | --- | --- | --- | --- |
| 1 | `6c64e7d6` | main | Initialize HAPI DSH documentation | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 2 | `073886ef` | main | Implement unified DSH workspace with native Codex and paired runners | 事件队列契约：本轮 128/8MiB 定向与全量单测通过；全局 TCP/服务端边界仍未验证 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 3 | `e60d7e8a` | main | fix(distribution): install the official DSH pnpm prerequisite | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 4 | `1cdb2e7d` | main | feat: integrate HAPI source capabilities into the unmodified DSH workspace | 源能力/scope 索引：全量单测通过；旧索引负对照保留 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 5 | `3d27a01f` | backup | fix(client): generate ids without crypto.randomUUID on insecure origins | 备份独有补丁；主线对应 9，不重复计为已上线版本 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 6 | `0bd59504` | backup | fix(host): keep the Host available while a large catalog attaches | 备份独有补丁；主线对应 10，不重复计为已上线版本 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 7 | `9c8c4bdb` | backup | test(e2e): cover the live HTTPS site and wait for the preview notice | 备份独有补丁；主线对应 11，不重复计为已上线版本 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 8 | `159907f6` | main | feat: preserve native input, share selection, and workspace navigation | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 9 | `70af5bad` | main | fix(client): generate ids without crypto.randomUUID on insecure origins | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 10 | `24a3f78a` | main | fix(host): keep the Host available while a large catalog attaches | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 11 | `17883f22` | main | test(e2e): cover the live HTTPS site and wait for the preview notice | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 12 | `d3517b75` | main | fix: restore source workspaces and official plugin usability | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 13 | `1dad739f` | main | feat: structural pane surface, native history and restore fixes | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 14 | `8bb56a4f` | main | fix: live feedback batch — history, diagnostics, writable sources, startup, UI v2, seamless history | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 15 | `4aaf3d7f` | main | feat(composer): compact workspace composer, remove routine metadata rows, handoff doc | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 16 | `4f19dcac` | main | docs(handoff): add Phase-0 pre-read findings for architecture A | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 17 | `6a47858d` | main | docs(handoff): record official AppFrame/scope boundary for architecture A | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 18 | `9e459db3` | main | feat: add opt-in shared Host views and live history reconciliation | 旧缓存先显示：本轮 native 冷打开 8/8 证明最新尾页优先 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 19 | `58800d1f` | main | feat: default shared Host views and tail-first history seed | fastHistorySeed：与 18 同轮复验 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 20 | `95892d0e` | main | fix: polish shared pane startup and source composer | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 21 | `370f4fc5` | main | Recover interrupted workspace navigation and source actions | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 22 | `34ab8fc7` | main | Restore independent toolbar controls on every workspace pane | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 23 | `4935ce22` | main | Move source status into pane headers and prune empty layouts | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-01-23.md](commit-audit-01-23.md) |
| 24 | `5d1ef8df` | main | Document connecting an existing DSH Web host | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 25 | `118c33c5` | main | Bound initial history work and release oversized warm caches | warm cache 数量上限：全量单测/验收通过；字节预算仍缺 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 26 | `92df62f4` | main | Preserve pending question drafts across source display revisions | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 27 | `1ebe52e7` | main | Record separate pane content and composer mount timings | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 28 | `08c88230` | main | Isolate remote graph stylesheet ownership across DSH builds | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 29 | `c4a7d403` | main | Default to Codex glass and use a supported-stop effort slider | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 30 | `fdb6f8c9` | main | Show native shell commands and results in compact tool views | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 31 | `c7430d3f` | main | Preload source settings and separate reads from history synchronization | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 32 | `2bab966c` | main | Display source token usage without synthetic DSH statistics | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 33 | `8304f2cc` | main | Restore official composer auto-growth and text sizing | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 34 | `33b18b20` | main | Separate source settings availability from execution permissions | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 35 | `35a930e1` | main | Keep source settings available through history read retries | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 36 | `806b1f0d` | main | Persist composer drafts across panes and source display generations | 草稿所有权：旧负对照 2 项保留，positive 14 项 + 生命周期草稿复验通过 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 37 | `2f2b8878` | main | Route source queue editing through confirmed native cancellation | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 38 | `da3a4ba5` | main | Correct the queue slot fixture owner props | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 39 | `37d06299` | main | Hide queue recovery details after the draft is restored | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 40 | `09e77df8` | main | Compact sidebar navigation and move list controls into options | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 41 | `ed507ba6` | main | Lighten glass surfaces and give conversations the full pane width | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 42 | `0de42440` | main | Route official queue steering to the native source inbox | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 43 | `f2301fd1` | main | Use settings capability snapshot instead of transcript lock in picker | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 44 | `db4be945` | main | Make source queue compact and replace text action glyphs | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 45 | `ccfddeb0` | main | Prioritize foreground session loading and record Host startup timings | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 46 | `1c19245c` | main | Improve pane startup, draft recovery, compact tools and release workflow | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-24-46.md](commit-audit-24-46.md) |
| 47 | `c694b02d` | main | fix: reuse official shell views and restore compact source queues | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 48 | `d6283776` | main | fix: stop reentrant warm-cache eviction from freezing the page | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 49 | `b1ec2038` | main | fix(mobile): reclaim conversation space and compact workspace controls | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 50 | `a37ef84e` | main | Bridge HAPI audit gaps through official DSH views and source identities | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 51 | `9be022b1` | main | Fix native live projection ordering and add measured UI acceptance | UI acceptance：22 项通过 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 52 | `5cda7863` | main | Record UI acceptance measurements and remaining cold-open and scroll failures | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 53 | `e9ffa4ed` | main | Improve installable package and cross-platform onboarding | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 54 | `fd57928d` | main | Handle Windows sharing violations during atomic credential replacement | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 55 | `431c659d` | main | fix: separate unknown receipts and compact native command rows | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 56 | `c366dad5` | main | perf: bound cold session work and cache official web assets | 冷打开缓存/预算：冷文档 1.43–2.60 s，first body ≤0.37 s | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 57 | `212afb0e` | main | perf: separate native execution state and suppress unchanged wire projections | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 58 | `feaefd51` | main | test: use platform temporary directories in native and asset cases | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 59 | `2a044ef1` | main | fix: preserve mobile reading during paging and plugin activation | 手机自动补页：12/12 触摸用例通过 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 60 | `c5af8948` | main | fix: preserve history position across gestures at the upper edge | 手机顶端补页：12/12 触摸用例通过 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 61 | `5b6ff473` | main | fix: preserve manual history anchors and defer plugin activation during touch | 手动分页锚点：12/12 触摸用例通过 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 62 | `25bc0002` | main | fix: reconcile shared layouts without repeated restore conflicts | 维持基线审计；本轮完整 typecheck/unit 未推翻其结论 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 63 | `4764ae04` | main | fix: simplify mobile workspace navigation and preserve reader state | 手机导航：mobile-chrome 2/2 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 64 | `31999315` | main | fix: move source receipts into existing pane menus | 回执菜单：source-presentation 2/2 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 65 | `301c1526` | main | Upgrade to DSH rc.3 and preserve workspace behavior | rc.3 升级：全部 E2E 在 rc.3 官方组件上通过 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 66 | `67375a05` | main | Reduce federated cold opening work and verify remote navigation | 联邦冷打开：2/2 通过 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 67 | `5784b239` | main | Fix quadratic stream retention and add measured memory regressions | 流式平方留存：负对照与修复组单测通过 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 68 | `a5073b26` | main | Preserve desktop reading position across interrupted history pages | 桌面阅读位置：3/3 通过 | [commit-audit-47-69.md](commit-audit-47-69.md) |
| 69 | `6d540ca5` | main | Keep child scope metadata without retaining cumulative message bodies | 子代理 scope 索引：全量单测通过 | [commit-audit-47-69.md](commit-audit-47-69.md) |

## 9. 失败、未验证与剩余边界

1. **全归档字节预算 FAIL**：见 5.2；没有证明单源全归档峰值已消除，也没有全 Host 显示缓存字节上限。
2. **生产长期 OOM UNVERIFIED**：15 分钟合成压力只覆盖约 14.4 分钟时间窗，不是生产 Host、不是用户会话、不是生产网络；不能据此关闭 4 GiB OOM 问题。
3. **物理手机/真实网络 UNVERIFIED**：360/390px 是 Chromium 触摸/视口模拟；物理软键盘、真实粗指针、Chrome 下拉刷新、用户网络均未测。
4. **30 秒换代超时浏览器注入 UNVERIFIED**：单元/observer 控制覆盖失败收敛，但本轮没有在真实浏览器强制 30s 超时并核对 timer/observer/RAF 清理。
5. **页面崩溃/reload 租约清理**：依赖 5 分钟 TTL；正常 reload 旧租约可存活最多一个 TTL，期间阻止 Host 退役。没有 pagehide 释放，以避免与新页 acquire 竞争。
6. **全局事件链路 UNVERIFIED**：本地 128/8MiB 有界，TCP/服务端 socket 缓冲未证明有界。
7. **完整归档投影**：readPass 仍一次持全量 raw rows；没有逐页 seed/Worker 方案。可见窗口优先只通过分页 yield 与最新页独立读取体现。
8. **首次 perf 失败保留**：`perf-1792897519366.json` 中 desktop 4 打开失败（15s 内无 body/editor），修复 reload lease 竞争后 `perf-1792897751574.json` 5 轮 86 项全过；没有删除失败报告，也没有用单轮最好成绩覆盖。
9. **部署/生产重启/真实发送 UNVERIFIED**：按约束未执行。

## 10. 原始证据路径

日志：

- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/final-typecheck.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/final-unit2.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/warm-restart.log`、`build-identity.log`、`final-build.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/native-cold-opening-final.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/cold-boot.log`、`cold-boot2.log`（失败保留）、`cold-boot-final.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/display-lifecycle-final2.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/specialized-final.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/ui-acceptance.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/ui-perf.log`（首次失败保留）、`ui-perf2.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/stress-15m.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/cache-leases-tests.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/client-display-leases.log`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/logs/warmup-test.log`

报告/JSON：

- `/mnt/cache/data-cache/hapi-dsh-warm-ffc33f041b32/accept-1792897407806.json`
- `/mnt/cache/data-cache/hapi-dsh-warm-ffc33f041b32/perf-1792897519366.json`（失败）、`perf-1792897751574.json`（最终 5 轮）
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/json/stress-15m.jsonl`、`stress-diag.jsonl`（3 分钟持有 map 诊断）、`archive-peak.json`
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/json/summary.json`（机器可读汇总）
- `/mnt/cache/data-cache/dsh-repair-2026-10-24/json/commit-table.md`（69 项表）

截图目录：

- `/mnt/cache/data-cache/dsh-repair-2026-10-24/visual/`

## 11. 结论

本轮把“旧缓存/全归档阻塞打开”“显示代切换丢正文”“设置失败不能重试”“已访问显示永不释放”从仅有单元证据推进到 pinned rc.3 官方 Host/Chromium 的合成源 E2E，并保留了失败、负控和原始日志。可复现的跨源显示释放、草稿/审批/实时补齐和 5 轮 UI/性能验收通过；但全归档 raw rows 的单源峰值、全显示缓存字节预算、生产长期 OOM、物理手机和真实网络仍未解决或未验证，不能把本轮写成全量完成。
