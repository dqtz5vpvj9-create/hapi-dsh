# Codex message presentation

The native HHPI source path emitted tool names such as `codex.commandExecution`
and `codex.fileChange`, while the presentation aliases still recognized the
older HAPI tool names. Commands consequently fell back to generic tool rows.
Command action metadata and exit codes were also discarded by the source
projection. Native `subAgentActivity` and image inputs were rendered as literal
implementation placeholders.

## Display changes

- Native command rows use the registered official DSH Bash component. Their
  summaries retain source command actions; expansion shows the command, output
  and actual exit status. Missing exit codes remain unknown.
- Native file changes use the official Edit row with one path per recorded
  file and the source's explicit diff. Failed or declined changes do not gain
  successful diff metadata. Original native records remain available to Inspect.
- Web search and page-open actions select the corresponding official views.
  MCP and dynamic tools display their actual tool names and readable output.
- Subagent activity becomes a structured tool row with its activity and agent
  path, using DSH's registered details component. This display does not create
  an executing DSH tool or transfer control of the native child agent.
- User images become official image content blocks. Native image-view results
  use the official `read_image` tool vocabulary, result metadata and image
  envelope, allowing the existing authorized gallery to render them.

The native record shapes are taken from the pinned
[Codex 0.165.0 ThreadItem schema](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts).
The reused UI components remain from the pinned DSH 0.2.1-rc.3 extension set;
this change adds no upstream DSH patch.

## Image access and loading

Full native history indexing performs no image IO. Image preparation is limited
to the requested history page and live message upserts, with bounded concurrent
decoding. A local image path is accepted only from an indexed native item and
read through that source app-server's `fs/readFile` API. Embedded image data is
decoded at the same boundary. Remote image URLs and opaque file IDs without a
byte-reading capability retain an explicit unavailable-preview message.

The pinned official attachment backend validates and normalizes images, then
stores immutable references. The browser requests an opaque attachment ID in
the exact source-session scope; it cannot choose a filesystem path. The source
verifies that a current accepted item still references that image, including
after asynchronous reads. History rewrites, source retirement and released
views revoke pending reads. General filesystem and attachment-upload
capabilities remain unadvertised.

Preview enrichment preserves native message IDs, call IDs, source event
sequences and completion times. It updates the existing message or result.

## Existing history

The source display projection version is now 2. Each native thread uses a
versioned SQLite display index, so an unchanged native revision cannot reopen
an old cached placeholder projection. When the legacy index has a complete
checkpoint matching fresh native metadata and a complete accepted native-item
cache, the first open reprojects those records locally without fetching all
remote turn and item bodies. The old database stays untouched. Missing,
incomplete or stale caches use the normal authoritative history scan.
Subsequent matching revisions keep the existing cache-first behavior. Native
transcripts and execution owners are unchanged.

## Validation

Validation ran on Node 24.22.1 with the exact pinned DSH source extensions built
and installed. `npm run check` completed successfully: all three typecheck
programs, 1,915 passing Node tests (two opt-in integration tests skipped), 35
passing component tests, all six injected fault checks, and the distributable
build. The skipped tests require an unmodified official DSH integration run or
an explicitly configured native Codex executable; neither is claimed here.

`npm run test:history` separately passed all five continuous-reading tests.
The focused presentation, attachment, session-resource and cache-upgrade run
passed 54 checks, including native command completion, real exit codes, file
diffs, subagent records, old-cache migration, lazy image loading, source-scoped
attachment reads and rewrite races.

Before publication, concurrent main commit `a93bd9a` added official
`RemoteStream` recovery for idle subscriptions. The integration retains its
zero-change native subscription acknowledgement and follows real updates with
lazy image enrichment. All 26 combined official-history, native-reading and
attachment contracts passed after the merge, including quiet reconnects and
releasing the final reader.

The bounded browser lab has a `--codex-rendering` scenario that feeds native
items through the production source projection and registered official tool
components at desktop and mobile viewport sizes. Its source IO and outer
workspace shell are synthetic. Both Chromium 141.0.7390.37 scenarios passed:
desktop 1440×900 in 2.371 seconds and mobile viewport 390×844 in 1.964 seconds.
They expanded official command and diff rows, decoded both user and tool
images, checked structured agent activity, and asserted no horizontal overflow
with a visible, clickable editor. Browser errors, unexpected external requests
and native write operations were all zero. Browser interaction and DOM
geometry evidence do not establish screenshot review, production deployment,
physical-phone, OS input-method or software-keyboard behavior.

## Publication boundary

This change includes Host-side native projection and resource handling as well
as the Client views. On the configured production Host, the existing guarded
release entry point is `npm run deploy -- --host`; it checks ordinary DSH
sessions before restarting the display Host, then verifies authenticated HTTP,
WebSocket and the live continuous-history scenario. Keep the previous build
available for rollback and keep the pinned extension set consistent.

The current cloud checkout has no production launch configuration or production
Host runtime context. The deployment entry point and live history smoke were
not executed, and the production site has not been updated or verified by this
work. The production authentication and restart guards remain in place.
