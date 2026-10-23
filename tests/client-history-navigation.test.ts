import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { OpenState } from '@deepseek-ai/dsh-api-session-controller/client'
import { loadHistoryThrough } from '../src/client/history-navigation.ts'

function fixture(loadingOlder = true) {
    let state = { openState: 'open' as OpenState, loadingOlder, removed: false }
    const listeners = new Set<() => void>(), calls: number[] = []
    let resolve: (() => void) | undefined
    const session = {
        getSnapshot: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        loadThrough(seq: SessionSeq) {
            // Reproduce the pinned official contract, including its busy no-op.
            if (state.loadingOlder) return Promise.resolve()
            calls.push(seq); state = { ...state, loadingOlder: true }
            return new Promise<void>(done => { resolve = done })
        },
    }
    const publish = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
    return { session, listeners, calls, publish, complete() { publish({ loadingOlder: false }); resolve?.() } }
}

test('explicit navigation waits for an earlier page instead of accepting official busy no-op', async () => {
    const f = fixture(), controller = new AbortController()
    let finished = false
    const task = loadHistoryThrough(f.session, 50 as SessionSeq, controller.signal).then(() => { finished = true })
    await Promise.resolve()
    assert.deepEqual(f.calls, [])
    assert.equal(finished, false)
    f.publish({ loadingOlder: false })
    assert.deepEqual(f.calls, [50], 'claim the newly idle public flight synchronously')
    assert.equal(f.listeners.size, 0)
    f.complete(); await task
    assert.equal(finished, true)
})

test('abort while waiting removes the subscription and leaves the shared page running', async () => {
    const f = fixture(), controller = new AbortController()
    const task = loadHistoryThrough(f.session, 50 as SessionSeq, controller.signal)
    controller.abort(new Error('reader moved'))
    await assert.rejects(task, /reader moved/)
    assert.equal(f.listeners.size, 0)
    assert.equal(f.session.getSnapshot().loadingOlder, true)
    f.publish({ loadingOlder: false }); assert.deepEqual(f.calls, [])
})

test('replacement while waiting does not issue a navigation on the retired binding', async () => {
    const f = fixture(), controller = new AbortController()
    let current = true
    const task = loadHistoryThrough(f.session, 50 as SessionSeq, controller.signal, () => current)
    current = false; f.publish({ loadingOlder: false })
    await assert.rejects(task, /replaced/)
    assert.deepEqual(f.calls, []); assert.equal(f.listeners.size, 0)
})

test('a removed source terminates a pending wait', async () => {
    const f = fixture(), controller = new AbortController()
    const task = loadHistoryThrough(f.session, 50 as SessionSeq, controller.signal)
    f.publish({ removed: true })
    await assert.rejects(task, /no longer open/)
    assert.deepEqual(f.calls, []); assert.equal(f.listeners.size, 0)
})

test('reconnect replacement arriving before open waits for the public open transition', async () => {
    const f = fixture(false), controller = new AbortController()
    f.publish({ openState: 'loading' })
    const task = loadHistoryThrough(f.session, 50 as SessionSeq, controller.signal)
    await Promise.resolve(); assert.deepEqual(f.calls, [])
    f.publish({ openState: 'open' }); assert.deepEqual(f.calls, [50])
    f.complete(); await task
})

test('an earlier subscriber claiming the idle flight makes navigation wait for the next idle notification', async () => {
    const f = fixture(), controller = new AbortController()
    let reclaim = true
    f.listeners.add(() => {
        if (reclaim && !f.session.getSnapshot().loadingOlder) { reclaim = false; f.publish({ loadingOlder: true }) }
    })
    const task = loadHistoryThrough(f.session, 50 as SessionSeq, controller.signal)
    f.publish({ loadingOlder: false }); assert.deepEqual(f.calls, [])
    f.publish({ loadingOlder: false }); assert.deepEqual(f.calls, [50])
    f.complete(); await task
})

test('abort after claiming history suppresses late navigation completion without cancelling its shared flight', async () => {
    const f = fixture(false), controller = new AbortController()
    const task = loadHistoryThrough(f.session, 50 as SessionSeq, controller.signal)
    assert.deepEqual(f.calls, [50])
    controller.abort(new Error('pane closed'))
    await assert.rejects(task, /pane closed/)
    assert.equal(f.session.getSnapshot().loadingOlder, true)
    f.complete(); await Promise.resolve()
})
