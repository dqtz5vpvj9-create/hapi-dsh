# Mobile workspace navigation

The mobile conversation no longer reserves a pane title/status row. A single-pane window omits the P1 strip; split windows retain P1/P2 navigation. The bottom-left arrow opens the conversation list without releasing the view. Returning to the current conversation preserves its draft and reading position. Choosing another conversation still replaces the focused pane, and desktop selection keeps its existing latest-message behavior.

The list opens without focusing search. Search expands and receives focus only after the user selects it. Its return control is a 44px arrow rather than a narrow, wrapped text button. Pane actions remain available in the bottom menu. Source errors and delivery receipts are now inside the existing pane menu under “Source status and receipts”: the bottom menu on mobile and the title-bar menu on desktop, without a separate warning button. Stable slots retain their pane identity through viewport changes; receipt navigation observes only the corresponding pane and slot and opens the containing menu.

## Initial mobile-navigation validation

The final candidate ran against the pinned official DSH Host and Conversation with synthetic native-source sessions. No real messages were sent.

- `e2e/mobile-chrome.spec.ts`: both 360px and 390px scenarios passed in 36.9 seconds. They cover touch navigation, single/split layouts, drafts and session identities, reading-position drift of at most 1px after returning, explicit search focus, source-status isolation, same-page desktop/mobile transitions, and a separate 1440px desktop context.
- `e2e/mobile-scroll.spec.ts --grep 'repeated touch scrolling'`: both scenarios passed in 40.2 seconds. The tests include delayed history insertion, streaming and inertia. Reverse movement, blank frames and composer displacement were zero; the hidden header stayed at zero height. Paging concurrency remained one.
- The 17 reading-binding tests passed, including four new cases for asynchronous footer receipts, sibling-pane isolation, approval scope, and cancelling waits when a pane hides.
- All 11 final webshot images were opened and visually inspected. They show no extra mobile title row or horizontal overflow, and the list return control no longer wraps into three lines. Screenshot replay checks that it does not replace the saved window structure.

| Mobile width | Earlier/later frame interval p95 | Maximum frame interval |
| --- | --- | --- |
| 360px | 16.8 / 16.8ms | 50ms |
| 390px | 33.3 / 16.8ms | 66.7ms |

These are local Chromium mobile-emulation results, not physical-phone or remote-network measurements. The early candidate exposed search autofocus; the fix was exercised in the final run. A separate screenshot-helper error replaced a pane while waiting for its title; the helper now waits for the saved view and uses existing pane tabs, with window-structure assertions before and after replay.

Logs and browser evidence are in `/mnt/cache/data-cache/hapi-mobile-chrome-final.log`, `hapi-mobile-chrome-final-results/`, `hapi-mobile-chrome-scroll.log`, and `hapi-mobile-chrome-scroll-results/`. Final images are in `/mnt/cache/data-cache/hapi-dsh-visual-review/`.

## Initial publication

`npm run deploy` passed typechecking and all 1,163 logical tests (1,162 passed, one skipped, zero failed), rebuilt the client, and passed authenticated HTTP and compressed WebSocket checks. The served asset contains the exact local client bundle, 1,301,876 bytes, built at `2026-10-24T03:18:11.155Z`.

The display Host stayed active with its existing start time, `Fri 2026-10-23 09:33:14 PDT`, and `NRestarts=0`. No Host, Hub or Runner restart was performed.

## Source-status menu follow-up

Old indeterminate receipts previously kept a separate red warning button visible indefinitely. They now remain queryable under the existing pane menu, with no independent status button. Checking an indeterminate receipt explicitly reports when the source still has not confirmed delivery. This does not settle, resend, or discard the receipt. Approvals remain in the conversation dock.

The source-presentation and mobile-chrome browser specs passed all four cases in 1.1 minutes against the pinned official DSH runtime and synthetic source sessions. Inspecting the screenshots exposed left-edge clipping in the expanded 360px menu. Including padding and borders in its maximum width fixed that issue; the final source-presentation rerun passed both cases in 33.4 seconds, including new left/right menu-boundary assertions. Its six screenshots cover closed and expanded menus at 1440px, 390px, and 360px, including the check-result feedback. All 13 distinct screenshots across both specs were opened and inspected; the final six menu screenshots were recaptured and reviewed after the width fix.

All 17 reading-binding tests passed. Explicit receipt navigation now opens both the outer pane menu and nested receipt details while preserving pane-scoped lookup, observation, and approval handling. Browser checks also confirmed that refreshing unknown receipts sends and cancels no messages, while a real synthetic queue entry can still be retrieved for editing.

Final browser evidence: `/mnt/cache/data-cache/hapi-dsh-status-menu-final-e2e.log`, `hapi-dsh-status-menu-final-results/`, and `hapi-dsh-status-menu-review/`. These are local browser and mobile-emulation results, not physical-phone measurements.

The follow-up client release passed typechecking, 1,162 logical tests (one additional test skipped, zero failures), and authenticated HTTP/compressed WebSocket checks. The served asset contains the local 1,302,332-byte client bundle built at `2026-10-24T03:29:29.696Z`. The Host retained its original start time and `NRestarts=0`. Release output is in `/mnt/cache/data-cache/hapi-dsh-status-menu-release.log`.
