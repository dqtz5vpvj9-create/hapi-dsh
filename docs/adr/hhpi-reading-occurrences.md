# Exact reading occurrences for official Conversation

Status: source implementation and independent reading/input contracts verified. Mounted-Chat integration and release acceptance are tracked separately in the implementation checkpoint.

## Ownership boundary

The canonical source Session owns all native writes and source identity. A reading occurrence owns a distinct Client scope, optional `viewId`, official Conversation history window, renderer store key and InputHub shell. It retains the same `sessionId`; no display alias is sent to source authorization, resources or operations.

`ISessions.openReadingView` creates a retained occurrence. `ownsBinding` validates it at UiSession and UiConversation. `bindingOf` resolves an exact scoped input owner. The outer SourceSessions facade forwards the actual history-source and window-commit capabilities, so the selected reader participates in the original commit coordinator.

The renderer receives an opaque `owner` and canonical `injectionKey`. Scoped inject callbacks receive the binding as an optional final argument after their existing identity and store-action arguments. The renderer does not interpret that owner. Existing callbacks and default bindings retain their ordinary behavior. The per-occurrence store key is independent of native authorization identity.

## Official reading targets

The official Conversation selects one BoundHistoryView for each occurrence. Chat nodes, process groups, navigation, request inspection, trajectory, historical todo details and plan-card context all read that same occurrence assembler. Native DSH bindings without a view ID retain their event-feed assembler.

Complete-window publication notifies selected readers inside the existing measure/publish/layout-correction checkpoint. Ordinary growth retains the existing incremental publication implementation. Older and newer reads use the source's opaque cursors. An explicit message target resolves its source sequence to an actual official Chat node before requesting mounted navigation.

The mounted Chat owns scroll correction. Gesture callbacks resolve the exact retained occurrence through a lifecycle-bound DOM owner; they cannot fall back from a direct source to a canonical root reader. An occurrence-local older-commit counter reports paging progress without synthesizing HAPI coordinates from an opaque cursor. Cancellation aborts the current Pane's read, and the source's accepted-page cache is shared across panes.

## Inputs and release

InputHub owns separate shells per binding. The renderer persistence key is the tuple of canonical Session and view ID, matching the shell's initial draft lookup. HHPI autosave uses the stable workspace Pane identity, while keyboard and Steer seats use the exact current binding. Native send, cancel and approval delegate to the canonical Session and its deduplication ledger.

Releasing a Pane invalidates its binding, aborts local reads, releases its official scope, and then releases the held canonical reference. A stale scoped context cannot resolve a newer or canonical input owner. Closing a view never cancels native execution.

## Source-extension delivery

The `readingOccurrences:1` capability is delivered with one verified eleven-package set: Session Controller, Slots, Renderer, UiSession, Conversation, Chat, Trajectory, Tool, Plan, Input Trigger and Commands. Source transforms are applied only to pinned DSH revision `1f81c047fc48fa190a683e469daa699857e9afe8` before compilation. No compiled-bundle rewriting or alternate Chat renderer is introduced. Input Trigger and Commands resolve the exact scoped binding through `ISessions.bindingOf(ctx)` and validate non-canonical occurrences with `ownsBinding`; older session implementations retain the canonical `binding(sessionId)` fallback. Their controllers remain keyed by binding, so panes sharing one native Session keep independent input state.

Setting `globalThis.__DSH_CLIENT_READING_OCCURRENCES = 'off'` before graph construction disables occurrence admission. The default native DSH path remains available. A direct source fails explicitly when the capability is unavailable. Mixed or incomplete source package sets are rejected by the installer.

## Verification

The real installed-source ownership contracts establish two independent reading/input bindings over one canonical Session, six earlier content segments, shared cache hits, exact source writes, actual commit-coordinator participation, rejection of manufactured bindings, and invalidation on release. Settings, source RPC and unused external services are fixtures; official Session/Conversation/Input implementations are executed.

The mounted-DOM contract additionally executes the actual Renderer, SessionProvider, ConversationSession, Chat and mounted controls. Its geometry is deterministic jsdom input. Real-browser layout, scrolling and physical keyboard behavior require separate bounded desktop/mobile acceptance; passing component geometry fixtures does not establish those results.
