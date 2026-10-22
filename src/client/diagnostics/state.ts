/** Browser-side diagnostics ring buffer shared by every pane graph in one page.
 *
 * Privacy contract (ship blocker): entries are an ALLOWLIST of operational
 * fields. Request/response bodies, prompts, file contents, cookies,
 * authorization values, URL queries/fragments, console text and free-form error
 * messages are never stored. Identity is captured per event, so concurrent
 * panes cannot leak each other's context through a shared mutable slot.
 * Memory only; nothing is written to storage.
 */
import { HAPI_DSH_BUILD_ID, HAPI_DSH_VERSION, DSH_VERSION, HAPI_SOURCE_REVISION } from '../../build-info.ts'

export const DIAGNOSTICS_LIMIT = 300

export type DiagnosticEvent =
  | 'remote.rejected' | 'remote.failed' | 'remote.timeout' | 'remote.aborted'
  | 'connection.changed' | 'console.error' | 'console.warn'
  | 'window.error' | 'window.unhandledrejection'
  | 'source.error' | 'source.plan' | 'pagination' | 'pane.opening'

export type DiagnosticSource = 'remote' | 'connection' | 'console' | 'window' | 'source' | 'pagination' | 'performance'

/** Per-event source identity; never a page-global mutable context. */
export interface DiagnosticIdentity {
  hubId?: string
  hostId?: string
  sessionId?: string
  hapiSessionId?: string
  machineId?: string
  engine?: string
}

/** Allowlisted operational fields only. */
export interface DiagnosticInput {
  source: DiagnosticSource
  event: DiagnosticEvent
  key?: string
  time?: number
  durationMs?: number
  method?: string
  route?: string
  status?: number
  code?: string
  requestId?: string
  outcome?: string
  timeout?: boolean
  aborted?: boolean
  retryAfterMs?: number
  connection?: 'connected' | 'disconnected' | 'reconnecting'
  direction?: 'latest' | 'before' | 'after'
  beforeAt?: number
  beforeSeq?: number
  epoch?: number
  reset?: boolean
  hasMore?: boolean
  errorName?: string
  identity?: DiagnosticIdentity
}

export interface DiagnosticEntry extends DiagnosticInput {
  readonly id: number
  readonly time: number
}

export interface DiagnosticsSnapshot {
  readonly entries: readonly DiagnosticEntry[]
  readonly drawerOpen: boolean
}

/** Static, build-time context only. Never mutable per-pane state. */
export function diagnosticsBuildContext(): string[] {
  return [`build ${HAPI_DSH_BUILD_ID}`, `hapi-dsh ${HAPI_DSH_VERSION} · dsh ${DSH_VERSION} · hapi ${HAPI_SOURCE_REVISION}`]
}

const TOKEN = /^[A-Za-z0-9._:@/+=-]{1,160}$/
/** A protocol identifier: short token, no whitespace/URL query/fragment. */
export function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && TOKEN.test(value) ? value : undefined
}

/** Path only: no query, fragment, credentials or trailing free text. */
export function safeRoute(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const url = new URL(value, 'http://diagnostics.invalid')
    const path = url.pathname
    return TOKEN.test(path) ? path : undefined
  } catch { return undefined }
}

const IDENTITY_KEYS = ['hubId', 'hostId', 'sessionId', 'hapiSessionId', 'machineId', 'engine'] as const

export function safeIdentity(identity: DiagnosticIdentity | undefined): DiagnosticIdentity | undefined {
  if (!identity) return undefined
  const clean: DiagnosticIdentity = {}
  let found = false
  for (const key of IDENTITY_KEYS) {
    const value = safeToken(identity[key])
    if (value !== undefined) { clean[key] = value; found = true }
  }
  return found ? clean : undefined
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Copy only allowlisted, validated fields; anything else is dropped. */
export function sanitizeEntry(input: DiagnosticInput, id: number): DiagnosticEntry {
  const entry: DiagnosticEntry = { id, time: numeric(input.time) ?? Date.now(), source: input.source, event: input.event }
  const key = input.key ? safeToken(input.key) : undefined
  if (key !== undefined) entry.key = key
  const durationMs = numeric(input.durationMs)
  if (durationMs !== undefined) entry.durationMs = Math.max(0, Math.round(durationMs))
  const method = safeToken(input.method)
  if (method !== undefined) entry.method = method
  const route = safeRoute(input.route)
  if (route !== undefined) entry.route = route
  const status = numeric(input.status)
  if (status !== undefined) entry.status = status
  const code = safeToken(input.code)
  if (code !== undefined) entry.code = code
  const requestId = safeToken(input.requestId)
  if (requestId !== undefined) entry.requestId = requestId
  const outcome = safeToken(input.outcome)
  if (outcome !== undefined) entry.outcome = outcome
  if (input.timeout === true) entry.timeout = true
  if (input.aborted === true) entry.aborted = true
  const retryAfterMs = numeric(input.retryAfterMs)
  if (retryAfterMs !== undefined) entry.retryAfterMs = Math.max(0, retryAfterMs)
  if (input.connection === 'connected' || input.connection === 'disconnected' || input.connection === 'reconnecting') entry.connection = input.connection
  if (input.direction === 'latest' || input.direction === 'before' || input.direction === 'after') entry.direction = input.direction
  const beforeAt = numeric(input.beforeAt)
  if (beforeAt !== undefined) entry.beforeAt = beforeAt
  const beforeSeq = numeric(input.beforeSeq)
  if (beforeSeq !== undefined) entry.beforeSeq = beforeSeq
  const epoch = numeric(input.epoch)
  if (epoch !== undefined) entry.epoch = epoch
  if (input.reset !== undefined) entry.reset = input.reset
  if (input.hasMore !== undefined) entry.hasMore = input.hasMore
  const errorName = safeToken(input.errorName)
  if (errorName !== undefined) entry.errorName = errorName
  const identity = safeIdentity(input.identity)
  if (identity !== undefined) entry.identity = identity
  return entry
}

function identityText(identity: DiagnosticIdentity | undefined): string {
  if (!identity) return ''
  const parts = [identity.hubId && `hub=${identity.hubId}`, identity.hostId && `host=${identity.hostId}`, identity.sessionId && `session=${identity.sessionId}`,
    identity.hapiSessionId && `source=${identity.hapiSessionId}`, identity.machineId && `machine=${identity.machineId}`, identity.engine && `engine=${identity.engine}`]
  return parts.filter(Boolean).join(' ')
}

function entryText(entry: DiagnosticEntry, index: number): string[] {
  const facts = [
    entry.method && `method=${entry.method}`, entry.route && `route=${entry.route}`,
    entry.status === undefined ? '' : `status=${entry.status}`, entry.code && `code=${entry.code}`,
    entry.requestId && `requestId=${entry.requestId}`, entry.outcome && `outcome=${entry.outcome}`,
    entry.durationMs === undefined ? '' : `durationMs=${entry.durationMs}`,
    entry.timeout ? 'timeout=true' : '', entry.aborted ? 'aborted=true' : '',
    entry.retryAfterMs === undefined ? '' : `retryAfterMs=${entry.retryAfterMs}`,
    entry.connection && `connection=${entry.connection}`,
    entry.direction && `direction=${entry.direction}`, entry.beforeAt === undefined ? '' : `beforeAt=${entry.beforeAt}`,
    entry.beforeSeq === undefined ? '' : `beforeSeq=${entry.beforeSeq}`, entry.epoch === undefined ? '' : `epoch=${entry.epoch}`,
    entry.reset === undefined ? '' : `reset=${entry.reset}`, entry.hasMore === undefined ? '' : `hasMore=${entry.hasMore}`,
    entry.errorName && `errorName=${entry.errorName}`,
  ].filter(Boolean)
  const identity = identityText(entry.identity)
  return [`${index + 1}. ${new Date(entry.time).toISOString()} [${entry.source}] ${entry.event}`,
    `   ${facts.join(' ')}${identity ? ` ${identity}` : ''}`.trimEnd()]
}

/** One ring buffer per browser page, shared by the primary and pane graphs. */
export class DiagnosticsCore {
  private readonly listeners = new Set<() => void>()
  private snapshot: DiagnosticsSnapshot
  private nextId = 1
  private readonly keys = new Set<string>()
  constructor(entries: DiagnosticEntry[] = [], drawerOpen = false) {
    this.snapshot = { entries: Object.freeze(entries), drawerOpen }
  }
  getSnapshot = (): DiagnosticsSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(entries: readonly DiagnosticEntry[], drawerOpen = this.snapshot.drawerOpen): void {
    this.snapshot = { entries: Object.freeze(entries), drawerOpen }
    for (const listener of this.listeners) listener()
  }
  add(input: DiagnosticInput): void {
    if (input.key) {
      const key = safeToken(input.key)
      if (!key || this.keys.has(key)) return
      this.keys.add(key)
      input = { ...input, key }
    }
    const entry = sanitizeEntry(input, this.nextId++)
    const entries = [...this.snapshot.entries, entry]
    while (entries.length > DIAGNOSTICS_LIMIT) {
      const dropped = entries.shift()
      if (dropped?.key) this.keys.delete(dropped.key)
    }
    this.publish(entries)
  }
  clear(): void {
    if (!this.snapshot.entries.length) return
    this.keys.clear()
    this.publish([])
  }
  openDrawer(open = true): void {
    if (this.snapshot.drawerOpen === open) return
    this.publish(this.snapshot.entries, open)
  }
  /** Plain copyable report. Contains allowlisted fields only; a final scrub is
   * defense in depth for credential-shaped substrings (never expected here). */
  format(): string {
    const lines = ['hapi-dsh diagnostics', `generated: ${new Date().toISOString()}`, ...diagnosticsBuildContext(), `entries: ${this.snapshot.entries.length}`, '']
    for (const [index, entry] of this.snapshot.entries.entries()) lines.push(...entryText(entry, index))
    return lines.join('\n')
      .replace(/([?&;]\s*(?:token|access_token|refresh_token|jwt|secret|password|authorization|cookie|api_key)\s*=)\s*[^&\s;]+/gi, '$1[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]')
  }
}

const CORE_KEY = Symbol.for('hapi-dsh.diagnostics.core')
type DiagnosticsWindow = Window & { [CORE_KEY]?: DiagnosticsCore }

/** Page-owned singleton; every pane graph reports into the same buffer. */
export function diagnosticsCore(): DiagnosticsCore {
  if (typeof window === 'undefined') return new DiagnosticsCore()
  const target = window as DiagnosticsWindow
  target[CORE_KEY] ??= new DiagnosticsCore()
  return target[CORE_KEY]
}
