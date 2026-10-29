# HHPI implementation checkpoint

Date: 2026-10-29. Branch: `feat/hhpi-remote-access-20261029`.

This is a development checkpoint. HHPI is not yet a complete installable, browser-accepted product. Main and the production site are unchanged.

## Implemented code

- HAPI-optional Host/CLI configuration, Runner source configuration, a persistent HAPI-independent workspace directory, and authenticated source API registration.
- Canonical machine/source/engine/native-thread identity and a source adapter interface.
- Direct Codex 0.165.0 app-server transport using stdio or operator-configured loopback WebSocket, with cancellation, bounded frames, disconnect handling and no automatic write retry.
- Source-owned SQLite display index with stable IDs/order, incremental native-item normalization, bounded page/replay reads, cross-page dependencies and explicit epoch invalidation after native history rewrites.
- Native send, steer, cancel, approval routing and native thread creation. Durable source-scoped receipts prevent duplicate or uncertain mutations from being resent.
- Exact-scope gateway and resource-denial behavior. Unsupported direct-source file/terminal operations cannot fall through to the central Host.

Compatibility rationale: `docs/adr/hhpi-source-event-compatibility.md`.

## Actual verification

Local environment: Linux x86-64, Node 24.19.0; DSH 0.2.1-rc.3 and source snapshot based on upstream commit `1f81c047fc48fa190a683e469daa699857e9afe8`; native Codex 0.165.0.

- Host TypeScript check: passed on this checkpoint.
- Source index, gateway and durable receipt suite: 18 tests passed.
- Actual Codex app-server integration: one test passed. It creates a native thread, sends eight turns, reads six older body-bearing segments, preserves source identities, deduplicates creation and sends, steers and cancels. Only the external Responses API model is a local synthetic fixture. No production credentials or model service were used.
- HAPI-free configuration and source fallback guards: three tests passed.
- Existing configuration regression: 12 tests passed.
- Earlier baseline fast suite: 136 Node and 31 component tests passed before these changes. That result is not the checkpoint regression result.

Commands:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.host.json --noEmit
node --import tsx --test tests/hhpi-index.test.ts tests/hhpi-ledger.test.ts tests/hhpi-gateway.test.ts tests/hhpi-no-hapi.test.ts
HHPI_CODEX_TEST_COMMAND=/absolute/path/to/codex node --import tsx --test tests/hhpi-codex-native.test.ts
```

`HHPI_CODEX_TEST_SCRIPT` can instead name the pinned npm CLI entrypoint. The native test explicitly reports skipped when neither executable selector is present; that is not a passing native integration run.

## Not verified or incomplete

The official Runner Web-profile test was attempted. Profile installation did not complete successfully in this environment; the run was interrupted and is recorded as failed/unverified, not passed. HAPI-free real DSH Host discovery, authenticated RPC and pairing revocation still need complete integration evidence.

The restored frontend window/provider/controls are unintegrated. Full-window publication, all official chat readers, independent Pane state and draft ownership, and commit-time anchor protection remain incomplete. No browser six-segment continuity, viewport layout, physical device, production deployment, complete clean install, full project check or final build acceptance is claimed.

The baseline's three source extension packages were built locally from delivered source patches. A reproducible installer and final Host/Runner extension identity remain to be delivered. This checkpoint must not be deployed or described as the completed HANDOFF implementation.
