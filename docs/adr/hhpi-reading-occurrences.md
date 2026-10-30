# Exact reading occurrences for official Conversation

Status: implementation under installed-source verification. No browser acceptance is implied.

## Boundary

The canonical source Session continues to own all native writes and source identity. A reading occurrence owns a distinct Client scope, optional `viewId`, official Conversation history window, renderer store key and InputHub shell. It retains the same `sessionId`; no display alias is sent to source authorization, resources or operations.

`ISessions.openReadingView` creates a retained occurrence. `ownsBinding` validates it at UiSession and UiConversation. `bindingOf` resolves an exact scoped input owner. The opaque renderer `owner` and canonical `injectionKey` are delivered as an optional final argument to scoped inject callbacks. Existing callbacks and default bindings retain their old behavior. The renderer never interprets the domain owner.

The official Conversation selects one BoundHistoryView for an occurrence. Every target and grouping source reads that assembler, including Chat nodes, process groups, navigation and tool/request inspection. Native DSH without a viewId retains its event-feed assembler. Complete-window publications notify readers inside the existing measure/publish/layout-correction checkpoint. Ordinary growth keeps the existing incremental publication implementation.

InputHub owns separate shells per binding. The renderer persistence key is the tuple of canonical Session and viewId, matching the shell's initial draft lookup. HHPI autosave, keyboard and Steer seats use the same binding. Native send/cancel/approval delegate to the canonical Session and its deduplication ledger. Releasing a pane aborts local reads, releases the occurrence and then its lease; it never cancels native execution.

The `readingOccurrences:1` marker is delivered only with the six-package extension set: Session Controller, Slots, Renderer, UiSession, Conversation and Chat. Setting `globalThis.__DSH_CLIENT_READING_OCCURRENCES = 'off'` before graph construction disables occurrence admission. The default native DSH path continues unchanged. A direct source fails explicitly when the capability is unavailable.

## Verification requirements

Actual pinned sources must compile and execute. Contracts cover complete scope injection, two occurrences of the same native Session, six earlier content segments, stable resident nodes, cached revisits, exact input shells and persistence, operation ownership, failure retention and disposal. RPC/model/DOM geometry fixtures must be identified. Real browser layout, scrolling and physical keyboard behavior remain separate bounded acceptance scenarios.
