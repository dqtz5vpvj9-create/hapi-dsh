/** Public SessionReference protocol fixtures, with controllable ready waits. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ISessions, SessionBinding, SessionReference, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSessionWarmup } from '../src/client/surface/session-warmup.ts'

const ids = (...values: string[]): SessionId[] => values as SessionId[]
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function fixture(onRetain?: (id: SessionId) => void, onRelease?: (id: SessionId) => void) {
    const refs: Array<{ id: SessionId; source: string; signal?: AbortSignal | undefined; releases: number; resolve(): void; reject(error: Error): void; grow(count: number): void; watchers(): number }> = []
    const sessions: Pick<ISessions, 'retain'> = { retain(target, options) {
        const id = typeof target === 'string' ? target : target.childSessionId
        let eventCount = 0
        const listeners = new Set<() => void>()
        const binding = { sessionId: id, eventSource: {
            getSnapshot: () => ({ entries: new Array<SessionEventLikeEntry>(eventCount), hasMore: true, revision: eventCount,
                change: { kind: 'replace' as const, entries: [] } }),
            subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        } } as unknown as SessionBinding
        let resolve!: (value: SessionBinding) => void, reject!: (error: Error) => void
        const ready = new Promise<SessionBinding>((yes, no) => { resolve = yes; reject = no })
        const record = { id, source: options.source, signal: options.signal, releases: 0, resolve: () => resolve(binding), reject,
            grow(count: number) { eventCount = count; for (const listener of listeners) listener() }, watchers: () => listeners.size }
        const reference: SessionReference = { sessionId: id, binding, ready,
            release() { record.releases++; onRelease?.(id) }, [Symbol.dispose]() { this.release() } }
        refs.push(record); onRetain?.(id)
        return reference
    } }
    return { sessions, refs }
}

test('warmup bounds candidates to five and pending acquisitions to two', async () => {
    const f = fixture(), errors: unknown[] = [], warmup = createSessionWarmup(f.sessions, { onError: error => errors.push(error) })
    try {
        warmup.update(ids('a', 'a', 'b', 'c', 'd', 'e', 'f', 'g'))
        assert.deepEqual(warmup.getSnapshot(), { ids: ids('a', 'b', 'c', 'd', 'e'), queued: 3, opening: 2, ready: 0, failed: 0, uncached: 0, retained: 2 })
        assert.deepEqual(f.refs.map(ref => ref.id), ids('a', 'b'))
        f.refs[1]!.resolve(); await tick()
        assert.deepEqual(f.refs.map(ref => ref.id), ids('a', 'b', 'c'))
        f.refs[0]!.resolve(); await tick()
        assert.equal(warmup.getSnapshot().opening, 2)
        const error = new Error('offline source')
        f.refs[2]!.reject(error); await tick()
        assert.equal(f.refs[2]!.releases, 1)
        assert.equal(f.refs[2]!.signal?.aborted, true)
        assert.deepEqual(errors, [error])
        f.refs[3]!.resolve(); f.refs[4]!.resolve(); await tick()
        assert.deepEqual(warmup.getSnapshot(), { ids: ids('a', 'b', 'c', 'd', 'e'), queued: 0, opening: 0, ready: 4, failed: 1, uncached: 0, retained: 4 })
        warmup.update(ids('a', 'b', 'c', 'd', 'e'))
        assert.equal(f.refs.length, 5, 'frequent catalog publication must not hot-loop a failed candidate')
    } finally { warmup.dispose(); warmup.dispose() }
    assert.ok(f.refs.every(ref => ref.releases === 1))
    assert.ok(f.refs.every(ref => ref.source === 'hapiWarmup'))
})

test('eviction releases its own reference and ignores late results of the previous generation', async () => {
    const f = fixture(), errors: unknown[] = [], warmup = createSessionWarmup(f.sessions, { onError: error => errors.push(error) })
    try {
        warmup.update(ids('a', 'b', 'c'))
        const oldA = f.refs[0]!, oldB = f.refs[1]!
        warmup.update(ids('x', 'y'))
        assert.equal(oldA.releases, 1); assert.equal(oldB.releases, 1)
        assert.ok(oldA.signal?.aborted && oldB.signal?.aborted)
        warmup.update(ids('a'))
        const current = f.refs.at(-1)!
        assert.equal(current.id, 'a')
        oldA.reject(new Error('retired failure')); oldB.resolve(); await tick()
        assert.equal(warmup.getSnapshot().opening, 1)
        assert.deepEqual(errors, [])
        current.resolve(); await tick()
        assert.equal(warmup.getSnapshot().ready, 1)
        assert.equal(current.releases, 0)
    } finally { warmup.dispose() }
    assert.ok(f.refs.every(ref => ref.releases === 1))
})

test('warmup cancellation on teardown cannot acquire queued sessions later', async () => {
    const f = fixture(), warmup = createSessionWarmup(f.sessions)
    warmup.update(ids('a', 'b', 'c', 'd', 'e'))
    warmup.dispose()
    f.refs[0]!.resolve(); f.refs[1]!.resolve(); await tick()
    warmup.update(ids('f'))
    assert.equal(f.refs.length, 2)
    assert.equal(warmup.getSnapshot().retained, 0)
    assert.deepEqual(warmup.getSnapshot().ids, [])
    assert.ok(f.refs.every(ref => ref.releases === 1))
})

test('synchronous catalog reentry during retain cannot leak the evicted reference', async () => {
    let warmup!: ReturnType<typeof createSessionWarmup>
    const f = fixture(id => { if (id === 'a') warmup.update(ids('b')) })
    warmup = createSessionWarmup(f.sessions)
    try {
        warmup.update(ids('a'))
        assert.deepEqual(f.refs.map(ref => ref.id), ids('a', 'b'))
        assert.equal(f.refs[0]!.releases, 1)
        f.refs[0]!.reject(new Error('evicted during retain')); f.refs[1]!.resolve(); await tick()
        assert.deepEqual(warmup.getSnapshot().ids, ids('b'))
        assert.equal(warmup.getSnapshot().ready, 1)
    } finally { warmup.dispose() }
    assert.ok(f.refs.every(ref => ref.releases === 1))
})

test('public Conversation preparation runs after readiness only for a retained generation', async () => {
    const f = fixture(), prepared: string[] = [], failures: unknown[] = []
    const failure = new Error('optional presentation cache is unavailable')
    const warmup = createSessionWarmup(f.sessions, { prepare: reference => {
        prepared.push(reference.binding.sessionId)
        if (reference.sessionId === 'b') throw failure
    }, onError: error => failures.push(error) })
    try {
        warmup.update(ids('a', 'b'))
        assert.deepEqual(prepared, [], 'pending history must not be presented as a ready cache')
        const retired = f.refs[0]!
        warmup.update(ids('b', 'c'))
        retired.resolve(); f.refs[1]!.resolve(); await tick()
        assert.deepEqual(prepared, ['b'], 'evicted references must not materialize a Conversation binding')
        assert.deepEqual(failures, [failure])
        assert.equal(warmup.getSnapshot().ready, 1, 'optional presentation cache failure must not discard the source tail')
        warmup.dispose()
        f.refs[2]!.resolve(); await tick()
        assert.deepEqual(prepared, ['b'])
    } finally { warmup.dispose() }
})

test('an intended session takes the next warm slot without restarting pending references', async () => {
    const f = fixture(), warmup = createSessionWarmup(f.sessions)
    try {
        warmup.update(ids('a', 'b', 'c', 'd', 'e'))
        warmup.update(ids('x', 'a', 'b', 'c', 'd'))
        assert.deepEqual(f.refs.map(ref => ref.id), ['a', 'b'])
        assert.equal(f.refs[0]!.releases, 0)
        assert.equal(f.refs[1]!.releases, 0)
        f.refs[0]!.resolve(); await tick()
        assert.deepEqual(f.refs.map(ref => ref.id), ['a', 'b', 'x'])
        assert.equal(warmup.getSnapshot().opening, 2)
    } finally { warmup.dispose() }
})

test('oversized history releases only the warm lease and does not reacquire on catalog updates', async () => {
    const f = fixture(), warmup = createSessionWarmup(f.sessions, { maxEvents: 2 })
    warmup.update(ids('long'))
    const ref = f.refs[0]!
    ref.resolve(); await tick()
    ref.grow(2); assert.equal(ref.releases, 0)
    ref.grow(3)
    assert.equal(ref.releases, 1)
    assert.equal(ref.watchers(), 0)
    assert.equal(warmup.getSnapshot().uncached, 1)
    warmup.update(ids('long'))
    assert.equal(f.refs.length, 1)
    warmup.dispose(); assert.equal(ref.releases, 1)
})

test('an oversized ready window skips presentation warming and frees the next acquisition slot', async () => {
    const f = fixture(), prepared: string[] = []
    const warmup = createSessionWarmup(f.sessions, { maxEvents: 2, concurrency: 1, prepare: ref => { prepared.push(ref.sessionId) } })
    warmup.update(ids('long', 'short'))
    f.refs[0]!.grow(3); f.refs[0]!.resolve(); await tick()
    assert.equal(f.refs[0]!.releases, 1)
    assert.deepEqual(f.refs.map(ref => ref.id), ['long', 'short'])
    assert.deepEqual(prepared, [])
    f.refs[1]!.resolve(); await tick()
    assert.deepEqual(prepared, ['short'])
    warmup.dispose(); assert.equal(f.refs[1]!.watchers(), 0)
})

// Protocol reproduction of the uploaded trace: release -> catalog -> warmRecent
// reenters update while a hover is evicting the background candidate.
test('synchronous catalog reentry during eviction cannot repeatedly release a re-added candidate', async () => {
    let warmup!: ReturnType<typeof createSessionWarmup>
    let releases = 0
    const f = fixture(undefined, () => {
        if (++releases > 10) throw new Error('eviction/reacquisition loop')
        warmup.update(ids('a', 'b'))
    })
    warmup = createSessionWarmup(f.sessions)
    try {
        warmup.update(ids('a', 'b'))
        f.refs[0]!.resolve(); f.refs[1]!.resolve(); await tick()
        warmup.update(ids('a'))
        assert.equal(releases, 1)
        assert.equal(f.refs.length, 3)
        assert.equal(f.refs[1]!.releases, 1)
        assert.equal(f.refs[2]!.releases, 0)
        assert.deepEqual(warmup.getSnapshot().ids, ids('a', 'b'))
        f.refs[2]!.resolve(); await tick()
        assert.equal(warmup.getSnapshot().ready, 2)
    } finally { warmup.dispose() }
    assert.ok(f.refs.every(ref => ref.releases === 1))
})

test('warmup mirrors its exact public reference lifetime onto the display lease', async () => {
    const f = fixture(), events: string[] = []
    const warmup = createSessionWarmup(f.sessions, { lease: {
        acquire: id => events.push(`acquire:${id}`), release: id => events.push(`release:${id}`),
    } })
    warmup.update(ids('a', 'b'))
    assert.deepEqual(events, ['acquire:a', 'acquire:b'])
    f.refs[0]!.resolve(); f.refs[1]!.resolve(); await tick()
    warmup.update(ids('a'))
    assert.deepEqual(events, ['acquire:a', 'acquire:b', 'release:b'])
    warmup.dispose()
    assert.deepEqual(events, ['acquire:a', 'acquire:b', 'release:b', 'release:a'])
    assert.ok(f.refs.every(ref => ref.releases === 1))
})

test('a failed warm retain releases the lease it acquired', async () => {
    const sessions: Pick<ISessions, 'retain'> = { retain() { throw new Error('catalog unavailable') } }
    const events: string[] = []
    const warmup = createSessionWarmup(sessions, { lease: {
        acquire: id => events.push(`acquire:${id}`), release: id => events.push(`release:${id}`),
    }, onError: () => {} })
    warmup.update(ids('a'))
    assert.deepEqual(events, ['acquire:a', 'release:a'])
    warmup.dispose()
})
