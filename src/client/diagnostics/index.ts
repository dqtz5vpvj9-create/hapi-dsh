/** Diagnostics layer install/hooks used by the source dock and the composer.
 *
 * Nothing here participates in source execution: failures are recorded as
 * evidence, and the overlay only shows them after the user opens it. Entries
 * follow the allowlist in ./state.ts: no bodies, prompts, console text, URLs.
 */
import type { HapiRemoteApi } from '../../client-api.ts'
import { installBrowserCapture } from './capture.ts'
import { instrumentHapiApi, setDiagnosticIdentity } from './api.ts'
import { diagnosticsCore, safeIdentity, type DiagnosticIdentity, type DiagnosticInput } from './state.ts'
import { mountDiagnosticsOverlay } from './overlay.tsx'

export { DIAGNOSTICS_LIMIT, diagnosticsBuildContext, diagnosticsCore, safeIdentity, safeRoute, safeToken } from './state.ts'
export type { DiagnosticEntry, DiagnosticEvent, DiagnosticIdentity, DiagnosticInput, DiagnosticSource, DiagnosticsSnapshot } from './state.ts'
export { setDiagnosticIdentity } from './api.ts'
export { translate } from './localize.ts'

/** Install page-global capture plus this graph's remote instrumentation. */
export function installDiagnostics(api: HapiRemoteApi): () => void {
  if (typeof window === 'undefined') return () => {}
  const core = diagnosticsCore()
  const disposers = [installBrowserCapture(core), instrumentHapiApi(api, core)]
  mountDiagnosticsOverlay(core)
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

export function recordDiagnostic(input: DiagnosticInput): void {
  if (typeof window === 'undefined') return
  diagnosticsCore().add(input)
}

export function openDiagnostics(): void {
  if (typeof window === 'undefined') return
  diagnosticsCore().openDrawer(true)
}

/** Route repeated source error notices into the diagnostics layer. Only their
 * stable identity and kind are recorded; notice text stays in the source UI. */
export function recordSourceErrors(sessionId: string, entries: readonly { id: string; createdAt: number }[], identity?: DiagnosticIdentity): void {
  if (typeof window === 'undefined' || !entries.length) return
  const core = diagnosticsCore()
  const clean = safeIdentity({ ...identity, sessionId })
  for (const entry of entries) core.add({ source: 'source', event: 'source.error', key: `source-error:${sessionId}:${entry.id}`,
    time: entry.createdAt, ...(clean ? { identity: clean } : {}) })
}

/** Transport/projection/plan refresh failures are diagnostics, never read-only. */
export function recordSourceFailure(sessionId: string, component: 'history' | 'plan' | 'projection', error: unknown, identity?: DiagnosticIdentity): void {
  if (typeof window === 'undefined') return
  const code = (() => {
    const value = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
    return typeof value === 'string' && /^[A-Za-z0-9._:@/+=-]{1,160}$/.test(value) ? value : undefined
  })()
  const clean = safeIdentity({ ...identity, sessionId })
  diagnosticsCore().add({ source: 'source', event: `source.${component === 'plan' ? 'plan' : 'error'}`, ...(code ? { code } : {}),
    key: `failure:${component}:${sessionId}:${code ?? 'unknown'}`, ...(clean ? { identity: clean } : {}) })
}

/** Connection-state changes observed by plugin code (not free-form logs). */
export function recordConnection(sessionId: string, connection: 'connected' | 'disconnected' | 'reconnecting', identity?: DiagnosticIdentity): void {
  if (typeof window === 'undefined') return
  const clean = safeIdentity({ ...identity, sessionId })
  diagnosticsCore().add({ source: 'connection', event: 'connection.changed', connection,
    key: `connection:${sessionId}:${connection}`, ...(clean ? { identity: clean } : {}) })
}

/** Pagination diagnostics for the empty/late-history incident: direction, cursors,
 * epoch and reset only. Used by history-loading call sites when available. */
export function recordPagination(sessionId: string, input: {
  direction: 'latest' | 'before' | 'after'; beforeAt?: number; beforeSeq?: number; epoch?: number; reset?: boolean; hasMore?: boolean
  identity?: DiagnosticIdentity
}): void {
  if (typeof window === 'undefined') return
  const clean = safeIdentity({ ...input.identity, sessionId })
  diagnosticsCore().add({ source: 'pagination', event: 'pagination', direction: input.direction,
    ...(input.beforeAt === undefined ? {} : { beforeAt: input.beforeAt }), ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
    ...(input.epoch === undefined ? {} : { epoch: input.epoch }), ...(input.reset === undefined ? {} : { reset: input.reset }),
    ...(input.hasMore === undefined ? {} : { hasMore: input.hasMore }), ...(clean ? { identity: clean } : {}) })
}
