import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DisplayLeases } from '../src/codex/display-leases.ts'
import { createDisplayLeaseRegistry, type DisplayLeaseOptions } from '../src/client/surface/display-leases.ts'

const deferred = () => {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const until = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition did not settle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

interface HarnessOptions {
  legacyResponse?: boolean
  resolver?: () => Promise<{ ok: boolean; value?: { hubId: string; sourceSessionId: string; sessionId: string }; error?: Error }>
  leaseOptions?: DisplayLeaseOptions
}
function harness(options: HarnessOptions = {}) {
  let now = 0, attached = true, resolves = 0, recoveries = 0
  const host = new DisplayLeases(() => now)
  const actions: string[] = [], errors: unknown[] = []
  const api = {
    async sourceDisplayLease(request: { action: 'acquire' | 'renew' | 'release'; sourceSessionId: string; leaseId: string; ttlMs?: number }) {
      actions.push(request.action)
      if (options.legacyResponse) {
        if (request.action === 'acquire') host.acquire(request.sourceSessionId, request.leaseId, request.ttlMs)
        if (request.action === 'renew') host.renew(request.sourceSessionId, request.leaseId, request.ttlMs)
        if (request.action === 'release') host.release(request.sourceSessionId, request.leaseId)
        return { ok: true, value: { released: false } } as never
      }
      if (request.action === 'acquire') {
        host.acquire(request.sourceSessionId, request.leaseId, request.ttlMs)
        return { ok: true, value: { released: !attached, leaseActive: true, attached } } as never
      }
      if (request.action === 'renew') {
        const active = host.renew(request.sourceSessionId, request.leaseId, request.ttlMs)
        return { ok: true, value: { released: !attached && !active, leaseActive: active, attached } } as never
      }
      const empty = host.release(request.sourceSessionId, request.leaseId)
      return { ok: true, value: { released: empty && !attached, leaseActive: false, attached } } as never
    },
    async sourceSessionResolve(request: { hubId: string; sourceSessionId: string }) {
      resolves++
      if (options.resolver) return options.resolver() as never
      attached = true
      return { ok: true, value: { hubId: request.hubId, sourceSessionId: request.sourceSessionId, sessionId: `display-${resolves}` } } as never
    },
  }
  const registry = createDisplayLeaseRegistry(api as never, error => errors.push(error), {
    retryBaseMs: 10, retryMaxMs: 20, rpcTimeoutMs: 100, ...options.leaseOptions,
    onRecover: () => { recoveries++ },
  })
  return {
    host, registry, actions, errors, sessions: () => resolves, recoveries: () => recoveries,
    expire() { now += 300_001; host.expire(); attached = false },
    detach() { attached = false },
    setAttached(value: boolean) { attached = value },
    advance(ms: number) { now += ms },
  }
}

test('display lease keeps one Host lease until every pane and warm reference releases it', async () => {
  const h = harness()
  try {
    h.registry.remember('display-1', { hubId: 'hub', sourceSessionId: 'source-1' })
    h.registry.retain('display-1')
    h.registry.retain('display-1')
    await h.registry.flush()
    assert.deepEqual(h.actions, ['acquire'])
    h.registry.release('display-1')
    await h.registry.flush()
    assert.deepEqual(h.actions, ['acquire'], 'one reader remains; the Host lease must stay live')
    h.registry.release('display-1')
    await h.registry.flush()
    assert.deepEqual(h.actions, ['acquire', 'release'])
    assert.equal(h.recoveries(), 0)
  } finally { h.registry.dispose() }
})

test('a frozen page that outlives its lease re-acquires on the next heartbeat', async () => {
  const h = harness({ legacyResponse: true })
  const savedInterval = globalThis.setInterval, savedClear = globalThis.clearInterval
  let heartbeat: (() => void) | undefined
  globalThis.setInterval = ((fn: () => void) => { heartbeat = fn; return 1 }) as never
  globalThis.clearInterval = (() => {}) as never
  try {
    h.registry.remember('display', { hubId: 'hub', sourceSessionId: 'source' })
    h.registry.retain('display'); await h.registry.flush()
    h.expire()
    heartbeat?.(); await h.registry.flush()
    assert.equal(h.host.has('source'), true, 'an active page must regain its lease after TTL expiry')
    assert.deepEqual(h.actions, ['acquire', 'renew', 'acquire'])
    assert.equal(h.recoveries(), 0, 'a live Host display needs no source generation change')
  } finally { h.registry.dispose(); globalThis.setInterval = savedInterval; globalThis.clearInterval = savedClear }
})

test('expiry that retires the display recovers a new generation through the public source resolver', async () => {
  const h = harness()
  try {
    h.registry.remember('display', { hubId: 'hub', sourceSessionId: 'source' })
    h.registry.retain('display'); await h.registry.flush()
    h.expire()
    h.registry.resume()
    await until(() => h.recoveries() === 1 && h.host.has('source'))
    assert.equal(h.sessions(), 1)
    assert.deepEqual(h.actions.slice(0, 3), ['acquire', 'renew', 'acquire'])
    assert.equal(h.errors.length, 0)
  } finally { h.registry.dispose() }
})

test('a lease lost while another browser still holds the source re-acquires without forcing a new generation', async () => {
  const h = harness()
  try {
    h.host.acquire('source', 'other-browser', 3_600_000)
    h.registry.remember('display', { hubId: 'hub', sourceSessionId: 'source' })
    h.registry.retain('display'); await h.registry.flush()
    h.expire()
    h.setAttached(true) // the other browser's lease kept the display alive
    h.registry.resume()
    await until(() => h.host.size('source') === 2 && h.actions.filter(action => action === 'acquire').length === 2)
    assert.equal(h.sessions(), 0, 'the still-live display is never reopened or version-bumped')
    assert.equal(h.recoveries(), 0)
    assert.equal(h.host.has('source'), true)
  } finally { h.registry.dispose() }
})

test('recovery retries a failed resolver with bounded backoff and then refreshes the catalog', async () => {
  let failures = 2
  const h = harness({ resolver: async () => {
    if (failures-- > 0) return { ok: false, error: new Error('Host restarting') }
    return { ok: true, value: { hubId: 'hub', sourceSessionId: 'source', sessionId: 'display-recovered' } }
  } })
  try {
    h.registry.remember('display', { hubId: 'hub', sourceSessionId: 'source' })
    h.registry.retain('display'); await h.registry.flush()
    h.expire()
    h.registry.resume()
    await until(() => h.recoveries() === 1 && h.host.has('source'), 2_000)
    assert.equal(h.sessions(), 3)
    assert.ok(h.errors.length >= 2)
  } finally { h.registry.dispose() }
})

test('recovery cannot revive a display released while its resolver is in flight', async () => {
  const gate = deferred()
  const h = harness({ resolver: async () => {
    await gate.promise
    return { ok: true, value: { hubId: 'hub', sourceSessionId: 'source', sessionId: 'display-late' } }
  } })
  try {
    h.registry.remember('display', { hubId: 'hub', sourceSessionId: 'source' })
    h.registry.retain('display'); await h.registry.flush()
    h.expire()
    h.registry.resume()
    await until(() => h.sessions() === 1)
    h.registry.release('display')
    gate.resolve()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(h.recoveries(), 0, 'a closed display must not run the controller recovery refresh')
  } finally { h.registry.dispose() }
})

test('a hung lease RPC keeps at most one in-flight request and a bounded retry cadence', async () => {
  let calls = 0
  const registry = createDisplayLeaseRegistry({
    sourceDisplayLease: async () => { calls++; return new Promise(() => {}) },
  } as never, () => {}, { rpcTimeoutMs: 30, retryBaseMs: 20, retryMaxMs: 20 })
  try {
    registry.remember('display', { hubId: 'hub', sourceSessionId: 'source' })
    registry.retain('display')
    await new Promise(resolve => setTimeout(resolve, 140))
    assert.ok(calls >= 2, 'the timeout must schedule a retry')
    assert.ok(calls <= 5, `heartbeat retries must not form an unbounded chain (saw ${calls})`)
  } finally { registry.dispose() }
})
