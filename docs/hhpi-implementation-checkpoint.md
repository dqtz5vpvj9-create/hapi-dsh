# HHPI implementation checkpoint

Branch: `feat/hhpi-remote-access-20261029`.

Validated code revision: `24541313db51c9b9ca499ff4bb0deaf64cf8e798`. This is a development checkpoint, not final HANDOFF acceptance. Main and the production site are unchanged.

## Implemented code

- HAPI-optional Host/CLI configuration, Runner source configuration, a persistent HAPI-independent workspace directory, and authenticated source API registration.
- Canonical machine/source/engine/native-thread identity and a source adapter interface.
- Direct Codex app-server transport using stdio or an operator-configured loopback WebSocket, with cancellation, bounded frames, disconnect handling and no automatic write retry.
- Source-owned SQLite display index with stable identities/order, incremental native-item normalization, bounded page/replay reads, cross-page dependencies and explicit epoch invalidation after native history rewrites.
- Native send, steer, cancel, approval routing and native thread creation. Durable source-scoped receipts prevent duplicate or uncertain mutations from being resent.
- Exact-scope gateway and resource-denial behavior. Unsupported direct-source file/terminal operations cannot fall through to the central Host.
- Shared accepted history, per-view source feeds, candidate publication acknowledgement, and source-built optional complete-window/official-reader extensions. Their data and contract tests do not establish complete browser wiring.

Compatibility rationale: [source event compatibility](adr/hhpi-source-event-compatibility.md). Publication extension: [complete-window publication](adr/hhpi-complete-window-publication.md).

## Changes since the prior saved source checkpoint

The following implementation changes were committed on the feature branch after `787ab2b1`:

- Source-built extension archives carry the pinned upstream revision and patch-set fingerprint in their package metadata. The installer validates the complete three-package set, archive checksums and actual installed markers, and preserves tracked package/lock inputs. Installation instructions are in [source extension installation](hhpi-extension-install.md).
- Unsupported, offline, pre-cancelled and missing-native-turn submissions retire their pending echo through the failed-submission callback. They do not leave the composer waiting for an operation that was never dispatched.
- A source receipt must name the exact session and operation before it acknowledges a submission. Equal operation IDs deduplicate only equal arguments; conflicting payloads are rejected. Dispatch owns an immutable payload copy. Uncertain promises remain recorded without an automatic retry.
- Released Session faces reject new operations and late history cannot reopen them. Closing the view does not issue a native cancellation. A catalog removal marks already-held Session faces offline.
- Approval controls isolate state by complete source identity and request identity. Replacing a Session face invalidates callbacks before new input, clears stale busy state, and ignores the released owner's late receipt. Steer is disabled when there is no native turn.
- Regression fixtures use system temporary directories, validate the optional-HAPI controller contract, and give doctor an explicit artifact-presence fixture with a negative missing-artifact assertion. No production behavior assertion was removed to obtain a passing baseline.

## Actual verification

The current verification environment is GitHub Actions on Ubuntu 24.04, Node 24.19.0. DSH is pinned to `0.2.1-rc.3`, with delivered source patches based on upstream `1f81c047fc48fa190a683e469daa699857e9afe8`. These are CI executions, not claims about a currently running production installation.

### Installed extension integration

Run `40916917282`, job `123599505299`, at code revision `24541313db51c9b9ca499ff4bb0deaf64cf8e798`: **success**.

The job completed all of the following without skipping a failed stage:

1. Bootstrap dependency installation and six extension-package boundary tests.
2. Pinned source preparation, official compiler build of all three extension packages, and verified installation of that package set.
3. Host, Client and component TypeScript checks.
4. The full Node and DOM behavior suite.
5. History regression and component/history fault-detection contracts.
6. The distributable plugin build and confirmation that tracked package/lock inputs were unchanged.

The immediately preceding run `40915416727` recorded 1,824 passing Node tests, two explicit skips, 35 passing DOM tests, five passing history tests and all six specified fault detections. Its overall result was failure because the new DOM test used the wrong TypeScript import form for `userEvent`. Revision `24541313` changes that import to the declared named export; the subsequent complete installed-integration run above passed. A skipped native test is never counted as native integration evidence.

### Source operation red/green evidence

Run `40914825645`, at `16e9601d30dd4ee760b19117c1914d51bedaff8a`, executed nine source Session operation tests. Eight failed with the intended behavior assertions and one passed. There were no loading failures, cancellations or skipped tests in that lane.

The production fixes in `3e06f701d9268ce06968fafb0014e5a5eaa90bce` passed all nine tests in run `40915051728`. The latest source operation run `40916917238` also passed, including the four real approval component tests. Only remote IO and the existing public-contract import boundary are fixtures; the Session state/operation implementation and approval component are production code.

### Native backend

Backend run `40916916933` at the validated code revision completed successfully. The native Codex integration uses the actual pinned Codex 0.165.0 app-server. The model HTTP endpoint is synthetic, and no production credentials are used. It exercises native thread creation, repeated sends, six source history segments, stable identities, duplicate suppression, steer and cancellation. Source history segments in this test are not browser scrolling evidence.

For the independently selectable native test:

```sh
HHPI_CODEX_TEST_COMMAND=/absolute/path/to/codex node --import tsx --test tests/hhpi-codex-native.test.ts
```

`HHPI_CODEX_TEST_SCRIPT` can instead name the pinned npm CLI entrypoint. With neither selector present, the test explicitly reports skipped.

## Remaining product work

The full official Chat input boundary is still incomplete. The source Session supplies a history provider while its legacy event feed is empty; all normal Chat/Conversation readers must consume the same per-Pane official window, including node/group readers, tool details, navigation and input ownership. Replacing only one selector would leave these readers inconsistent.

Specific inspected call sites still requiring the full boundary migration:

- `src/client/surface/session-view.tsx` initial viewport preparation reaches `session.loadOlder()`. A direct HHPI Session intentionally rejects this unscoped operation; the mounted Pane reader must own it.
- The pinned official Chat injection still contains root Session/Conversation lookups and the fixed `chat` reader identity. These must not make two Panes displaying one native source share a navigation window or draft.
- Source-window head navigation must reach the same official reader; the existing legacy source callback alone does not implement the direct HHPI path.

The source-window and publication contracts are implemented and tested, but the above live composition has not been accepted. The old HAPI正文 bridge remains for its existing source; removal waits for actual call-site migration. Native DSH federation still needs complete Web discovery/open/history/revocation acceptance evidence.

No desktop/mobile six-segment browser journey, physical-device result, production deployment, or final end-user installation acceptance is claimed. The successful plugin build is not evidence that every view is wired or that scrolling is correct. Main remains unchanged; this checkpoint must not be described as completed HHPI.
