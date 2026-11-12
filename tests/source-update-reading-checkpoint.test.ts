/** Actual source memory/cache and controlled-update tickets; native reader IO is a declared boundary. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { SourceReadingCache } from '../src/client/remote-reading-cache.ts'
import { installRemoteReadingMemory } from '../src/client/remote-reading-memory.ts'
import { armOrdinaryReadingForReload, registerSourceUpdateReadingCheckpoint } from '../src/client/ordinary-reading-checkpoint.ts'
import { WorkspaceApplicationIdentity } from '../src/client/application-identity.ts'
import { createWorkspaceUpdatePreparations } from '../src/client/update-preparation.ts'
import type { SourcePage, SourceSession } from '../src/remote/protocol.ts'
import type { MountedChatControlV1 } from '../src/client/mounted-chat-control.ts'

function storage() {
    const values = new Map<string, string>()
    return { values, get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null,
        getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
        removeItem: (key: string) => { values.delete(key) }, clear: () => values.clear() }
}
function fixture(store = storage(), options: { reload?: boolean; account?: string; host?: string; pane?: string; epoch?: string } = {}) {
    const ctx = new Context(), updates = createWorkspaceUpdatePreparations(), application = new WorkspaceApplicationIdentity()
    application.set({ accountId: options.account ?? 'account', origin: 'https://fixture.invalid' }, 'device')
    let epoch = options.epoch ?? 'original-epoch', live = true, ack = true, position = { anchorKey: 'native-body', anchorTop: -44, scrollTop: 173 }
    const session: SourceSession = { id: 'hhpi:machine:source:codex:native', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'native',
        cwd: '/native', title: 'Source', updatedAt: 50, status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } }
    const page: SourcePage = { session, epoch, version: 1, before: 12, after: 20, hasBefore: true, hasAfter: false, context: [], entries: [
        { type: 'event', event: { type: 'turn/end', seq: 12, time: 30, data: {} } } as SourcePage['entries'][number],
        { type: 'event', event: { type: 'turn/end', seq: 20, time: 40, data: {} } } as SourcePage['entries'][number],
    ] }
    const cache = new SourceReadingCache({ storage: store, scope: application.getSnapshot()!.scope })
    cache.write({ session, epoch, version: 1, head: page, windows: [{ viewId: 'pane', page }] })
    const binding = { sessionId: session.id, viewId: 'pane', session: { get sourceEpoch() { return epoch } } } as unknown as SessionBinding
    let read: (request: unknown, signal: AbortSignal) => Promise<void> = async () => {}
    const requests: unknown[] = [], reveals: unknown[] = []
    const nodes = new Map([['native-body', { key: 'native-body', anchorSeq: 12 }]])
    ctx.reflect.provide('uiConversation', { binding: () => ({ target: () => ({ getSnapshot: () => ({ nodes }) }),
        readingView: { read: async (request: unknown, signal: AbortSignal) => { requests.push(request); await read(request, signal) } } }) } as unknown as Context['uiConversation'])
    const stop = installRemoteReadingMemory(ctx, () => cache, () => live)
    const memory = ctx.chatScrollMemory.forBinding(binding)!
    let reveal: () => Promise<void> = async () => {}
    const control = { read: () => ({ revision: 1, renderRevision: 1, following: false, busy: false }),
        checkpointReading() { if (ack) memory.save(position) }, reveal: async (target: unknown) => { reveals.push(target); await reveal() } } as unknown as MountedChatControlV1
    const owner = registerSourceUpdateReadingCheckpoint(ctx, binding, { updates, application,
        target: { hostId: options.host ?? 'host', sessionId: session.id, paneId: options.pane ?? 'pane' }, storage: store, reload: options.reload ?? false,
        reader: () => control, current: () => live })
    return { ctx, store, updates, application, owner, memory, requests, reveals,
        setRead: (value: typeof read) => { read = value }, setReveal: (value: typeof reveal) => { reveal = value }, setEpoch: (value: string) => { epoch = value },
        setAck: (value: boolean) => { ack = value }, revoke: () => { live = false },
        async close() { owner.dispose(); stop(); cache.dispose(); updates.dispose(); application.dispose(); await ctx.fiber.dispose() } }
}

test('HHPI passive/new-open memory stays latest; only the final armed update restores the exact epoch-scoped body once', async () => {
    const store = storage(), before = fixture(store)
    try {
        before.memory.save({ anchorKey: 'native-body', anchorTop: -44, scrollTop: 173 })
        assert.equal(before.ctx.chatScrollMemory.forBinding({ sessionId: 'hhpi:machine:source:codex:native', viewId: 'pane', session: {} } as unknown as SessionBinding)!.read(), null)
        await before.updates.checkpoint(); armOrdinaryReadingForReload(before.updates)
        const after = fixture(store, { reload: true })
        try {
            assert.equal(await after.owner.restore(new AbortController().signal), true)
            assert.deepEqual(after.requests, [{ kind: 'around', target: { key: 'native-body', seq: 12 } }])
            assert.deepEqual(after.reveals, [{ key: 'native-body', seq: 12 }])
            assert.equal(await after.owner.restore(new AbortController().signal), false)
            const later = fixture(store, { reload: true })
            try { assert.equal(await later.owner.restore(new AbortController().signal), false); assert.deepEqual(later.requests, []) } finally { await later.close() }
        } finally { await after.close() }
    } finally { await before.close() }
})

test('unarmed, ordinary navigation, account, Host and Pane changes never activate HHPI history restoration', async () => {
    for (const variant of ['unarmed', 'ordinary-open', 'account', 'host', 'pane'] as const) {
        const store = storage(), before = fixture(store)
        try {
            await before.updates.checkpoint(); if (variant !== 'unarmed') armOrdinaryReadingForReload(before.updates)
            const after = fixture(store, { reload: variant !== 'ordinary-open', ...(variant === 'account' ? { account: 'other-account' } : {}),
                ...(variant === 'host' ? { host: 'other-host' } : {}), ...(variant === 'pane' ? { pane: 'other-pane' } : {}) })
            try { assert.equal(await after.owner.restore(new AbortController().signal), false, variant); assert.deepEqual(after.requests, []) } finally { await after.close() }
        } finally { await before.close() }
    }
})

test('an epoch replacement before activation or during source IO cannot reveal an obsolete raw sequence', async () => {
    const store = storage(), before = fixture(store)
    try {
        await before.updates.checkpoint(); before.setEpoch('replacement')
        assert.throws(() => armOrdinaryReadingForReload(before.updates), /open readers changed/)
        before.setEpoch('original-epoch'); await before.updates.checkpoint(); armOrdinaryReadingForReload(before.updates)
        const after = fixture(store, { reload: true }), pending = Promise.withResolvers<void>()
        try {
            after.setRead(() => pending.promise)
            const restore = after.owner.restore(new AbortController().signal)
            after.setEpoch('replacement'); pending.resolve()
            await assert.rejects(restore, /source replaced/); assert.deepEqual(after.reveals, [])
        } finally { await after.close() }
    } finally { await before.close() }
})

test('failed restore keeps its exact ticket for explicit retry; revoked account and source drop late effects', async () => {
    for (const variant of ['retry', 'account', 'source', 'cancel'] as const) {
        const store = storage(), before = fixture(store)
        try {
            await before.updates.checkpoint(); armOrdinaryReadingForReload(before.updates)
            const after = fixture(store, { reload: true }), pending = Promise.withResolvers<void>(), abort = new AbortController()
            try {
                after.setRead(() => pending.promise)
                const restore = after.owner.restore(abort.signal)
                if (variant === 'retry') pending.reject(Error('Temporary source read failure'))
                else { if (variant === 'account') after.application.set({ accountId: 'other-account', origin: 'https://fixture.invalid' }, 'device')
                    if (variant === 'source') after.revoke()
                    if (variant === 'cancel') abort.abort(new DOMException('A new navigation won', 'AbortError'))
                    pending.resolve() }
                await assert.rejects(restore); assert.deepEqual(after.reveals, [])
                if (variant === 'retry') { after.setRead(async () => {}); assert.equal(await after.owner.restore(new AbortController().signal), true); assert.equal(after.reveals.length, 1) }
            } finally { await after.close() }
        } finally { await before.close() }
    }
})

test('a source cache entry without an actual mounted reader save cannot arm an update', async () => {
    const f = fixture()
    try { f.setAck(false); await assert.rejects(f.updates.checkpoint(), /actual source reader did not save/); assert.throws(() => armOrdinaryReadingForReload(f.updates), /open readers changed/) }
    finally { await f.close() }
})
