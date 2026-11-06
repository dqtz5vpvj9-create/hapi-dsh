# Retained Pane interaction ownership

Approved scope: client-ui-chat, client-ui-input-trigger and client-ui-conversation, pinned DSH 0.2.1-rc.3. The user explicitly approved these three package changes on 2026-11-05.

A retained Pane has a SessionBinding distinct from the canonical session owner. Menu injection and file picking must resolve that exact binding; a session ID alone selects the wrong input instance. Input trigger contexts gain an optional binding for retained occurrences. InputHub accepts either the existing session ID or a live owned binding. Stale or foreign bindings cannot acquire another input shell. Canonical contexts retain their existing shape and behavior.

Chat presentation supplied by the registered consumer now takes precedence for retained Panes. Without a consumer, the previous retained-Pane fallback remains unchanged. HHPI opts into official completed-turn folding and collapsed step grouping; it does not create another renderer.

The source-only transformer is scripts/dsh-ext/interaction-occurrences.mjs. Removing that transformer and the HHPI presentation policy disables this extension. Source archive and pinned package artifacts are supplied with the release. The retained-Pane menu regression uses the real trigger service and slot registry with a fixture session scope; it checks exact owner projection and independent canonical menu state. Native command receipt and file-reference contracts are tested separately in tests/hhpi-input-triggers.test.ts. These tests do not establish browser layout or real file writes.

The shared Conversation bootstrap and isolated Pane bootstrap both register native input sources. The shared path is the default workspace path. HHPI keeps grouped virtual rows (`virtualizeGroupMembers: false`); the member-flattening mode skips ChatGroupSeat and therefore cannot provide its disclosure. Native file references carry source paths, while uploads retain their separate file bytes/receipt contract.
