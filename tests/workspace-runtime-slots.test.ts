import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createGraphSlots } from '../src/client/runtime-slots.ts'

test('packaged graph Slot core preserves delegated renderer injections independently of the shell', async () => {
    const built = await build({ entryPoints: ['@deepseek-ai/dsh-client-ui-slots'], bundle: true,
        format: 'iife', globalName: '__HAPI_DSH_OFFICIAL_SLOTS__', platform: 'browser', write: false })
    const { SlotCore } = createGraphSlots(built.outputFiles[0]!.text)
    const core = new SlotCore()
    core.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } } as never, (() => null) as never)
    const presentation = { getSnapshot: () => 'complete', subscribe: () => () => {} }
    const fileMentions = () => 'file navigation'
    core.register({ name: 'conversation.chat.node', key: 'assistant-step',
        inject: () => ({ hooks: { presentation }, fileMentions }) } as never, (() => null) as never)
    const original = core.entries('conversation.chat.node')[0]!
    core.register({ name: 'conversation.chat.node', key: 'assistant-step', priority: -1, delegate: original } as never, (() => null) as never)
    const active = core.entries('conversation.chat.node')[0]!
    assert.equal(active.delegate, original)
    const injected = active.delegate!.inject!()
    assert.equal(injected.fileMentions, fileMentions)
    assert.equal((injected.hooks as { presentation: unknown }).presentation, presentation)
})
