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
