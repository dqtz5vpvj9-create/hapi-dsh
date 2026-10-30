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

## Production verification

Runtime commit `2fd25bdbc203aec82d1a23037e95928d3f480b95` was installed through the formal bundle upgrade. The authenticated site advertises three online sources with the legacy body renderer disabled. The nine served client modules match the active release, and authenticated HTTP and compressed WebSocket checks passed. Two saved DSH panes migrated to their original native session, preserving pane IDs, focus and draft origins. The existing native DSH and Codex processes were not restarted.

The targeted source regressions passed 17 tests. The runtime release check passed 1,880 Node tests, 35 component tests, six injected defects, type checking and the build; two existing optional tests were skipped. The separate history suite passed five tests. Subsequent probe changes passed 13 probe contracts. Those later changes affect acceptance tooling, not the deployed runtime.

The actual affected conversation contains 8,990 native events. A direct read-only preflight took 604 ms to accept its original prefix; six subsequent adapter reads took 39–69 ms each. These are source-read measurements, not browser opening or subjective scrolling measurements.

Both real Chromium scenarios opened an isolated copy of the saved pre-cutover reference and restored the native body plus editable composer. Desktop completed six earlier visible body segments; nine observed commits preserved the selected anchor at zero pixels, and cached-tail traversal made no additional source read. The final mobile scenario completed five earlier visible segments within its 60-second budget, but did not certify the sixth visible segment; its failure sample was still 3,248 pixels from the beginning of the resident interval. This is not evidence of a source request stuck at the top. Desktop recorded a 233 ms rAF gap. The probe also performs synchronous DOM/text measurements, so that maximum has not been attributed to a particular product operation. The complete smooth-reading gate remains failed.

The initial probes could not correlate native Markdown answers: folded reasoning was included in source text, and rendered Markdown differs from its source spelling. The corrected probe correlates official context identities and visible source text, scopes text exclusions to the node being inspected, and permits native touch inertia to finish before measuring a commit. Failed reports and the red/green probe contracts remain in local task evidence; no retry is presented as unchanged-code acceptance.

Desktop and mobile screenshots were captured with `webshot` and actually inspected: both show the original native conversation and composer rather than an unavailable screen. This confirms restored opening, not physical-phone, operating-system IME or unrestricted inertial-scroll acceptance. Local evidence is under `/mnt/cache/data-cache/hhpi-dsh-reconnect-20261030`; screenshots and saved workspace/configuration snapshots remain private and are not committed.
