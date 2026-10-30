# Complete-window publication through the official DSH reader

Status: implementation and contract validation in progress; browser acceptance is not implied.

## Boundary

Native DSH retains the existing event-page feed. An optional `HistoryFeedV1.mode = 'complete-window'` declares that a read returns the entire bounded candidate window, including opaque source cursors and forward-gap state. Treating that response as a prepend duplicates resident entries and bypasses the official window coordinator.

Complete-window reads and stream snapshots use the same official Conversation assembler and window coordinator. A per-view serial publication queue orders reads and revisions. The coordinator samples the mounted reader immediately before publication and restores it after layout. A read stays busy through that restoration. A failed preparation preserves the old displayed window.

The React UI publisher uses `flushSync` around candidate publication. Store notification alone is not a DOM commit: correcting immediately after notification can still measure the previous virtual row order. The coordinator remains renderer-neutral; only its UI host establishes this synchronous layout boundary. The mounted-DOM contract checks the same retained Node's physical `data-index` against the committed model order at correction, on all six prepends.

The viewport pins the stable semantic owner of an inner tool anchor, allowing the virtualizer to resolve its physical row again after grouping changes. Saved positions carry both the exact text anchor and its semantic owner. If the exact anchor needs remounting, the owner is revealed and the exact offset is restored at the virtual layout checkpoint; the old raw scroll offset is not applied while that remount is pending. The commit-time measurement also becomes the preservation position, so a later content notification cannot restore an older request-time seat.

Ordinary virtual-range recycling does not constitute a reading-window mutation. The virtual list captures before DOM mutation, completes its existing row measurements, and only then requests correction when the row model, scroll margin or measured-size revision changed. The measurement revision covers both ref/ResizeObserver measurements and the parent layout-effect fallback. The latter must run before deciding whether to discard the captured position. A pending exact-anchor remount is processed regardless of that change flag. This removes forced post-mutation geometry reads during unchanged-size range recycling while retaining correction for real size changes.

The source feed exposes synchronous `validate`, `accept`, and `discard` publication acknowledgements. Candidate preparation cannot release the displayed entries. Validation occurs immediately before the assembler publication; acceptance occurs in the same synchronous publication boundary. The source cache pins accepted windows and bounded candidates independently from the DOM virtual range. A late or expired candidate fails explicitly.

A complete delta includes an authoritative snapshot. Its source cursors and detached state survive edits and streaming completion. Explicit latest and reconnect refresh are separate operations. Provider cursors remain opaque; Chat must use the committed source cursor rather than deriving one from a displayed event or context row.

## Source changes and default behavior

The extension is applied only to the pinned TypeScript sources by `scripts/dsh-ext/complete-windows.mjs`. Its structural edits assert the expected interface, class and publication method boundaries before changing anything. The build records its SHA-256 and produces the source diff; no installed or compiled JavaScript is string-patched and no runtime object is intercepted. Feeds omitting the mode keep the original path.

Host and Runner must distribute the same extension packages and source-input identity. Ordinary DSH does not use HHPI source IDs, SourceFrames, or a second execution Session.

## Validation requirements

Contract tests must use the real patched `BoundHistoryView`, assembler and coordinator. The source wire and reader measurement/layout boundary may be controlled fixtures. Required assertions cover repeated body-bearing prepends, one publication for coalesced reads, read-time scrolling measured at commit, rejection before publication preserving the visible window, a live revision during paging, opaque cursors, independent Pane positions, and cancellation. Browser scrolling, mobile viewport and physical-device checks are separate release evidence.
