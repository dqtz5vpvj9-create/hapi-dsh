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
