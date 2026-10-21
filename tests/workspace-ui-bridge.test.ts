/** Explicit audio callbacks/storage fakes; these test ownership, not speech providers. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceUiBridge, createWorkspaceVoiceCoordinator } from '../src/client/workspace-ui.ts'

test('shared microphone claims remain scoped even when two graphs use the same caller id', async () => {
    const coordinator = createWorkspaceVoiceCoordinator(), alpha = coordinator.createScope(), beta = coordinator.createScope()
    let stopped = 0
    assert.equal(alpha.voice.claim('voice', () => { stopped++ }), true)
    assert.equal(alpha.voice.claim('voice', () => { stopped++ }), true)
    assert.equal(beta.voice.claim('voice', () => { stopped++ }), false)
    assert.equal(alpha.voice.owns('voice'), true); assert.equal(beta.voice.owns('voice'), false)
    beta.voice.release('voice')
    await beta.dispose()
    assert.equal(stopped, 0); assert.equal(alpha.voice.getSnapshot(), 'voice')
    await alpha.dispose()
    assert.equal(stopped, 1); assert.equal(alpha.voice.getSnapshot(), null)
    assert.equal(alpha.voice.claim('voice', () => {}), false)
    await coordinator.dispose()
})

test('explicit stop coalesces while actual audio cleanup is pending and cannot release a newer owner', async () => {
    const coordinator = createWorkspaceVoiceCoordinator(), alpha = coordinator.createScope(), beta = coordinator.createScope()
    let finish!: () => void, stops = 0
    alpha.voice.claim('alpha', () => { stops++; return new Promise<void>(resolve => { finish = resolve }) })
    const pending = beta.voice.stop(), duplicate = alpha.voice.stop()
    assert.equal(pending, duplicate)
    await Promise.resolve()
    assert.equal(stops, 1)
    alpha.voice.release('alpha')
    assert.equal(beta.voice.claim('beta', () => {}), false)
    finish(); await pending
    assert.equal(beta.voice.claim('beta', () => {}), true)
    alpha.voice.release('alpha'); await alpha.dispose()
    assert.equal(beta.voice.owns('beta'), true)
    await coordinator.dispose()
    assert.equal(beta.voice.getSnapshot(), null)
})

test('failed cleanup retains truthful ownership, can be explicitly retried, and disposes subscriptions', async () => {
    const coordinator = createWorkspaceVoiceCoordinator(), alpha = coordinator.createScope(), beta = coordinator.createScope()
    let calls = 0, changes = 0
    beta.voice.subscribe(() => { changes++ })
    alpha.voice.claim('alpha', () => { if (++calls === 1) throw new Error('Audio cleanup failed') })
    assert.equal(changes, 1)
    await assert.rejects(beta.voice.stop(), /Audio cleanup failed/)
    assert.equal(alpha.voice.owns('alpha'), true)
    assert.equal(beta.voice.claim('beta', () => {}), false)
    await beta.dispose()
    await alpha.voice.stop()
    assert.equal(calls, 2); assert.equal(changes, 1)
    await coordinator.dispose()
})

test('original note migration can only read the exact source key and shares declared voice preferences', async () => {
    const data = new Map<string, string>([['hapi.scratchlist.v1.source-session', '{"notes":["original"]}'], ['dsh-private', 'private']])
    const read: string[] = []
    const bridge = createWorkspaceUiBridge({ getItem(key) { read.push(key); return data.get(key) ?? null },
        setItem(key, value) { data.set(key, value) }, removeItem(key) { data.delete(key) } })
    const alpha = bridge.createScope(), beta = bridge.createScope()
    assert.equal(alpha.readLegacyScratchlist('source-session'), '{"notes":["original"]}')
    assert.equal(alpha.readLegacyScratchlist('dsh-private'), null)
    assert.deepEqual(read, ['hapi.scratchlist.v1.source-session', 'hapi.scratchlist.v1.dsh-private'])
    assert.throws(() => alpha.readLegacyScratchlist(''), /Invalid original/)
    assert.throws(() => alpha.readLegacyScratchlist('bad\nidentity'), /Invalid original/)
    alpha.preferences.setItem('hapi-voice-backend', 'gemini')
    assert.equal(beta.preferences.getItem('hapi-voice-backend'), 'gemini')
    assert.throws(() => alpha.preferences.getItem('provider-secret' as never), /not a shared/)
    assert.equal(data.get('hapi.scratchlist.v1.source-session'), '{"notes":["original"]}')
    await bridge.dispose()
})

test('unavailable original note storage is reported, never mistaken for absent user data', async () => {
    const unavailable = createWorkspaceUiBridge()
    assert.throws(() => unavailable.root.readLegacyScratchlist('source'), /unavailable/)
    const rejected = createWorkspaceUiBridge({ getItem() { throw new Error('Storage blocked') }, setItem() {}, removeItem() {} })
    assert.throws(() => rejected.root.readLegacyScratchlist('source'), /Storage blocked/)
    await unavailable.dispose(); await rejected.dispose()
})

test('share hand-off has one coordinator per root and a window-scoped persisted owner', async () => {
    const localWrites: string[] = [], windowValues = new Map<string, string>()
    const local = { getItem: () => null, setItem(key: string) { localWrites.push(key) }, removeItem() {} }
    const windowStorage = { getItem: (key: string) => windowValues.get(key) ?? null,
        setItem(key: string, value: string) { windowValues.set(key, value) } }
    const first = createWorkspaceUiBridge(local, undefined, windowStorage)
    const pane = first.createScope()
    assert.equal(first.root.shareInbox, pane.shareInbox)
    const owner = first.root.shareInbox.owner
    assert.equal(windowValues.get('hapi-dsh:share-window:v1'), owner)
    assert.deepEqual(localWrites, [])
    await pane.dispose(); await first.dispose()
    const reload = createWorkspaceUiBridge(local, undefined, windowStorage), separate = createWorkspaceUiBridge(local)
    assert.equal(reload.root.shareInbox.owner, owner)
    assert.notEqual(separate.root.shareInbox.owner, owner)
    await reload.dispose(); await separate.dispose()
})
