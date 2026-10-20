/** Real Cordis Loader/isolation lifecycle; sidebar business UI is an explicit fake. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { installSidebarNavigation } from '../src/client/sidebar-navigation.ts'

test('official sidebar navigation adapter rebinds through Loader isolation and restores on disposal', async () => {
    const root = new Context()
    let originalCalls = 0
    let customCalls = 0
    let active: (() => void) | undefined
    let starts = 0
    let stops = 0
    // A real tracked Service matters here: Cordis reads prototype method
    // descriptors, so a Proxy get trap over an original Service is insufficient.
    class OriginalNavigation extends Service {
        constructor(ctx: Context) { super(ctx, 'uiWorkspace') }
        startSession() { originalCalls++ }
    }
    new OriginalNavigation(root)
    await root.plugin(Loader)
    const loader = root.get('loader')!
    loader.internal = { import: async () => ({
        inject: ['uiWorkspace'],
        apply(ctx: Context) {
            starts++
            active = () => ctx.uiWorkspace.startSession()
            return () => { active = undefined; stops++ }
        },
    }) } as never
    const id = await loader.create({ name: '@deepseek-ai/dsh-client-ui-sidebar' })
    await loader.await()
    active!(); assert.equal(originalCalls, 1)
    const plugin = root.plugin({ inject: ['loader', 'uiWorkspace'], apply: (ctx: Context) => installSidebarNavigation(ctx, {
        requestNewSession: () => { customCalls++ },
    }) })
    await plugin; await loader.await()
    assert.equal(typeof active, 'function', JSON.stringify({ starts, stops, plugin: plugin.ctx.fiber.state, sidebar: loader.resolve(id).fiber?.state, provided: Boolean(loader.resolve(id).context.get('uiWorkspace')), isolation: loader.resolve(id).options.isolate }))
    active!()
    assert.equal(customCalls, 1)
    assert.equal(originalCalls, 1)
    root.get('uiWorkspace')!.startSession()
    assert.equal(originalCalls, 2)
    assert.match(String(loader.resolve(id).options.isolate?.uiWorkspace), /^hapi-dsh:sidebar:/)
    await plugin.dispose(); await loader.await()
    active!()
    assert.equal(originalCalls, 3)
    assert.equal(customCalls, 1)
    assert.equal(loader.resolve(id).options.isolate, undefined)
    assert.equal(starts, 3)
    assert.equal(stops, 2)
    await root.fiber.dispose()
})
