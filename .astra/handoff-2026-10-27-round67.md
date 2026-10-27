# HAPI-DSH handoff — round 67 (2026-10-27)

## Truth as of now

- Real deployment: `https://hapi-dsh.tail.lixinrui000.cn`, Host `127.0.0.1:3090`, Hub `127.0.0.1:3006`.
- Client-only publishing works: `npm run build:client` + prod rev check (`.tmp/gates/prod-check-version.mjs`). Host was NOT restarted; no token rotation.
- Latest prod client rev built this session: see `.tmp/build-client-r66c.log` / run prod-check.
- Worktrees remain uncommitted: `/mnt/cache/src/hapi-dsh` (~150 files), `/mnt/cache/src/dsh-ext` (8).

## What is actually verified

On the real HAPI session (display row "DSH 扩展架构与补丁部署排查"):
- multi-page "Load earlier" reaches the oldest page; button disappears; no internal RPC text.
- anchor drift during prepend: 0px (after trim deferral).
- continuous wheel frames: p95 17ms, max 50ms.

Warm fixture (official acceptance):
- Best result **21/22** achieved after the structural change below.
- Latest runs fluctuate 20–21/22 because `cached history reversal does not reload` is flaky.
- Remaining failure: `live updates preserve reader and editor` (element not found).

## Key structural decision (do not undo)

Older paging is owned by the official `ClientSession.loadOlder()`; the façade
(`src/client/source-sessions.ts`) only mirrors, retains and anchors the window.
This raised warm from 19/22 to 21/22. Consequently 11 old contracts that assert
the façade owns paging now fail — they must be rewritten, not the behavior.

## Live updates diagnosis (precise)

- Data reaches the façade: marks `live:change`, `live:append:append`,
  `live:flush-start`, sometimes `live:flush-end`.
- Programmatic `scrollTop = bottom` does NOT set official `data-chat-following-tail`;
  new nodes stay below the viewport and are virtualized away → locator finds nothing.
- Tried and reverted (all caused regressions or had no effect): synthesizing
  `input('down')`, removing the non-following live filter, auto-clicking the
  official to-bottom button on scroll.
- Correct next step: ext patch (0004) to make programmatic landing at the live edge
  count as following (or expose a sanctioned follow setter), then let the existing
  `flushLive` filter stand. Plugin must not fake scroll/input.

## Contracts

`client-source-sessions-contract` currently **46/57**. Failing 11:
1. pending loadOlder publishes loadingOlder, then publishes completion and exhaustion
2. actual viewport admission passes measured page sizes while ordinary paging retains its default
3. a rejected tail loadOlder after release does not fall back to the original pager or mutate the window
4. opening 8-turn seed recovers its omitted prefix before source paging (archive true)
5. opening 12-turn seed recovers its omitted prefix before source paging (archive true)
6. prepared latest pages preserve separate before and after epochs at publication
7. an older page keeps its readable beginning until its reader releases it (move/hide/unregister)
8. a pending page survives an extended trailing span, changed geometry overscan and an empty forward repair
9. viewport eviction preserves source cursors for complete backward and forward traversal

Rewrite direction: assert official `/api/session/page` as the paging path; façade
assertions limited to mirroring/retention/anchor. Keep test names meaningful.

## Next actions in order

1. Rewrite the 11 contracts to the official-pager-owner semantics; get 57/57.
2. Stabilize `cached history reversal does not reload` (suspected async `adoptOlderCursor`
   issuing an extra page request; it is required by contracts, so make it conditional
   on a genuinely incomplete window, not cache-complete).
3. ext 0004: programmatic live-edge → following in dsh-client-ui-chat; rebuild ext
   artifacts/manifests; warm live must pass.
4. Run warm 3× requiring 22/22 each, then Astra review and six gates.
5. Update `.astra/verify-package.md` with this evidence; do not claim closure earlier.

## Trap list (do not repeat)

- Closing a pane then clicking a discovered pending-source row: `openSourceSession`
  now has a 15s timeout + visible error (implemented).
- Warm fixture: must stop previous fixture, wait ~8s, then `run-warm.sh`; stale
  fixtures produce identical bogus failures.
- Chromium: use fixed `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; bare `chromium.launch()`
  fails under the warm HOME.
- Do not add bottom-follow logic in the seamless controller: it breaks cached-history
  accounting and disconnected anchor stability.

## ext 0004 plan (round 70 findings)

Repository: `/mnt/cache/src/dsh-ext` (full DSH fork), branch `ext/0.2.1-rc.3`,
HEAD `dcdf7e9d`. Series lives in `ext/patches/0.2.1-rc.3/`:
- `0001-history-source.patch`
- `0002-mounted-chat.patch`
- `0003-window-commit.patch`
- plus `series`; release/artifact metadata in `ext/releases/0.2.1-rc.3/`,
  `ext/releases/active-rc.json`, compatibility matrix templates.

Live-follow source files (the patch target for 0004):
- `packages/client/ui-chat/src/client/chat/use-chat-scroll.ts`
- `packages/client/ui-chat/src/client/chat/use-chat-reading.ts`
- `packages/client/ui-chat/src/client/chat/ChatView.tsx` (writes `data-chat-following-tail`)
- tests: `packages/client/ui-chat/tests/fold-follow.client.spec.ts`

Change shape for 0004: a scroll sample that lands on the live edge but was not
produced by a reader gesture should re-enter `followingTail`. Today that path is
gated on `movedByReader`; keep the default path byte-identical behind an opt-in
switch (ext capability flag, default off) and enable it from the hapi-dsh
composition. Add an ext contract test for:
1. programmatic `scrollTop = scrollHeight` then append -> new row mounted/visible;
2. reader scrolled away -> append must not move the reading position;
3. default-off behavior unchanged.
Then rebuild ext artifacts/manifests and reinstall into the hapi-dsh runtime
before rerunning warm acceptance.

## ext 0004 implemented (round 75)

`dsh-ext` branch `ext/0.2.1-rc.3` now has 0004:
- `bf6aeedc` opt-in `setFollowOnProgrammaticEdge` in ui-chat use-chat-reading
  (+ `ext/adr/0004.md`)
- `08dc38b7` export from ui-chat client entry
- `5838efbe` cumulative patch `ext/patches/0.2.1-rc.3/0004-programmatic-live-edge.patch`,
  `series` updated
Default off; stock consumers unchanged. Remaining for 0004:
1. ext contract tests (programmatic edge follow / reader-away unchanged / default-off);
2. regenerate the rc.3 release artifacts + manifests/checksums;
3. conditionally enable from the hapi-dsh composition only when the patched
   package is present (feature-detect the export, never assume);
4. `node scripts/bundle/pack.mjs --ext-release <dir>`, install the runtime,
   verify live on a real Host, then rerun warm.

## rounds 75-77 update

ext 0004 is now complete at the source level and tested inside dsh-ext:

- `dsh-ext` HEAD `259a5279` (branch `ext/0.2.1-rc.3`):
  - module-scope `setFollowOnProgrammaticEdge` (default off) in
    `packages/client/ui-chat/src/client/chat/use-chat-reading.ts`;
  - exported from the ui-chat client entry;
  - `tests/live-edge-follow.client.spec.ts` — 3/3 passing (stock off unchanged,
    opt-in follows, reader away not pulled);
  - `ext/patches/0.2.1-rc.3/0004-programmatic-live-edge.patch` (87 lines, with
    test) + `series` + `ext/adr/0004.md`; worktree clean.
- Remaining to make it effective end-to-end:
  1. build the real rc.3 ext release (artifacts + manifest/checksums);
  2. `node scripts/bundle/pack.mjs --ext-release <dir>` and install the runtime;
  3. enable the switch from the hapi-dsh composition only when the patched
     package is present. Today `src/client` imports ui-chat only as `import type`,
     so first establish how the browser runtime provides that package
     (external/remote module) before adding a runtime `import` call. Alternative
     acceptable route: ext reads an existing composition flag instead of the
     plugin calling a ui-chat export;
  4. real-Host live verification, then warm acceptance (currently 21/22 with the
     placeholder ext fixture; live is the only failure).
- Also still open: rewrite the 11 source-session contracts to the
  official-pager-owner semantics (46/57 today).

## round 79-80: publication truth check

- Both worktrees clean: hapi-dsh `f8409e819`, dsh-ext `259a5279`.
- Production is NOT running the latest client: served bundle hash
  `15c5f258683044c3` vs local `5c4f7a034ae72fc2` (`same: false`).
- `npm run deploy` fails (exit 1) because it gates on typecheck + the full test
  suite, and 55 tests currently fail. Main groups: the 11 source-session
  contracts changed by the official-pager-owner decision, plus related history
  window/live tests (`pending loadOlder…`, `actual viewport admission…`,
  `a rejected tail loadOlder…`, `opening 8-turn seed…`, `live append is
  bounded…`).
- Therefore earlier "client-only published" statements were wrong: only the
  local dist changed; production still serves the previous bundle.
- Order to finish: (1) rewrite/repair those tests until the full suite is green;
  (2) `npm run deploy` and verify served == local; (3) build real rc.3 ext
  release with 0004, `pack.mjs --ext-release`, install runtime; (4) real-Host
  live verification and warm 22/22; (5) Astra six-gate review.

## rounds 81-84: green suite, published client, ext.4 built

- Full test suite: 1696 tests, 1695 pass, 0 fail (was 55 failing at round 81).
  Root fixes: `ensureDisplayAgent` no-ops without native/observed engines;
  loadOlder distinguishes seed/tail/target modes with a facade fallback page
  reader; direct pages prefer the explicit before cursor, pass exact measured
  sizes, preserve the forward boundary and skip exact replays; `returnToLive`
  keeps an authoritative resident tail; older prepends merge in place.
- `npm run deploy` passes and publishes the client without restarting the Host
  (served bundle equals local dist plus the appended sourceMappingURL line).
  Commits: 1bd39c285, 66ac3a751, bb4629c4c.
- Warm: stationary prepend passes; `live updates` still fails — the streamed
  text never appears in the pane DOM (`hasStreaming: false`, anchors 291-320,
  nodes ~7k). Relaxing the live filter grows the window but the text still does
  not render, and it breaks live/races contracts, so the stock filter stays.
  `continuous up and down` long frame fluctuates 416-866 ms (>200 budget); CPU
  profile is dominated by browser (program)/layout, client JS self-time is small.
- ext.4 is ready in `dsh-ext` commit `2c5dfd3c`:
  `ext/releases/0.2.1-rc.3/ext.4/` has the three tarballs, manifest.json and
  release.json (patchSet sha b3101919…, capabilities historySource/mountedChat/
  windowCommit). ui-chat was rebuilt with 0004 (`setFollowOnProgrammaticEdge`
  present in lib/client.js).
- Next: `npm run bundle:pack -- --ext-release /mnt/cache/src/dsh-ext/ext/releases/0.2.1-rc.3/ext.4`,
  install that bundle into a DSH profile/runtime, enable the 0004 switch from the
  hapi-dsh composition (feature-detect; ui-chat is currently type-only in
  src/client), verify live streaming on that runtime, then retest warm and the
  remaining frame budget.

## round 85: production HAPI Main failure — new root-cause candidate

Production probe after the latest deploy:
- Clicking the display row "HAPI Main" opens the conversation with body and
  `Load earlier` (flow present). A fresh page shows no restored panes, so the
  screenshot's hard error is not reproducible via a plain row click.
- The probe did capture a real conversation-stream error:
  `[session-controller] event feed subscriber failed: Error: conversation
  Context 12:turn-process1000003 received an update before its start Match`
  (ConversationNodeAssembler.replayContext). This ordering violation can prevent
  the Chat from mounting, which would surface exactly as
  "The source conversation could not open its usable editor and first history
  viewport" after the admission retries time out.
- `session-view` admission retries were widened (visible pane: 40 attempts,
  up to a bounded minute; detached still stops) and deployed in commit
  `975ff07e4`. That removes the two-second hard failure but does NOT fix the
  ordering bug.
- Next: find which path feeds a turn-process update without its start to the
  official assembler (candidate: live append after a snapshot replace slices
  events by `liveSeqBase`, dropping start rows while keeping updates; or win-
  dow trim dropping a start group). Reproduce deterministically in warm by
  asserting no `event feed subscriber failed` in console, then fix ordering.

## round 86: production pane crash fixed (null event data)

Reproduced on production with full stack:
`[session-controller] event feed subscriber failed: TypeError: Cannot read
properties of null (reading 'turn') at payloadCoordinates ←
ConversationLocationIndex.rebuild ← ConversationNodeAssembler.prepend ←
BoundConversation.accept`.
An event with `event.data === null` reached the official conversation assembler
from a source page prepend, crashing the feed subscriber so the pane could never
mount; the UX symptom is exactly the HAPI Main screenshot error.

Fix (commit `e205260ca`, deployed): every entry/change emitted into the official
eventSource is normalized to an object payload (`data: {}` when null/undefined),
with a one-time warning per offending event type. Verified on production:
opening HAPI Main twice → `flow: true`, no "could not open its usable ...", no
event-feed/ordering errors, no normalization warnings in that run.

Also deployed earlier this round: widened initial viewport admission retries
(`975ff07e4`) so restored/split panes get up to a bounded minute instead of
failing after two seconds.

## rounds 87-100: live output reaches the DOM; suite green; deploy green

Root cause chain for `live updates` (diagnosed with performance marks + data
mining, not guessing):
1. every live event arrived (7x `live:queue:1:<type>` including
   `assistant/live-chunk`), but the non-following reader filter dropped them;
2. relaxing that alone was not enough: `flushLive` then hit
   `live:retention-fail` — the retained window was at its budget, so the live
   row could not be appended and the rest of the stream was withheld;
3. stale reader pins caused the same failure even when the unpinned window fit.

Fix (commit `9608390a8`):
- only a real `liveGap` withholds live rows;
- if the unpinned window fits, ignore the stale pin conflict and append;
- if live output overflows, evict the older side (before/after cursors kept
  recoverable) instead of dropping the stream;
- `flushLive` no longer trims streaming rows away.
Result: warm live check reached `hasStreaming: true` and the pane renders the
streamed answer; contracts updated to live-visible semantics
(live-window 31/31, races 14/14, full suite 1695 pass / 0 fail, deploy OK).

Warm acceptance remains flaky on machine load: best run 21/22 (only
`first body and editor` over its 1500 ms budget), other runs 20-21/22 with
`continuous up and down` (max frame 400-1100 ms vs 200 budget) and occasionally
the live check. Same bundle passes once and fails next, so these are
timing/budget noise or remaining scheduling work, not a deterministic failure.
Next: run warm repeatedly on an idle host, capture CPU profiles for the long
frames, and only then judge; do not claim closure until three consecutive
22/22 runs.

## rounds 101-112: scroll budget fixed; live DOM update remains

- Retained window reduced to 1500 events: warm continuous scroll now p95 16.8 ms,
  max 33-183 ms, no long tasks (was 400-1100 ms with 13k DOM nodes). Long-task
  attribution + mark correlation added to the UI probe; the acceptance report
  now records `longTasks` and per-sample `marks`.
- Cold open fixed after the reader-activity clock started at -infinity and only
  reader-owned scroll samples mark activity (warm body 344-360 ms).
- `flushLive` commits are gesture-deferred (160 ms quiet) and automatic earlier
  page loads wait out an active wheel.
- Live: all batches now map and commit (marks `live:queue` -> `live:mapped`),
  a fresh `plugin:hapi-dsh/execution` clears eviction gaps, fresh turns only
  clear eviction gaps (never omitted history), live-path trims no longer raise
  gaps, and new display seqs allocate above the real resident tail.
  BUT the official event source entry count stays constant (`live:flush-end:1187`)
  after those appends and the DOM never changes (`hasStreaming: false`,
  anchorKeys 333): appends are being swallowed silently, so the streamed text
  still does not render. Next: add `live:commit:<kind>:<entries>` marks plus a
  try/catch around the commit path and inspect whether `append` is rejected,
  whether `hasLateSourceRows` routes to replace, or whether the visible pane is
  bound to a different façade record.
- Suite 1695 pass / 0 fail; deploy ok (commit `6ac9abe52`); warm best 21/22 with
  live the only deterministic-looking failure left (first body/scroll now pass).

## rounds 113-116: mobile overlap, rotated upload recovery, clean placeholders

Mobile screenshots (`sh.tail...`/`pi.tail...`) showed ghosted overlapping
transcripts and a `会话不可用` composer, plus `[Source resource unavailable: …
ENOENT … hapi-blobs/<sid>-3mPNEL/…]` inside the chat.

Findings:
- Two windows/panes were both laid out at inset 0 on mobile; hidden ones used
  `visibility:hidden` with stored dimensions, so child compositing could leak.
  Fix (`32d086081`): hidden panes use `display:none`; inactive mobile windows
  use `display:none` in CSS. Verified on production layout: inactive window
  `display:none`, active one block, composer normal.
- The queued screenshots referenced a HAPI upload dir
  `.../hapi-blobs/<sid>-3mPNEL/` that had rotated; the same original filenames
  still exist under `<sid>-cxpChI/`. Host `sourceUploadImporter` now falls back
  to sibling `<sessionId>-*` directories and imports those bytes; missing
  resources render `[Source resource unavailable: <filename>]` without paths or
  transport text (full error goes to the Host log).
- Both Host-side changes (attachments.ts, content.ts) activate only on the next
  Host restart. The client-side hiding fix is already deployed.
- Warm after these changes: cold open 344-360 ms, scroll p95 16.8 / max 183 ms,
  only `live updates` remains (see previous section: event source append count
  stays 1187 despite mapped commits — next diagnostic is commit-kind/length
  marks plus whether the visible pane is bound to a different facade record).

Next: (1) Host restart to activate upload recovery + placeholder, then purge
`*.opening.json` observed caches so the affected conversation re-syncs and the
screenshots import; (2) finish live DOM commit diagnosis; (3) warm 3x22/22 and
Astra review, ext.4 wiring.

## rounds 117-129: live streaming root causes and warm 22/22 milestone

- Live commit diagnostics showed the official event source growth (append/replace)
  and the retained window length at each step. The remaining live failure was
  two-layered:
  1. fast-seeded native displays treated indexed `messages-invalidated` as a
     full archive sync; provisional snapshot updates were rejected as changed
     durable rows, so only the first chunk ever reached the client. Fixed in
     `src/codex/agent.ts`: native-history invalidations always use the
     incremental live path (`readNativeHistoryUpdate` under the cached epoch),
     and stale opening fallbacks skip the settings refresh so their read fault
     stays visible until history succeeds.
  2. the pinned retention plan could drop the row that was just streamed after
     commit; the client now trims as before and restores any dropped accepted
     row with fresh seqs, and live commits use cheap appends instead of a full
     window replace.
- Warm acceptance reached **22/22 (0 failures)** once with the replace-based
  live commit; subsequent runs are 21/22 with only `live updates` failing at the
  second cumulative chunk (first chunk always renders; scroll p95 16.8 / max
  183-233 ms). Full suite 1695 pass / 0 fail; commits `6fff3d753`, `9998a5f1b`.
- Host dist rebuilt and client deployed; production Host still needs a restart
  to activate the host-side incremental live fix.

## round 130 status

- Warm: two of the last three runs passed 22/22 in full (append-based live
  commits + incremental indexed reads + drop restoration); the occasional flake
  is the second cumulative live chunk not becoming visible within 1500 ms even
  though its text-delta commits (`after-commit` grows, DOM keeps only the first
  chunk). Acceptance now records `streamTexts` and the live commit sequence.
- Full suite 1695 pass / 0 fail. Commits `2dccf77b3` plus earlier `9998a5f1b`,
  `6fff3d753`. Client deployed and Host dist rebuilt.
- Production Host restart is scheduled by a detached systemd unit to activate
  the attachment recovery + incremental live fixes (user authorized restarts).
- Next: if the second-chunk flake persists, check whether the official
  conversation publishes `assistant/live-chunk` updates on animation frames that
  are starved in the warm harness; otherwise force a cheap render nudge after
  appending, then run three consecutive 22/22 and move to ext.4 wiring + Astra.

## rounds 131-84: ext.5/ext.6 distribution closed loop, Astra gate verdict

- ext 0004 gained a generic composition opt-in: exported setter OR
  `document.documentElement.dataset.dshFollowEdge = "1"` (renamed from the
  HAPI-specific name after Astra's architecture review). ext contract 4/4.
- Packed real releases ext.5 (93372e19) and ext.6 (9d02dba0), repacked bundles
  with `bundle:pack --ext-release ...` and verified the full isolated-home
  lifecycle: install healthy → repeat install `changed:false` → rollback to the
  previous ext → re-upgrade healthy; runtime identity seals 306 files and the
  served private-runtime ui-chat bundle contains the setter + generic marker
  (no HAPI-string in patch or served bundle).
- Installer fix `d23626785`: release re-verification skips generated symlinked
  trees (`runtime/`, `package/`, unpacked ext) while still enforcing SHA256SUMS
  on every copied file; previous idempotent reinstall failed there.
- Final artifact evidence: bundle sha
  `fbeaeaa0c2eb44b5c6c604d9712eb7e4fbe0a708ce61b3e9c2e918c7b2ebd9b2`,
  release `a0b65898d1037406`, extRelease 6. hapi-dsh marker commit `c877d277a`.
- Astra round 10: six gates all NOT_EXECUTED; acknowledged sub-evidence is
  real-artifact isolated install + idempotent reinstall + rollback/upgrade
  chain. Remaining: behaviour-level on/off on the installed artifact
  (setter-only/marker-only/both-off ×3), 3 consecutive warm 22/22 on the final
  artifact, then G1–G6 samplers (20 cold opens, paging matrix, capacity,
  dynamic composition matrix, Host+2Runner tamper, 3-round upgrade/rollback
  with fault injection).
- Warm on repo runtime: intermittent 22/22; remaining flake is the second live
  chunk's 1500 ms visibility and load-dependent cold-open variance. Dev warm is
  not yet the final-artifact run Astra requires.

## round 85: artifact-level warm acceptance on the installed runtime

- Warm harness supports `HAPI_DSH_E2E_MANAGED_HOME` (+ profile): copies the
  bundle-managed profile and state, restores the absolute hapi-dsh link, adds
  the fixture provider with the installing user's pnpm store, and records Host
  diagnostics/page text on failure.
- First artifact acceptance (ext.6) is 20/22: live streaming renders all six
  chunks in 90-312 ms, openings 29-44 ms, continuous scroll and paging pass.
  The two failures are anchor drift while streaming/reconnect on the patched
  official Conversation (47 px / 53 px); dev (unpatched) passes the same checks.
- Ext 0004 marker is default-on but has a kill switch
  (`globalThis.__hapiDshFollowEdgeDisabled`, warm `HAPI_DSH_FOLLOW_EDGE=0`).
  Marker-off runs show the same drift, so 0004 is not the cause.
- Latest artifact: sha `4d880735c963047483265c4721da83e26fcfbf26afda69f281010ff527263b13`,
  release `165b3806ac9df4ad…`, extRelease 6; repeat install `changed:false`.
- Next: make live window accounting scroll-neutral (defer trim/eviction while a
  stream is active and correct at idle), re-run artifact acceptance to 22/22,
  then three consecutive final-artifact warm runs, the 0004 on/off matrix and
  the G1-G6 samplers.
