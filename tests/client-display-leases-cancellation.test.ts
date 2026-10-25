import test from 'node:test'
import assert from 'node:assert/strict'
import { createDisplayLeaseRegistry } from '../src/client/surface/display-leases.ts'
import { HAPI_REMOTE } from '../src/client-api.ts'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('lease timeouts cancel the actual transport before retrying', async () => {
    let pending = 0, peak = 0, calls = 0, cancelled = 0
    const registry = createDisplayLeaseRegistry({
        sourceDisplayLease: (_request: unknown, signal?: AbortSignal) => {
            calls++; pending++; peak = Math.max(peak, pending)
            return new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => {
                    pending--; cancelled++; reject(signal.reason)
                }, { once: true })
            })
        },
    } as never, () => {}, { rpcTimeoutMs: 15, retryBaseMs: 10, retryMaxMs: 10 })
    try {
        registry.remember('display', { hubId: 'hub', sourceSessionId: 'source' })
        registry.retain('display')
        await pause(120)
        assert.ok(calls >= 2, 'a cancelled transport must be retried')
        assert.ok(cancelled >= 1, 'timeout must reach the transport, not only an outer Promise')
        assert.equal(peak, 1, 'actual unresolved transport requests must not accumulate')
    } finally { registry.dispose(); await pause(35) }
    assert.equal(pending, 0)
})

test('a transport that ignores cancellation cannot accumulate more pending requests', async () => {
    let pending = 0
    const registry = createDisplayLeaseRegistry({
        sourceDisplayLease: () => { pending++; return new Promise(() => {}) },
    } as never, () => {}, { rpcTimeoutMs: 15, retryBaseMs: 10, retryMaxMs: 10 })
    try {
        registry.remember('display', { hubId: 'hub', sourceSessionId: 'source' })
        registry.retain('display')
        for (let i = 0; i < 5; i++) { registry.resume(); await pause(25) }
        assert.equal(pending, 1)
    } finally { registry.dispose() }
})

test('disposing while acquire is pending releases the acknowledged lease', async () => {
    let resolve!: (value: unknown) => void
    const actions: string[] = []
    const registry = createDisplayLeaseRegistry({
        sourceDisplayLease: (request: { action: string }) => {
            actions.push(request.action)
            if (request.action === 'acquire') return new Promise(done => { resolve = done })
            return Promise.resolve({ ok: true, value: { released: true, leaseActive: false, attached: false } })
        },
    } as never)
    registry.remember('display', { hubId: 'hub', sourceSessionId: 'source' })
    registry.retain('display')
    registry.dispose()
    resolve({ ok: true, value: { released: false, leaseActive: true, attached: true } })
    await pause(10)
    assert.deepEqual(actions, ['acquire', 'release'])
})

test('display recovery calls expose official RPC cancellation', () => {
    for (const method of ['sourceDisplayLease', 'sourceSessionResolve']) {
        const descriptor = HAPI_REMOTE.descriptors.find(row => row.method === method)
        assert.deepEqual(descriptor?.cancellation, { parameter: 'signal' })
    }
})
