/** Capture failures of this plugin's own remote/HAPI calls without changing
 * their contract: results are returned untouched, rejections still reject.
 * Only allowlisted operational fields are recorded (method name, status, code,
 * request id, outcome, timing, timeout/abort); bodies and messages never are. */
import type { HapiRemoteApi } from '../../client-api.ts'
import { diagnosticsCore, safeIdentity, safeToken, type DiagnosticIdentity, type DiagnosticsCore } from './state.ts'

const INSTRUMENTED = Symbol.for('hapi-dsh.diagnostics.api')
const IDENTITIES = Symbol.for('hapi-dsh.diagnostics.api.identity')

interface RemoteFailure {
  code?: string
  status?: number
  outcome?: string
  requestId?: string
  timeout?: boolean
  aborted?: boolean
}

function read(object: unknown, key: string): unknown {
  if (object === null || typeof object !== 'object') return undefined
  try { return Reflect.get(object, key) } catch { return undefined }
}

function failureOf(error: unknown): RemoteFailure {
  const details = read(error, 'details')
  const code = safeToken(read(error, 'code') ?? read(details, 'code'))
  const sourceCode = safeToken(read(details, 'sourceCode'))
  const outcome = safeToken(read(details, 'outcome') ?? read(error, 'outcome'))
  const statusValue = read(details, 'status') ?? read(error, 'status')
  const status = typeof statusValue === 'number' && Number.isFinite(statusValue) ? statusValue : undefined
  const requestId = safeToken(read(details, 'requestId') ?? read(details, 'rpcId') ?? read(error, 'requestId'))
  const failure: RemoteFailure = {
    ...(code ? { code } : {}),
    ...(sourceCode ? { code: sourceCode } : {}),
    ...(status === undefined ? {} : { status }),
    ...(outcome ? { outcome } : {}),
    ...(requestId ? { requestId } : {}),
    ...(code && /timeout/i.test(code) ? { timeout: true } : {}),
    ...(code && /abort|cancel/i.test(code) ? { aborted: true } : {}),
  }
  return failure
}

function isResult(value: unknown): value is { ok: boolean } {
  return value !== null && typeof value === 'object' && typeof read(value, 'ok') === 'boolean'
}

type AnyFunction = (...args: unknown[]) => unknown

type MutableApi = HapiRemoteApi & { [INSTRUMENTED]?: true; [IDENTITIES]?: Map<string, DiagnosticIdentity> }

/** Identity is keyed by the pane graph's own api object, so concurrent panes
 * never share a mutable identity slot. */
export function setDiagnosticIdentity(api: HapiRemoteApi, identity: DiagnosticIdentity): void {
  const target = api as MutableApi
  let map = target[IDENTITIES]
  if (!map) {
    map = new Map()
    try { Object.defineProperty(target, IDENTITIES, { value: map, configurable: true }) } catch { return }
  }
  const clean = safeIdentity(identity)
  if (clean) map.set('current', clean)
  else map.delete('current')
}

function currentIdentity(api: HapiRemoteApi): DiagnosticIdentity | undefined {
  return (api as MutableApi)[IDENTITIES]?.get('current')
}

function methodsOf(api: object): string[] {
  const names = new Set<string>()
  let cursor: object | null = api
  while (cursor && cursor !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (name === 'constructor') continue
      if (typeof read(api, name) === 'function') names.add(name)
    }
    cursor = Object.getPrototypeOf(cursor) as object | null
  }
  return [...names]
}

/**
 * Wrap one graph's remote namespace. Instrumentation is per API object and
 * idempotent; a frozen namespace is left untouched rather than failing boot.
 */
export function instrumentHapiApi(api: HapiRemoteApi, core: DiagnosticsCore = diagnosticsCore()): () => void {
  const target = api as unknown as Record<PropertyKey, unknown>
  if (target[INSTRUMENTED] === true) return () => {}
  const originals = new Map<string, AnyFunction>()
  const recordFailure = (name: string, error: unknown, startedAt: number): void => {
    try {
      const failure = failureOf(error)
      const identity = currentIdentity(api)
      core.add({ source: 'remote', event: failure.timeout ? 'remote.timeout' : failure.aborted ? 'remote.aborted' : 'remote.rejected',
        method: `hapi/${name}`, durationMs: Date.now() - startedAt, ...failure, ...(identity ? { identity } : {}) })
    } catch { /* diagnostics must never change the result */ }
  }
  for (const name of methodsOf(api)) {
    const original = read(api, name) as AnyFunction
    originals.set(name, original)
    const wrapped = (...args: unknown[]): unknown => {
      const startedAt = Date.now()
      let result: unknown
      try { result = original.apply(api, args) } catch (error) { recordFailure(name, error, startedAt); throw error }
      if (result === null || typeof result !== 'object') return result
      if (typeof read(result, 'then') !== 'function') {
        if (isResult(result) && result.ok === false) recordFailure(name, read(result, 'error'), startedAt)
        return result
      }
      return Promise.resolve(result as Promise<unknown>).then((value: unknown) => {
        if (isResult(value) && value.ok === false) recordFailure(name, read(value, 'error'), startedAt)
        return value
      }, (error: unknown) => { recordFailure(name, error, startedAt); throw error })
    }
    try {
      Object.defineProperty(api, name, { value: wrapped, configurable: true, writable: true })
    } catch { originals.delete(name) }
  }
  try { Object.defineProperty(api, INSTRUMENTED, { value: true, configurable: true }) } catch { /* keep working untracked */ }
  return () => {
    for (const [name, original] of originals) {
      try { Object.defineProperty(api, name, { value: original, configurable: true, writable: true }) } catch { /* ignore */ }
    }
    try { Reflect.deleteProperty(api, INSTRUMENTED) } catch { /* ignore */ }
  }
}
