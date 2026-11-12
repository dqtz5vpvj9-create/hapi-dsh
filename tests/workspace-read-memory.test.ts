/** Actual Cordis provider and reading cache; public binding/snapshot boundaries are controlled. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { SourceReadingCache } from '../src/client/remote-reading-cache.ts'
import { installRemoteReadingMemory, registerSourceReadingCheckpoint, type SourceReadCommit } from '../src/client/remote-reading-memory.ts'
import { createWorkspaceUpdatePreparations } from '../src/client/update-preparation.ts'
import type { MountedChatControlV1 } from '../src/client/mounted-chat-control.ts'
import type { SourcePage, SourceSession } from '../src/remote/protocol.ts'
import { installOrdinaryReadingMemory, registerOrdinaryReadingCheckpoint } from '../src/client/ordinary-reading-checkpoint.ts'
import { WorkspaceApplicationIdentity } from '../src/client/application-identity.ts'

function fixture(options?: { ordinaryFirst: boolean }) {
    const values = new Map<string, string>()
    const storage: Storage = { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
        getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) }, clear: () => values.clear() }
    const cache = new SourceReadingCache({ storage, scope: 'authenticated-account' }), ctx = new Context(), commits: SourceReadCommit[] = []
    const session: SourceSession = { id: 'hhpi:machine:source:codex:native', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'native',
        cwd: '/source', title: 'Source', updatedAt: 50, status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } }
    const page: SourcePage = { session, epoch: 'original-epoch', version: 1, before: 40, after: 41, hasBefore: true, hasAfter: false, context: [], entries: [
        { type: 'event', event: { type: 'turn/end', seq: 40, time: 30, data: {} } } as SourcePage['entries'][number],
        { type: 'event', event: { type: 'turn/end', seq: 41, time: 40, data: {} } } as SourcePage['entries'][number],
    ] }
    cache.write({ session, epoch: page.epoch, version: 1, head: page, windows: [{ viewId: 'visible', page }] })
    const binding = { sessionId: session.id, viewId: 'visible', session: {} } as unknown as SessionBinding
    const nodes = new Map([['original-node', { anchorSeq: 40 }]])
    ctx.reflect.provide('uiConversation', { binding: () => ({ target: () => ({ getSnapshot: () => ({ nodes }) }) }) } as unknown as Context['uiConversation'])
    let owns = true, current: SourceReadingCache | undefined = cache
    let samples = 0
    const before = options?.ordinaryFirst ? installOrdinaryReadingMemory(ctx) : undefined
    const stop = installRemoteReadingMemory(ctx, () => current, () => owns, (_binding, value) => { commits.push(value) }, () => { samples++ })
    const after = options && !options.ordinaryFirst ? installOrdinaryReadingMemory(ctx) : undefined
    const memory = ctx.get('chatScrollMemory')!.forBinding!(binding)!
    return { ctx, cache, commits, memory, page, session, binding, storage, samples: () => samples, current: () => current === cache && owns,
        revoked() { owns = false }, replaceOwner() { current = undefined },
        async close() { after?.(); stop(); before?.(); cache.dispose(); await ctx.fiber.dispose() } }
}

for (const ordinaryFirst of [true, false]) test(`actual HHPI and ordinary providers compose when ${ordinaryFirst ? 'ordinary' : 'HHPI'} installs first`, async () => {
    const f = fixture({ ordinaryFirst }), updates = createWorkspaceUpdatePreparations(), application = new WorkspaceApplicationIdentity()
    application.set({ accountId: 'account', origin: 'https://fixture.invalid' }, 'device')
    const binding = { sessionId: 'ordinary-source' } as unknown as SessionBinding
    const control = { read: () => ({ revision: 1, following: true, busy: false, hasOlder: false, anchor: null }),
        checkpointReading: () => f.ctx.chatScrollMemory.forBinding(binding)!.save(null) } as unknown as MountedChatControlV1
    const stop = registerOrdinaryReadingCheckpoint(f.ctx, binding, { updates, application,
        target: { hostId: 'host', sessionId: binding.sessionId, paneId: 'pane' }, storage: f.storage, reload: false,
        reader: () => control, current: () => true })
    try {
        await updates.checkpoint()
        f.memory.save({ anchorKey: 'original-node', anchorTop: 0, scrollTop: 5 })
        assert.equal(f.samples(), 1); assert.equal(f.commits[0]?.position.seq, 40)
        f.replaceOwner(); assert.equal(f.ctx.chatScrollMemory.forBinding(f.binding), undefined)
        await updates.checkpoint()
    } finally { stop.dispose(); application.dispose(); updates.dispose(); await f.close() }
})

test('loading one real Cordis plugin registers memory once and another consumer context captures its original service', async () => {
    const ctx = new Context(), updates = createWorkspaceUpdatePreparations(), application = new WorkspaceApplicationIdentity()
    application.set({ accountId: 'account', origin: 'https://fixture.invalid' }, 'device')
    const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    const stops: Array<() => void> = []
    await ctx.plugin({ name: 'actual-loading-memory-owner', apply(owner: Context) {
        stops.push(installRemoteReadingMemory(owner, () => undefined, () => false))
        stops.push(installOrdinaryReadingMemory(owner))
    } })
    const binding = { sessionId: 'ordinary-source' } as unknown as SessionBinding
    const control = { read: () => ({ revision: 1, following: true, busy: false, hasOlder: false, anchor: null }),
        checkpointReading: () => ctx.chatScrollMemory.forBinding(binding)!.save(null) } as unknown as MountedChatControlV1
    const checkpoint = registerOrdinaryReadingCheckpoint(ctx, binding, { updates, application,
        target: { hostId: 'host', sessionId: binding.sessionId, paneId: 'pane' }, storage, reload: false,
        reader: () => control, current: () => true })
    try { await updates.checkpoint(); assert.equal(values.size, 1) }
    finally { checkpoint.dispose(); for (const stop of stops.reverse()) stop(); application.dispose(); updates.dispose(); await ctx.fiber.dispose() }
})

test('only a saved original node or actual window tail yields a reader commit, with original epoch and source time', async () => {
    const view = fixture()
    try {
        assert.deepEqual(view.commits, [], 'provider installation and cached body alone do not mark content read')
        view.memory.save({ anchorKey: 'original-node', anchorTop: 0, scrollTop: 12 })
        view.memory.save(null)
        assert.deepEqual(view.commits, [
            { position: { kind: 'hhpi', epoch: 'original-epoch', seq: 40 }, at: 30 },
            { position: { kind: 'hhpi', epoch: 'original-epoch', seq: 41 }, at: 50 },
        ])
    } finally { await view.close() }
})

test('the update provider samples its original memory before freezing the cache revision and refuses a missing save acknowledgement', async () => {
    const view = fixture(), updates = createWorkspaceUpdatePreparations()
    let actualSave = true, control: MountedChatControlV1 | undefined
    const original = { read: () => ({ revision: 1, following: false, busy: false, hasOlder: true, anchor: { key: 'original-node', top: 0 } }),
        checkpointReading() { if (actualSave) view.memory.save({ anchorKey: 'original-node', anchorTop: 0, scrollTop: 15 }) },
    } as unknown as MountedChatControlV1
    control = original
    const stop = registerSourceReadingCheckpoint(updates, view.binding, () => control, { cache: view.cache, current: view.current, samples: view.samples })
    try {
        await updates.checkpoint(); assert.equal(view.samples(), 1)
        assert.deepEqual(view.cache.readPosition(view.session.id, 'visible'), { anchorKey: 'original-node', anchorTop: 0, scrollTop: 15 })
        actualSave = false; await assert.rejects(updates.checkpoint(), /actual reader did not save/)
        actualSave = true; await updates.checkpoint()
        control = undefined; await assert.rejects(updates.checkpoint(), /source or account changed/)
        control = original; view.revoked(); await assert.rejects(updates.checkpoint(), /source or account changed/)
    } finally { stop(); updates.dispose(); await view.close() }
})

test('a replacement mounted reader during another pending checkpoint cannot pass final verification', async () => {
    const view = fixture(), updates = createWorkspaceUpdatePreparations(), delayed = Promise.withResolvers<void>()
    const make = () => ({ read: () => ({ revision: 1, following: true, busy: false, hasOlder: true, anchor: null }),
        checkpointReading: () => view.memory.save(null) }) as unknown as MountedChatControlV1
    let control = make()
    const stop = registerSourceReadingCheckpoint(updates, view.binding, () => control, { cache: view.cache, current: view.current, samples: view.samples })
    updates.registerCheckpoint({ kind: 'attachment', label: 'Other draft', current: () => true, revision: () => 1, save: () => delayed.promise })
    try {
        const pending = updates.checkpoint(); await new Promise(resolve => setImmediate(resolve)); control = make(); delayed.resolve()
        await assert.rejects(pending, /reading position changed while saving/)
        await updates.checkpoint()
    } finally { stop(); updates.dispose(); await view.close() }
})

test('unknown anchors and replaced or revoked owners cannot emit read evidence', async () => {
    const view = fixture()
    try {
        view.memory.save({ anchorKey: 'missing-node', anchorTop: 0, scrollTop: 0 })
        view.revoked(); view.memory.save(null)
        view.replaceOwner(); view.memory.save(null)
        assert.deepEqual(view.commits, [])
    } finally { await view.close() }
})

test('the tail of an older visible window uses its original event time rather than current session metadata', async () => {
    const view = fixture()
    try {
        view.page.hasAfter = true
        view.memory.save(null)
        assert.deepEqual(view.commits, [{ position: { kind: 'hhpi', epoch: 'original-epoch', seq: 41 }, at: 40 }])
    } finally { await view.close() }
})
