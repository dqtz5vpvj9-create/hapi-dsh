# Expose exact mounted Chat node render acknowledgements

Read-state consumers need to distinguish a published source node from the payload that its row currently renders. A same-key body replacement can leave both the DOM key and reader anchor unchanged while React has not committed the replacement.

This change adds the optional mounted capability `renderedNodes: 1`, `renderedNode(key)` and `read().renderRevision`. Each official Node seat acknowledges its exact public node object in a layout effect. The existing control subscription reports commit and withdrawal. Multiple mounted parts are counted, and an old payload's cleanup cannot remove its successor. ChatView does not rerender for per-node acknowledgements; without a mounted-control consumer, tracking remains absent.

Consumers still determine viewport visibility and source event identity. The API does not assert browser paint, move the viewport, publish history or change Session records. Real NodeSeat and snapshot-builder tests cover same-key replacement, cleanup, disposal and stable parent render count; the existing mounted paging and opt-out cases remain. This draft is local; no upstream PR has been sent.

The same control adds optional `readingCheckpoint: 1` and `checkpointReading()` so update owners can request an actual current sample without waiting for another scroll event. It delegates to the official reader and memory provider, rejecting unavailable geometry, missing semantic anchors and save failures. This explicit call is independent of history-publication preparation. Tests cover fresh sampling, tail policy, provider failure and unmounted control rejection.
