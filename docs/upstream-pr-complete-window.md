# Upstream PR draft: optional complete-window history publication

No upstream pull request or push has been made.

## Proposed change

Add an opt-in `complete-window` history feed for providers that maintain stable source-side identities and return complete bounded windows. Route every such candidate through the existing official window coordinator, retain opaque paging boundaries in the published view snapshot, and acknowledge acceptance at the synchronous assembler publication boundary.

The native event-page path remains the default. Execution, queue and approval ownership are unchanged. A complete-window provider supplies publication validation/accept/discard operations and a region-preserving refresh operation. Streaming revisions supply a complete snapshot with authoritative cursor and gap state.

## Motivation

A full-window response cannot be prepended as an event page: it repeats resident entries, separates paging from reader correction and may let a failed candidate release visible cache entries. Stream revisions must not convert a detached window into an apparently continuous tail.

The UI host must commit React DOM before the coordinator corrects measured readers. A synchronous store notification does not provide that guarantee. Wrap candidate publication in the UI host's `flushSync`, and test the real mounted row's new index at correction. Keep the coordinator independent from React.

Retain the physical virtual row owning a nested tool anchor. Carry the semantic owner through saved positions and reveal it when an exact inner anchor needs remounting. Complete the exact offset correction at the virtual layout checkpoint, without applying an obsolete raw scroll offset while waiting. Use the commit-time position for subsequent content preservation.

## Review and tests

Review the source transformation and generated diff against the pinned upstream revision. Contract tests should cover actual official Conversation nodes and the reader/coordinator publication order. DOM tests do not certify browser scrolling. Release evidence and outstanding combinations are recorded independently in the HHPI implementation checkpoint.
