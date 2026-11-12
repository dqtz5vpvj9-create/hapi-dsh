# Keep a reading anchor reachable in a short history window

Status: implemented against DSH `0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`; browser acceptance remains separate.

A real continuous-reading run showed the first history prepend moving a retained body by 217.84 px. The old window underfilled its 822 px viewport. After publication, the official reader needed to scroll farther to retain the original body position, but `scrollTop` was already at the new natural floor of 86 px. Clamping made the body move even though its node and contents survived. Later prepends, with enough retained content to fill the viewport, stayed within 0.47 px. This is a physical scroll-range limitation, separate from candidate group identity.

The official Chat viewport already owns an end spacer for preserving reading positions through folds. Paging preservation now uses that same spacer when its measured anchor requires a position beyond the natural scroll floor. Window-commit correction opts into this behavior only for a reader that is not following the tail. Ordinary explicit navigation and default `restore` retain their natural-range clamp. No client plugin writes the scroll position.

DOM `scrollHeight` is at least `clientHeight`, so it hides how much a short window underfills the viewport. On the exceptional path where the required position exceeds the current floor, the reader briefly reserves one viewport plus the deficit, measures the revealed range, and reduces the reservation to the exact required room before writing its position. Existing scroll, growth and display-mode policies reclaim that room. Unchanged, already reachable positions add no reservation or extra measurement.

Source tests use a scrollport that actually clamps assignments to its computed floor. They cover a prepend that still underfills a tall viewport, a prepend that fills a shorter viewport, repeat resize stability, and a history correction that preserves its measured position while ordinary navigation continues to clamp. The prior no-spacer behavior is retained and tested. These deterministic geometry boundaries do not replace browser acceptance under the unchanged 2 px and 80 ms limits.

The consolidated `.6` source offer includes this decision and the [upstream PR draft](../upstream-pr-short-tail-reading-room.md). There is no HHPI protocol change, alternate renderer, runtime interception, or compiled-code edit.
