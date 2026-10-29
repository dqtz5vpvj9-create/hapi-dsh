# HHPI source-side event compatibility

Status: backend implementation checkpoint, not a release acceptance.

## Decision

Native DSH remains on the existing authenticated opaque federation transport. A non-DSH source may emit the pinned public DSH Session event vocabulary once at its native source boundary. The Codex adapter persists this projection in a private SQLite index. It never constructs a DSH execution Agent or execution Session. HAPI is optional and is not an intermediate representation for this path.

Each native item has a canonical thread/turn/item identity. Source event sequence and turn/step coordinates are allocated once in source order, persisted across process restarts and reused by pagination and streaming revisions. A source rewrite removes an authoritative suffix and invalidates its epoch; removed sequences are never reused. Read cursors are exclusive source sequence boundaries. Dependencies outside a page keep their original identity and precede their body entries.

This deliberately retains lifecycle coupling to the pinned DSH event vocabulary. Source normalization must provide turn/start and step/start before message/tool entries, and complete a turn only after its paged native items have been accepted. It is not a claim that the DSH ChatSnapshot object is a network protocol. There is no SourceFrame round trip or browser-side sequence allocation in the direct source backend.

## Execution and authorization

The native app-server retains execution, steering, cancellation and approval resolution. Shared mode controls only threads loaded by that app-server. Exclusive mode is an explicit operator assignment of a Codex home; an explicit send may resume the same persisted native thread. Reading never resumes a thread. Adapter disposal belongs to the configured source lifetime, never to a Pane.

The official DSH authenticated Typert carrier remains responsible for callers and resource policies. HHPI checks the canonical machine/source/engine/thread scope, filters catalogs by access grants, rechecks access after read IO and before each stream frame, and fails closed for unsupported source resources. Existing Host filesystem and execution routes reject the HHPI prefix, including malformed source IDs.

All native mutations use durable write-ahead receipts. Concurrent identical operations share one dispatch. A persisted indeterminate result survives process restart and cannot be automatically retried. Reusing an operation ID with different arguments fails. Receipt storage hashes prompt parameters instead of persisting prompt bodies.

## Limits and outstanding integration

This checkpoint implements the source backend and HAPI-optional configuration. The recovered frontend is not connected to the new endpoint. The official Chat source, tool details, navigation, per-Pane draft ownership and commit-time reader anchor must still be wired to one complete window boundary. The existing optional historySource/windowCommit source snapshot does not alone establish that connection.

Real desktop/mobile six-segment reading and ordinary DSH regression remain release gates. No production rollout or upstream patch submission is authorized by this ADR alone. Existing repository user authorization governs those operations; successful backend tests cannot substitute for the missing UI acceptance.
