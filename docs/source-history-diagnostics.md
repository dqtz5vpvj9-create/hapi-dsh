# Offline source-history diagnostics

Use this script when a source conversation has turn or step counts but its body is missing. It reads either an existing **original HAPI JSON export** or an explicitly structured local capture of the **original messages API responses**. It does not connect to a Hub, invoke a model, change the input, or write an output file.

From this repository with its development dependencies installed:

```sh
node --import tsx scripts/diagnose-source-history.ts /path/to/hapi-export.json
```

To save the report, redirect stdout to a different file:

```sh
node --import tsx scripts/diagnose-source-history.ts /path/to/hapi-export.json > history-diagnostic.json
```

Both modes accept `-` for JSON on stdin. The diagnostic input limit is 100 MiB, matching the pinned source export limit; the same local limit applies to a captured-pages bundle. Do not redirect stdout over the input file; the shell would truncate it before the script opens it.

## What the report contains

- Fixed schema, role, envelope and known message-type categories; unrecognized values are counted as `other` or `unrecognized`.
- Whether native execution metadata is present and parseable, whether it belongs to the export's source thread, and whether the source has terminal turn facts. The actual identities are never emitted.
- Counts of equal or missing durable `localId` and body IDs.
- Native and observed parser candidates: displayable users, pending users, durable assistant items, provisional assistant snapshots, tools, lifecycle records, notices, and usage. These are parser outcomes, not proof that a browser rendered the corresponding content. Observed child scopes remain separately counted.
- The raw JSON byte size, largest physical JSON line, total serialized message size, and largest message size. These help distinguish a large tool-output payload from a large number of short messages.
- Fixed incompatibility counters, such as a malformed message row, missing native turn, foreign native thread, or provisional assistant item without a durable identity.

The report does **not** contain message text, tool arguments/results, original IDs, timestamps, paths, credentials, model strings, scratchlist text, arbitrary field names, raw unknown values, or exception messages. Input and filesystem failures produce a fixed JSON error code and exit status 2. A successful structural report exits 0 even when it reports incompatible rows.

## Exact input and a native-history limitation

The supported format is the pinned HAPI `schemaVersion: 2` download:

```ts
{ schemaVersion: 2, exportedAt: number, session: Session, messages: DecryptedMessage[], scratchlist: ScratchlistEntry[] }
```

The original Web export writes this object directly. In this default export mode, a `{ payload: ... }` wrapper, API `/messages` response, Markdown download, JSONL file, arbitrary app-server response, or older schema version is rejected rather than guessed.

**The pinned original export reads the Hub's message store. Native Codex's chat history reads a separate native RPC.** The export additionally excludes uninvoked user input and certain internal source events. Consequently an empty export, or one without native execution metadata, cannot establish that native history is empty. Reports for a native source explicitly include `native-rpc-history-completeness-unproven`. This tool narrows a diagnosis; it does not claim to fix or verify a live blank conversation.

## Actual native messages pages

To diagnose the native RPC path, run the explicit second mode against responses already captured **locally**:

```sh
node --import tsx scripts/diagnose-source-history.ts --native-pages /path/to/captured-pages.json
```

Its exact offline envelope is:

```ts
{
    session: Session,
    pages: Array<{
        messages: DecryptedMessage[],
        page: {
            direction: 'latest' | 'before' | 'after',
            limit: number,
            epoch: number,
            reset: boolean,
            nextBeforeSeq: number | null,
            nextBeforeAt: number | null,
            nextAfterSeq: number | null,
            nextAfterAt: number | null,
            snapshotHeadSeq: number | null,
            snapshotHeadAt: number | null,
            hasMore: boolean
        }
    }>,
    requests?: Array<MessagesQuery>
}
```

Use the `.session` member of the original `GET /api/sessions/:id` response, including its original metadata. Each `pages` entry must be an unchanged JSON response from the original `GET /api/sessions/:id/messages` endpoint, in capture order. A native session's `metadata.codexNativeSession` selects the native RPC path in the original Hub. A missing native flag is reported as `native-rpc-routing-not-advertised`; the script does not infer that a non-native page came from the native RPC.

For a backward history capture, the first response is `latest`. Each subsequent request uses the previous page's **both** `nextBeforeAt` and `nextBeforeSeq`, together with its epoch. Continue only according to the original `hasMore` and reset rules. Keep already captured responses as they are: do not remove pending rows, reorder messages, manufacture a missing page, or substitute an app-server `thread/read` or `thread/items/list` response. Saving only a first page is useful and is explicitly reported as partial evidence.

Optional `requests` contains the actual query parameters for each corresponding response, with exactly the same number of entries as `pages`. Only the original fields are allowed: `limit`, `beforeAt`, `beforeSeq`, `afterAt`, `afterSeq`, `untilAt`, `untilSeq`, `epoch`, and `bounded`. Query numbers can be JSON numbers or query-string strings; `bounded` uses its HTTP string values `"true"` or `"false"`. For example, the first entry can be `{ "limit": "200", "bounded": "true" }`. Do not include URLs, request headers, cookies, tokens or a HAR capture. The script neither needs nor reads them.

Raw captures contain private messages and stay on the local machine. Run the diagnostic there and share only its content-free report if needed; raw history does not need to be uploaded.

### What pagination evidence means

This mode validates the exact response field types and the original query constraints. It checks native row ordering, first/last cursor correspondence, cursor progress, repeat/stall evidence, request links when provided, and generation changes. It reuses the same Native/Observed parser statistics as export mode.

The implementation preserves these actual source rules:

- The Hub appends pending inputs with `seq:null` after the native rows, without changing the page cursors or limit. They are counted as queue overlay and excluded from native position/order/limit checks. A response can therefore contain more total rows than `limit`.
- An empty native page can have `hasMore:true` and a valid advancing scan frontier. A final empty page may repeat the previous cursor. Sparse sequence values do not have to differ by one.
- `snapshotHead` is a scan frontier, not necessarily a message. It can advance without changing epoch. A different limit on a later page is also valid.
- An epoch change, a reset, a new `latest` response, or an `after` capture starts a separate capture segment. Parser counts use only the final uninterrupted segment; earlier pages are counted as excluded and are never silently merged into its transcript. A forward-only segment is not labelled a compatible backward chain.

`pagination.chainCompatible` means the captured responses satisfy these checks. `requestLinksVerified` additionally means the recorded query fields link them correctly with pinned epochs. **Neither proves that the local capture is authentic or complete.** Responses do not independently identify the requested source session or machine, and without recorded queries a skipped intermediate page can be impossible to detect. Source head growth can also occur during the capture. The report always includes `capture-completeness-unproven` and `capturedHistoryCompletenessProven:false`; `reachedReportedBeginning:true` means only that the final source response reported no more earlier rows.

Capture requests should pin the source epoch as described above. If an unpinned request races an indexed coordinate rebuild, the source may legitimately return a new `latest` page without `reset:true`. The diagnostic conservatively counts that request/response direction change as incompatible capture evidence; it does not establish a source bug. Repeat the local capture with pinned epochs before drawing a pagination conclusion.

`bytes.json`, `bytes.pagesTotal` and `bytes.largestPage` describe the entire input capture. Message-byte statistics and parser counts describe only the analyzed final segment. Row and Native candidate counts describe received occurrences; the Observed parser retains its normal stable-item coalescing behavior. No raw page, request cursor, epoch value, original identity or content is emitted.

Primary source locations at HAPI `0f8ef697`:

- `shared/src/sessionExport.ts`: version 2 envelope and 100 MiB limit.
- `shared/src/schemas.ts`, `DecryptedMessageSchema`: actual message fields.
- `web/src/lib/sessionExport/download.ts`: direct JSON download serialization.
- `hub/src/web/routes/sessions.ts` and `hub/src/sync/messageService.ts`: store-based export and filtering.
- `hub/src/web/routes/messages.ts`: the distinct native-history RPC route.
- `shared/src/apiTypes.ts`, `MessagesResponse` and `MessagesQuerySchema`: exact messages response and query contracts.
- `hub/src/sync/nativeQueuePage.ts`: pending input overlay with no native cursor mutation.
- `cli/src/codex/shared/nativeHistoryIndexed.ts` and `nativeHistory.ts`: indexed/fallback pages, scan frontiers and reset behavior.

The reproduction tests use synthetic messages and secret canaries. They exercise the real parsers and both documented CLI modes, verify that all output omits those canaries and private filenames, and verify that input bytes remain unchanged. Page cases cover pending overlays, advancing empty pages, changing limits and head frontiers, missing query evidence, skipped/stalled cursor evidence, malformed schemas, and separation of native generations.
