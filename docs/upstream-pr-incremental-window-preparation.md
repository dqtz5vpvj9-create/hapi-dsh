# Preserve private preparation across complete-window growth

Preparing an older body page currently rebuilds every resident Context on a new private assembler, even when publication correctly uses prepend. One native CPU trace attributes approximately 51ms of a 102ms publication microtask to that private full replay.

Reuse a coordinator-owned private assembler for complete-window growth, checking every retained source entry and dependency by identity. Keep replacement for revisions/removals and rebuild after registry changes. Copy reading-key validation into each prepared token so another private preparation cannot alter the token's facts. Rebase independently forkable grouping state from the accepted owner before materialization. The published assembler and synchronous window commit remain separate and unchanged in ownership.

Tests cover two successive prepend operations after a retained dependency prefix, resident identities, revision/deletion, immutable prepared validation, registry replacement, grouped anchors and dependent values after source updates/removal. Browser acceptance remains required; the existing `.14` desktop 100ms failure and mobile 67ms pass remain recorded. No upstream push is included in this draft.

Declare the controller's `/client` module as an explicit ui-conversation request for the shared `WindowCommitError` constructor. The official purity gate rejected the undeclared import in the first `.15` cohort build; the corrected real client bundle passes and retains the external constructor rather than duplicating its class.
