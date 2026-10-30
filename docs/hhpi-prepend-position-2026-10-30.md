# Prepend position correction, 2026-10-30

The reported failure is a viewport landing at newly prepended content instead of retaining the text being read. Two regressions reproduced it in the installed official implementation before the fix:

- A nested `call:child` anchor was passed to the virtualizer, which only knows Conversation nodes, groups and virtual rows. Resolving the current row but retaining the unknown inner key did not keep that row mounted.
- The coordinator invoked `correct` after notifying stores, before React committed their new row order. The real mounted desktop row still had index 145 when the new model required 305; mobile was 142 versus 302. A source-page count or successful RPC could not detect this ordering error.

The optional complete-window UI publisher now flushes React publication before correction. The viewport retains the stable semantic owner, resolves its new virtual row after regrouping, carries that owner through position memory, and restores the precise inner offset after a necessary remount. A removed inner anchor cannot leave a pending restoration that revives on a later layout. Commit-time measurement becomes the content-preservation position.

The mounted component contract checks actual DOM/model order at correction on every one of six prepends. The viewport contract checks nested-tool identity, semantic pinning, exact remount landing, temporary-pin release and cancellation when a subcall disappears. Explicit jsdom geometry remains a fixture, not browser evidence.

The browser lab uses the installed official bundles, production HHPI reader and shared cache, with synthetic source IO. Its history includes complete tool/PTC/result lifecycles as well as 1,440 user messages. The live probe holds each read response until genuine input scrolling settles, samples the current DOM anchor, then checks its offset after the row-order publication before issuing another gesture. It does not write production conversations or alter DOM geometry. Subsequent gestures must still expose six consecutive earlier source bodies and read the resident tail without fetching it again.

Build, deployed identity and browser results are recorded after execution. Physical-phone behavior and software-keyboard viewport changes require separate device evidence.
