# Cold-opening design provenance

This audit separates the original design, its default enablement, and later
changes. Git authors and co-authors do not identify the model that wrote code.
Model attribution below requires an original edit invocation and model metadata
from the same recorded interaction. All times are UTC.

| Change | Introducing commit | Verified writing model | Evidence and limits |
| --- | --- | --- | --- |
| Replace the display generation when history changes; release an obsolete workspace lease before its replacement is ready | [`073886ef`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/073886ef252d16b87994c98a007034c336804d3b), 2026-10-20 20:18:42 | Unconfirmed | The commit adds `onHistoryChanged`/`replaceDisplay`, disposes the previous agent, creates a new display, and releases obsolete client references. The original writing interaction was not established in this audit. |
| Hide and park a retired retained pane surface | [`1cdb2e7d`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/1cdb2e7dcbcc7db367eeb65bb8293df558736e9d), 2026-10-21 01:09:22 | Unconfirmed | This is an earlier lifecycle change, distinct from the later recent-view cache. The original writing interaction was not established. |
| Prefer a cached history seed, then reconcile the full source archive in the background | [`9e459db3`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/9e459db3e861055bf9ce5337ac4068e34202db45), 2026-10-22 03:14:55 | Unconfirmed | This commit introduces the `fastHistorySeed` cache branch. It is explicitly an opt-in, default-off experiment at this point. Local records show a later import of this commit, not its original edit. |
| Enable shared Host views and `fastHistorySeed` in the normal composition | [`58800d1f`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/58800d1fa71d8900951af8f2d08eb0b0caf8856a), 2026-10-22 03:51:40 | `deepseek-flash`, provider `deepseek-official` | The recorded edit at 03:38:25.580 changes both service constructors to `fastHistorySeed: true`. Its result confirms both writes; the same model later commits and pushes `58800d1f`. |
| Reuse recently visited views through `recentViews` and `parkPane` | [`9be022b1`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/9be022b1dc7dd4e88ac65ec58d47718b4c770e3c), 2026-10-23 03:04:26 | `gpt-6-astra` | The recorded Python edit at 00:09:28.457 introduces the cache/parking path and exits successfully. |
| Use cached history only when the cache contains an epoch | Same `9be022b1` | `gpt-6-astra` | The recorded patch at 02:07:30.968 changes `if (cached)` to `if (cached?.epoch !== undefined)`. This narrows an existing branch; it does not originate the cache-first architecture. An epoch-bearing cache still bypasses the fresh opening tail in this version. |
| Read a small opening cache and limit the initial source tail to one page | [`c366dad5`](https://github.com/dqtz5vpvj9-create/hapi-dsh/commit/c366dad57e79a8ec882a66e15dc390cef5a1b918), 2026-10-23 14:25:20 | `gpt-6-astra` | The recorded patch at 13:48:41.460 adds the opening-cache path and bounds the tail read. It retains the earlier cache/epoch branch. |

The observed failure combines these decisions: cached content can become visible
without a fresh tail, then full reconciliation replaces the display generation
while its old view is retired. The final two changes reduce startup work but do
not establish freshness or a continuous handoff between display generations.
The current fixes address those separate requirements.

This evidence does not justify attributing the entire architecture to one model,
or assigning a model to the three unconfirmed early changes.
