import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPaneBootGate, shouldBootPane } from '../src/client/surface/lazy-pane.ts'
import { prefetchPaneArtifacts } from '../src/client/surface/prefetch.ts'

test('visible panes boot eagerly; plugin-page renderers without a visible flag boot too', () => {
    assert.equal(shouldBootPane({ visible: true }, false), true)
    assert.equal(shouldBootPane({ visible: undefined }, false), true)
    assert.equal(shouldBootPane({}, false), true)
})

test('parked-window panes stay deferred until shown', () => {
    assert.equal(shouldBootPane({ visible: false }, false), false)
})

test('a booted pane is never unloaded by a later hidden presentation', () => {
    assert.equal(shouldBootPane({ visible: false }, true), true)
    assert.equal(shouldBootPane({ visible: true }, true), true)
})

test('boot gate: success latches, failure reopens for a visibility retry', () => {
    const gate = createPaneBootGate()
    assert.equal(gate.phase(), 'deferred')
    assert.equal(gate.begin(), true)
    assert.equal(gate.phase(), 'booting')
    // Duplicate activation (e.g. focus + visibility in the same tick) is ignored.
    assert.equal(gate.begin(), false)
    gate.fail()
    assert.equal(gate.phase(), 'deferred')
    // A failed boot is retryable through the same gate (window flip or Retry).
    assert.equal(gate.begin(), true)
    gate.succeed()
    assert.equal(gate.phase(), 'booted')
    // A booted pane is never unloaded or started again by a later hidden flip.
    assert.equal(gate.begin(), false)
    gate.fail()
    assert.equal(gate.phase(), 'booted')
})

interface FakeLoad {
    readonly calls: string[]
    maxInflight: number
    inflight: number
}

function fakeLoads(delayMs = 2): FakeLoad & { load(url: string): Promise<string> } {
    const state: FakeLoad = { calls: [], maxInflight: 0, inflight: 0 }
    return Object.assign(state, {
        async load(url: string): Promise<string> {
            state.calls.push(url)
            state.inflight++
            state.maxInflight = Math.max(state.maxInflight, state.inflight)
            await new Promise(resolve => setTimeout(resolve, delayMs))
            state.inflight--
            return `source:${url}`
        },
    })
}

const BASE = 'http://host.invalid/'

test('prefetch fetches each retained row bundle once, resolving against the Host base', async () => {
    const artifacts = new Map<string, Promise<string>>()
    const load = fakeLoads()
    await prefetchPaneArtifacts({
        entries: [{ url: 'plugins/??a/client.js&rev=1' }, { url: '/plugins/??b/client.js&rev=2' }, { url: 'plugins/??a/client.js&rev=1' }],
        baseUrl: BASE, artifacts, load: load.load, concurrency: 2,
    })
    assert.deepEqual(load.calls.sort(), ['http://host.invalid/plugins/??a/client.js&rev=1', 'http://host.invalid/plugins/??b/client.js&rev=2'])
    assert.equal(artifacts.size, 2)
    assert.equal(await artifacts.get('http://host.invalid/plugins/??a/client.js&rev=1'), 'source:http://host.invalid/plugins/??a/client.js&rev=1')
})

test('prefetch keeps its concurrency bound while warming a large row set', async () => {
    const artifacts = new Map<string, Promise<string>>()
    const load = fakeLoads(4)
    const entries = Array.from({ length: 30 }, (_value, index) => ({ url: `plugins/??row-${index}/client.js&rev=${index}` }))
    await prefetchPaneArtifacts({ entries, baseUrl: BASE, artifacts, load: load.load, concurrency: 6 })
    assert.equal(load.calls.length, 30)
    assert.ok(load.maxInflight <= 6, `expected <= 6 concurrent fetches, saw ${load.maxInflight}`)
    assert.ok(load.maxInflight > 1, 'expected parallel fetches, saw fully serialized loads')
    assert.equal(artifacts.size, 30)
})

test('prefetch never overrides a bundle another pane already loaded', async () => {
    const existing = Promise.resolve('already-cached')
    const artifacts = new Map<string, Promise<string>>([['http://host.invalid/plugins/??a/client.js&rev=1', existing]])
    const load = fakeLoads()
    await prefetchPaneArtifacts({ entries: [{ url: 'plugins/??a/client.js&rev=1' }], baseUrl: BASE, artifacts, load: load.load })
    assert.equal(load.calls.length, 0)
    assert.equal(await artifacts.get('http://host.invalid/plugins/??a/client.js&rev=1'), 'already-cached')
})

test('prefetch drops failed bundles from the cache and keeps warming the rest', async () => {
    const artifacts = new Map<string, Promise<string>>()
    const calls: string[] = []
    await prefetchPaneArtifacts({
        entries: [{ url: 'plugins/??bad/client.js&rev=1' }, { url: 'plugins/??good/client.js&rev=2' }],
        baseUrl: BASE, artifacts, concurrency: 2,
        load: async url => {
            calls.push(url)
            if (url.includes('bad')) throw new Error('HTTP 500')
            return 'ok'
        },
    })
    assert.deepEqual(calls.sort(), ['http://host.invalid/plugins/??bad/client.js&rev=1', 'http://host.invalid/plugins/??good/client.js&rev=2'])
    assert.equal(artifacts.has('http://host.invalid/plugins/??bad/client.js&rev=1'), false, 'a failed prefetch must not poison the loader cache')
    assert.equal(await artifacts.get('http://host.invalid/plugins/??good/client.js&rev=2'), 'ok')
})
