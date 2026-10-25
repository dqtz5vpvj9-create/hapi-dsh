# Cold opening must show current source content

The opening measurement covers navigation through a readable, current source
tail and a usable composer. Seeing any transcript text is only first paint.
It is not evidence that the selected conversation has caught up.

## Failure and repair

The native fast-opening path used a disk opening cache whenever it contained a
history epoch. The observed-engine adapter also preferred its opening cache
before reading current source content. An epoch only identifies structural history changes; ordinary
appends can leave it unchanged. The cache could therefore omit recent messages.
The first corrective read traversed the complete archive before replacing that
display, putting all historical work between the old preview and current text.

Both adapters now request the bounded latest source page (at most 200 source rows)
and uses the existing epoch validation before publishing the display. Archive
backfill continues independently. A failed source read can still show explicitly
stale cached content; it is not counted as fresh. No source execution is restarted
or transferred by this change.

A separate title regression occurred when official reconnection cleared
projection values before the next baseline. The adapter now keeps the current
durable title and remembers the known name for each open pane's exact source
identity. That name also survives a gap between retired and successor display
rows; a delayed catalog poll cannot roll a newer durable name back. A closed
pane or a different source clears this small, pane-scoped record.

The first realistic browser run exposed a further defect: background archive
replacement cleared a previously readable transcript for about 188 ms. The
same-source handoff now keeps the previous official surface readable and inert
while the successor renders at its final size. It switches after the reference,
body, composer and reading restoration are ready. Ordinary navigation does not
retain another conversation's content. Each pane may retain only one predecessor;
navigation, closure and failed preparation release it. No HTML snapshots or
replacement conversation renderer are used.

## Why the former tests missed it

Both production navigation probes stopped their animation-frame sampling when
any body and composer appeared. The remote probe also accepted any title that
was not a session ID, which included `Untitled conversation`. The tests neither
required a latest source marker nor kept observing after their first success.
Small, already-materialized fixture sessions did not exercise a stale opening
cache followed by a blocked full archive.

The shared opening observer now distinguishes first body, visible latest source
marker, usable composer, known title, and stable readiness. Missing expected
source markers or titles are reported as unverified. Transient title and body
regressions remain failures even when the final DOM recovers. Sampling starts
before application initialization and continues after first readiness.

## Measurement boundaries

A read-only check on 2026-10-24 found the affected conversation's opening cache
about 16 minutes old and at an older epoch. Reading its current source metadata
took 97 ms and its bounded tail, including epoch validation, took 137 ms from
the server host. That tail contained 26 rows and about 259 kB of JSON. These are
server-local request measurements, not the user's browser or network latency.

The native negative controls block archive completion and provide a fresh tail
with no overlap with the old cache. They cover unchanged and changed epochs,
rewind during validation, and live output arriving during backfill. The original
implementation failed all three new negative controls; the updated native suite
passed 54 tests. The browser negative control also failed on the old backend:
after the latest page was released, it still could not become current while the
archive remained blocked. The observer has independent controls for temporary
title regressions, offscreen markers, parked old views and transparent staged
successors. A final recovered DOM cannot erase an earlier failure. The actual
opening cases also preserve an unsent draft through archive replacement and
require exactly one usable composer, with no native send or abort.

The observed-engine negative control also returned only the old cached answer
while its archive was blocked. After the repair, all 23 observed-agent tests
passed, including a fresh tail with no cache overlap, live output during archive
backfill, and recovery after a source read failure.

The first complete desktop/mobile cold-opening browser run passed seven cases:
two official Host cases and five observer controls. The latest text appeared
232 ms and 255 ms after the deliberately blocked source response was released.
These are synthetic-source, loopback measurements, not production latency.
Both screenshots were viewed; the mobile view had no duplicate header or P1
tab, and neither viewport had horizontal overflow.

A separate isolated replay used 26 saved source rows (about 259 kB) with the
actual official Host and Conversation. It did not fetch the omitted archive or
contact production. Latest visible text, the known title and a usable editor
were ready 625 ms after the desktop click and 541 ms after the mobile click;
navigation-to-ready was 3.44 s and 3.02 s, including the initial application and
picker. The longest observed tasks were still 222 ms and 185 ms, so this is not
a claim that main-thread work meets the performance budget. There were no
browser exceptions or source mutations, and both screenshots were viewed.

That replay initially timed out because the observer recognized only the English
`Pane:` accessible-name prefix, while the browser used Chinese `窗格:`. The
observer now handles both supported locales, with a separate control that still
rejects a transient Chinese unnamed title. The failed run and corrected run are
retained separately; only the corrected measurement is reported above.

Full archive projection, serial attachment imports, remote asset loading and
service event-queue retention remain separate costs. This repair does not claim
that every long task, OOM risk or network-dependent opening delay is resolved.

## 2026-10-24 后续验收状态

Checkpoint `a8bf4af` 之后的修复已提交为 `d6193fd`。在候选构建 `8ac857bc642ec81640eca37728acc44706e1af7090a1b9f502f67436d7c36cd7` 上，最终 `native-cold-opening.spec.ts` 8/8 通过：两条真实 Host 用例在归档仍被阻塞时出现最新正文和可编辑 composer，`archiveReleased=false`；归档放行后继续稳定观察，标题/正文不回退，唯一可操作 composer 保留草稿。两条真实用例的截图已逐张查看。

此前记录的两条 Settings 重试用例在本轮第一次运行失败：503 已真实发生（trace network 证据），但测试监听的是浏览器 console，而 `ctx.logger` 只写进程内 buffer；account-script 用例还错误假设账户插件加载后侧栏仍有独立 Settings 按钮。测试改为读取 `hapi:deferred-plugins-failed` performance mark，并在 signed-out 状态通过官方 Account menu → Settings menuitem 打开；最终 4/4 通过。原始失败日志保留。

仍为 `UNVERIFIED`/`FAIL` 的条目：30 秒换代超时的浏览器注入、完整归档的单源 raw-row 峰值与全局字节预算、生产长期 OOM、物理手机和用户网络。详见[修复结果](dsh-repair-result-2026-10-24.md)。
