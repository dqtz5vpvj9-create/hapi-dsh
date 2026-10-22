/** Pinned public SlotRegistry; no browser rendering or source mutations. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { editableSourceQueue, installSourceQueueOwnership } from '../src/client/source-queue.tsx'
import type { DeliveryView } from '../src/codex/projection-types.ts'

const require = createRequire(import.meta.url)
let published: { factory(resolve: (id: string) => unknown): typeof import('@deepseek-ai/dsh-client-ui-renderer/client') } | undefined
new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8'))({
    __ModuleLoader__: { load(value: typeof published) { published = value } },
})
const { SlotRegistry } = published!.factory(require)

test('only source-owned queues suppress the incompatible official queue; ordinary DSH delegates intact', async () => {
    const ctx = new Context(); new SlotRegistry(ctx)
    const original = () => null
    const declaration = ctx.plugin({ name: 'source-queue-fixture', apply(owner: Context) {
        owner.slots.register({ name: 'root', children: { 'conversation.input.dock': { kind: 'list', scope: 'session' } } },
            ({ renderSlot }: PropsRenderSlots<'conversation.input.dock'>) => renderSlot('conversation.input.dock', {}))
        owner.slots.register({ name: 'conversation.input.dock', id: 'queue', order: 20, inject: () => ({ marker: 'official queue' }) }, original)
    } })
    await declaration
    const plugin = ctx.plugin({ name: 'source-queue-composition', apply: installSourceQueueOwnership })
    await plugin
    try {
        const entry = ctx.slots.entries('conversation.input.dock').find(row => row.component !== original)!
        const render = entry.component as (props: object) => ReactElement | null
        assert.equal(render({ useProjection: () => undefined })?.type, original)
        assert.equal(render({ useProjection: (key: string) => key === 'hapi' ? {} : undefined }), null)
        assert.equal(render({ useProjection: (key: string) => key === 'hapiObserved' ? { sidechain: null } : undefined }), null)
        assert.equal(render({ useProjection: (key: string) => key === 'hapiObserved' ? { sidechain: {} } : undefined })?.type, original)
        await plugin.dispose()
        assert.equal(ctx.slots.entries('conversation.input.dock').length, 1)
    } finally { await ctx.fiber.dispose() }
})

test('source queue includes unresolved delivery without reviving retired messages', () => {
    const states: DeliveryView['state'][] = ['queued', 'accepted', 'dispatching', 'indeterminate', 'invoked', 'cancelled', 'discarded', 'rejected']
    const rows = states.map((state, index): DeliveryView => ({ state, localId: String(index), messageId: String(index), text: '', mode: 'queue', createdAt: index, error: null }))
    assert.deepEqual(editableSourceQueue(rows).map(row => row.state), states.slice(0, 4))
})
