import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TranslationIdentity, TranslationLog } from '@deepseek-ai/dsh-experimental-translator'
import type { TranslationStorageProvider } from '@deepseek-ai/dsh-experimental-translator'
import { SourceTranslationStorage, installSourceTranslation } from '../src/workspace/source-translation.ts'
import type { SourceGateway } from '../src/remote/gateway.ts'

const identity: TranslationIdentity = { provider: 'deepseek-official', text: 'Synthetic reasoning', sourceLanguage: 'auto', targetLanguage: 'zh', recipe: 'native-flash' }
const signal = (): AbortSignal => new AbortController().signal
const save = (text: string, dispatch: () => void = () => {}) => async (log: TranslationLog): Promise<string> => {
    const request = await log.request(identity)
    await log.assertCurrent?.()
    dispatch()
    await log.result(request, text)
    return text
}

test('source translations survive restart and isolate exact account and source identities', async () => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-translations-'), path = join(directory, 'translations.sqlite')
    let storage = new SourceTranslationStorage(path), authorizations = 0, dispatches = 0
    const authorize = async () => { authorizations++ }, dispatched = () => { dispatches++ }
    try {
        assert.equal(await storage.owner('account-a', 'source-a', authorize).run(identity, signal(), save('译文 A', dispatched)), '译文 A')
        await storage.close(); storage = new SourceTranslationStorage(path)
        assert.equal(await storage.owner('account-a', 'source-a', authorize).run(identity, signal(), save('must reuse', dispatched)), '译文 A')
        assert.equal(dispatches, 1)
        assert.equal(await storage.owner('account-b', 'source-a', authorize).run(identity, signal(), save('other account', dispatched)), 'other account')
        assert.equal(await storage.owner('account-a', 'source-b', authorize).run(identity, signal(), save('other source', dispatched)), 'other source')
        assert.equal(dispatches, 3)
        assert.ok(authorizations >= 13, 'cached reads and every request/result/dispatch recheck source authorization')
    } finally { await storage.close(); await rm(directory, { recursive: true, force: true }) }
})

test('two panes share a completed result while cancellation preserves another pane and excludes the late result', async () => {
    const storage = new SourceTranslationStorage(':memory:'), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const owner = storage.owner('account', 'source', async () => {}), cancelled = new AbortController()
    let dispatches = 0
    const first = owner.run(identity, cancelled.signal, async log => {
        const request = await log.request(identity); entered.resolve(); await release.promise
        await log.result(request, 'late result'); return 'late result'
    })
    try {
        await entered.promise
        const second = owner.run(identity, signal(), save('accepted pane', () => { dispatches++ }))
        cancelled.abort(new DOMException('Pane closed', 'AbortError')); release.resolve()
        await assert.rejects(first, { name: 'AbortError' })
        assert.equal(await second, 'accepted pane')
        assert.equal(await owner.run(identity, signal(), save('must reuse', () => { dispatches++ })), 'accepted pane')
        assert.equal(dispatches, 1)
    } finally { release.resolve(); await Promise.allSettled([first]); await storage.close() }
})

test('denial on cache read and revocation before dispatch fail before external text leaves', async () => {
    const storage = new SourceTranslationStorage(':memory:')
    let allowed = true, dispatches = 0
    const owner = storage.owner('account', 'source', async () => { if (!allowed) throw new Error('denied') })
    try {
        await owner.run(identity, signal(), save('cached'))
        allowed = false
        await assert.rejects(owner.run(identity, signal(), save('must not run', () => { dispatches++ })), /denied/)
        allowed = true
        const changed = { ...identity, text: 'New synthetic reasoning' }
        await assert.rejects(owner.run(changed, signal(), async log => {
            await log.request(changed); allowed = false
            await log.assertCurrent?.(); dispatches++; return 'must not dispatch'
        }), /denied/)
        assert.equal(dispatches, 0)
    } finally { await storage.close() }
})

test('the provider leaves ordinary DSH unchanged and rejects unauthenticated, denied and unknown HHPI sources', async () => {
    const ctx = new Context(), caller = new Context(), source = SessionId('hhpi:machine:source:codex:native')
    let provider: TranslationStorageProvider | undefined, allowed = true, known = true, resolves = 0
    const access = { allows: () => allowed }
    ctx.reflect.provide('remoteAccess', access as never)
    caller.reflect.provide('remoteAccess', access as never)
    ctx.reflect.provide('translator', { registerStorageProvider(value: TranslationStorageProvider) { provider = value; return () => {} } } as never)
    const gateway = { async resolve(id: string, authorize: (resource: { kind: 'session'; id: string }) => boolean) {
        resolves++; assert.equal(id, source)
        if (!authorize({ kind: 'session', id })) throw new Error('denied')
        if (!known) throw new Error('unknown source')
        return { id }
    } } as unknown as SourceGateway
    try {
        await installSourceTranslation(ctx, gateway, ':memory:')
        assert.ok(provider)
        assert.equal(await provider(SessionId('ordinary-dsh'), caller, signal()), undefined)
        assert.equal(resolves, 0)
        await assert.rejects(provider(source, caller, signal()), /authenticated invocation/)
        caller.reflect.provide('invocation', { peer: { principal: { kind: 'owner' } } } as never)
        const owner = await provider(source, caller, signal()); assert.ok(owner)
        assert.equal(await owner.run(identity, signal(), save('source result')), 'source result')
        allowed = false
        await assert.rejects(provider(source, caller, signal()), /denied/)
        await assert.rejects(owner.run(identity, signal(), save('must not reuse denied cache')), /denied/)
        allowed = true; known = false
        await assert.rejects(provider(source, caller, signal()), /unknown source/)
    } finally { await caller.fiber.dispose(); await ctx.fiber.dispose() }
})
