/** Public SessionReference protocol fixtures, with controllable ready waits. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ISessions, SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSessionWarmup } from '../src/client/surface/session-warmup.ts'

const ids = (...values: string[]): SessionId[] => values as SessionId[]
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function fixture(onRetain?: (id: SessionId) => void) {
    const refs: Array<{ id: SessionId; source: string; signal?: AbortSignal | undefined; releases: number; resolve(): void; reject(error: Error): void }> = []
    const sessions: Pick<ISessions, 'retain'> = { retain(target, options) {
        const id = typeof target === 'string' ? target : target.childSessionId
        const binding = { sessionId: id } as SessionBinding
        let resolve!: (value: SessionBinding) => void, reject!: (error: Error) => void
        const ready = new Promise<SessionBinding>((yes, no) => { resolve = yes; reject = no })
        const record = { id, source: options.source, signal: options.signal, releases: 0, resolve: () => resolve(binding), reject }
        const reference: SessionReference = { sessionId: id, binding, ready,
            release() { record.releases++ }, [Symbol.dispose]() { this.release() } }
        refs.push(record); onRetain?.(id)
        return reference
    } }
    return { sessions, refs }
}

test('warmup bounds candidates to five and pending acquisitions to two', async () => {
    const f = fixture(), errors: unknown[] = [], warmup = createSessionWarmup(f.sessions, { onError: error => errors.push(error) })
    try {
        warmup.update(ids('a', 'a', 'b', 'c', 'd', 'e', 'f', 'g'))
        assert.deepEqual(warmup.getSnapshot(), { ids: ids('a', 'b', 'c', 'd', 'e'), queued: 3, opening: 2, ready: 0, failed: 0, retained: 2 })
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
        assert.deepEqual(warmup.getSnapshot(), { ids: ids('a', 'b', 'c', 'd', 'e'), queued: 0, opening: 0, ready: 4, failed: 1, retained: 4 })
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
