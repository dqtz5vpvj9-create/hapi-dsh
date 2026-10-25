# Complete-conversation observer validation

The observer now rejects transient partial conversations and later capability loss. This is a test-infrastructure change; the complete-conversation product contract remains **FAIL / UNVERIFIED**. No product release is established by this report.

## Changes

The observer checks stable editor, scroll-root and view identities, the first painted target body, actual history request/commit evidence, exact navigation targets, retained input and the observation window after source/display activity. A later recovery does not erase an earlier failure. Desktop navigation uses the official turn rail. Mobile return-to-latest is a separate action; it cannot stand in for an unvisited older target.

Production probes require the exact Hub, source, view and source-confirmed text. Display resolve/lease requests are scoped to that source; native commands remain blocked. A probe refuses to type into an existing nonempty draft or an ambiguous editor, and only clears its own unchanged marker. These probes still require real-target execution and review of any blocked request before their results are used for product acceptance.

## Evidence actually obtained

The parent ran the browser sampler controls in Chromium, one worker, against explicitly synthetic `data:` pages. The first run passed 16 cases in 1.2 minutes, covering a painted partial frame shorter than 100 ms, initial wrong body, nonempty replacement, copied/remounted editor, draft replacement, DOM-only fake paging, broken paging/navigation, mobile return-to-latest, ignored input, late source activity and failures at 6 s / 20 s followed by recovery.

Parent review then removed duplicate configuration keys and fixed an editor-count check that used `.first()` before counting. An additional browser case verified that the draft action preserves existing text and refuses multiple official editors; it passed in 1.2 seconds. The earlier 16 cases were not rerun after these limited helper/configuration changes.

`npx tsc -p tsconfig.e2e.json --noEmit` initially failed because two new real-Host specs called `emit` on a session data object. The parent routed those events through the existing HAPI wire fixture owner. The subsequent E2E typecheck passed. `git diff --check` passed. The delegated implementation also ran 32 lightweight Node logic checks; those are distinct from the browser results.

Private raw logs are in `/mnt/cache/data-cache/hapi-dsh-parent-sampler-20261025-0642/`: `run.log`, `draft-run-2.log`, `e2e-typecheck.log` and `e2e-typecheck-2.log`. The first draft-only command found no tests after a failed local edit assertion; `draft-run.log` preserves that setup failure and is not counted as a product or sampler result.

## Remaining acceptance

The source-history fixture now implements bounded outline and message-context reads, forward paging, snapshot limits and epoch reset. The previous outline handler returned an unbounded result, and forward requests fell through to the latest page. Four loopback HTTP contract tests passed after the parent applied the fixture changes. These tests validate the test service; they do not establish product acceptance.

The revised real-Host opening suites and production probes have **not** passed on the new product implementation. Source-wide navigation, first usable paint, long-turn pagination, closing-window cancellation, natural live updates, paired HAPI performance and retained memory still require validation. A passing sampler control proves that its injected defect is detected; it does not establish product usability.
