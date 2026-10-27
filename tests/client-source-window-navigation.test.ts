/** Public slot composition and source state; actual layout is browser acceptance. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { installSourceWindowNavigation } from '../src/client/surface/source-window-navigation.tsx'
import { WorkspacePaneProvider } from '../src/client/surface/pane-context.tsx'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'

const require = createRequire(import.meta.url)
let published: { factory(resolve: (id: string) => unknown): typeof import('@deepseek-ai/dsh-client-ui-renderer/client') } | undefined
new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8'))({
    __ModuleLoader__: { load(value: typeof published) { published = value } },
})
const { SlotRegistry } = published!.factory(require)

test('the public input dock exposes only a source gap and preserves the existing dock occupant', async () => {
    const ctx = new Context(); new SlotRegistry(ctx)
    let hasMoreAfter = false, busy = false, source = true
    ctx.reflect.provide('sessions', { binding: () => ({ session: source ? { sourceWindow: {
        getSnapshot: () => ({ hasMoreAfter }), subscribe: () => () => {},
    } } : {} }) } as unknown as Context['sessions'])
    const original = () => null
    const declaration = ctx.plugin({ name: 'source-latest-fixture', apply(owner: Context) {
        owner.slots.register({ name: 'root', children: { 'conversation.input.dock': { kind: 'list', scope: 'session' } } },
            ({ renderSlot }: PropsRenderSlots<'conversation.input.dock'>) => { void renderSlot; return null })
        owner.slots.register({ name: 'conversation.input.dock', id: 'queue', order: 20 }, original)
    } })
    await declaration
    const plugin = ctx.plugin({ name: 'source-latest-composition', apply: installSourceWindowNavigation })
    await plugin
    try {
        const entry = ctx.slots.entries('conversation.input.dock').find(row => row.options.id === 'hapi.source-latest')!
        assert.ok(entry)
        const Seat = entry.component as (props: any) => ReactElement | null
        const props = { sessionId: 'source', useSession: (select: (value: { loadingOlder: boolean }) => unknown) => select({ loadingOlder: busy }),
            t: () => 'Back to bottom' }
        const intents: unknown[] = []
        const pane = { locate(target: unknown) { intents.push(target) } } as unknown as WorkspacePaneNavigation
        let rendered: ReactElement | null = null
        const Capture = () => { rendered = Seat(props); return rendered }
        const render = () => renderToStaticMarkup(createElement(WorkspacePaneProvider, { value: pane }, createElement(Capture)))
        assert.equal(render(), '', 'a source window already at latest adds no dock')
        hasMoreAfter = true
        assert.match(render(), /aria-label="Back to bottom"/)
        assert.doesNotMatch(render(), /disabled/)
        assert.deepEqual(intents, [], 'source publication does not navigate automatically')
        const button = (rendered as ReactElement<{ children: ReactElement<{ onClick(): void }> }> | null)?.props.children
        assert.ok(button)
        button.props.onClick()
        assert.deepEqual(intents, [{ kind: 'latest' }], 'the real slot button uses this occurrence’s existing reading destination')
        busy = true
        assert.match(render(), /disabled=""/, 'the existing source operation blocks another latest request')
        source = false
        assert.equal(render(), '', 'ordinary sessions retain their official behavior')
        assert.equal(ctx.slots.entries('conversation.input.dock').find(row => row.options.id === 'queue')?.component, original)
        await plugin.dispose()
        assert.equal(ctx.slots.entries('conversation.input.dock').length, 1)
    } finally { await ctx.fiber.dispose() }
})
