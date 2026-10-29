/** Production DSH event and scoped lifecycle functions in a thin test boundary.
 * The actual SourceSessions, HHPI facade and pane state are not mocked.
 * Alias this file only for esbuild's in-memory Node test bundles. */
export { MutableSessionEventSource } from '../../node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/events.js'
export { createScope, scopeOf } from '../../node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/scope.js'
