# Source file operation recovery

The source tools extend the official DSH Files and Document action slots. The original source Hub, session and machine own file changes. This recovery layer neither replaces those views nor redirects an operation to the DSH Host filesystem.

## What is retained

Before create, rename, move, copy, delete or upload reaches HAPI, the browser commits a small intent in IndexedDB. Its owner is the complete `(sourceHubId, sourceSessionId, machineId)` tuple. The receipt stores an operation UUID, the original paths and revision precondition, timestamps, and bounded source result/inspection metadata. Upload receipts store the target path only. They never retain the uploaded file bytes. Source file editing has its separate existing draft journal.

The shared workspace journal survives the disposal of an individual pane graph. A new DSH display generation for the same source reads the same receipt. A page reload reads IndexedDB. A receipt with no confirmed source response remains uncertain, including one whose source operation completed but whose response or local result write was lost. No recovery step automatically repeats a mutation.

Stored metadata is bounded to 2 MiB per source. Large partial-delete responses retain at most 32 affected paths and explicitly record the omitted count. The journal keeps the current operation for a source; an explicit next operation may replace a confirmed or locally reviewed receipt. It is not a complete audit history or a copy of file contents.

## Concurrent views and windows

Real browser Web Locks provide an exclusive, non-queueing lock for each complete source tuple. The lock covers durable admission, the source call and receipt settlement. Inspecting and acknowledging an uncertain receipt also require this lock. A second view cannot clear the blocker while a known request in another pane or window is still running. Blocked operations are not queued to execute later.

Admission checks run again inside the acquired lock. They read the current durable receipt, reject pending or unknown operations, and compare the originally observed revision before writing a new intent. Atomic IndexedDB compare-and-swap also protects against stale receipt writes. A late response cannot overwrite a different operation.

If a window disappears, the browser releases its Web Lock. The saved pending intent is then treated as uncertain; it is never inferred to have failed or succeeded. HAPI's filesystem mutation protocol does not provide an operation-ID lookup or exactly-once retry guarantee.

## Recovery controls

An unresolved receipt exposes **Recover source file operation** in the official view's action area. The panel displays the operation UUID and original paths even if the pane is now using a replacement display generation.

**Inspect current source** reads the original and destination paths without resubmitting the mutation. **I reviewed the source; start a new action** records a local acknowledgement after this view has obtained usable path observations. It means the user chose to remove the local blocker. It is not a source acknowledgement of the earlier RPC, and the panel continues to say that its result was unconfirmed. Current path contents cannot prove whether an earlier request has finished. The user should account for this uncertainty before issuing another change.

A graph disposed before durable admission finishes does not dispatch its obsolete API. If a request was already sent, its temporary closure may settle the original receipt; the shared journal never keeps that old graph's API for reuse. Disposed components cannot navigate the current pane or continue a multi-file upload.

## Browser requirements and limits

File mutations require IndexedDB and the Web Locks API in a supported browser, on trusted HTTPS or localhost. If storage is blocked, full, incompatible, or unavailable, or cross-window locking is unavailable, the UI reports the reason and refuses to send. There is no in-memory fallback that silently weakens recovery. Source reads, previews, downloads and direct target inspection remain available. Ordinary remote HTTP access that is not a browser secure context therefore has an additional write-admission requirement; it is not equivalent to trusted HTTPS access.

Receipts are local to the browser origin and profile. Clearing browser site data removes them. Web Locks coordinate windows of that origin, not different devices or unrelated installations. HAPI's own revision preconditions continue to govern conflicts with other clients. The local operation UUID is not represented as a source idempotency key.

## Verification

Focused tests exercise storage refusal, immutable admission, graph disposal, two independent journals sharing a lock/storage fixture, a delayed lock grant after another window writes an unknown receipt, stale review attempts, upload-byte exclusion, result persistence failure, source isolation, late replies, bounded partial evidence, and a blocked IndexedDB open that succeeds after rejection. These are explicit protocol/storage fixtures, not a claim about a real Runner filesystem.

`e2e/source-file-recovery.spec.ts` runs the actual official DSH Files/Document views against the HAPI wire fixture with real browser IndexedDB and Web Locks. It covers a committed file copy with a dropped acknowledgement, actual source-history/display-generation replacement, page reload, read-only inspection, local review and a source mutation count of one. The rebind assertion waits until the original official view's action element is disconnected, then reads the identical operation UUID from the replacement graph. A second case checks the explicit unsupported-Web-Locks boundary while source reading and inspection still work.

Verified on 2026-10-21 against the shared official-profile build:

- 17 focused tests passed; client and E2E TypeScript checks passed.
- The two recovery cases and the existing `source file actions extend official views` browser regression passed together: 3 cases in 47.5 seconds. The existing case exercises CAS editing, saved-draft recovery, file search, Git, create/copy/rename/move/delete and uploads.
- After tightening the rebind check to require actual old-view disposal, both recovery cases passed again in 23.3 seconds. Both assert zero browser `pageerror` events. The lost-acknowledgement case confirms exactly one source mutation across rebind, reload, inspection and local review.
- The recovery and existing action screenshots were inspected. The recovered operation keeps its original paths and UUID, and the panel explains that local review is not a source completion receipt.

These browser runs use real official DSH views, browser storage/locks and HTTP/SSE transport, with simulated HAPI filesystem state. They do not certify a real Runner's disk or an actual model session.
