import assert from 'node:assert/strict'
import test from 'node:test'
import { sameSourceGeneration, canReuseGenerationSurface, replacementReady, stageGenerationSurface, revealGenerationSurface } from '../src/client/surface/generation-handoff.ts'
import type { PaneResource } from '../src/client/model.ts'

type Resource = Exclude<PaneResource, { kind: 'empty' }>
const id = `hapi-codex-${'a'.repeat(32)}`
const resource = (sessionId: string, patch: Partial<Resource> = {}): Resource => ({
    kind: 'chat', sessionId, sourceHubId: 'hub', sourceSessionId: 'original', ...patch,
} as Resource)

test('generation handoff requires the exact source, Host and conversation view', () => {
    assert.ok(sameSourceGeneration(resource(id), resource(`${id}-r1`)))
    assert.ok(sameSourceGeneration(resource(`hapi-remote:host:${id}-r2`), resource(`hapi-remote:host:${id}-r3`)))
    for (const next of [resource(id), resource(`${id}-r1`, { sourceHubId: 'foreign' }),
        resource(`${id}-r1`, { sourceSessionId: 'another' }), resource(`hapi-remote:other:${id}-r1`),
        resource('ordinary-r1'), { kind: 'view', viewId: 'files', sessionId: `${id}-r1`, sourceHubId: 'hub', sourceSessionId: 'original', target: { type: 'tab', kind: 'files' } } as Resource]) {
        assert.equal(sameSourceGeneration(resource(id), next), false)
    }
    assert.equal(sameSourceGeneration({ kind: 'chat', sessionId: id, sourceSessionId: 'original' }, resource(`${id}-r1`)), false)
    assert.equal(sameSourceGeneration(resource('ordinary'), resource('ordinary-r1')), false)
})

test('a reference cannot replace the old surface before body, editor and reading recovery', () => {
    const ready = { referenceReady: true, open: true, blank: false, content: true, editor: true, reading: 'ready' }
    assert.ok(replacementReady(ready))
    for (const key of ['referenceReady', 'open', 'content', 'editor'] as const) {
        assert.equal(replacementReady({ ...ready, [key]: false }), false, key)
    }
    assert.equal(replacementReady({ ...ready, reading: 'loading' }), false)
    assert.equal(replacementReady({ ...ready, reading: 'error' }), false)
    assert.ok(replacementReady({ ...ready, reading: 'reader' }))
    assert.ok(replacementReady({ ...ready, content: false, blank: true }), 'a genuinely empty source still opens')
})

test('cancelled staging releases observers and can be parked and reused without invisible or inert state', t => {
    let mutation: (() => void) | undefined, disconnected = 0, sequence = 0, commits = 0
    const frames = new Map<number, () => void>(), timers = new Map<number, () => void>()
    const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
    Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: class {
        constructor(callback: () => void) { mutation = callback }
        observe() {}
        disconnect() { disconnected++ }
    } })
    t.after(() => {
        if (previousObserver) Object.defineProperty(globalThis, 'MutationObserver', previousObserver)
        else Reflect.deleteProperty(globalThis, 'MutationObserver')
    })
    const window = {
        requestAnimationFrame(callback: () => void) { const id = ++sequence; frames.set(id, callback); return id },
        cancelAnimationFrame(id: number) { frames.delete(id) },
        setTimeout(callback: () => void) { const id = ++sequence; timers.set(id, callback); return id },
        clearTimeout(id: number) { timers.delete(id) },
    }
    const surface = (): HTMLElement => ({ inert: false, dataset: {}, ownerDocument: { defaultView: window },
        style: { removeProperty(name: string) { Reflect.deleteProperty(this, name === 'pointer-events' ? 'pointerEvents' : name) } },
    }) as unknown as HTMLElement
    const previous = surface(), next = surface()
    let ready = false
    const stage = () => stageGenerationSurface({ previous, next, ready: () => ready,
        commit: () => { commits++; previous.hidden = true; revealGenerationSurface(next) }, timeout: () => { throw new Error('Unexpected timeout') } })
    const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback() } }
    const stop = stage()
    assert.equal(previous.inert, true)
    assert.equal(next.style.opacity, '0')
    flush(); assert.equal(commits, 0)
    mutation?.(); stop(); revealGenerationSurface(next)
    assert.equal(frames.size, 0); assert.equal(timers.size, 0); assert.equal(disconnected, 1)
    assert.equal(next.inert, false)
    assert.equal(next.dataset.hapiHandoff, undefined)
    for (const name of ['position', 'inset', 'opacity', 'pointerEvents']) assert.equal(Reflect.get(next.style, name), undefined)
    ready = true; mutation?.(); flush(); assert.equal(commits, 0, 'a cancelled observer cannot commit later')
    stage(); flush()
    assert.equal(commits, 1)
    assert.equal(previous.hidden, true)
    assert.equal(next.inert, false)
    assert.equal(frames.size, 0); assert.equal(timers.size, 0)
})


test('a catalog-gap layout rollback recreates the suspended old occurrence instead of reusing its stopped reader', () => {
    assert.equal(canReuseGenerationSurface(id, id, false), true, 'ordinary same-session renders preserve the live editor')
    assert.equal(canReuseGenerationSurface(id, `${id}-r1`, true), true, 'waiting for the successor may keep the inert predecessor')
    assert.equal(canReuseGenerationSurface(id, id, true), false, 'rolling back requires a fresh reader and usable editor')
    assert.equal(canReuseGenerationSurface(id, id, false), true, 'the recreated occurrence can subsequently be reused')
})
