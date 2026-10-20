/** Unmodified pinned official store implementation; only browser Storage is a fake. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createGraphStore, graphStorage } from '../src/client/runtime-store.ts'

test('independent official Client graph stores persist the same keys without touching another graph or the main Web', async () => {
    const built = await build({
        entryPoints: ['@deepseek-ai/dsh-client-store'], bundle: true, format: 'iife', globalName: '__HAPI_DSH_OFFICIAL_STORE__',
        platform: 'browser', target: 'es2022', write: false, legalComments: 'inline',
        define: { 'process.env.NODE_ENV': '"production"' },
    })
    const source = built.outputFiles[0]!.text
    const data = new Map<string, string>([['dsh.sessions.current', '{"sessionId":"primary"}']])
    const storage: Storage = {
        getItem: key => data.get(key) ?? null,
        setItem: (key, value) => { data.set(key, value) },
        removeItem: key => { data.delete(key) },
        clear: () => { data.clear() }, key: index => [...data.keys()][index] ?? null,
        get length() { return data.size },
    }
    const storageA = graphStorage(storage, 'runner', 'pane-a')
    const storageB = graphStorage(storage, 'runner', 'pane-b')
    const graphA = createGraphStore(storageA, source)
    const graphB = createGraphStore(storageB, source)
    assert.notEqual(graphA.createSnapshotStore, graphB.createSnapshotStore)
    const selectionA = graphA.createSnapshotStore<{ sessionId?: string }>({}, { persist: { name: 'dsh.sessions.current' } })
    const selectionB = graphB.createSnapshotStore<{ sessionId?: string }>({}, { persist: { name: 'dsh.sessions.current' } })
    assert.deepEqual(selectionA.getSnapshot(), {})
    assert.deepEqual(selectionB.getSnapshot(), {})
    selectionA.set({ sessionId: 'source-a' })
    selectionB.set({ sessionId: 'source-b' })
    assert.equal(storage.getItem('dsh.sessions.current'), '{"sessionId":"primary"}')
    assert.equal(storageA.getItem('dsh.sessions.current'), '{"sessionId":"source-a"}')
    assert.equal(storageB.getItem('dsh.sessions.current'), '{"sessionId":"source-b"}')
    const restoredA = createGraphStore(graphStorage(storage, 'runner', 'pane-a'), source)
        .createSnapshotStore({}, { persist: { name: 'dsh.sessions.current' } })
    assert.deepEqual(restoredA.getSnapshot(), { sessionId: 'source-a' })
    storageA.clear()
    assert.equal(storageA.getItem('dsh.sessions.current'), null)
    assert.equal(storageB.getItem('dsh.sessions.current'), '{"sessionId":"source-b"}')
    assert.equal(storage.getItem('dsh.sessions.current'), '{"sessionId":"primary"}')
})
