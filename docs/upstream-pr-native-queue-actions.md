# Optional source queue actions and attachment handoff in QueueDock

Adapters that expose an external queue may support editing and deletion without supporting DSH's running-turn Steer action. QueueDock currently offers every native action once a row arrives. An external queue can also carry source-local attachment inputs before durable Conversation attachment references exist; replacing its local pending row then removes the real preview.

Add an optional per-row `queueActions` client projection to `ui-conversation`. Its `edit`, `remove` and `steer` booleans disable the corresponding real buttons; a missing projection or missing row keeps existing behavior. The original session-scoped `updateQueue` remains the sole write path. The type export carries no runtime service or changed Session wire.

Use the same capability for InputBar's empty-input hint and keyboard action. Queue-wide steering is unavailable while any queued row denies it. InputHub rechecks the current projection at operation time, including a callback retained before the capability changed; typed draft steering and ordinary missing-projection behavior retain their existing paths.

Reuse the existing matching queued pending submission's attachment previews inside the source-owned QueueDock row until durable references arrive. Match exact `rpcId`, prefer durable references, and keep preview lifetime with the original submitter. Queue ownership and pending retirement remain the adapter/Session owner's responsibility.

Validation: focused upstream `queue-dock.client.spec.tsx` passes 38 cases, including unchanged default actions, per-row Steer denial, exact original Remove ID and preview preservation and notices routed to the retained reading input shell. HHPI's source tests separately exercise single admission, queue-to-body continuity, source text edits, original native Edit/Remove, fresh-read failure, reconnect without writes and uncertain-action no-replay. Candidate runtime acceptance remains a separate delivery step. No model-visible input or logged data format changes.

The related InputBar and service-orchestration suites pass 186 cases for the queue-wide hint, keyboard and operation-time checks, with typed draft steering and default behavior retained.

Draft only; no upstream push is authorized by this file.

Source-owned mixed inputs can supply an optional `editText` buffer on the same row capability. The native inline editor changes only that text; the source retains all attachments and references while updating the original native queue item. Without this field, ordinary DSH keeps its text-only editing rule. Focused checks cover the mixed-row native text update plus unchanged default mixed-content denial; upstream component span `d7945725-8294-41c6-ace1-65752aafd5cd`, HHPI source span `a603c982-39e0-496f-80e7-4d25493f1e6c`.

An optional source `delivery` state also keeps source-held and not-yet-confirmed local input visible without presenting unavailable queue actions as three grey icons. Missing delivery state preserves ordinary DSH. Source adapter semantics, native receipts and execution ownership remain outside this generic UI contract.

Explicit source `steer: true` overrides the local running-state presentation gate for a retained-operation continuation. Missing projection or row preserves ordinary running-only behavior; the same per-row availability drives the tooltip, native disabled state and original action callback.
