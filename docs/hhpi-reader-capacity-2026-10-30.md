# False history capacity failure: 2026-10-30

The `CAPACITY_EXCEEDED` failure encountered during normal older-history reading was reproduced and fixed at `8c8030191`. The source returned successful pages; the client rejected publication because it compared two different kinds of identity.

## Cause and correction

The official ToolCallTree exposes precise inner DOM anchors such as `call:<id>`. Its outer Conversation node has a different key. ChatViewport correctly captured that inner reading position, but `BoundHistoryView.validateCandidate` passed its raw DOM key to `ConversationNodeAssembler.containsReadingKey`, which searches semantic nodes and groups. A still-present tool was therefore classified as an evicted reader anchor. The captured failing candidate contained only 482 events after three successful source reads; this was not the event-budget limit.

The optional reader measurement now carries the semantic `ownerKey` separately. ChatViewport captures the closest owning node/group and the reader forwards it. Candidate validation checks that owner; the viewport still restores the original inner key and pixel offset. Exact group and segmented-member aliases are recognized when their corresponding entries exist. Missing owners still reject publication. History budgets, execution ownership and native operations were not changed.

The source transform is [reader-publication.mjs](../scripts/dsh-ext/reader-publication.mjs). It runs before compiling the pinned DSH source, without modifying compiled JavaScript at runtime. Rationale and the unsubmitted upstream proposal were updated.

## Development verification

The new actual-source viewport regression failed against the previous source at the expected missing-owner assertion, then passed against the correction. Twelve installed official contracts passed, covering precise nested tool anchors, owner retention, actual tool/PTC events, group and reasoning aliases, independent reading/input occurrences and mounted components. The tests use declared jsdom geometry; they do not establish browser smoothness.

`npm run check` passed: type checks, 1,859 Node tests, 35 component tests, six specified fault-detection checks and the complete build. Two optional tests were explicitly skipped. `npm run test:history` also passed all five journeys.

## Production release and observed result

The formal bundle installer activated release `ee2f72aec326729fa024dc2008c12cb9c88dc06d952648a28a7ff77c271b65fa`, extension `hhpi-reader-anchor-owner-20261030`, source fingerprint `4e8233a2a7eb3382ced6e47c585bb4adb12836c45c2679985fe0929299d1c7dc`. The authenticated ordinary-DSH running query returned zero before the display Host restart. Original native engines were not restarted. Authenticated HTTP, compressed WebSocket and nine served client modules matched the installed release; both native Codex sources were online.

A read-only production diagnostic exercised the real long conversation using unchanged source data and real Chromium wheel/touch inputs:

| Scenario | Visible earlier body segments | Source reads | Observed capacity error | Maximum frame gap |
| --- | --- | --- | --- | --- |
| Desktop | 6 | 7 | None | 167 ms |
| Mobile viewport | 6 | 7 | None | 183 ms |

Both contexts displayed the official body and editable composer and opened one real changes stream. Separate desktop and mobile screenshots were captured through `webshot` and visually inspected; both showed body and composer in the same Pane. No production write or disallowed stream was attempted. The desktop and mobile scenarios lasted 9.538 and 11.898 seconds respectively.

**Overall reading acceptance remains failed.** Both exceeded the existing 80 ms frame-gap criterion. The anchor probe also reported unresolved virtual-range samples; these do not establish a commit-position error because visibility can be checked after further user gestures. Cached-tail checks were not reached. These failures were retained, not relabeled as passing or addressed by increasing thresholds.

The capacity diagnostic defers the existing anchor verdict until the end so it can inspect all six segments, while retaining a failing overall result. Its first ad hoc error scan incorrectly matched the literal error code inside conversation text. That report was invalidated and preserved; the corrected scan inspects error text outside message nodes. This probe correction is distinct from a product fix or a retry of identical code.

Physical-phone touch, soft keyboards and system input methods were not tested. This release establishes the bounded capacity-error correction, not a claim of completely smooth reading.
