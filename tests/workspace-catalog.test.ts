/** Catalog-readiness unit test with an explicit transport/catalog fake. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { waitForCatalogSession } from '../src/client/catalog-readiness.ts'

function catalog(initial: SessionListState) {
    let snapshot = initial
    const listeners = new Set<() => void>()
    return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        set(value: SessionListState) { snapshot = value; for (const listener of [...listeners]) listener() },
    }
}

test('an initially resolved refresh is not catalog readiness; a later Host baseline permits retention', async () => {
    const id = 'remote-source' as SessionId
    const list = catalog({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} })
    let reads = 0
    let ready = false
    const waiting = waitForCatalogSession({ list, async refresh() {
        reads++
        // The first read mirrors the official folded pre-connection failure:
        // its Promise resolves but no catalog identity has been published.
        if (reads < 2) return
        list.set({ ids: [id], byId: { [id]: { id, displayTitle: 'Remote', running: false, blank: false, updatedAt: 1, retainedBy: {} } }, phase: 'ready', projectionsBySession: {} })
    } }, id, new AbortController().signal, { retryMs: 1, timeoutMs: 1_000 }).then(() => { ready = true })
    await Promise.resolve()
    assert.equal(ready, false)
    await waiting
    assert.equal(reads, 2)
    assert.ok(list.getSnapshot().byId[id])
})

test('closing a pending pane cancels catalog readiness and its read retries', async () => {
    const list = catalog({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} })
    const lifetime = new AbortController()
    let reads = 0
    const waiting = waitForCatalogSession({ list, async refresh() { reads++ } }, 'missing' as SessionId, lifetime.signal, { retryMs: 1 })
    lifetime.abort(new Error('Pane closed'))
    await assert.rejects(waiting, /Pane closed/)
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(reads, 1)
})
