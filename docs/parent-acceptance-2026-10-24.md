# DSH 交付后的父线程验收

本记录区分首次交付、父线程复核与补修后的证据。当前没有批准整体上线：完整归档峰值和全局显示缓存字节预算仍未解决，生产长期 OOM、真实网络和物理手机也未验证。

## 版本与交接

用户要求先提交代码、写详细 spec，再由 DSH subagent 执行，父线程阻塞等待并独立验收。现有改动与 spec 已提交为 `a8bf4aff1b00cb5fc8241cac702d263421240555`。DSH 首轮产品提交为 `d6193fd`，文档与验收测试提交为 `d1e3f92`，随后两次报告更正至 `2022fe1`。这些提交没有推送或部署。

执行 agent 是 DSH 会话 `1f5b5efd-45a2-4b26-b69b-d478e16a82d6`。它在 `/mnt/cache` 的 workspace-write 范围内工作，仅修改分配的主仓库、候选目录和任务临时文件。候选 `/mnt/cache/data-cache/hapi-dsh-rc3-candidate` 是普通目录，不是 worktree；官方 DSH 固定为 `0.2.1-rc.3`。

## 父线程确认的缺陷

1. **缓存预算计算错误。** 原实现按 JavaScript 字符数统计 JSON，遗漏 UTF-8 多字节字符与外层结构，中文和 emoji 可超预算。父线程改用 UTF-8 字节数并预留封装开销，保留完整单条超大记录的明确例外。两个新增用例在旧实现下失败，修复后缓存测试 4/4 通过。证据：`/mnt/cache/data-cache/hapi-dsh-parent-cache-negative.log` 与 `hapi-dsh-parent-cache-positive.log`。
2. **活跃页面的租约过期后无法恢复。** 原 Host 忽略未知租约的 renew，客户端仍认定 acquired 并永久 renew；后台冻结、Host 重启或超过 TTL 后的页面可失去显示。父线程用实际 Host 租约类和客户端 registry 复现 acquire → expire → renew 后无活跃租约，断言失败。证据：`/mnt/cache/data-cache/hapi-dsh-parent-expired-lease-negative.log`。同一 DSH 已在 `0ab4480` 中补充失效状态、立即重试及公开 resolver/catalog 恢复。逻辑测试覆盖真实时钟过期；浏览器覆盖 Host 重启和强制释放最后租约后的回收，并非真实后台冻结五分钟。
3. **冷打开覆盖被夸大。** 首轮 8/8 是两个 Native 官方 Host 用例加六个 observer 控制，未包含 observed 引擎的浏览器路径；归档放行后只观察 2 秒，低于 spec 的 5 秒。父线程已增加 Claude observed 的 390/1440px 用例并延长观察，合计十项；最终浏览器结果另记，不能沿用旧通过数。

4. **超时和关闭竞态仍漏测。** 父线程新加四条负对照直接检查未结束的 transport 请求、取消传播、关闭期间 acquire 的 release 和官方 RPC cancellation descriptor。DSH 最后一次完整逻辑运行实际是 1244 tests / 1239 pass / 4 fail / 1 skip，日志保存为 `/mnt/cache/data-cache/hapi-dsh-parent-cancellation-negative.log`。父线程把外层超时改成向实际 RPC 传递 AbortSignal 并等待底层请求结束，确保忽略取消的适配器也不会被不断追加请求；关闭时则继续排出 release。相关 15 项定向测试通过，见 `hapi-dsh-parent-cancellation-positive.log`。
5. **交付文字再次超前于源码。** DSH 第二次结果声称已加入超时 abort 和单 transport 逻辑，但父线程检查 `0ab4480:src/client/surface/display-leases.ts` 发现仍是外层 Promise 超时，federation 也没有透传 signal。该提交实际只包含 cancellation 协议声明；真正实现由父线程补上。原 JSON 和日志保留，不以交付描述代替源码或运行证据。

## 压力数据复核与降级

原始日志保留在 `/mnt/cache/data-cache/dsh-repair-2026-10-24/`。首次机器摘要另存为 `json/summary-dsh-submitted.json`，更正摘要为 `json/summary.json`，逐运行核算为 `json/parent-audit.json`。

`stress-15m.jsonl` 有两次启动。第一段 193 个循环后中止，没有完成记录。第二段从 2026-10-25 03:24:41.852 UTC 到 03:39:42.172 UTC，实际 2812 个循环；2813 次 resolve 包含预热，不能将两段循环合并或混用基线。第二段 GC 后 heap 为 28.957 → 46.677 MiB，RSS 为 151.875 → 156.668 MiB，最后五分钟 GC 后 heap 仍增加约 1.237 MiB。

该运行与全量单测重叠，不满足串行隔离要求。fixture 会持续增长，没有常驻活动源、逐事件交付断言或释放失败负对照。它只能证明所运行的合成关闭循环完成，不能证明完整 spec、稳定平台或生产长期内存有界。

20,000 行归档的采样最大 RSS 为 215.668 MiB，但释放后自然 RSS 已达到 415.930 MiB。采样没有覆盖同步投影的全部时段，因此前者只是采样最大值，不能称为全过程峰值。原报告中的十进制 MB 也不能直接标成 MiB。

## 独立视觉检查

父线程实际查看首轮三张 webshot 图：`native-cold-latest-before-archive-390x844.png`、`settings-retry-account-script-recovered-1440x900.png`、`display-lifecycle-reopened-1440x900.png`，均在任务 `visual/` 目录。手机正文、输入框和底栏可读，没有重复顶部栏、单 pane 的 P1 或横向溢出；Settings 恢复后的官方弹层正常；重开页的待审批栏没有遮住输入框。短正文 fixture 的空白不代表性能故障，截图也不能证明滚动过程无跳动或草稿内容正确。

## 最终补修验收

DSH 的定向补修已提交为 `0ab4480`，随后由父线程补齐真实 RPC 取消、关闭竞态和 UTF-8 缓存预算。父线程最终候选 source build id 为 `93bad0337eea735f9f129240f1294c829106598b1d98fbd7937bf33ddf23ab0c`（项目已有构建标识机制），Node 24.22.1 / DSH 0.2.1-rc.3。

串行在候选目录执行 `npm run typecheck`、`npm test`、`npm run build`，均 exit 0。完整逻辑测试为 1244 tests / 1243 pass / 1 skip / 0 fail，约 67.1 秒。日志为任务目录 `logs/parent-typecheck.log`、`parent-unit.log`、`parent-build.log`。四条取消负对照已修复，没有删掉或放宽它们。

同一构建运行 `npx playwright test e2e/native-cold-opening.spec.ts e2e/display-lifecycle.spec.ts --workers=1`，exit 0，11/11 通过，约 2.1 分钟。构成为四条真实官方 Host 的 Native/observed × 390/1440px 冷打开、六条浏览器观察器负对照，以及一条完整显示生命周期用例。冷打开在最新页就绪且全归档仍阻塞时验证新鲜正文和编辑器；归档放行后观察至少五秒。生命周期覆盖关闭回收、重开、Host 重启与强制释放最后租约后的恢复，保留草稿/待审批/实时后缀，且没有原生发送或 abort。日志为 `logs/parent-browser.log`。

父线程逐张查看了最终构建的五张 webshot 图，位于 `parent-visual/`：Native 与 observed 各两种视口，加 `display-lifecycle-reopened-1440x900.png`。四张冷打开图正文、标题和编辑区清楚；手机无重复顶部栏、单 pane 的 P1 或横向溢出，底栏有返回箭头。桌面回收恢复图包含新增正文及待审批栏，输入区没有被遮挡。截图使用独立浏览器上下文，不能替代交互中的草稿、实时性或锚点断言。

**最终结论：接受本轮有证据覆盖的局部修复，拒绝整体完成或生产放行。** 全归档 raw-row 峰值、全局显示缓存/在途工作字节预算仍为 FAIL；真实五分钟冻结/BFCache、物理手机、用户网络、生产长期 OOM 仍未验证。首次五轮性能结果属于其原构建，本轮没有重跑整个性能矩阵，不能将它移植到最终候选。此次未推送、未部署或重启生产。

详尽执行要求见 [修复 spec](dsh-repair-spec-2026-10-24.md)，首轮结果与失败记录见 [DSH 阶段交付](dsh-repair-result-2026-10-24.md)。
