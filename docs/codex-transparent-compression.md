# Codex transparent rollout compression

Codex may transparently store a rollout as `.jsonl.zst` while its native SQLite index continues to reference `.jsonl`. HHPI resolves the existing representation in `src/remote/codex-rollout.mjs` and streams only the first line to obtain the session header. Native generation discovery includes compressed execution replacements and sparse fork parents. A restored plain file takes precedence for a logical `.jsonl` path, and discovery counts coexisting plain/compressed files only once.

The source-side metadata helper awaits the header reads before querying native sparse metadata. It does not inflate an entire transcript, modify native archive state, create another Codex app-server, or change execution ownership. The SSH helper bundle includes the same implementation as local metadata reads.

The bounded native-open fixtures cover both plain and compressed sparse-fork ancestry. HAPI also exercises coexisting representations and replacement cutoffs. These fixture results are distinct from live deployment and browser acceptance.

During publication, an older SourceSessions test still expected the initial reveal to fetch three pages before showing accepted content. The current reading contract reveals the positioned first window without optional prefetch. Its regression now asserts zero initial requests, then exercises the real candidate preparation and interactive paging with the original three-page cursor and budget assertions. It preserves that paging coverage rather than removing it to pass the release gate.

## Earlier deployment attempt, 2026-11-04

The final targeted native-open, checkpoint, and metadata-transport run passed 13 tests. Continuous history reading passed five tests, and all six deliberate experience/history regressions were detected against passing baselines. A read-only metadata call against the actual compressed Linux rollout returned its current item and both execution generations with the expected cutover. These checks did not send a message or modify the native archive.

HHPI has **not been published by this change**. The final `npm run deploy -- --host` passed type checking but stopped during Node tests: 2026 passed, nine failed, three skipped. Failures were in the concurrently changing DSH native history/receipt paths, including `This source requires the approved indexed DSH persistence extension`. The prior viewport test now passes. The deployment stopped before build or Host restart; the existing Host still has its 2026-11-01 start time. No successful full-release or live HHPI UI acceptance is claimed.

Logs and the pre-deployment artifact backup are in `/mnt/cache/data-cache/hapi-compressed-20261104` and expire under the host's seven-day cleanup policy. Complete the DSH persistence integration and its failing contracts before rerunning the existing deployment entry point. Do not bypass the checks or publish a partial compiled-file patch. Since no HHPI activation occurred, no HHPI rollback was required.

The later native-index repair incorporates this source change and replaces the failed integration state above. Its implementation and current acceptance boundaries are recorded in [HHPI opening repair](hhpi-opening-repair-2026-11-04.md). The earlier failed attempt is retained as historical evidence.
