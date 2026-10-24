# Mobile workspace navigation

The mobile conversation no longer reserves a pane title/status row. A single-pane window omits the P1 strip; split windows retain P1/P2 navigation. The bottom-left arrow opens the conversation list without releasing the view. Returning to the current conversation preserves its draft and reading position. Choosing another conversation still replaces the focused pane, and desktop selection keeps its existing latest-message behavior.

The list opens without focusing search. Search expands and receives focus only after the user selects it. Its return control is a 44px arrow rather than a narrow, wrapped text button. Pane actions remain available in the bottom menu. Source errors and delivery receipts use the focused pane's bottom status slot on mobile and its title bar on desktop. Stable slots retain their pane identity through viewport changes; receipt navigation observes only the corresponding pane and slot.

## Validation

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

## Publication

`npm run deploy` passed typechecking and all 1,163 logical tests (1,162 passed, one skipped, zero failed), rebuilt the client, and passed authenticated HTTP and compressed WebSocket checks. The served asset contains the exact local client bundle, 1,301,876 bytes, built at `2026-10-24T03:18:11.155Z`.

The display Host stayed active with its existing start time, `Fri 2026-10-23 09:33:14 PDT`, and `NRestarts=0`. No Host, Hub or Runner restart was performed.
