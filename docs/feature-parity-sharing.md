# Incoming share picker

This page records the incoming-share picker work against HAPI
`0f8ef6970884c92fb2ddca3070be2ec56cb50333`. It describes the picker and its
integration with the existing share hand-off, not a second composer or chat
renderer.

## Original behavior and implementation

| Original HAPI behavior | Current implementation | Evidence |
| --- | --- | --- |
| Capture prepared sessions once after the initial list finishes loading | The picker waits for actual source-catalog discovery, local official session membership, advertised Host discovery, and known source display identities. It captures one candidate snapshot per opened transfer. | `src/workspace/catalog-discovery.ts`, controller discovery test, first browser case |
| Keep the target list stable while choosing | Live titles, metadata, activity, new sessions and source timestamps do not mutate the captured ordering, search fields or addresses. An explicit **Refresh conversation snapshot** creates a new snapshot. | Snapshot unit test; actual SSE changes in the first browser case |
| Recent active sessions by source recency | The unfiltered list includes active sessions only and sorts by source last-active time. Native Codex uses the original Codex update timestamp when published, rather than the display-proxy timestamp. | Preparation/filter tests and deliberately conflicting timestamps in the first browser case |
| Shared preview limit and hidden count | The original `hapi-session-preview-limit` preference remains owned by the shared sidebar state. Default 8, valid range 1–99; the picker shows the number of additional active matches. | First browser case changes the original preference to 3 and observes the same fixed candidates with the new cap |
| Search includes inactive sessions without the preview cap | Case-insensitive AND terms and `*`/`?` matching reuse the sidebar search helper. Search includes snapshotted titles, directories, source identities, summaries, agent labels and custom machine labels. Matching results remain ordered by recency. | Search unit tests and active/inactive browser queries |
| Calendar search and activity dates | The original shared calendar supports whole local dates, an inclusive end date, reverse range selection, activity markers and clearing. Activity markers cover the prepared snapshot, including sessions outside the preview cap. | Local-date unit test; reverse range 5 → 3 in the first browser case |
| Native duplicate preparation and empty placeholders | Duplicate grouping uses the published original engine identity. Codex groups also include source machine/store; separate Hubs and serving Host graphs remain separate. Active/pinned/recent preference follows the source rule. Only positively identified empty source placeholders are removed; unknown facts and ordinary DSH sessions remain eligible. | Native preparation and unknown-facts unit tests; exact whitelisted `sourceListFacts` DTO |
| Read-only payload preview | Text uses the original text/URL/title preference and a 200-character preview. A single image has a 64 × 64 preview with type and size. Multiple files show the count and first three names. The original full text and each original file remain available for inspection/download. | Preview unit test; second browser case compares downloaded original bytes and IndexedDB bytes |
| Explicit destination and draft insertion | Selecting a candidate rechecks the exact current source address before navigating. The existing share receiver inserts text/files through the official composer callbacks. It does not send a message. | All three browser cases assert exact destinations and zero source chat writes |
| New-session hand-off and cancellation | Canceling creation keeps the payload. A creation receipt waits for a real source identity before binding a HAPI share; a cold proxy ID cannot be treated as an ordinary DSH session. | Existing incoming-share creation/cancellation and successor-handoff regression cases |

The preparation/search behavior is adapted from the pinned source files:

- `web/src/routes/share/index.tsx`
- `web/src/lib/sharePickerSessions.ts`
- `web/src/components/SessionList.tsx` (`prepareSidebarSessions`)
- `web/src/lib/sessionListSearch.ts`
- `web/src/hooks/useSessionPreviewLimit.ts`
- `shared/src/sessionSummary.ts`

Adapted source carries HAPI attribution and the AGPL-3.0-only notice.

## Unified Host behavior

The original source list is extended to include ordinary local and remote DSH
sessions. These are still real official sessions in their own Host graphs;
selecting one binds the share to its Host ID and official session ID. Source
HAPI sessions instead use their original Hub ID and source session ID.

An unavailable source Hub or offline Runner is reported in the picker. It does
not permanently block already loaded ordinary DSH conversations. While first
discovery is still pending, **Use loaded conversations** is an explicit choice
to capture the currently known subset. The default path does not use a timeout
or the first empty array as proof of readiness.

The candidate list is a snapshot of display facts, not a retained foreign
`SessionReference`. Selection checks current official catalog membership and
the immutable source address. Missing, offline, ambiguous or unresolved targets
are disabled and must be refreshed or chosen again. A new display generation
may resolve the same original source; a similarly named or reused ID belonging
to another source never does.

The original transfer stays in `hapi-share-transfers` with its original Blob
bytes and existing delivery journal. Search, truncation, image thumbnails,
calendar changes and candidate refreshes do not rewrite it. Hiding the dialog
also preserves the transfer and its current picker snapshot. A new transfer or
a new page load starts a new discovery/snapshot lifecycle.

## Validation

The focused tests passed:

- `tests/workspace-share-picker.test.ts`: 9 cases covering source preparation,
  filtering, immutable snapshots, true source ownership and readiness failures.
- `tests/workspace-controller.test.ts`: 29 cases, including the new real
  controller discovery/identity transition regression.
- Client and E2E TypeScript programs: no errors.

On shared build **39359**, `e2e/share-picker.spec.ts` passed all **3** real
browser cases in **36.5 seconds**:

1. Delayed first source discovery, original preview cap, frozen order under
   actual source SSE changes, custom machine labels, inactive search, calendar
   range and exact source selection.
2. A real Service Worker multipart share, mobile 420 px image/file previews,
   original file download byte comparison and insertion into one official
   composer with the original four attachment files.
3. A real remote DSH graph as a destination, followed by an explicit source
   catalog outage with a loaded local DSH conversation still selectable.

These tests run unchanged official DSH server/client components, browser
Service Worker and IndexedDB, with explicit HAPI protocol fixtures and a
scripted DSH model. They do not claim execution against live third-party model
accounts or the operating system's native share sheet. Each case asserted no
browser page errors and no HAPI chat send.

Visual inspection then found a real theme-scope defect: the root share dialog
did not inherit the pane-local calendar color aliases, leaving the calendar
background transparent. A new computed-style browser assertion reproduced the
failure. The scoped fix maps this dialog to public DSH theme tokens and keeps
generic dialog rules below the shared calendar's own activity/selection rules.

On the subsequent shared build **32280**, all **5** targeted browser cases
passed in **1.0 minute**:

- All three picker cases above, now including actual computed-style assertions
  for the calendar's opaque background, activity/inactive date color difference
  and selected-date background.
- `e2e/incoming-share.spec.ts`: cancel creation, preserve the transfer, then
  create a real source session and insert into its official draft without
  sending.
- `e2e/draft-handoff.spec.ts`: require explicit append when the successor
  already has text, and move only an untouched pending share to the confirmed
  successor source identity.

The desktop calendar and 420 px mobile image-preview screenshots were also
inspected after the fix. Their layout and calendar colors were visible without
changing the global DSH theme. Test output for this batch is
`/tmp/hapi-dsh-share-picker-32280` in the validation environment.

## Boundaries

- Candidate snapshots intentionally do not live-update. Availability is checked
  live, and refreshing the list is explicit.
- Source duplicate/content facts must be actually published. Unknown metadata
  is preserved instead of guessed empty; ordinary DSH is never filtered as a
  source placeholder.
- Source child sessions are not destinations through this root-session picker.
- File previews do not convert the original payload or grant a different Host
  access to its bytes. File admission remains the actual destination
  composer's responsibility.
- Calendar/readability verification is scoped to this dialog; it does not
  replace the broader appearance or native-device share-sheet validation.
