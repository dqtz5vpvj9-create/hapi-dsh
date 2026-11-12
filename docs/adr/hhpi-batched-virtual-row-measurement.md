# Accept virtual row sizes from one native observer batch

Status: prepared source contracts passed; installed reading/performance acceptance pending. Package: `@deepseek-ai/dsh-client-ui-chat`, DSH `0.2.2-rc.1`, upstream `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`. No new public method, capability or HHPI wire field is introduced.

The actual `.13` desktop/390 formal results remain 233/117ms against the unchanged 80ms budget. A single subsequent 17.140s geometry diagnostic identifies the expensive operation inside the layout-effect function: `list.getClientRects`, not the following row-bound reads. Fifty list calls take 1,075ms in that instrumented run; 221 row-bound calls take about 1ms after the list has forced layout. Two calls in one bad interval cost 45.7ms and 17.8ms. Forty-five of the 46 slow list reads have newly mounted rows; the other has real text/fold changes. This does not support suppressing repeated measurements of unchanged rows. Instrumented timings are attribution evidence, not release acceptance.

The current effect measures a new candidate synchronously, updates virtual sizes, mounts a few more rows in the corrected range and synchronously measures the next candidate again. Reuse `VirtualChatRows`' existing viewport/margin `ResizeObserver` for row border boxes, with the virtualizer's public `resizeItem` as the sole row-sizing path. Stop registering a parallel TanStack row-measurement callback. One native entries batch accepts actual mounted boxes and publishes their size updates together; the React sizing effect no longer forces list/row geometry reads. This changes the measurement phase, not the amount of required readable content.

New and truly changed rows stay unready until a real observer sample is accepted. A changed existing row is observed again on that same observer so equal-height content changes also receive a current sample. Already pending rows are not observed again by the batch's own mutation drain. Metadata-only counts, reindexing and the component-owned outer margin continue to reuse accepted heights. Width changes invalidate heights; hidden zero boxes cannot replace valid sizes or establish readiness. Removed rows are unobserved. Native border-box entries remain authoritative, with the existing actual-rect fallback only when the browser does not supply that box.

An accepted real size equal to the 96px estimate may not notify TanStack, so the observer batch also publishes its acceptance revision. The existing `rowsCommitted` microtask then publishes and settles the mounted reader. The reader reports busy during actual row measurement, and first opening, Latest and exact reveal wait for that real layout. A renderer with no virtual-row registration keeps its previous behavior. The official synchronous window measure/publish/correct transaction and the viewport's before/after anchor ownership remain unchanged.

The unproven `.13` readiness guard is withdrawn as documented in [the prior ADR](hhpi-measured-virtual-layout.md). Immutable `.13` source/package archives and their failures remain intact; the next source archive includes the withdrawal.

The component regression supplies explicit native border-box entries, including equal estimates, real text/child/style growth, native resizing, width reflow, hidden/visible changes and retained/deleted/reordered ranges. Against the old implementation it fails on 11 synchronous row reads before native delivery (`ea2a30dc-b40f-4c88-8c9d-7fae6639efcf`). A mounted production Chat/virtual-row fixture additionally checks initial busy, Latest and same-height retained-target reveal. It exposed the need to publish accepted same-height batches rather than leave an original operation unsettled. These are source contracts with explicit observer/geometry fixtures; they do not prove browser layout or the 80ms budget. Five associated files pass 69 cases (`a46de9d3-5af2-4d37-9ec1-31985ae869a0`).

## Estimate-equal samples and geometry revisions

A later `.17` native-scroll diagnostic caught an independent 1,083ms reader-settled stall: the scroll callback enters TanStack's synchronous React commit, the viewport restores its semantic seat, and the task repeats style/layout and scroll writes. This does not attribute the separate unprofiled 390px formal failure of 100ms. Native layout repetitions alone cannot count JavaScript commits.

The controlled regression uses the actual `VirtualChatRows`, `ChatViewport`, React and pinned TanStack virtualizer, with explicit border-box and scrolling boundaries. Interleaving collapsed zero-height rows, real 96px rows and larger rows, then prepending older bodies and scrolling again, reproduces `Maximum update depth exceeded` in `captureVirtualLayout → pinReading → getSnapshotBeforeUpdate` (`e572f2dc-5503-4eb4-acf0-c1c8f42417d7`). A uniform-size baseline does not reproduce it.

TanStack virtual-core 3.17.8 deliberately leaves a key out of `itemSizeCache` when its first actual size equals the existing estimate: `resizeItem` sees zero delta. The Chat observer and sizing effect instead compared that missing cache entry with the accepted actual size, repeatedly advancing `layoutRevision` without a size change. Those false revisions re-enabled correction during the native range/pin updates. Compare the effective prior size, `itemSizeCache.get(key) ?? estimateSize(index)`, in both places. Real samples still establish readiness through the separate acceptance revision. Actual size changes, including zero sizes and changed gaps, still call `resizeItem`; no restoration, measurement, range protection, timer or loop limit is removed or added.

The same regression no longer throws and keeps a readable semantic seat during the native commit. The existing actual text/child/style growth, resize, width, hidden-box and gap assertions remain unchanged. The three associated files pass 57 cases (`dbda7ba5-1784-4d75-a84c-cef6b5bdeef5`); strict source/test types pass (`68bc3f96-dec7-43a8-9b87-029788b49b52`). This source fix is not yet installed or browser-validated. It changes only `ui-chat`'s internal revision accounting, with no new public contract or package. The `.17` archives, formal 67/100ms results and single failed diagnostic remain intact.

## Range-only commits and pending observer measurements

A controlled late observer delivery exposed a separate intermediate jump after
`.18`: mounting two rows changed flow by 428px while the leading spacer shrank
by 204px. The already visible body moved by 224px. Model, accepted-size revision
and margin were unchanged, so `VirtualLayoutCommit` reported no geometry change
and the viewport discarded its saved seat. A later range change reversed the
jump; an assertion only at the end hid the failure. The regression now checks
the actual reading row after every official layout correction and fails on that
224px transition before the fix (`f85c09dd-ce03-4ec9-a0d1-6d71be6af2c7`).

Include the already computed mounted key/start/size geometry in the internal
commit comparison. Merely correcting each changed range is insufficient:
feeding the corrected offset back into estimates before actual observer sizes
arrive can alternate two mounted sets synchronously. Retain only the current
transaction's mounted seats until its observer samples are accepted. Keep that
hold across its own layout correction; real native scrolling or explicit
navigation releases it. A new model cannot reuse an old hold, and unmounting
releases the component and its row registrations. Estimate-equal samples are
accepted through the existing readiness revision, so they also finish the hold.
No timer, loop limit, parallel observer or alternate scroll owner is introduced.

An incomplete geometry-only variant reproduced an update-depth failure and was
not retained. The combined source now passes 67 cases across the existing row,
viewport, window-commit and live-edge files (`4ad39451-91c5-4dca-8ab0-71e2495f5415`).
The production mounted Chat case for actual initial/Latest/exact-target row
readiness passes (`2f4f9f27-acdc-4726-a075-95a2d59a2568`), as do strict source/test
types (`0360f661-bf02-4098-becc-70a288501281`). The fixture delivers native geometry
and observer samples explicitly; it does not establish actual browser timing.
The native-reading owner's distinct non-reader floor-clamp guard is recorded in
[ADR 0004](../../source-snapshots/dsh-ext/adr/0004.md). Both fixes are combined in
`.19`; immutable `.18` and earlier archives remain unchanged. The original
224px exploration and the formal 390px 100ms negative result remain recorded.
The latter is still unattributed and must be checked against the original 80ms
budget after integration.

## Layout snapshots cannot choose the semantic pin

The installed `.19` original-search/Zoom path exposed a further ownership loop.
An anonymous, bounded observation retained the same 26-row model and nonzero
size cache. During a width change, the cached total fell from 42,349px to 3,175px;
the held set remained valid. With no further size revision or observer
acceptance, the reading owner alternated between two intermediate visible rows,
adding or removing a dynamic pin outside the held base. This caused 8/9-row
commits to feed each other. The actual browser ended blank, but its caught React
error type was not collected and is not inferred from the fixture.

`captureVirtualLayout` ran from `getSnapshotBeforeUpdate` and unconditionally
called `pinReading` on the first visible row. A geometry snapshot of an
intermediate restored DOM is not a new reader sample. Remove that pin side
effect; keep the before/after geometry correction itself. A successful semantic
navigation/restore write now pins its actual landing directly, rather than
relying on a later layout snapshot to choose it. Actual `capturePosition`
samples and paging retain continue to select their owners. No public API,
observer, timer, loop limit, measurement skip or change to the `.19` hold/native
guard is introduced.

The source regression replays the recorded 26-item size cache and two wide row
batches using actual React/TanStack/VirtualChatRows/Viewport. It reproduces
`Maximum update depth exceeded` through `captureVirtualLayout → pinReading`
before the fix (`c6b1e372-6a52-4976-8d75-810962e7d40c`). Separate ownership
assertions show the layout snapshot replacing the reader with an intermediate
row and the actual navigation write failing to establish its own pin
(`b6c3cf25-9b15-422a-a1a5-dafb6849c69a`). All three pass after the fix. The
four-file source suite passes 70 cases (`2dc88a86-6d4d-40b7-b2f9-16d6ab637a56`),
the real mounted-reader readiness case passes
(`5caabc3a-3047-4ecb-8858-4638b6556425`), and strict source/test types pass
(`f125d572-5d2e-496e-89c1-e98696ffde1c`). Browser boxes and simplified row
contents are supplied boundaries, not the complete upstream renderer DOM. The
original browser exception type and the formal 390px 100ms failure remain
unattributed. No new browser, SDK build, stage edit or performance run has been
performed for this source fix.

## One semantic owner across resize and a pending reader sample

The installed `.20` search/Zoom observation identified the next failure without
another source query: a browser anchoring adjustment changed the physical top
from 5,704 to 5,688 while the viewport grew from 769 to 822px. No reading input
was observed. Offset-only attribution nevertheless started a reader sample,
which blocked both resize restorations. When that same sample ran, its current
movement was non-reader, but it captured and saved an intermediate row instead
of the original key/top24. The 92-record observation identifies `flushSample`
as the first memory writer; checkpoint and commit were not the cause.

Retain the viewport size accepted by the last semantic landing/sample. A resize
cannot become reader input solely because its offset changed. Actual reading
input accepts its current size without changing its semantic position, so a
subsequent real scroll can take ownership. A pending reader sample captures its
semantic seat once at its first accepted movement; later scroll deliveries
update that seat from their known offset delta. Resize restores this pending
seat rather than old memory or intermediate visible DOM. The existing sample
clock may expire between row-observer batches; the same transaction then waits
for the existing rows-committed path before saving. It introduces no second
timer, delay window or correction limit. Checkpoint rejects an unfinished
sample or unaccepted virtual layout instead of saving it as settled reading.

The actual Hook/Viewport/Reading/TanStack/VirtualRows regression supplies the
recorded 26-row geometry and native RO deliveries. Public mounted reveal first
establishes an opened reader. Both the no-input pre-RO displacement and genuine
wheel movement followed by resize fail on `.20` with a different saved key
(`746be7f0-995e-4b84-a731-f3f2a9d77960`). Both pass with the unified owner; the
real-reader case also checks a second scroll without another capture, sample
expiry between RO batches, and checkpoint rejection before acceptance. Seven
related files pass 163 contracts (`39b10aaf-683d-4c67-ba73-ebc47d0816e4`); the
final two-case checkpoint check passes (`1a163ace-67f5-45a2-b4ce-f01ae667d1a2`).
These are supplied geometry/observer boundaries, not an installed browser or
performance result. `.20` remains immutable. No new cohort, stage change or
browser run is part of this source fix; the formal 390px 100ms failure remains.
