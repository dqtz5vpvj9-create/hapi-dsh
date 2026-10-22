# Pane surface: structural route (spike memo + implementation record)

Status: implemented in task-12, measured against the pinned upstream
`@deepseek-ai/dsh@0.2.1-rc.2` (`687f282e8625c6b8d11ff58211a90524be2e4317`).
The spike (task-7) asked whether a pane can render **only** the official
Conversation body/header/composer for an explicit `SessionReference`, with no
per-pane AppFrame. The answer is no with public APIs; the shipped route is the
closest supported structure: a **filtered per-pane official graph** whose root is
still the official AppFrame (the only public conversation host), with the
duplicated session list/seats shadowed per pane, the official sidebar shell
retained so the focused pane keeps the official Settings root, and the shared
HAPI bundle evaluated once per page.

Revision record: (a) `ui-deliverables` retained (54 rows) because it owns the
`present` tool renderer and the changes-review right-column tab; (b) pane chrome
shadows `sidebar.workspaces` + `shell.leading` only, keeping the sidebar shell
and `sidebar.settings` subtree; (c) the plugin-event SSE projection keeps its
decoder/buffer per stream instead of module-level; (d) task-18 added lazy
pane-graph boot by window visibility plus bounded prefetch of the published
row-URL bundle set — startup measurements in §3 are from the release build
`dist/client.js` 10:16:58 and are separate from the earlier per-pane heap table.

## 1. Verdict per feasibility question

### Q1. Can an explicit-session Conversation body be rendered without AppFrame/root? — **No (public-API gate)**

Evidence from the installed pinned packages:

1. `ctx.slots.renderSlot` is root-only. `@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1532`
   throws `ctx-level renderSlot only renders 'root'`; every child slot renders
   only through the `renderSlot` prop the renderer hands to the **declaring**
   entry (`standardKit`, same file `:754`).
2. The only `main.conversation` declarer is ui-conversation's private
   `ConversationPanel`: registration at
   `@deepseek-ai/dsh-client-ui-conversation/lib/client.js:20018-20026`, its body
   `renderSlot("main.conversation", {})` at `:17886-17887`, declaration of the
   `main.conversation` key at `:19727`. One declarer per slot is enforced by
   `SlotCore.register` (second declarer throws naming the first).
3. ui-conversation's runtime exports stop at services/types (`apply`,
   `UiConversation`, `ConversationController`, …; same file `:20030-20045`).
   `ConversationRoot` (`:17559`), `ConversationMainPanel`, `ConversationHeader`,
   `InputBar` are module-private. The public mount face renders `root` only
   (`dsh-client-ui-renderer/lib/types/client/index.d.ts`, `UiRendererService.mount`;
   `app.d.ts`: "The whole layout tree hangs from the built-in `root` slot").
4. `main.conversation` is `single`/`session-maybe`
   (`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:198-201`),
   so one graph renders exactly one Conversation. The `session` scope adapter is
   boot-once (`ui-renderer/lib/client.js:1491-1504`), while explicit subtree
   binding exists (`scopeAreaProvider`/`adapter.bindingSource(reference)`,
   `ui-renderer:705-724`): explicit-session bodies work **inside** a graph, but
   N independent panes still require N graphs.

Consequence: a custom React "pane root" cannot render the official Conversation;
any public-API route keeps AppFrame in the pane graph.

### Q2. Best achievable alternative — **route (b), shipped**

- (b1) one shared graph per window with several conversations: blocked by the
  single `main.conversation` seat and missing component exports above.
- (b2) filtered/minimal per-pane graph whose only rendered state is the
  official conversation, with the window chrome owned once: **chosen**.

### Q3. Memory — measured (see table in §3), target met per extra pane

The filtered pane graph evaluates 5.71 MiB of official row source per pane in
the 53-row measurement below (down from 14.48 MiB), rising to ~5.82 MiB by
estimate after the 54th row (`ui-deliverables`, §6) is retained. It costs
**~6.0 MB JS heap per additional pane** after the first (down from 16–17 MB with
the compiled-cache baseline, and 52 MB with no cache). The first pane costs
+21.7 MB because it also pays the one-time per-page compiled-cache entries for
the retained rows.

### Q4. Single-package seam plan — implemented, §4

### Q5. Rightbar/modals/terminal/files ownership — §5

## 2. Implemented route

Every pane still boots an official `ClientModuleSystem` + Loader + Cordis
Context, but:

1. **Pane graph subset.** The Host graph is projected through
   `PANE_GRAPH_POLICY.transform` (`src/client/surface/pane-graph.ts`): excluded
   rows are removed and every retained row gets its own single-resource batch
   (a Host combo script would otherwise register excluded modules too; the row
   `url` is the module loader's documented single-resource fallback, original
   bootstrap/application phase preserved).
2. **HAPI bundle once per page.** `hapi-dsh` is excluded from pane graphs; the
   primary graph installs the pane-only HAPI surfaces on the pane Context
   (`mountPaneNative(graph.ctx)`, `src/client/pane-native.ts`).
3. **Compiled-bundle cache kept.** One `new Function` per Host artifact URL,
   executed per pane with that pane's facades
   (`federation.tsx` `HostResources.compiled`, unchanged semantics).
4. **Bootstrap freshness.** `refreshBootstrap()` re-fetches
   `hapi-dsh/bootstrap` before each pane boot, so a pane opened after a Host
   graph revision never boots the stale revision cached at page start.
5. **Plugin-event projection.** Pane graphs still consume the official
   `/plugins/events` SSE stream (shared per Host). `projectPluginEvents` rewrites
   `graph` sync payloads through the same pane transform and drops `rebuilt`
   frames for excluded rows; unrelated frames pass byte-for-byte, cancellation
   and stream errors propagate. (Astra: filter frames, don't deny the stream.)
6. **Structural chrome.** `installPaneChrome` shadows only the duplicate
   sidebar *content* seat (`sidebar.workspaces`) and the collapsed-sidebar
   reopen controls (`shell.leading`) with empty occupants through the public slot
   API (distinct priority, one declarer per key untouched). The pane keeps the
   official sidebar **shell** on purpose: the official Settings root (trigger,
   modal, sections) is declared and rendered inside the sidebar's
   `sidebar.settings` subtree, so unmounting the shell would take the focused
   pane's Settings ownership away with it. The session/workspace list itself is
   built once in the primary graph; the pane's shell is CSS-hidden and carries
   only panel navigation, footer actions, and the settings subtree.
7. **One global chrome per window.** The unified session list, window tabs and
   global tools live in the primary graph only.

## 3. Measurements

Environment: `e2e/official-runtime.ts startOfficialEnvironment(false)`, headless
Chromium, one worker, real pinned official Web + official Loader; HAPI sessions
are wire fixtures. Method: CDP `HeapProfiler.collectGarbage` ×3 then
`Runtime.getHeapUsage.usedSize`, `Memory.getDOMCounters`, resource timing.
Spec: `e2e/pane-surface.spec.ts` (1 passed, 46.6 s). Raw log:
the throwaway e2e run log (not committed).

| state | JS heap MB | delta |
| --- | --- | --- |
| primary graph, 0 panes | 35.96 | — |
| +1 chat pane | 57.68 | **+21.72** (first pane; measured on the 53-row graph, 54 compiled-cache entries after retaining `ui-deliverables`) |
| +2 chat panes | 64.37 | **+6.69** |
| +4 chat panes | 75.84 | **+6.05 / extra pane** average |

Before/after:

| metric | compiled-cache baseline | filtered pane surface |
| --- | --- | --- |
| 4 panes, total heap | 139.5 MB | **75.84 MB** (−45.6%) |
| additional pane | 16–17 MB | **6.05 MB** (−63%) |
| evaluated row bytes per pane | 14.48 MiB | **5.71 MiB** (−60.6%) |
| DOM nodes per pane | 900–1500 | 1135–1194 |
| listeners per pane | 390–425 | ~254 |
| docs (`documents`) | 2 | 2 (unchanged) |

Evaluated-bytes evidence: Host graph = 70 rows; measured pane graph = **53
rows** (54 after this revision; see below); the filtered pane fetches exactly
one single-resource artifact per retained row for the whole page (55
`/plugins/` resource entries = 2 primary combo scripts + 53 pane-row artifacts;
decoded pane-row bytes 5,990,192 B). The `hapi-dsh` single-resource bundle is
never fetched by a pane. Resource fetches still grow with pane count
(32→111→132→170) because every pane graph polls the Host APIs; that is not
bundle evaluation and is a separate follow-up (task-14/15).

**Row-count revision (post-measurement, not re-measured).** `ui-deliverables` is
retained now that the review established it owns conversation/right-column
surfaces (§6), so the pane graph is 54 rows instead of 53. Its bundle is
110,973 B, so expected evaluated row source becomes 6,101,165 B ≈ 5.82 MiB
(+1.8%). The heap table above is still the measured 53-row graph; retaining one
~111 KB row is expected to add well under 1 MB per pane (its renderers mount
only when a `present` tool row or the changes-review tab is actually used). The
Lead's final release build should confirm the exact 54-row heap; no rebuild was
run in this revision.

Nothing was rebuilt for this table after the source edits: `dist/client.js`
(07:59:24) and `dist/index.js` (07:59:23) are newer than the last src edit
(07:58:08). `tsc -p tsconfig.host|client|e2e.json --noEmit` all clean.

### Lazy pane boot and restored-workspace startup (task-18, release build `dist/client.js` 10:16:58)

Method: same fixture/harness, restored 13-pane layout across three windows
(4 active + 5 parked + 4 parked) seeded through the real restore path (local
workspace snapshot + display/source session identity from HAPI catalog), then a
page reload into it. Heap: CDP `HeapProfiler.collectGarbage` ×3 +
`Runtime.getHeapUsage`. Startup timing: Node wall clock from reload start to the
last active-window Conversation body; bundle timing from Playwright request
events (`/plugins/` first byte/response), which measure enqueue and completion
rather than wire-level concurrency. The Hub and the paired "remote" Runner run
on the same machine, so absolute remote numbers underestimate a real Hub
reverse-tunnel/lis-imac link; only the relative shape is meaningful there.

| startup metric | eager baseline (1dad739) | lazy build |
| --- | --- | --- |
| workspace visible after reload | 9.34s | 5.9–8.1s |
| active window 4 panes ready | 14.63s | **6.0–8.2s** |
| panes at load | 13 graphs booted, all ready 16.79s | **4 booted / 9 deferred** (w2=5, w3=4) |
| first activation of window 2 | already booted | **1.9–5.2s** |
| first activation of window 3 | already booted | **3.4–7.2s** |
| switch back to window 1 | — | **0.7–1.2s**, graph reused, no re-boot |
| parked pane usable + draft | — | **pass**: composer usable on activation; drafts survive window switches and a reload (active window draft restored; parked window still deferred, then boots and restores its draft) |

| heap (4 panes, same method) | eager baseline | lazy build |
| --- | --- | --- |
| 0 panes | 36.6–36.7 MB | 36.17 MB |
| 1 pane | 58.4 MB | 58.44 MB |
| 2 panes | 65.3 MB | 65.37 MB |
| 4 panes | 77.32 MB | **77.6–77.8 MB** (+0.4–0.6%, noise-level) |

| 54 retained-row bundle URLs | eager baseline (13 graphs at load) | lazy build (4 graphs at load) |
| --- | --- | --- |
| single-resource requests per Host | 54 | 55 (build row set drifts, still one per row) |
| span | 14.7s | 7.7–10.4s (by first window-2 activation) |
| parallelism (busy/span) | 1.45 | 1.55–2.34 |
| serialized-equivalent | 21.3s | 11.9–22.7s |
| max queued at once | 10 | 51 (prefetch + per-pane loader enqueue; request events, not wire concurrency) |

| remote Host pane first boot | eager baseline | lazy build |
| --- | --- | --- |
| click → Conversation ready | 2.20s | **2.0–2.8s** |
| row-URL span | 1.52s | 1.21–1.72s |
| row-URL parallelism | 3.28 | **5.0–6.1** |

The lazy build boots only the active window's four graphs; every parked pane
mounts a lightweight surface and fetches no bundle until its window is shown.
Booted panes are never unloaded (the boot gate latches on success only, so a
failed boot stays retryable) and switching windows reuses the graph, which keeps
drafts, dialogs, terminal and rightbar state. On top of that, the published
single-resource row URLs are prefetched into the shared per-Host artifact cache
with bounded concurrency (12 local / 6 tunnelled) before the official Loader's
dependency-ordered arrival resolves them; the loader, its compilation cache and
the graph synchronization are unchanged. No combo URL is constructed: the pinned
Host serves only its precomposed response map (phase combos plus one-row combos;
unknown URLs are 404), and no Host-side merge endpoint was added.

Residual risks observed during verification:

1. **Official `ui-sidebar-right` lifecycle log** (`Sidebar Session opening
   failed: ... Session reference ... is released`, pinned
   `dsh-client-ui-sidebar-right/lib/client.js:1640`): the eager baseline emits
   2 of these during its boot storm; the lazy build emits 0–2 during startup and
   3–6 only while the synthetic test rapidly switches windows/reloads. This is
   accepted as pre-existing `controller/openSession` churn in the official
   sidebar views, not part of the lazy-boot path; a controller-scope follow-up
   should reconcile view retirement with `reference.ready`. No `connection lost`
   / plugin-event transport errors were observed in the lazy runs.
2. **Enqueue burst**: prefetching plus four concurrent pane loaders can queue up
   to ~51 row requests at once on a fast local Host (baseline 10). Wire
   concurrency is browser-bounded and every URL is still fetched once per Host,
   but a queue-reservation form of the prefetch (reserve all row promises, one
   bounded worker queue) is the next optimisation if a real tunnel shows an
   adverse burst.
3. **Retained heap is unchanged by design**: deferred graphs are not allocated,
   but once the panes are opened the retained heap matches the eager build
   (77.6–77.8 vs 77.32 MB at 4 panes). Lazy boot only removes the startup cost.
4. **Remote Runner deploy overlap**: one combined verification run hit transient
   `HTTP 404/503` for a remote Runner artifact
   (`@deepseek-ai/dsh-client-ui-subagent/client.js`) while the release services
   were being restarted; the same remote-pane spec passed standalone immediately
   afterwards (`consoleErrors: []`). Treat remote artifact 404/503 in the first
   seconds after a deploy/restart as environmental, not a pane-surface defect.

## 4. Single-package seam plan (implemented layout)

```
src/client/surface/
    contracts.ts   Chassis contracts: PaneHost, SessionSource, SessionView,
                   PaneGraphPolicy, ChromeOwnership (one documented table).
    pane-graph.ts  PANE_GRAPH_EXCLUDE + PANE_GRAPH_POLICY.transform,
                   filterPluginEventData/projectPluginEvents (SSE projection),
                   paneRows() inventory helper.
    chrome.ts      PANE_SHADOWED_SLOTS + installPaneChrome (empty
                   sidebar.workspaces / shell.leading occupants per pane; the
                   sidebar shell and its settings subtree stay mounted/CSS-hidden).
src/client/pane-native.ts   One installer per pane Context: mountPaneNative
                   (remote namespace + pane-only HAPI surfaces), installPaneNative,
                   installPaneDocumentStyles (page-global style dedupe).
src/client/federation.tsx   Host runtime: bootHost/bootGraph, pane graph policy,
                   bootstrap refresh, filtered event stream, pane-native mount,
                   ordered teardown.
src/client/remote-pane.tsx  Official AppFrame + pane bridge + tools seat; the
                   conversation shell itself is unchanged upstream rendering.
```

Contracts intentionally stay internal to this package; there is no second
package and no new manifest entry. Adding a structural feature means adding one
module under `surface/` and wiring it in `federation.tsx`/`pane-native.ts`; the
primary graph, catalog graphs, remote adapters and Codex integration keep their
existing modules.

Pane-native ownership contract (Astra follow-up, implemented):

- exactly one installer per pane Context; a second `installPaneNative` throws
  instead of duplicating the `hapiWorkspace` locale namespace;
- installer throws unwind all completed registrations in reverse order;
- the federation disposes a stale install immediately if the pane was
  closed/superseded while `mountPaneNative` was awaited (generation + abort
  checked after the await);
- teardown order: pane React renderer first, then HAPI pane surfaces, then the
  retained `SessionReference`, then the graph; remote namespace unmount last;
- workspace stylesheet is page-global: a pane reuses the primary graph's style
  element and owns none, so closing a pane can never remove another pane's CSS.

## 5. Chrome / rightbar / settings / modals ownership

`ChromeOwnership` (`surface/contracts.ts`):

| surface | owner | behavior |
| --- | --- | --- |
| unified session list, window tabs, global tools, plugin pages | **window** (primary graph) | exactly one copy of the session list; panes shadow only `sidebar.workspaces` and `shell.leading` empty and keep the CSS-hidden official sidebar shell (see below) |
| official rightbar (Files / Document preview / Terminal tabs) | **focused pane** | stays in each pane graph by design: those resources are opened *as pane views* through the official `sidebarRight` occurrence + `hapiWorkspacePane`; removing it would break F01–F12 |
| settings modal | **focused pane** | the pane keeps the official sidebar shell so the official Settings root (launcher + modal + sections from the retained settings rows) is rendered/owned by the focused pane graph; excluded settings *subpages* (account/models/plugins/session-log/agent-loop/web-search/subagent) show as unavailable in a pane, while the primary window keeps the full set. Task-13 owns the visible launcher placement |
| third-party dialogs / portals | **focused pane** | each graph keeps its own modal stack; not moved between panes |
| official plugin pages (inventory/market/cordis/trajectory/schedule/… ) | **deferred in panes** | rows excluded from pane graphs; the primary graph keeps them |

**Sidebar shell decision.** A pane keeps the official sidebar shell mounted
(hidden by the pane CSS); it shadows only `sidebar.workspaces` (the session
list) and `shell.leading` (reopen controls). This is deliberately the smallest
shadow that removes duplicated window chrome while preserving the
`sidebar.settings` subtree: the official Settings trigger, modal, sections,
permissions and plugin contributions stay owned by the focused pane's graph,
matching the `settings: focused-pane` ownership above. Deleting the whole
sidebar seat would also delete the only public Settings root in a pane.

Focus moves do not migrate state: panes keep their own rightbar occurrence/tab
state and dialogs; the workspace pane bridge restores a saved rightbar target
from the pane's own navigation (`pane-bridge.tsx`, unchanged). Closing a pane
releases views and never terminates source execution — unchanged and re-verified
by the existing suite in Lead's integration run.

## 6. Retained pane graph inventory (54 rows)

Rows retained (bootstrap 70 − 16 excluded): `@deepseek-ai/dsh-client-modules`
(bootstrap kernel) plus:

- API/session/data: `dsh-api-gateway`, `dsh-api-job-controller`,
  `dsh-api-terminal-controller`, `dsh-api-workspace-files`,
  `dsh-api-remote-access`, `dsh-api-remotes`, `dsh-api-workspace-controller`,
  `dsh-api-session-controller`, `dsh-client-connection`, `dsh-client-resources`,
  `dsh-client-file-upload`, `dsh-client-hmr`, `dsh-typert-registry`,
  `dsh-session-log-export`
- shell/conversation: `dsh-client-ui-layout`, `dsh-client-ui-renderer`,
  `dsh-client-ui-session`, `dsh-client-ui-conversation`, `dsh-client-ui-chat`,
  `dsh-client-ui-approval`, `dsh-client-ui-tool`, `dsh-client-ui-attachment`,
  `dsh-client-ui-workspace`, `dsh-client-ui-jobs`, `dsh-client-ui-goal`,
  `dsh-client-ui-plan`, `dsh-client-ui-workflow-run`, `dsh-client-ui-commands`,
  `dsh-client-ui-input-trigger`, `dsh-client-ui-skill`,
  `dsh-client-ui-subagent`, `dsh-client-ui-reference`,
  `dsh-client-ui-secret-mask`, `dsh-client-ui-user-questions`,
  `dsh-client-ui-permission-presets`, `dsh-client-ui-model-selection`,
  `dsh-client-ui-deepseek-model-label-1017`, `dsh-client-ui-open-in-app`,
  `dsh-client-ui-directory-picker-browse`
- rightbar/files/terminal: `dsh-client-ui-sidebar-right`,
  `dsh-client-ui-sidebar-documentpreview`, `dsh-client-ui-sidebar-terminal`,
  `dsh-client-ui-sidebar-files`
- official deliverables surfaces: `dsh-client-ui-deliverables` — it registers
  the `present` tool renderer (`tool.call.toolview`, pinned
  `dsh-client-ui-deliverables/lib/client.js:2299`) and the changes-review
  right-column tab (`sidebar.right.pane.tab` plus its tab type at `:2307`), so
  it is a conversation/rightbar surface and is retained rather than treated as
  window chrome.
- look & locale: `dsh-client-ui-theme`, `dsh-client-locale`,
  `dsh-client-shortcuts`, `dsh-client-ui-shortcuts`,
  `dsh-client-ui-primitives`-family platform seeds (React/react-dom/cordis/zod/
  virtual/slots/primitives/dockkit are static modules, not graph rows)
- `dsh-client-ui-brand-official`

Excluded (16 present in the local graph + 1 not emitted locally): hapi-dsh,
ui-settings-account, cordis-client-runner, ui-trajectory, ui-schedule,
ui-settings-models, ui-agent-preset, ui-cordis,
ui-settings-plugin-inventory, ui-settings-subagent, ui-message-feedback,
ui-settings-web-search, ui-settings-plugins, ui-settings-shell,
ui-settings-session-log, ui-settings-agent-loop, product-analytics (absent from
the local graph). Rationale: settings subpages/inspectors/marketplace/analytics
surfaces that are window-level, plus the HAPI bundle; nothing conversation,
composer, header, rightbar, file, terminal, official tool renderer, or
deliverables related.

## 7. Verification performed

- `npx tsc -p tsconfig.client.json --noEmit` (also host, e2e): clean.
- `node --import tsx --test tests/pane-surface.test.ts`: 9/9 pass (row
  projection incl. retained `ui-deliverables`; single-resource batches with
  preserved phases; HMR graph-sync rewrite; excluded-rebuilt drop;
  foreign/malformed frame pass-through; SSE bytes split every 3 bytes incl.
  mid-UTF-8; per-stream decode-state isolation between two interleaved pane
  streams; cancellation propagating to the official event source). The
  interleaved-stream test fails if the decoder is module-level, so it pins the
  per-instance state requirement.
- `npx playwright test e2e/pane-surface.spec.ts`: 1 passed. Asserts: pane graph
  row subset; per-pane official Conversation text for 4 explicit references;
  empty sidebar/leading seats; no HAPI bundle fetch; heap and DOM curve.
- Not run in this task (Lead's integration run): full `npm test`,
  `npm run typecheck`, and the affected official-flow specs. Recommended order:
  workspace, plugin-workspace, artifact-plugins, notify-summary, dsh-children,
  collaboration, admin, appearance, composer-enter, share-picker,
  workspace-interactions.

## 8. Risks and accepted trade-offs

1. **Body-only remains upstream-blocked.** A pane graph still mounts AppFrame;
   residual frame DOM/listeners remain (~1.1k nodes/pane). Removing it needs an
   upstream public entry that renders `main.conversation` outside `root` (or a
   multi-conversation-per-graph seat). Do not re-implement the conversation.
2. **Filtered pane feature surface (accepted loss).** Settings subpages
   (account/models/plugins/session-log/agent-loop/web-search/subagent), the
   plugin inventory/market pages, trajectory and schedule inspectors, and
   product analytics are not evaluated in panes. A pane that navigates there
   shows an unavailable page; chat/rightbar/files/terminal/tool renderers and
   the official deliverables surfaces are unaffected. The pane still owns the
   official Settings root (sidebar shell retained), so its available sections
   work; the full section set remains in the primary window. Task-13 owns the
   visible launcher placement.
3. **Third-party `sidebar.workspaces` contributions don't render in panes**
   (that one seat is shadowed). Contributions into the rest of the retained
   sidebar shell (e.g. `sidebar.settings`/footer seats), the conversation,
   composer, header, and rightbar still render; this matches "one session list
   per window".
4. **Root-captured browser globals in pane-native** (Astra): the pane-installed
   HAPI code now runs in the primary bundle's lexical scope. It was audited for
   `document`/`localStorage`: page-global CSS is deduped, dialogs/portals use the
   window document (same as before for root-graph contributions), and
   child-command recovery persistence (`source-dsh-child.tsx`) now uses root
   `localStorage` instead of the per-pane `localStorage` facade. Keys are
   session/local-id scoped, so this is accepted; a future pane-local entry can
   restore strict per-pane storage if QA finds cross-pane collisions.
5. **Per-pane polling amplification** remains: each pane graph polls Host APIs.
   Orthogonal to the graph filter; candidate for a shared catalog/poll plan.
6. **HMR**: graph syncs are projected per pane and rebuilds of excluded rows
   dropped, unit-tested; a full live HMR rebuild across four panes was not
   exercised in this task.
7. **First-pane cost** (+21.7 MB) includes one-time compiled-cache entries for
   the retained rows (53 measured, 54 after retaining `ui-deliverables`; the
   extra ~111 KB row is expected to add well under 1 MB/pane at boot). It is paid once per page; subsequent panes cost ~6 MB.
   Further trims available without structural change: exclude
   `ui-plugin-manager` (626 KB) and `ui-settings`/`ui-settings-general` chrome
   rows from panes if task-13/15 accept losing those pages there.

## 9. Files changed

- new `src/client/surface/contracts.ts`
- new `src/client/surface/pane-graph.ts`
- new `src/client/surface/chrome.ts`
- rewritten `src/client/pane-native.ts`
- edited `src/client/federation.tsx` (pane graph policy, bootstrap refresh,
  filtered plugin events, pane-native mount + teardown ordering, generation
  checks)
- `src/client/index.ts` unchanged in this task (pane branch already extracted by
  the Lead's base change)
- `tests/pane-surface.test.ts`: row-projection/HMR tests + SSE projection tests
  (chunk splitting incl. mid-UTF-8, per-stream decode isolation, cancellation)
- new `e2e/pane-surface.spec.ts`
# 2026-10-22 当前性能修正

初始历史预取最多两页，已保留窗口达到 1500 个协议事件后不再自动补页。共享 Conversation 外层只订阅实际呈现阶段，正文流和草稿更新由各自的官方组件订阅处理。

预热缓存仍最多保留五个会话、并发打开两个；单个窗口超过 1500 个协议事件时释放该缓存的 reference。现有可见或隐藏 Pane 自己持有的 reference 不受影响；最后一个实际视图关闭后，官方 Session 生命周期才能回收这份大历史。这里没有修改官方事件窗口，也没有实现活跃视图中的窗口 trim。

当前阶段只做类型、逻辑和发布连通性检查，实际首开耗时与长会话交互由用户手测。

共享会话 Pane 激活时开始记录 `pane.reference.ready`、`pane.content.mounted` 与 `pane.composer.mounted`，进入现有诊断导出。同一次打开使用相同 request ID；`warm` 表示激活前官方会话已 open，`cold` 表示尚未 open。只读取 DOM 标记，不记录消息、草稿或附件内容。空会话不伪造正文耗时；30 秒内未齐、隐藏、关闭和失败分别留下 incomplete 记录并停止观察。纯性能记录不会单独弹出诊断浮标。

这里的时间从 Host graph 可用后开始激活 Pane 算起，正文和输入框记录的是 DOM 挂载，不是屏幕绘制或交互完成；它不涵盖此前 Host 冷启动/隧道建立耗时。该实现完成 12 项相关逻辑测试及 Client 类型检查，实际浏览器耗时尚待用户手测采集。

## 2026-10-22 DSH Web 本地构建样式修复

独立 DSH Web 从本地目录构建，CSS Modules 类名与主站 npm 构建不同；官方 CSS 标签的 `data-plugin-css` 却只包含包名和文件名。此前远端 document facade 把样式查找转给整页 document，同名标签使远端跳过注入，形成正文和输入框布局失效。

现在样式查询限定在各 graph 自己的容器；普通 DOM 查询仍可找到容器外的会话 portal。模块加载器使用未经修改的 pinned 官方 bundle，在同一 document facade 中求值，因此样式归属记录和 HMR 清理也不会跨 Host。没有修改独立 DSH Web 的源码或会话数据。

14 项定向逻辑测试通过，包含真实 pinned CSS 注入代码的同名冲突复现、分 Host 样式加载/清理，以及真实官方模块加载器的样式归属检查。DOM 为协议夹具，未运行浏览器或截图验收。
