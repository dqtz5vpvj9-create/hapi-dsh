/** Real Cordis Loader/isolation lifecycle; sidebar business UI is an explicit fake. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { installEntrySessionNavigation, installSidebarNavigation } from '../src/client/sidebar-navigation.ts'

test('disabled optional entry menus do not block pane resources or weaken the required Sidebar', async () => {
    const root = new Context()
    await root.plugin(Loader)
    try {
        const restore = await installEntrySessionNavigation(root, { startSession: () => { throw new Error('An absent menu cannot navigate') } })
        assert.equal([...root.loader.entries()].length, 0)
        await restore()
        await restore()
        await assert.rejects(installSidebarNavigation(root, { requestNewSession() {} }), /navigation plugin .*ui-sidebar is not present/)
        assert.equal([...root.loader.entries()].length, 0)
    } finally { await root.fiber.dispose() }
})

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

test('official entry menus pass workspace, preset and append options to the shared draft owner', async () => {
    const root = new Context()
    let isolatedCalls = 0
    let active: ((...args: Parameters<Context['uiWorkspace']['startSession']>) => void) | undefined
    class OriginalNavigation extends Service {
        constructor(ctx: Context) { super(ctx, 'uiWorkspace') }
        startSession() { isolatedCalls++ }
    }
    new OriginalNavigation(root)
    await root.plugin(Loader)
    root.loader.internal = { import: async () => ({
        inject: ['uiWorkspace'],
        apply(ctx: Context) {
            active = (workspaceId, options) => ctx.uiWorkspace.startSession(workspaceId, options)
            return () => { active = undefined }
        },
    }) } as never
    await root.loader.create({ name: '@deepseek-ai/dsh-client-ui-entry-customization' })
    await root.loader.await()
    const calls: Parameters<Context['uiWorkspace']['startSession']>[] = []
    const restore = await installEntrySessionNavigation(root, { startSession: (...args) => { calls.push(args) } })
    await root.loader.await()
    const options = { agentPreset: 'cordis', prompt: 'Create a plugin.', whenDraftExists: 'append' as const }
    active!(undefined, options)
    assert.equal(isolatedCalls, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]![0], undefined)
    assert.equal(calls[0]![1], options)
    await restore(); await root.loader.await()
    active!(undefined, options)
    assert.equal(isolatedCalls, 1)
    await root.fiber.dispose()
})
