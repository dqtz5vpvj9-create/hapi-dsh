# Draft upstream proposal: optional Session reading occurrences

No upstream pull request has been submitted.

Provide independently retained presentation bindings over a canonical Session. Add optional `viewId`, `ownsBinding`, `bindingOf`, and `openReadingView` contracts. A generic renderer binding may supply an opaque domain owner and an injection identity distinct from its store persistence key. Append the scope binding to existing scoped inject callback arguments.

UiSession validates the exact binding with its owning Session service. UiConversation selects its official history assembler when an occurrence viewId is present. Chat nodes, groups, navigation, details and scroll memory read that same occurrence. InputHub resolves its shell through the exact retained binding and persists by the same occurrence store key. Native operations keep their canonical Session and authorization identity.

Default bindings omit these fields and follow the current event-feed and per-Session input paths. The feature is capability-gated and independently disabled before graph construction. No runtime interception, compiled-bundle rewriting, alternate Chat renderer or execution Agent is introduced.

Delivered source changes are in `scripts/dsh-ext/reading-occurrences.mjs`, applied only to pinned upstream source commit `1f81c047fc48fa190a683e469daa699857e9afe8`. The source installer verifies every modified package as one fingerprinted set. Detailed rationale and verification boundaries are in `docs/adr/hhpi-reading-occurrences.md`.
