# Batch virtual Chat measurements through the existing ResizeObserver

Loading older Chat rows currently forces document layout from a React layout effect, updates virtual sizes, mounts more rows and can force another document layout in the same task. A bounded native-browser diagnostic identifies `list.getClientRects` as the expensive call; the batches contain actual newly mounted rows, so unchanged-row deduplication would not solve this path.

Use the component's existing viewport/margin observer for real row border boxes and apply one native batch through public `resizeItem`. Remove the commit-time list/row measurements and the duplicate TanStack row-observer registration. Preserve actual content/width/visibility invalidation, explicitly resample same-height mutations, and publish acceptance even when a real size equals its estimate. The mounted reader remains busy until those sizes are accepted; initial opening, Latest and exact reveal settle from that actual commit. No public method, timer, reduced range or replacement scroll owner is added.

The associated component test fails on the old synchronous reads. Five source contract files pass 69 cases, including production mounted Chat, exact viewport ownership, checkpoint and synchronous window-commit behavior. Their geometry and observer inputs are explicit fixtures. Real desktop/narrow reading acceptance remains required with the unchanged six body segments, exact anchors, cache checks and 80ms budget. The archived `.13` negative results remain recorded, and its unsupported readiness guard is withdrawn in this source version.

Follow-up: keep accepted observer samples distinct from actual size changes. TanStack does not populate `itemSizeCache` for a first sample equal to its estimate. Comparing that absent entry directly against the actual size makes Chat repeatedly report a new geometry revision. A production virtualizer/viewport regression with interleaved collapsed, estimate-equal and larger rows reproduces a React update-depth failure after prepend and native scrolling. Comparing the cached size or the existing estimate fixes the false revisions; accepted-sample readiness and real resize notifications stay intact. Three related files pass 57 cases and strict source/test types pass. The fix has not yet been installed or validated against the browser performance budget; the separate `.17` formal 390px result remains 100ms against 80ms.

A subsequent range-only regression checks the reading body after every layout
commit, rather than only after later commits can cancel a jump. Newly mounted
flow and a changed leading spacer moved that body by 224px while the old
model/size/margin comparison reported no change. Include the existing mounted
geometry signature in the internal commit comparison and retain that
transaction's mounted seats until actual observer samples arrive. Its own
correction keeps the hold; real native scrolling, explicit navigation, model
replacement and disposal release it. Estimate-equal accepted samples finish it
normally. Geometry-only correction without this retention reproduces an update
depth failure and is not the proposed fix. The final four-file source suite
passes 67 cases, the production mounted-reader readiness case passes, and
strict source/test types pass. The independent non-reader floor-clamp ownership
fix is described in the preserved [0004 draft](../source-snapshots/dsh-ext/upstream-pr/0004.md).
The combined .19 source still requires actual-path acceptance; the recorded
formal 390px 100ms result against 80ms is not explained or passed by these
component results.

A real installed resize exposed another loop despite a valid held range:
`getSnapshotBeforeUpdate` captured the first visible intermediate row and
published it as a new reading pin. That dynamic pin changed the held range's
union, so the next snapshot selected the other row, without any new reader
sample or size acceptance. Make the layout snapshot a geometry read only.
Successful semantic navigation/restore writes establish their actual pin;
real reading samples and paging keep their existing ownership paths. The
recorded 26-item cache/two observer-batch fixture reproduces an update-depth
error before this change. Three direct failures now pass, four related files
pass 70 cases, actual mounted-reader readiness and strict source/test types
pass. The native-reading guard, measurement acceptance and hold are unchanged.
The installed browser's exact caught error type was not collected, and its
search/Zoom user path and original 80ms budget still need actual acceptance.
No new archive or runtime is produced by this source-only follow-up.

A subsequent installed `.20` resize was traced through the actual memory
writer: a 16px browser-anchoring adjustment during a viewport size change was
misclassified as reader movement, blocked restoration, and later saved an
intermediate row from `flushSample`. Preserve the accepted viewport size in
movement attribution and give each pending reader sample one semantic owner.
Capture that owner once, update later reader offsets without another geometry
capture, restore it through resize, and save only after actual row acceptance.
A sample expiring mid-batch resumes from the existing rows-committed callback;
checkpoint rejects its unfinished state. Real input and explicit navigation
retain ownership. The two actual-Hook/VirtualRows geometry cases fail before
this change and pass after it; seven related source files pass 163 contracts.
Installed search/Zoom and the unchanged 80ms reading budget still require
acceptance. The `.20` archive and its recorded failures are preserved.
