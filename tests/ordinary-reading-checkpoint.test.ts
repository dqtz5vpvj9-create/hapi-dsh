/** Actual Cordis public memory provider/update coordinator; renderer/history IO are named boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatScrollPosition } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MountedChatControlV1 } from '../src/client/mounted-chat-control.ts'
import { WorkspaceApplicationIdentity } from '../src/client/application-identity.ts'
import { createWorkspaceUpdatePreparations } from '../src/client/update-preparation.ts'
import { armOrdinaryReadingForReload, installOrdinaryReadingMemory, registerOrdinaryReadingCheckpoint } from '../src/client/ordinary-reading-checkpoint.ts'
import { registerReadingMemoryProvider } from '../src/client/reading-memory-provider.ts'

function storage() {
    const values = new Map<string, string>(); let fail = false
    return { values, fail(value: boolean) { fail = value },
        getItem: (key: string) => values.get(key) ?? null,
        setItem(key: string, value: string) { if (fail) throw new Error('Reading storage quota'); values.set(key, value) },
        removeItem: (key: string) => { values.delete(key) } }
}
function fixture(store = storage(), reload = false, accountId = 'original-account') {
    const ctx = new Context(), updates = createWorkspaceUpdatePreparations(), application = new WorkspaceApplicationIdentity()
    application.set({ accountId, origin: 'https://fixture.invalid' }, 'fixture-device')
    const binding = { sessionId: 'ordinary-session', session: {} } as unknown as SessionBinding
    const requests: unknown[] = [], reveals: unknown[] = [], nodes = new Map([
        ['first-node', { key: 'first-node', anchorSeq: 12 }], ['second-node', { key: 'second-node', anchorSeq: 30 }],
    ])
    ctx.reflect.provide('uiConversation', { binding: () => ({ target: () => ({ getSnapshot: () => ({ nodes }) }),
        readingView: { read: async (request: unknown) => { requests.push(request) } } }) } as unknown as Context['uiConversation'])
    const delegated = { read: () => null, save: () => {} }
    registerReadingMemoryProvider(ctx, 'hhpi', () => delegated)
    const stop = installOrdinaryReadingMemory(ctx), readers: Array<{ dispose(): void }> = []
    function pane(id: string, position: ChatScrollPosition | null, hostId = 'host-a') {
        let live = true, ack = true, revision = 1
        const make = () => ({ version: 1, read: () => ({ revision, following: position === null, busy: false, hasOlder: true, anchor: null }),
            checkpointReading() { if (ack) ctx.chatScrollMemory.forBinding(binding)!.save(position) },
            reveal: async (target: unknown) => { reveals.push({ id, target }) },
        }) as unknown as MountedChatControlV1
        let control = make()
        const owner = registerOrdinaryReadingCheckpoint(ctx, binding, { updates, application,
            target: { hostId, sessionId: binding.sessionId, paneId: id }, storage: store, reload,
            reader: () => control, current: () => live })
        const result = { ...owner, position, setAck(value: boolean) { ack = value }, replace() { control = make() },
            move() { revision++ }, revoke() { live = false }, control: () => control }
        readers.push(result); return result
    }
    return { ctx, updates, application, binding, pane, store, requests, reveals, delegated, stopMemory: stop,
        async close() { for (const reader of readers) reader.dispose(); stop(); updates.dispose(); application.dispose(); await ctx.fiber.dispose() } }
}
const first = { anchorKey: 'first-node', anchorTop: -25, scrollTop: 500 }
const second = { anchorKey: 'second-node', anchorTop: 5, scrollTop: 700 }

test('two actual Pane captures sharing one binding stage distinct semantic positions, then only the controlled reload restores them', async () => {
    const store = storage(), before = fixture(store)
    try {
        before.pane('pane-a', first); before.pane('pane-b', second)
        await before.updates.checkpoint()
        assert.equal([...store.values.keys()].some(key => key.includes('armed')), false, 'ordinary checkpoint must not activate reload restoration')
        armOrdinaryReadingForReload(before.updates)
        const reloaded = fixture(store, true)
        try {
            const a = reloaded.pane('pane-a', null), b = reloaded.pane('pane-b', null)
            assert.equal(await a.restore(new AbortController().signal), true)
            assert.equal(await b.restore(new AbortController().signal), true)
            assert.deepEqual(reloaded.requests, [{ kind: 'around', target: { key: 'first-node', seq: 12 } }, { kind: 'around', target: { key: 'second-node', seq: 30 } }])
            assert.deepEqual(reloaded.reveals, [{ id: 'pane-a', target: { key: 'first-node', seq: 12 } }, { id: 'pane-b', target: { key: 'second-node', seq: 30 } }])
            a.dispose()
            assert.equal(await reloaded.pane('pane-a', null).restore(new AbortController().signal), false, 'normal reopening does not reuse the update ticket')
            const laterReload = fixture(store, true)
            try { assert.equal(await laterReload.pane('pane-b', null).restore(new AbortController().signal), false) } finally { await laterReload.close() }
        } finally { await reloaded.close() }
    } finally { await before.close() }
})

test('an unarmed or nonreload document, another account, Host or Pane cannot consume the original position', async () => {
    for (const variant of ['unarmed', 'new-open', 'account', 'host', 'pane'] as const) {
        const store = storage(), before = fixture(store)
        try {
            before.pane('original-pane', first); await before.updates.checkpoint()
            if (variant !== 'unarmed') armOrdinaryReadingForReload(before.updates)
            const after = fixture(store, variant !== 'new-open', variant === 'account' ? 'foreign-account' : 'original-account')
            try {
                const owner = after.pane(variant === 'pane' ? 'foreign-pane' : 'original-pane', null, variant === 'host' ? 'foreign-host' : 'host-a')
                assert.equal(await owner.restore(new AbortController().signal), false, variant)
                assert.deepEqual(after.requests, []); assert.deepEqual(after.reveals, [])
            } finally { await after.close() }
        } finally { await before.close() }
    }
})

test('only a real acknowledged save can prepare; storage failure, reader replacement and changed account prevent activation', async () => {
    const f = fixture()
    try {
        const pane = f.pane('original-pane', first)
        pane.setAck(false); await assert.rejects(f.updates.checkpoint(), /actual ordinary reader did not save/)
        pane.setAck(true); f.store.fail(true); await assert.rejects(f.updates.checkpoint(), /Reading storage quota/)
        assert.throws(() => armOrdinaryReadingForReload(f.updates), /open readers changed/)
        f.store.fail(false); await f.updates.checkpoint(); pane.replace()
        assert.throws(() => armOrdinaryReadingForReload(f.updates), /open readers changed/)
        await f.updates.checkpoint(); f.application.set({ accountId: 'another-account', origin: 'https://fixture.invalid' }, 'fixture-device')
        assert.throws(() => armOrdinaryReadingForReload(f.updates), /open readers changed/)
        await assert.rejects(f.updates.checkpoint(), /source or account changed/)
    } finally { await f.close() }
})

test('a reader move during another pending participant blocks update and can be explicitly retried', async () => {
    const f = fixture(), delayed = Promise.withResolvers<void>()
    try {
        const pane = f.pane('original-pane', first)
        f.updates.register('Actual other draft IO', () => delayed.promise)
        const pending = f.updates.checkpoint(); await new Promise(resolve => setImmediate(resolve)); pane.move(); delayed.resolve()
        await assert.rejects(pending, /reading position changed while saving/)
        assert.throws(() => armOrdinaryReadingForReload(f.updates), /open readers changed/)
        await f.updates.checkpoint(); const cancel = armOrdinaryReadingForReload(f.updates)
        cancel(); const reload = fixture(f.store, true)
        try { assert.equal(await reload.pane('original-pane', null).restore(new AbortController().signal), false) } finally { await reload.close() }
    } finally { await f.close() }
})

test('tail restoration performs no historical jump and the composed memory delegates HHPI to its original provider', async () => {
    const f = fixture()
    try {
        const hhpi = { sessionId: 'hhpi:machine:source:codex:thread' } as unknown as SessionBinding
        assert.equal(f.ctx.chatScrollMemory.forBinding(hhpi), f.delegated)
        const mountedMemory = f.ctx.chatScrollMemory.forBinding(f.binding)!
        mountedMemory.save(first)
        assert.equal(f.store.values.size, 0, 'passive saves cannot create an arbitrary-reload bookmark')
        assert.deepEqual(mountedMemory.read(), first, 'the current official reader keeps its actual anchor facts')
        assert.equal(f.ctx.chatScrollMemory.forBinding(f.binding)!.read(), null)
        f.pane('tail-pane', null); await f.updates.checkpoint(); armOrdinaryReadingForReload(f.updates)
        const after = fixture(f.store, true)
        try {
            assert.equal(await after.pane('tail-pane', null).restore(new AbortController().signal), true)
            assert.deepEqual(after.requests, []); assert.deepEqual(after.reveals, [])
        } finally { await after.close() }
    } finally { await f.close() }
})

test('disposal of the original memory owner during worker activation invalidates staged reading tickets', async () => {
    const f = fixture()
    try {
        f.pane('original-pane', first); await f.updates.checkpoint(); f.stopMemory()
        assert.throws(() => armOrdinaryReadingForReload(f.updates), /open readers changed/)
        await assert.rejects(f.updates.checkpoint(), /source or account changed/)
    } finally { await f.close() }
})
