# HHPI implementation checkpoint

This document preserves the feature-branch checkpoint below. During the subsequent `main` cutover, the production configuration switched to HHPI-only native Codex sources. Production UI acceptance is still being repaired and is not implied by this historical component result.

Date: 2026-10-30. Branch: `feat/hhpi-remote-access-20261029`.

Validated code revision: `464fc74186c19908fffc61e1b30b44996b6c16f3`.

The complete front-end reading integration is implemented and verified against the installed official DSH components. This checkpoint records development and component integration acceptance. Real desktop/mobile layout and final end-user deployment acceptance remain separate. Main and the production site were not changed by this work.

## Front-end reading integration

Each Pane now retains an independent official reading occurrence over its canonical native Session. It owns its Client scope, official Conversation history window, renderer stores, Chat scroll memory and InputHub shell. The native Session ID remains unchanged for authorization and source operations.

The following paths have been connected:

- Official Chat body, keyed nodes, process groups, navigation and request inspection use the selected occurrence assembler. Trajectory, historical todo details and plan-card context use the same binding.
- Initial viewport filling, visible older-page loading, gesture-driven paging, forward paging, message-target navigation and return-to-latest reach the selected official reader. Source cursors remain opaque. Message sequences are resolved to actual official node keys before mounted navigation.
- The actual window-commit capability is forwarded through the outer Session facade. Each selected reader participates in the existing measure/publish/layout-correction checkpoint. The mounted Chat retains scroll-correction ownership.
- Gesture callbacks identify their exact mounted reading owner. Direct HHPI sources cannot silently fall back to a canonical root reader. An occurrence-local older-commit counter reports progress without inventing HAPI coordinates from native cursors.
- Official input shells and rendered editors are independent for two Panes showing the same native Session. Autosave, keyboard submission and Steer use their exact retained binding. Native sends, cancellation and approvals continue through the canonical Session and its operation ledger.
- Closing a Pane invalidates its binding and scoped input owner, aborts its local reads, disposes its official scope and releases its canonical reference. It never issues a native execution cancellation. Other Panes remain retained.
- Reader errors and detached-head state have explicit controls. Recovery uses the same reading region; returning to latest remains a separate navigation.

Source-extension rationale: [reading occurrences](adr/hhpi-reading-occurrences.md). Upstream proposal draft: [optional reading occurrences](upstream-pr-reading-occurrences.md). No upstream pull request was submitted.

## Source-extension delivery

DSH is pinned to `0.2.1-rc.3`, upstream source `1f81c047fc48fa190a683e469daa699857e9afe8`. Source transformations run before the pinned official compiler. No alternate Chat renderer or runtime rewriting of compiled bundles implements this feature.

The previously verified extension set contains nine packages under `@deepseek-ai/`: `dsh-api-session-controller`, `dsh-client-ui-slots`, `dsh-client-ui-renderer`, `dsh-client-ui-session`, `dsh-client-ui-conversation`, `dsh-client-ui-chat`, `dsh-client-ui-trajectory`, `dsh-client-ui-tool`, and `dsh-client-ui-plan`. The follow-up Slash and command-popup correction adds Input Trigger and Commands. The complete eleven-package set was built and installed in the development checkout on 2026-10-30, and all five installed official reading/input/mounted-component contracts passed. Its patch fingerprint is `c49b1d1043711139fd10a7271cf6f7fcad5a3a7b2ba214a399febbe02a7eb7ac`; this local result does not claim production UI acceptance.

The installer verifies all archive checksums, exact package identities, pinned upstream revision, matching source markers and actual installed markers. Incomplete or mixed sets are rejected. Tracked `package.json` and `package-lock.json` remain unchanged. Instructions: [source extension installation](hhpi-extension-install.md).

The historical nine-package set has patch fingerprint:

```text
eb66f4f35e382d9052f373f53c50e16d79b5f905e88a27d5581b8fc5dc6165fb
```

The optional `readingOccurrences:1` capability gates direct-source occurrence admission. Default native DSH bindings without a view ID retain their existing event-feed and per-Session input paths. Disabling the capability before graph construction causes direct-source occurrence admission to fail explicitly.

## Actual verification

Environment: GitHub Actions, Ubuntu 24.04.5, Node 24.19.0. These are CI executions; no production installation or credentials were used.

Installed-extension workflow run **40990314953**, job **123850844897**, at code revision **464fc74186c19908fffc61e1b30b44996b6c16f3** completed successfully.

| Verification | Observed result |
| --- | --- |
| Extension installation boundary | 6 passed |
| Complete source-extension set installation | All 9 packages verified and installed |
| Official reading/input/mounted Chat integration | 3 passed; 0 failed, cancelled or skipped |
| Host, Client and component TypeScript checks | Passed |
| Full Node suite | 1,824 passed; 0 failed; 2 explicit skips |
| Full component experience suite | 35 passed across 9 files |
| History reading journey | 5 passed |
| Injected component/history regressions | All 6 specified defects detected |
| Distributable plugin build | Passed |
| Tracked dependency inputs | Unchanged |

The final workflow restored an exact-input source-build cache, so source preparation and compilation were correctly reported as skipped in that run. The same nine-package source set had already compiled successfully in the preceding source-build executions. Every final archive and installed marker was verified again before tests. The cache is keyed by the source transformation and snapshot inputs, not merely by the rc version string. The installed identity manifest is retained as workflow artifact `12949565050`.

### Independent reading and input contracts

The installed official Session, Conversation, InputHub and Chat implementations execute in these tests. The external source RPC boundary, settings and unused external services are controlled fixtures.

The contracts establish that two Panes can retain one canonical source Session while holding different reading bindings, scope identities, renderer store keys and input shells. Pane A reads six older content segments, growing from 160 to 1,120 unique body rows; Pane B remains at 160 rows. Pane B can then reuse an accepted cached page without another source read. Six measure/correct pairs verify that the actual commit coordinator participates. Native submission addresses the original Session ID. Manufactured bindings are rejected, and released bindings cannot resolve a newer or canonical input owner.

### Actual mounted official components

`tests/contracts/hhpi-reading-dom.test.ts` mounts the actual official Renderer, SessionProvider, public Conversation content factory, Chat, mounted Chat controls and editable input components.

Both Panes display real source message bodies and deliver different mounted controls. Six successive older-page operations through Pane A's mounted control advance only its cursor and content. Both actual rendered input elements preserve their different drafts throughout all six operations. The control finishes with no busy state, unmounting invalidates the handle, and the entire reading journey produces no native write.

DOM geometry, selection rectangles and unavailable font-loading APIs are explicit jsdom fixtures. These tests establish component composition and behavior, not real-browser layout, scroll smoothness, physical keyboard behavior or device acceptance. No official reading, input or Chat implementation is replaced to satisfy an assertion.

### Earlier backend evidence

The earlier checkpoint `24541313db51c9b9ca499ff4bb0deaf64cf8e798` passed installed integration run `40916917282` and native backend run `40916916933`. That backend run used the actual pinned Codex 0.165.0 app-server with a synthetic model HTTP endpoint and no production credentials. It exercised thread creation, repeated sends, six source history segments, stable identities, duplicate suppression, Steer and cancellation. This is earlier backend evidence, distinct from the front-end verification above.

The source operation red/green sequence is retained: run `40914825645` initially failed eight of nine behavior assertions at `16e9601d`; production fixes at `3e06f701` passed all nine in run `40915051728`. Source operation and approval tests remain covered by the current regression suite.

The independently selectable native test remains:

```sh
HHPI_CODEX_TEST_COMMAND=/absolute/path/to/codex node --import tsx --test tests/hhpi-codex-native.test.ts
```

`HHPI_CODEX_TEST_SCRIPT` may instead name the pinned npm CLI entrypoint. Without either selector, the native test explicitly reports skipped; a skip is never counted as native integration evidence.

## Remaining release acceptance

The prior missing front-end reading composition has been implemented. Real desktop/mobile six-segment browser journeys, viewport-layout verification and physical-device keyboard/scroll behavior have not been executed in this checkpoint.

HAPI-free real Host/Runner Web discovery, authenticated opening and pairing revocation still need complete end-to-end acceptance. A clean end-user distribution rollout and production deployment are also outside this verified development-checkout result. Existing legacy HAPI support remains in place.

No main merge, production deployment or complete HHPI product release is claimed. This document supersedes the earlier statement that normal official Chat/Conversation readers were still connected only to the canonical root feed.
