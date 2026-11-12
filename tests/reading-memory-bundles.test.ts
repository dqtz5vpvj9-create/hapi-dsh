/** Separate compiled production module instances sharing the real Cordis graph.
 * This covers the source-provider/workspace split; browser loading remains root's acceptance. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MountedChatControlV1 } from '../src/client/mounted-chat-control.ts'
import * as ordinary from '../src/client/ordinary-reading-checkpoint.ts'
import * as remote from '../src/client/remote-reading-memory.ts'
import { WorkspaceApplicationIdentity } from '../src/client/application-identity.ts'
import { createWorkspaceUpdatePreparations } from '../src/client/update-preparation.ts'

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..')
type Api = typeof ordinary & typeof remote
async function modules(): Promise<[Api, Api]> {
    const compiled = await build({ stdin: { contents: "export * from './src/client/remote-reading-memory.ts'; export * from './src/client/ordinary-reading-checkpoint.ts';",
        loader: 'ts', resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
        packages: 'external', write: false, logLevel: 'silent' })
    const evaluate = (): Api => {
        const module = { exports: {} as Api }
        new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(require, module, module.exports)
        return module.exports
    }
    return [evaluate(), evaluate()]
}

for (const ordinaryFirst of [false, true]) test(`independent browser module instances share one owned memory service with ${ordinaryFirst ? 'workspace' : 'source-provider'} first`, async () => {
    const [source, workspace] = await modules(), ctx = new Context(), updates = createWorkspaceUpdatePreparations()
    assert.notEqual(source.installOrdinaryReadingMemory, workspace.installOrdinaryReadingMemory)
    const application = new WorkspaceApplicationIdentity(), values = new Map<string, string>(), stops: Array<() => void> = []
    application.set({ accountId: 'actual-account', origin: 'https://fixture.invalid' }, 'device')
    await ctx.plugin({ name: 'two-independent-memory-modules', apply(owner: Context) {
        if (ordinaryFirst) stops.push(workspace.installOrdinaryReadingMemory(owner))
        stops.push(source.installRemoteReadingMemory(owner, () => undefined, () => false))
        if (!ordinaryFirst) stops.push(workspace.installOrdinaryReadingMemory(owner))
    } })
    assert.equal(ctx.chatScrollMemory, ctx.sourceReadingMemory.memory)
    const binding = { sessionId: 'ordinary-session' } as unknown as SessionBinding
    const memory = ctx.chatScrollMemory.forBinding(binding)!
    const control = { read: () => ({ revision: 1, anchor: null, following: true, hasOlder: true, busy: false }),
        checkpointReading: () => memory.save(null) } as unknown as MountedChatControlV1
    // The consumer is intentionally evaluated in the other JS instance from
    // the ordinary installer. Its capture must come from the Cordis service.
    const checkpoint = source.registerOrdinaryReadingCheckpoint(ctx, binding, { updates, application,
        target: { hostId: 'original-host', sessionId: binding.sessionId, paneId: 'original-pane' }, reload: false,
        storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } },
        reader: () => control, current: () => true })
    try {
        await updates.checkpoint(); source.armOrdinaryReadingForReload(updates)
        assert.ok([...values.keys()].some(key => key.includes('armed')))
        assert.equal(ctx.chatScrollMemory.forBinding({ sessionId: 'hhpi:machine:source:codex:thread' } as unknown as SessionBinding), undefined)
    } finally { checkpoint.dispose(); for (const stop of stops.reverse()) stop(); updates.dispose(); application.dispose(); await ctx.fiber.dispose() }
})

test('an unrelated public memory owner is not overwritten', async () => {
    const ctx = new Context(), existing = { forBinding: () => undefined }
    ctx.reflect.provide('chatScrollMemory', existing)
    try {
        assert.throws(() => ordinary.installOrdinaryReadingMemory(ctx), /Another plugin already owns/)
        assert.equal(ctx.chatScrollMemory, existing)
    } finally { await ctx.fiber.dispose() }
})
