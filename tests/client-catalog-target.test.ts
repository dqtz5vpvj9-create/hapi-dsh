/** The real Pane prerequisite; only the catalog transport is controlled here. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForCatalogSession } from '../src/client/catalog-readiness.ts'

test('an exact HHPI identity opens before an unrelated full catalog completes', async () => {
  const id = 'hhpi:machine:source:codex:thread' as Parameters<typeof waitForCatalogSession>[1]
  const listeners = new Set<() => void>()
  const rows: Record<string, unknown> = {}
  let fullReads = 0, pointReads = 0
  const sessions = {
    list: { getSnapshot: () => ({ byId: rows }), subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) } },
    refresh: async () => { ++fullReads; throw new Error('Unrelated directory is unavailable') },
    resolveSession: async (target: typeof id, signal: AbortSignal) => {
      signal.throwIfAborted(); assert.equal(target, id); ++pointReads
      rows[id] = { id }; for (const notify of listeners) notify()
    },
  }
  await waitForCatalogSession(sessions as unknown as Parameters<typeof waitForCatalogSession>[0], id, new AbortController().signal)
  assert.equal(pointReads, 1)
  assert.equal(fullReads, 0)
  assert.equal(listeners.size, 0)
})

test('cancelling a target resolution releases its Pane listener without waiting for discovery', async () => {
  const listeners = new Set<() => void>(), waiting = Promise.withResolvers<void>()
  const abort = new AbortController()
  const sessions = {
    list: { getSnapshot: () => ({ byId: {} }), subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) } },
    refresh: async () => waiting.promise,
    resolveSession: async () => waiting.promise,
  }
  const pending = waitForCatalogSession(sessions as unknown as Parameters<typeof waitForCatalogSession>[0],
    'hhpi:machine:source:codex:thread' as Parameters<typeof waitForCatalogSession>[1], abort.signal)
  abort.abort(new Error('Pane released'))
  await assert.rejects(pending, /Pane released/)
  assert.equal(listeners.size, 0)
  waiting.resolve()
})

test('a source-specific refusal is shown immediately rather than retried as an incomplete directory', async () => {
  const refusal = new Error('The original source denied this conversation')
  let attempts = 0
  const sessions = {
    list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
    refresh: async () => { throw new Error('A full directory cannot repair access refusal') },
    resolveSession: async () => { ++attempts; throw refusal },
  }
  await assert.rejects(waitForCatalogSession(sessions as unknown as Parameters<typeof waitForCatalogSession>[0],
    'hhpi:machine:source:codex:thread' as Parameters<typeof waitForCatalogSession>[1], new AbortController().signal),
    error => error === refusal)
  assert.equal(attempts, 1)
})
