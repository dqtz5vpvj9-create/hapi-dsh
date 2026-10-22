/** The published SlotRegistry contains the real SlotCore and Cordis effect
 * receiver. No browser DOM or terminal transport is simulated by this test. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { followLegacyTerminalSeat } from '../src/client/legacy-terminal-slots.ts'

const require = createRequire(import.meta.url)
let published: { factory(resolve: (id: string) => unknown): typeof import('@deepseek-ai/dsh-client-ui-renderer/client') } | undefined
new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8'))({ __ModuleLoader__: { load(value: typeof published) { published = value } } })
assert.ok(published)
const { SlotRegistry } = published.factory(require)
const names = ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'] as const
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('legacy leaves keep the real Cordis slots receiver and follow original reload under their own plugin lifetime', async () => {
    const root = new Context()
    new SlotRegistry(root)
    const originalKey = 'official-terminal', legacyKey = 'legacy-terminal'
    const Body = () => null, Title = () => null, Replacement = () => null
    try {
        const declarations = root.plugin({ name: 'test-pane-declarations', inject: ['slots'], apply(ctx: Context) {
            ctx.slots.register({ name: 'root', children: {
                'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
                'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
            } } as never, Body as never)
        } })
        await declarations
        const source = (component: typeof Body) => root.plugin({ name: 'test-official-terminal', inject: ['slots'], apply(ctx: Context) {
            for (const name of names) ctx.slots.register({ name, key: originalKey, inject: (sessionId: SessionId) => ({ originalSession: sessionId }) }, component)
        } })
        let original = source(Body); await original
        const composed = root.plugin({ name: 'test-legacy-terminal', inject: ['slots'], apply(ctx: Context) {
            const dispose = names.map(name => followLegacyTerminalSeat(ctx, name, originalKey, legacyKey,
                (entry, sessionId) => ({ ...(entry.inject as (id: SessionId) => { originalSession: SessionId })(sessionId), legacySession: sessionId }),
                entry => entry.component === Body ? Title : Replacement))
            return () => { for (const stop of dispose) stop() }
        } })
        await composed
        const slots = root.get('slots')!
        for (const name of names) {
            const borrowed = slots.entriesOfSlot(name).find(entry => entry.options.key === legacyKey)
            assert.ok(borrowed, 'The actual registry must contain the composed leaf, not only its tab definition')
            assert.equal(borrowed.component, Title)
            assert.equal(borrowed.registrant, 'test-legacy-terminal')
            assert.deepEqual((borrowed.inject as (id: SessionId) => unknown)('pane-own-session' as SessionId), { originalSession: 'pane-own-session', legacySession: 'pane-own-session' })
        }
        await original.dispose(); await tick()
        for (const name of names) assert.equal(slots.entriesOfSlot(name).length, 0)
        original = source(Replacement); await original; await tick()
        for (const name of names) {
            assert.equal(slots.entriesOfSlot(name).length, 2)
            assert.equal(slots.entriesOfSlot(name).find(entry => entry.options.key === legacyKey)?.component, Replacement)
        }
        await composed.dispose(); await tick()
        for (const name of names) assert.deepEqual(slots.entriesOfSlot(name).map(entry => entry.options.key), [originalKey])
        await original.dispose(); await declarations.dispose()
    } finally { await root.fiber.dispose() }
})

for (const name of names) test(`legacy ${name} follower retires before queued notifications reach a disposing Context`, async () => {
    const root = new Context()
    new SlotRegistry(root)
    const originalKey = 'official-terminal', legacyKey = 'legacy-terminal'
    const Original = () => null, Replacement = () => null, Borrowed = () => null
    let replaceOriginal!: () => void, installations = 0, cleaned = false
    try {
        const declarations = root.plugin({ name: 'test-pane-declarations', inject: ['slots'], apply(ctx: Context) {
            ctx.slots.register({ name: 'root', children: {
                'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
                'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
            } } as never, Original as never)
        } })
        await declarations
        const official = root.plugin({ name: 'test-official-terminal', inject: ['slots'], apply(ctx: Context) {
            let remove = ctx.slots.register({ name, key: originalKey }, Original)
            replaceOriginal = () => { remove(); remove = ctx.slots.register({ name, key: originalKey }, Replacement) }
            return () => { remove() }
        } })
        await official
        const composed = root.plugin({ name: 'test-legacy-terminal', inject: ['slots'], apply(ctx: Context) {
            const stop = followLegacyTerminalSeat(ctx, name, originalKey, legacyKey, () => ({}), () => { installations++; return Borrowed })
            return () => { cleaned = true; stop() }
        } })
        await composed; await tick()
        assert.equal(installations, 1)

        // The real SlotCore queues this change before Cordis queues the
        // disposer work. The owner is already inactive when that batch runs,
        // although its unsubscribe callback has not been reached yet.
        replaceOriginal()
        const retiring = composed.dispose()
        assert.equal(composed.ctx.fiber.uid, null)
        assert.equal(cleaned, false)
        await retiring; await tick()

        assert.equal(installations, 1, 'No new component/effect may be created for the retired owner')
        assert.equal(cleaned, true)
        const remaining = root.get('slots')!.entriesOfSlot(name)
        assert.deepEqual(remaining.map(entry => entry.options.key), [originalKey])
        assert.equal(remaining[0]!.component, Replacement)
    } finally { await root.fiber.dispose() }
})

test('legacy follower ignores a notification already captured before its synchronous stop', async () => {
    const root = new Context()
    new SlotRegistry(root)
    const name = 'sidebar.right.pane.tab' as const, originalKey = 'official-terminal', legacyKey = 'legacy-terminal'
    const Original = () => null, Replacement = () => null, Borrowed = () => null
    let replaceOriginal!: () => void, stopBorrow = (): void => {}, installations = 0, retireOnChange = false
    let stopEarlier = (): void => {}
    try {
        const declarations = root.plugin({ name: 'test-pane-declarations', inject: ['slots'], apply(ctx: Context) {
            ctx.slots.register({ name: 'root', children: { [name]: { kind: 'keyed', scope: 'session' } } } as never, Original as never)
        } })
        await declarations
        const official = root.plugin({ name: 'test-official-terminal', inject: ['slots'], apply(ctx: Context) {
            let remove = ctx.slots.register({ name, key: originalKey }, Original)
            replaceOriginal = () => { remove(); remove = ctx.slots.register({ name, key: originalKey }, Replacement) }
            return () => { remove() }
        } })
        await official
        const slots = root.get('slots')!
        // SlotCore snapshots listeners before walking the batch. An earlier
        // owner may retire this follower while its callback is in that snapshot.
        stopEarlier = slots.subscribe(name, () => { if (retireOnChange) stopBorrow() })
        const composed = root.plugin({ name: 'test-legacy-terminal', inject: ['slots'], apply(ctx: Context) {
            stopBorrow = followLegacyTerminalSeat(ctx, name, originalKey, legacyKey, () => ({}), () => { installations++; return Borrowed })
            return () => { stopBorrow() }
        } })
        await composed; await tick()
        retireOnChange = true; replaceOriginal()
        await tick()

        assert.notEqual(composed.ctx.fiber.uid, null, 'The explicit stop must work even while its plugin remains active')
        assert.equal(installations, 1, 'An already captured callback cannot resurrect the stopped follower')
        assert.deepEqual(slots.entriesOfSlot(name).map(entry => entry.options.key), [originalKey])
        assert.equal(slots.entriesOfSlot(name)[0]!.component, Replacement)
        stopBorrow(); stopBorrow()
    } finally { stopEarlier(); await root.fiber.dispose() }
})
