# Native DSH cutover repair

The initial HHPI cutover migrated Codex panes only. Saved native DSH panes kept their original HAPI resource references, but the new Host registered only two Codex adapters. Reporting `source_not_connected` made this omission explicit; it did not restore the conversation.

The repair adds a native DSH source with two separate responsibilities:

```text
DSH official persistence -- read handle --> HHPI native history
  original seq, turn, step and call IDs      shared accepted prefix
                                             |
                                      official Conversation
                                             |
                          HHPI operation ledger + original owner bridge
                                             |
                              existing HAPI-owned ACP process
```

`DirectDshHistory` mounts only the pinned official JSONL persistence provider in a private storage context. It opens `read` handles while the original writer retains ownership. It does not construct Session or Agent objects, replay execution, read HAPI message bodies, or allocate replacement event sequence numbers. Pages include the earlier lifecycle and tool-call records required to interpret their body. A revision-consistent snapshot supplies both pagination and change publication; unchanged revisions reuse the accepted prefix.

`DshOwnerConnection` discovers only the configured machine's native DSH sessions. HAPI's summary omits the native DSH locator, so discovery reads candidate details before matching `dshSessionId`. Every write revalidates the original machine, engine and native session identity. The existing operation ledger keeps uncertain outcomes from becoming duplicate sends. This bridge preserves the currently running ACP owner; it does not resume or replace it. HAPI remains a dependency of this existing-owner operation bridge. New native DSH Hosts can continue to use the existing official federation path.

The bridge advertises only operations it can preserve. In particular, the current HAPI Hub downgrades DSH `deliveryMode=steer` to queue delivery, and its queued-message endpoint cannot enforce an exact active-turn operation. This adapter therefore reports Steer as unsupported. Files are not advertised. Cancellation requires a current exact execution turn, and approval retains the original request and final decision owner.

The authenticated catalog advertises an optional exact `legacyOrigin` alongside the native identity. Saved chat panes migrate only when one canonical source uniquely matches both the original Hub and source session. The pane ID, window geometry and draft origin survive. A matching title, a foreign Hub, a malformed canonical ID or multiple owners cannot cause migration. Plugin views and terminals do not silently become chat panes.

Operator configuration remains private. A native DSH source specifies `engine: "dsh"`, its official session root, machine identity, and an owner connection whose credential comes from an environment variable. The top-level legacy HAPI renderer stays disabled; Codex continues to use its direct source adapters.

The regression suite uses real pinned official persistence with a synthetic writer and a fixture only at the owner HTTP boundary. It covers six contiguous earlier pages, native sequence preservation, cross-page tool dependencies, concurrent writer ownership, revision caching and append publication, exact-origin pane migration, summary/detail discovery, wrong-owner rejection and durable operation deduplication. Production browser checks remain read-only and must verify the restored body and editor; source counts and an explicit unavailable screen are not acceptance evidence.
