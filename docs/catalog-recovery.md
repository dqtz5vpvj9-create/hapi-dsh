# Large source catalogs and original-session recovery

The plugin uses the unmodified official DSH Host and Client APIs. A HAPI history is still imported into its own official Session; loading a view does not resume a Runner or send an agent message.

## Host startup

`src/hapi/catalog-startup.ts` gives the first complete source catalog import a 5-second foreground budget. `src/index.ts` then lets the Host finish becoming ready while both source services continue the same import in the background. A short catalog can finish before that budget.

There is no catalog size cap and no archived-session filter. Both services retain their four-at-a-time background work, and a failure is reported through the existing source error logger. A failure after the foreground deadline is also observed and logged. Shutting down the Host stops subsequent batches and waits for work already admitted.

## Exact source recovery

`hapi/sourceSessionResolve` receives the original `hubId` and `sourceSessionId`. It rejects a different Hub before source I/O, reads that exact session, selects its real native Codex or observed source owner, and resolves the current official display. The response must still belong to the requested source and the service's current generation.

This request bypasses waiting for unrelated older histories in the background catalog. It uses the service's existing per-source attach/reconcile ownership, so a background import and an explicit request cannot create two owners for the same source.

The browser then waits for **its own official catalog projection** to confirm both original identities. A display header, a similar title, or a same-named source on another Hub is insufficient. Only that verified catalog can rebind a saved pane. Documents and terminal resources retain their original resource identity, pane geometry, and navigation target.

Multiple saved panes for one original source share one request. Closing all affected panes aborts their browser wait; a late result cannot recreate a closed pane. Explicit retry resolves the same original source again. A failed lookup is not repeatedly retried on every unrelated catalog update.

Legacy HAPI v2 layouts may lack a Hub field. The product waits for the configured original Hub's real `hapi/catalog` identity before filling that field. An early foreign Host catalog cannot supply a guessed Hub. Resources that already have a Hub continue to match it exactly.

## Loading and failure presentation

The workspace shows a loading state while the requested original source is being acquired. Failures retain the pane and its source identity. The UI distinguishes source responses for:

- not found (404), without claiming the source was deleted;
- removed (410 or an explicit source removal code);
- authorization denied (401/403);
- transport uncertainty or outage;
- a source or Client projection that is not ready;
- conflicting display bindings or mismatched source identity;
- an unclassified error.

These distinctions use structured response codes, not guessed meanings from English error text. English and Chinese explanations are provided by the workspace locale; the original error remains available in expandable details.

## HTTP UUID compatibility

`src/client/random-id.ts` provides `randomId()` to all 36 browser modules that allocate UUIDs. It uses the native method where available. On an HTTP origin where `crypto.randomUUID` is not exposed, it obtains 16 bytes from `crypto.getRandomValues` and sets the UUID v4 version and variant bits. It never uses `Math.random` or changes the global Crypto object. If no secure random source exists, the operation fails explicitly.

## Verification scope

`tests/hapi-catalog-startup.test.ts` uses 154 synthetic HAPI source sessions with the real pinned DSH Session, Agent, projection, and command registries. Earlier histories are deliberately held open while exact late native and archived sources are resolved. It then releases the gate and checks that all 154 sources imported. A separate shutdown case checks that the remaining batches are not started after disposal.

`tests/hapi-source-session-resolver.test.ts` covers source admission, same-request coalescing, current generation reconciliation, foreign Hub rejection, and mismatched source responses. `tests/client-source-session-resolver.test.ts` checks the official catalog projection barrier, cancellation, and structured failure classification. `tests/workspace-controller.test.ts` checks exact restored panes, duplicate view requests, real retry, closed-pane late results, and a foreign catalog arriving before the primary Hub identity. `tests/client-random-id.test.ts` also executes real workspace allocation with only `getRandomValues` exposed.

`e2e/catalog-source-recovery.spec.ts` passed against the coordinated production build and unchanged official Web. A saved v2 chat/document workspace points to an archived source deliberately absent from every discovery list. Its exact read initially returns HTTP 404; after that source failure is removed, an actual Retry restores the official Conversation body and original Markdown document. The case verifies the original Hub/session/machine/path, the 3:2 geometry and one current display binding. It confirms no new source session, model start/resume, message, approval, settings change, file mutation or terminal operation. Both failure and recovery screenshots were inspected.

These are synthetic source-protocol tests with a real official browser, not a claim that the user's deployment or private histories were exercised.

The shared browser-test helper `e2e/preview-notice.ts` waits for the official asynchronous notice on a fresh blank view and records only an acknowledgement actually completed through its UI. Later pages and reloads reuse that confirmed Host acknowledgement instead of waiting for a notice that should no longer appear. The pinned official `SettingsRoot` defers automatic onboarding while its retained main session is nonblank. Restored source workspaces therefore declare `initialView: 'existing-session'`: an actual notice is handled if later navigation makes it eligible, but a nonexistent notice is neither awaited nor counted as acknowledged.
