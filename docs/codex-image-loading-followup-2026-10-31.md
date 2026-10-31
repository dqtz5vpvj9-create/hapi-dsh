# Codex preview loading and release verification follow-up

This follows the [native message presentation change](codex-message-presentation-2026-10-31.md).
Review of that implementation reproduced five additional failures in production
code with synthetic source records: an oversized image disconnected the shared
native RPC; a slow image blocked later text; cancelling the first reader could
leave a prepared image permanently unprojected in an idle conversation; a new
image arriving during page enrichment could be returned at a version that
skipped its enrichment; and native function output used a different content
block vocabulary from dynamic tools.

## Independent image reads

`CodexImageReader` uses a disposable native RPC connection for each image. It
initializes the connection, checks `fs/getMetadata`, reads `fs/readFile`, and
disposes that connection. It never reads, resumes, subscribes to, or executes a
thread. The adapter's existing thread and approval connection does not receive
image bytes. Socket sources use another connection to the configured endpoint;
stdio or SSH bridge sources start and dispose only their auxiliary transport.
The preview connection ignores source-initiated requests, including global
broadcast requests, instead of sending a default unsupported reply. Responses
and approval ownership remain with the main source connection.

The pinned [metadata response](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/app-server-protocol/schema/typescript/v2/FsGetMetadataResponse.ts)
has no file size. The pinned [read parameters](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/app-server-protocol/schema/typescript/v2/FsReadFileParams.ts)
only support a path, without a range or byte limit. Metadata therefore verifies
a regular file; it cannot prevent a large source read or a file changing after
the check. The existing 16 MiB RPC frame limit remains in force. An oversized
response can close its preview connection without closing the native execution
connection. A response that fits the frame must still satisfy the 8 MiB image
budget and the official attachment decoder's existing image limits.

The source-level reader admits at most two active file reads and 32 waiting
requests. Source disposal cancels its queued and active preview reads. A failed
preview retains a readable unavailable message, and existing retry rules allow
a later requested page to try again.

## Background projection and stable versions

Image work belongs to the source owner. A requested page schedules its accepted
image items and immediately returns that exact page and version. A change
subscription schedules relevant upserts without awaiting image IO. Later text
can therefore continue while an earlier preview is still loading.

Each owner prepares at most two image items concurrently. Queue entries keep
item identities; preparation reads the latest accepted native state. Before
granting an attachment or publishing content, the implementation checks the
native item fingerprint, source revision and index epoch. An old completion
cannot replace a rewritten item. Source retirement cancels work and drains
already-started storage operations before closing the index.

Prepared content independently revises the existing native message or tool
result. Cancelling a page reader does not discard that revision. Cached content
can also be reprojected idempotently when the item is requested again. Message
IDs, tool call IDs, event sequence coordinates and source completion timestamps
remain stable. No second message renderer or execution owner is created.

## Native function output and existing caches

The pinned [function output union](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/app-server-protocol/schema/typescript/FunctionCallOutputContentItem.ts)
uses `input_text`, `input_image`, `input_audio` and `encrypted_content`.
`input_text` now yields readable text. Unsupported media and encrypted content
receive a short display label rather than exposing transport envelopes or
encoded bytes. Existing dynamic-tool camelCase content remains supported.

The display projection version is now 3. This also repairs already-cached idle
conversations, where no fresh native event would otherwise rerun the projector.
An empty v3 index first tries the v2 database and then the original unversioned
database. Import requires a complete accepted native cache and a checkpoint
matching fresh native thread metadata. It reprojects locally, preserves source
identity and timestamps, and leaves the previous database unchanged. Incomplete
or stale caches follow the existing authoritative source scan.

Already-prepared images also survive the upgrade. Only content and grants that
both match the accepted native item fingerprint and pass the existing
attachment-reference schema are retained. They reuse the official immutable
storage even when the original native temporary file has disappeared. Invalid,
revoked or differently scoped references are discarded, and resource reads
still pass through the official byte and digest verification.

## Release checks

The default browser CI journey now includes native Codex presentation checks in
each of its existing desktop and mobile scenarios. History navigation, idle
stream recovery, drafts and editing retain their original assertions. The
entire journey for each viewport has one 60-second deadline. The browser
workflow also watches the source projection, API, attachment and bootstrap
paths that can affect these views.

Both client-only and Host publication compare the served client with the
completed local bundle. Only the official optional source-map comment may
follow those bytes. Host publication additionally compares the compiled Host
build identity returned by the authenticated, uncached `/hapi-dsh/bootstrap`
route. Missing or mismatching identity fails verification. This works for
HHPI-only Hosts and does not rely on the optional HAPI notification worker.

## Validation and publication boundary

The combined Chromium 141.0.7390.37 browser run passed both scenarios: desktop
1440×900 in 21.733 seconds and mobile viewport 390×844 in 49.983 seconds. The
Codex phases took 1.956 and 1.900 seconds within those same deadlines. Both
scenarios retained thirteen earlier reading segments, grew from 154 to 2,156
official nodes, preserved the checked anchor with zero measured drift, and
recovered idle subscriptions without extra history reads.

The Codex phase began with both file reads deliberately pending while the
body, editor and subscription were usable. Releasing the source IO boundary
produced two actual source revisions and decoded both previews without another
body read. Commands, failed exit status, diffs, native function output and
structured subagent rows all passed. Browser errors and external requests were
zero. Each original history phase performed its existing one synthetic send;
the presentation phases sent no operations. The simulated DOM precheck passed
all four contracts. Sources and outer shell were synthetic, while the indexed
history, projection, attachment storage and pinned official UI were real.

`npm run check` completed on Node 24.22.1: all three typecheck programs,
1,942 passing Node tests with zero failures (two opt-in environment-dependent
integration tests skipped), 35 passing component tests, all six injected fault
checks, and the distributable build. The Node stage took 87.58 seconds. The
separate continuous-history journey passed all five tests. The exact pinned
official history and idle-recovery contracts passed all fifteen checks, and
the native reading contract passed its additional check.

Focused regressions exercise real WebSocket framing with a 13 MiB file,
unchanged main-connection generation and later text delivery; auxiliary
connections that cannot answer source requests; slow image and page/version
races; canceled readers and idempotent cached-image publication; same-ID item
replacement; source retirement with active, queued and late-completing work;
v1/v2 cache upgrades with saved images and revoked grants; and the actual
authenticated bootstrap route with stale-client and stale-Host rejection.
Only the declared native IO and loopback service boundaries use synthetic
data. The browser evidence above is a working-tree run before publication.

The cloud checkout has no production launch configuration or production Host
runtime context. Production publication and live history acceptance must use
the existing guarded `npm run deploy -- --host` entry point on the configured
Host. This work does not claim a production restart, production browser
acceptance, screenshot review, physical phone, IME or software keyboard test.
