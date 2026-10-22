# One official Client graph per Host

## Scope and verdict

The public composition required by architecture A is available in DSH
`0.2.1-rc.2`, pinned to `687f282e8625c6b8d11ff58211a90524be2e4317`.
The implementation uses one official AppFrame per Host and an explicit
SessionProvider for every conversation occurrence. It does not install a second
scope adapter, render a private Conversation root, or change upstream bytes.

**API verdict: green for concurrent conversation content, with shared Host
chrome.** The original per-pane graph remains the compatibility path for
non-conversation plugin views. Browser results and remaining rollout gates are
recorded below; an API verdict alone is not a production latency claim.

**Rollout verdict: amber.** The shared runtime is enabled with
`?hapiGraph=shared`; the normal URL retains the previous runtime. Legacy rich
draft migration, automatic display-generation preservation, and production
restore/cold/warm measurements remain release gates for changing the default.
The separate fast-history-seed option stays off by default even when the shared
Client runtime is selected. The final local fixture's warm-switch p95 is
**101.9 ms**, meeting **<150 ms in that ten-switch sample**; the preceding
checkpoint was **273.9 ms**. This variability does not establish a stable
production percentile. The <500 ms cached-first-transcript gate remains unmet.

## Verified public boundary

The installed packages provide the following evidence. Line numbers refer to
the published `lib/client.js` for the fixed version unless specified otherwise.

| Concern | Pinned implementation | Consequence |
| --- | --- | --- |
| Explicit session subtree | `dsh-client-ui-subagent`, `SidebarChatTab`, lines 800–809 | A reference can bind a child Conversation without changing current navigation. |
| Embedded official Conversation | Same package, `ConversationSlotPanel`, lines 786–798 | The public `conversation.content` factory accepts an embedded variant and a `views` override. |
| Official Chat leaf | Same package, `FixedChatConversationView`, lines 782–784 | The local factory position renders `conversation.session` with `view: 'chat'`. |
| Independent factory occurrences | `dsh-client-ui-renderer`, factory render/store APIs and `factoryStoreOf` | An occurrence has its own mounted presentation lifetime; shared definitions remain installed. |
| One root and one session adapter | `dsh-client-ui-renderer/lib/types/client/registry.d.ts`, `renderSlot` and `installScope` | `ctx.slots.renderSlot` is only valid for `root`; a second adapter installation is rejected. |
| Additive Host seat | `dsh-client-ui-layout/lib/types/client/index.d.ts`, `shell.overlay` | A contribution can inherit the one AppFrame and portal session subtrees into workspace panes. |
| Reference lifetime | `dsh-api-session-controller/lib/types/client/contract/sessions.d.ts`, `SessionReference` and `retain` | Each pane borrows one retained reference; closing the view does not own or terminate the Host agent. |
| Official factory content | `dsh-client-ui-conversation`, lines 19734–19790 | Composer, input dock, conversation leaf, and their registrations remain upstream-owned. |

`ui-workspace` manages the Host workspace and its current selection. It does not
provide the tmux layout. The HAPI workspace continues to own its windows,
geometry, focus, and pane identity. `ui-dockkit` internals are not used.

## Implemented composition

`src/client/surface/session-view.tsx` installs exactly one additive
`shell.overlay` contribution and declares a session-scoped
`hapi.workspace.session-view` child, with a sibling
`hapi.workspace.shared-rightbar` action bridge. Every portal is rendered
beneath that contribution, so the official renderer supplies the correct slot
host and scope adapter. Inside each portal:

1. `WorkspacePaneProvider` supplies the originating pane's HAPI navigation.
2. Official `SessionProvider` binds the caller-owned reference explicitly.
3. The session-scoped child consumes `useSession`, `useConversation`, and
   `useSessions` supplied by the official renderer.
4. The child renders the public `conversation.content` factory with the
   embedded variant and an official Chat view override.

The parent graph retains its one AppFrame. A remote Host renders its AppFrame
once in a Host-owned root; the portals inherit the same React scope even when
their DOM targets are placed in the primary workspace. A pane does not call
`uiWorkspace.openSession` while binding itself.

The `mount` input is `{ paneId, instanceId?, reference, target, navigation,
onReady?, onError? }`. An explicit instance identity allows an old hidden
draft-transfer occurrence and its successor to coexist under one durable pane.
The returned handle updates presentation and asynchronously removes
its portal. The outer pane owner awaits `handle.dispose()` before releasing the
reference, preventing reference invalidation while descendants are still
unmounting. The registry never releases borrowed references or disposes the
shared Client Context.

The `onReady` callback reports a settled reference and committed portal frame.
It is not a claim that every history row has rendered. Performance probes must
separately measure the official content element and actual transcript text.

## State ownership

| State | Owner under architecture A | Required behavior |
| --- | --- | --- |
| Transcript, projection, input draft, pending interactions | Official session binding | Different sessions remain independent. Two views of the same session intentionally share the upstream session draft. |
| Conversation factory DOM and scroll container | Mounted view occurrence | Different panes retain their own DOM containers and scroll offsets. |
| Window tree, pane focus, toolbar title | HAPI workspace | The bottom window label follows that window's focused pane. |
| HAPI per-pane actions | `WorkspacePaneProvider` | Event callbacks keep their originating pane, including asynchronous successor operations. |
| Settings, theme, locale, plugin manager | Host graph | One set of settings and one Host-owned shell. |
| Official rightbar and overlays | Host graph | One graph-level owner; they must not be duplicated into several AppFrames. |
| Plugin-view panes requiring complete original chrome | Compatibility graph path | Preserve the existing implementation until a separate shared view contract is validated. |
| Bundle bytes, activation, transport | Host graph | A conversation bind must cause no new graph bootstrap or plugin row load. |

HAPI components previously reading `ctx.get('hapiWorkspacePane')` require the
React pane context when shared. Replacing that service dynamically with the
currently focused pane would redirect delayed callbacks to the wrong pane.
The shared implementation carries the source pane through its React subtree;
legacy isolated graphs may continue to use their fixed service fallback.

## Restore and bounded warm references

With `WorkspaceOptions.deferHiddenSessions` enabled, the controller acquires
only the initial active window's visible references. A parked pane has no
failure lease and does not invoke original-source resolution until it is first
shown. A restored zoomed window initially acquires its focused pane. Once a pane
has a reference, hiding it preserves that generation, its draft, and its DOM
scroll state. Closing the pane releases its owned references normally. The
legacy option default remains eager to preserve the old runtime's behavior.

`src/client/surface/session-warmup.ts` is a separate bounded owner. It accepts
an ordered recent-session list, retains at most five references, and runs at
most two initial-open waits concurrently. Eviction aborts its own waiter and
releases only its own reference. Failed candidates remain remembered until
they leave the candidate list, avoiding repeated catalog-update retry loops.
The Host owner starts this work after a visible pane is ready so it does not
compete with that pane's initial request.

Candidate ordering first uses the five most recently viewed eligible sessions,
then fills remaining positions from the recent catalog. A warm reference is
kept while its session is also visible. The warm owner must not evict a session
merely because a pane has acquired its own reference: the pinned controller
retires a generation before announcing its last-reference release, so warming
only after the pane closes can reopen an already disposed generation. Both the
viewed-session list and the extra reference budget remain bounded at five.

This bounds extra warm references. It does not discard deliberately open pane
references or trim the upstream conversation history window. The public pin
does not provide an in-place retained-history trim API; forced scope disposal
would lose draft/view state and is not used.

## Verification

`tests/client-one-graph-session-view.test.ts` executes the unmodified pinned
SlotRegistry with explicit fake SessionReference readiness and DOM targets. It
checks registration ownership and disposal, independent pane lifetimes,
late-ready and late-failure isolation after replacement, and Host teardown
without reference release. It does not simulate or claim browser rendering.

`tests/workspace-deferred-sessions.test.ts` verifies a 13-pane fixture opens
four visible session references and leaves nine deferred, switching windows
opens only the newly visible panes, and each acquired reference releases once.
It also covers initial zoom and the unchanged eager legacy default.

`tests/client-session-warmup.test.ts` verifies the five-reference/two-wait bounds,
failure memory, cancellation, late-result isolation, and synchronous catalog
reentry while `retain` publishes reference ownership. These are public protocol
fixtures and do not claim production timing.

### Passed browser scope

The Playwright cases in `e2e/one-graph.spec.ts`, `e2e/shared-restore.spec.ts`, and
`e2e/shared-composer.spec.ts` passed against the repository's real pinned DSH
AppFrame, slot renderer, official session bindings, and Chromium. Source
history, delivery, cancellation, and approval endpoints are explicit synthetic
HAPI fixtures. The browser runs select `?hapiGraph=shared` after normal admission.

| Case | Verified behavior |
| --- | --- |
| Local shared panes | Four Conversation occurrences use the existing Host graph with zero additional bootstrap/plugin requests. Two different sessions retain independent transcript content, draft text, semantic file-reference choices, scroll offsets, focus, and a pane-owned voice dialog. A native approval resolves to its original source session. Closing a pane does not send an abort to the source; the other drafts remain intact. One sidebar and no iframe are present. |
| Remote shared panes | The first remote Conversation uses the already created Host graph; a second remote session opens through another explicit binding with zero additional bootstrap/plugin requests. The fixture transcript is rendered by official Conversation, and the workspace retains one sidebar. |
| Shared 13-pane restore (`e2e/shared-restore.spec.ts`) | Thirteen durable pane identities restore with four initial Conversation views and nine deferred views. Switching to each parked window binds its views without additional bootstrap/plugin requests. The original pane's draft and resized split ratio survive window switches and reload; reload again binds only the four visible views. No source abort occurs. |
| Shared composer ownership (`e2e/shared-composer.spec.ts`) | Default Enter sends beta exactly once while alpha's draft remains intact. While beta's cancellation is delayed, both editors receive newer drafts and alpha takes focus. Cancellation preserves both newer drafts and beta's originating receipt. Both drafts and the receipt survive reload. Explicit recovery replaces and focuses only beta's editor, preserves alpha's draft, and does not send again. |

The restore case also uses the real pinned graph and synthetic source fixtures.
It supplies browser evidence in addition to the controller's 13-pane unit
fixture; it does not establish fresh production cold startup or existing rich
draft migration.

The shared composer case passed in **25.6 s** on a dedicated rerun against the
same shared-runtime validation build. Its first attempt had failed during Host fixture startup,
before the test body executed; the rerun was its first actual assertion run.
No production code changed between those attempts. The complete focused-suite
results and other reruns are recorded in [validation.md](validation.md).

Legacy draft migration, source-generation resets, every graph-level dialog,
and production-site timing still require their own focused acceptance
evidence. No real user session was modified for these tests.

### Measurements

#### Latest unprofiled runtime checkpoint

Both `one-graph.spec.ts` cases passed on the shared-runtime validation build in the focused browser
batch that began on 2026-10-22 at 02:35:15.644 UTC. The local case took 39.753 s
and the remote case 27.676 s. The run used one worker, HeadlessChrome
145.0.7632.6, the existing Playwright `retain-on-failure` trace setting, and no
CPU profiler. The latest complete micro run had **922 tests: 921 passed, one
intended opt-in skip, zero failures**. Final diagnostic changes subsequently
passed their separate 9/9 focused checks, client/e2e typechecks, and the final
build. These checks are distinct from the browser measurements below; the
focused browser batch's other cases and reruns are recorded in
[validation.md](validation.md).

| Mounted chat panes | Used JavaScript heap after explicit GC | DOM nodes | Event listeners |
| ---: | ---: | ---: | ---: |
| 0 | 65.83 MiB | 2,096 | 331 |
| 1 | 68.95 MiB | 2,999 | 566 |
| 2 | 70.28 MiB | 3,826 | 774 |
| 4 | 74.02 MiB | 5,253 | 1,466 |

One to two panes added 1.33 MiB, and two to four added 3.74 MiB within this run.
The zero-pane baseline changed from 41.53 MiB in the preceding checkpoint to
65.83 MiB here. Shared activation, warmup, and sampling state therefore prevent
treating these whole-page differences as a fixed allocation per pane or a
causal memory comparison with measurements from another machine.

The ten final click-to-transcript times were **101.9, 82.0, 90.6, 92.9, 98.9,
69.6, 88.8, 75.7, 77.2, and 76.9 ms**. Nearest-rank **p95 = 101.9 ms**, below
the requested 150 ms threshold in this fixture. Surface-marker p95 was
101.8 ms; the largest marker-to-transcript difference was 0.2 ms. The preceding
unprofiled checkpoint below had p95 273.9 ms. These ten-sample runs demonstrate
variability and do not establish a stable production percentile or an exact
gain attributable to a single change.

Local additional bootstrap/plugin requests remained **0**. The remote case
counted **7** matching requests through its first view and **0** more for its
second session. The first count reflects existing admission/cache state, not
a full cold remote bundle inventory or a production tunnel measurement.

The dedicated 13-pane restore case also passed on the shared-runtime validation build. Its already
admitted, catalog-seeded navigation measured **6,170 ms** until the workspace
was visible and **6,896 ms** until all four initially active transcripts were
visible. It counted **4** matching bootstrap/plugin requests during that
navigation and **0** additional requests when activating the parked windows.
Those numbers are not a fresh-browser production cold startup, and the
sub-500 ms cached-first-transcript goal is not met. Production cold and warm
measurements remain unknown; neither a 17-second production restore reduction
nor a fixed memory improvement is inferred from this harness.

A later narrow-screen overflow correction only changes the open composer menu's
row clipping and horizontal anchor. The measurements above precede that CSS
correction; they are retained as the latest runtime performance checkpoint, not
a new benchmark of the menu fix. Its final UI gate is recorded in
[validation.md](validation.md).

#### Preceding unprofiled checkpoint

After the scoped rendering and warm-reference changes below, this two-case
checkpoint began on 2026-10-22 at 02:06:04 UTC and passed **2/2** in 59.4 s. It used
one worker, HeadlessChrome 145.0.7632.6, the existing Playwright
`retain-on-failure` trace setting, and no CPU profiler. The tested build followed
a clean micro gate: 919 tests, 918 passed, one intended opt-in skip, zero
failures, followed by a successful `npm run build`.

| Mounted chat panes | Used JavaScript heap after explicit GC | DOM nodes | Event listeners |
| ---: | ---: | ---: | ---: |
| 0 | 41.53 MiB | 2,000 | 332 |
| 1 | 68.84 MiB | 2,999 | 566 |
| 2 | 70.17 MiB | 3,826 | 774 |
| 4 | 73.89 MiB | 5,253 | 1,466 |

One to two panes added 1.33 MiB, and two to four added 3.72 MiB. These are
whole-page fixture measurements with shared activation and warmup, not a
constant per-pane allocation estimate.

The ten checkpoint click-to-transcript times were 119.5, 93.4, 88.0, 82.3, 217.2,
273.9, 158.4, 238.6, 241.2, and 209.3 ms. Nearest-rank **p95 = 273.9 ms; the
<150 ms target failed in this checkpoint**. The surface marker appeared within
0.1 ms of the transcript text in every sample. This run is lower than the initial 1,221.4 ms
p95 below, but ten observations on one machine do not establish a production
percentile or attribute an exact percentage gain to any single change.

Local additional bootstrap/plugin requests remained **0**. The remote case
again counted **8** matching requests through its first view and **0** more
when opening its second session. The first remote count reflects the harness's
admission/cache state, not a fresh remote bundle inventory. No <500 ms cold
cached-transcript or 13-pane production startup result is inferred from this
run. The latency threshold and rollout gates remain unchanged.

#### Initial diagnostic run

The initial passing synthetic browser run started on 2026-10-22 at 01:39:49 UTC.
It used the locally available Chromium Headless 145 executable through
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, rather than the runner's expected default
browser installation. These figures describe that harness and executable.

| Mounted chat panes | Used JavaScript heap after explicit GC | DOM nodes | Event listeners |
| ---: | ---: | ---: | ---: |
| 0 | 41.57 MiB | 1,997 | 332 |
| 1 | 69.23 MiB | 2,999 | 567 |
| 2 | 70.33 MiB | 3,826 | 775 |
| 4 | 74.18 MiB | 5,253 | 1,467 |

The first pane includes additional shared UI and warmup work. The measured
increase from one to two panes was 1.10 MiB; two to four panes added 3.85 MiB.
These are whole-page measurements with different fixture bodies, not a fixed
per-pane allocation claim. The JSON field is named `usedMB` but divides bytes
by 1,048,576, so the units here are MiB.

Ten switches between two previously opened source sessions produced actual
transcript-ready times of 111.5, 1,221.4, 768.5, 357.0, 146.4, 159.1, 766.6,
249.0, 183.9, and 163.1 ms. The nearest-rank **p95 was 1,221.4 ms: the <150 ms
goal failed**. Surface appearance and transcript readiness happened in the same
observed commit, within 0.4 ms in this sample. Passing isolation tests therefore
does not mean the warm-click latency target has been met. This initial run
preceded the warm-reference lifetime correction below: a previously opened
source could have lost its resident Client generation, so these timings cannot
be described as ten confirmed resident-cache binds.

Opening the local panes and rebinding those sessions caused **zero additional
bootstrap/plugin requests** after the ready Host baseline. The remote test
observed eight matching Host requests through its first view and **zero extra
requests for its second view**. That first count includes the harness's existing
admission/cache state; it is not a fresh remote Host bundle inventory or a
production tunnel measurement.

No production latency or heap measurement is inferred from these fixtures or
the unit tests. The handoff's 17.41 s workspace startup and 77.8 MB at four panes
are historical measurements from another machine, without a matching browser,
cache state, or confirmed unit convention; they remain comparison context.
There is no fresh production 13-pane cold restore or <500 ms
cached-first-transcript claim.

`HAPI_DSH_E2E_PROFILE=1` adds a Chromium CPU sample and task/layout/transport
counters around the ten switches. Profiling affects timing and is only used to
attribute the remaining delay; acceptance uses the unprofiled measurements.

The follow-up profile used HeadlessChrome 145.0.7632.6 and passed the local
isolation case. Across its 6.07 s capture, synchronous React rendering/commit
accounted for about 3.12 s of inclusive sampled time. There were 73 layouts and
205 style recalculations, with browser counters recording 0.136 s layout and
0.893 s style work. Garbage collection accounted for 43.5 ms of samples. The
largest identified HAPI geometry hotspot was the recent-sidebar margin effect:
`getClientRects` accounted for about 588 ms beneath that effect. Sidebar row JSX
allocation and date labels also appeared prominently. Playwright snapshot
capture itself contributed about 330 ms, so this instrumented run is not a
production click benchmark. HTTP/WS activity still occurred; the profile does
not prove every source request was already warm.

Three rendering changes follow that evidence. `SidebarWindow` remeasures its list
origin for mount, item-count/empty transitions, narrow mode, and observed
viewport resize; an unchanged origin no longer forces layout merely because a
row callback has a new identity. Individual row sizes remain measured by the
official virtualizer. `SessionSidebar` retains its snapshot for lease-readiness
and layout-save-only notifications, while catalog, layout, picker, machine,
preference, and workspace changes still update it. Each shared portal also
memoizes its unchanged occurrence; the pin supplies identity-stable
`renderSlot` and `SessionProvider` faces, while session/locale/slot subscriptions
continue updating their descendants. These changes do not alter the official
Conversation renderer or the latency threshold. The independent warm-lifetime
correction described above keeps the bounded MRU leases through visible use
instead of reacquiring them after their last view closes. Their combined final
unprofiled results are recorded above; stable production p95 remains an open
gate despite meeting the threshold in the final local fixture.

## Rollout and fallback

The shared path is gated during validation so the existing graph-per-pane path
can be selected for regressions. Conversation panes reuse one Host runtime;
non-conversation plugin panes keep their compatibility implementation. The
runtime must preserve parked-window laziness, session reference teardown,
native thread identity, and source execution ownership.

### Existing draft migration remains a rollout gate

Legacy per-pane graphs store their official draft keys beneath
`hapi-dsh:host:<hostId>:pane:<paneId>:dsh.conversation.<displayId>`.
The shared local graph uses `dsh.conversation.<displayId>`; a shared remote graph
uses `hapi-dsh:host:<hostId>:pane:shared:dsh.conversation.<displayId>`.
The opt-in path preserves old data but does not yet import those legacy draft
values. Switching the default therefore requires separate migration and reload
evidence, including a populated destination draft and simultaneous windows.

The public `requestDraftInitialization` face accepts a prompt string. A rich
draft with semantic references or command tokens needs the supported
`insertReference`/`beginCommand` and draft-handoff compare-and-set flow, or a
carefully conflict-preserving pre-bind transfer of the unchanged official
opaque key. Silently replacing an existing destination draft is not acceptable.
Attachment recovery uses a graph-independent identity composed of Host, pane,
source Hub or DSH, and source or display session; preserving those identities
keeps its file recovery path available.

### Fast history seeding also requires a generation-preservation gate

The Host journal and live-event buffering can operate independently of a fast
initial tail. The agent/service option `fastHistorySeed` is therefore opt-in;
the default opens with the complete stable history read and overlays events
captured during that read. Journal capture, merge, stale diagnostics, and
background reconciliation remain enabled with the option off. Production must
not enable cache-first or bounded-tail seeding until the transition described
below is verified.

The reason is specific to the pinned append-only DSH display. When an initial
tail is published before its older history, the later full snapshot cannot
prepend rows in place. The source service creates a new display generation
(`-rN`) and the workspace rebinds the same source pane to that display. The
current reset sequence disposes the old Host agent before announcing the new
one. `WorkspaceController` can then rebind through `bindSourceResources`, and
the federation catalog also resolves a changed logical display ID through
`replaceSession`. Neither path currently runs a client draft/scroll preparation
transaction before the old Conversation occurrence is removed.

The existing cross-source draft transfer is not that transaction:

- `WorkspaceDraftHandoffs.prepare` intentionally requires two different source
  sessions. Removing that check would weaken the explicit successor-transfer
  contract without fixing the automatic reset race.
- Its receiver captures semantic reference chips, command claims, and original
  `File` objects through public APIs. Capture still requires the old live
  session binding. A callback after old-generation disposal is not a reliable
  capture boundary.
- Its insertion guard requires a visible, focused destination and an unchanged
  destination draft. Automatic replacement can affect hidden panes, or race a
  newly typed destination draft; silently appending or overwriting is unsafe.
- Attachment recovery already owns an independent IndexedDB compare-and-set
  record for the original source and pane. An additional asynchronous file
  insertion must coordinate with that recovery owner to avoid duplicate files
  and stale writers. Preserved bytes do not prove an exact restored rich draft.
- A new official Conversation occurrence has a new scroll container. The
  public pinned API has no history-anchor restoration operation. Restoring only
  `scrollTop` after older rows appear does not preserve the reader's position.

A future same-source transition needs its own preparation protocol. Before a
display can be retired, each affected pane must capture and retain the exact
old input revision, semantic references/command claim, file bytes, and a
transcript anchor. The destination must match the original Host/Hub/source and
native identity, remain unchanged during public insertion, and settle its
attachment recovery before ownership transfers. Only a verified destination
copy permits release of the old view. Conflict, submission-in-flight, close,
refresh, or storage failure must leave a recoverable copy and an actionable
state, never silently clear the old draft. That protocol is separate from an
explicit move between different source sessions.

Required acceptance cases before enabling fast seeding are a user typing while
older history arrives; reference and command chips; original file bytes;
nonempty destination drafts; hidden panes; the same source open in multiple
panes; refresh during preparation/insertion; and scroll anchored above the
live tail. Tests must also verify no source submission or execution-ownership
change occurs during migration.

The default-off gate removes the new routine tail-to-full generation reset. It
does not claim preservation for every pre-existing generation replacement.
Source-history rewrites, identity changes, and recovery after an incomplete
cache fallback can still require a new display, so their draft/scroll behavior
remains a separate acceptance limitation. Full-history-first startup also
retains its cold source-history latency; a sub-500 ms cached transcript is not
claimed for that path.

Architecture A removes repeated Client graph construction. The separate
[source history/live implementation](live-history.md) now captures incoming
events synchronously in a bounded per-source Host journal, merges them with
history using source identity and monotonic stream state, rejects obsolete
checkpoints across structural barriers, and runs history reconciliation outside
the live event queue. Stale fallback is explicit and automatically retried even
without another source event. These mechanisms are enabled with
`fastHistorySeed` off; they do not require an additional per-pane SSE connection
or change native execution ownership.

The journal is bounded process memory, not durable source storage. Default
initial attachment still waits for complete stable history, so nonblocking
background reconciliation does not mean the first transcript renders before
that read. Cache-first/latest-page rendering remains behind the default-off
`fastHistorySeed` constructor option until same-source rich draft, attachment,
and scroll preservation is verified. Production active-session continuity and
the cached-first timing target still require their own acceptance evidence.
