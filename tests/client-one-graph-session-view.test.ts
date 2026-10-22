/** Real pinned SlotRegistry; SessionReference readiness and DOM targets are
 * explicit protocol fixtures. Browser composition is covered by the shared-
 * graph Playwright spec, not claimed by this lifecycle test. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspacePaneNavigation } from '../src/client/pane-navigation.ts'
import { installSessionViewHost } from '../src/client/surface/session-view.tsx'

const require = createRequire(import.meta.url)
let published: { factory(resolve: (id: string) => unknown): typeof import('@deepseek-ai/dsh-client-ui-renderer/client') } | undefined
new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8'))({
    __ModuleLoader__: { load(value: typeof published) { published = value } },
})
assert.ok(published)
const { SlotRegistry } = published.factory(require)
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function reference(id: string) {
    let resolve!: (binding: SessionReference['binding']) => void
    let reject!: (reason: unknown) => void
    let releases = 0
    const ready = new Promise<SessionReference['binding']>((yes, no) => { resolve = yes; reject = no })
    const binding = {} as SessionReference['binding']
    const ref: SessionReference = {
        sessionId: id as SessionId, binding, ready,
        release() { releases++ }, [Symbol.dispose]() { releases++ },
    }
    return { ref, resolve: () => resolve(binding), reject, releases: () => releases }
}

async function fixture() {
    const root = new Context()
    new SlotRegistry(root)
    const declaration = root.plugin({ name: 'test-official-shell-declaration', inject: ['slots'], apply(ctx: Context) {
        ctx.slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } },
            ({ renderSlot }: PropsRenderSlots<'shell.overlay'>) => renderSlot('shell.overlay', {}))
    } })
    await declaration
    let host!: ReturnType<typeof installSessionViewHost>
    const plugin = root.plugin({ name: 'test-shared-host-view', inject: ['slots'], apply(ctx: Context) {
        host = installSessionViewHost(ctx)
        return () => host.dispose()
    } })
    await plugin
    const mount = (paneId: string, ref: SessionReference, onError?: (error: unknown) => void) => host.mount({
        paneId, reference: ref, target: {} as HTMLElement, navigation: { paneId } as WorkspacePaneNavigation,
        ...(onError ? { onError } : {}),
    })
    return { root, host, mount, plugin, close: () => root.fiber.dispose() }
}

test('one Host adds one official shell contribution and independent explicit view lifetimes', async () => {
    const f = await fixture()
    const alpha = reference('alpha'), beta = reference('beta')
    try {
        const a = f.mount('pane-a', alpha.ref), b = f.mount('pane-b', beta.ref)
        assert.equal(f.host.size(), 2)
        assert.equal(f.root.slots.entriesOfSlot('root').length, 1)
        assert.deepEqual(f.root.slots.entriesOfSlot('shell.overlay').map(entry => entry.options.id), ['hapi.workspace.session-views'])
        assert.equal(f.root.slots.entriesOfSlot('hapi.workspace.session-view').length, 1)
        a.dispose(); a.dispose()
        assert.equal(f.host.size(), 1)
        alpha.resolve(); beta.resolve(); await tick()
        assert.equal(f.host.size(), 1, 'a released view must not return when its readiness completes')
        assert.equal(alpha.releases(), 0, 'the reference belongs to the outer pane owner')
        assert.equal(beta.releases(), 0, 'removing a sibling does not release or terminate this session')
        b.dispose()
        await f.plugin.dispose()
        assert.equal(f.root.slots.entriesOfSlot('root').length, 1)
        assert.equal(f.root.slots.entriesOfSlot('shell.overlay').length, 0)
        assert.equal(f.root.slots.entriesOfSlot('hapi.workspace.session-view').length, 0)
    } finally { await f.close() }
})

test('closing a loading pane suppresses its later failure and cannot poison a replacement', async () => {
    const f = await fixture()
    const old = reference('old-session'), current = reference('new-session')
    const failures: unknown[] = []
    try {
        const first = f.mount('pane', old.ref, error => failures.push(error))
        assert.throws(() => f.mount('pane', current.ref), /already has a session view/)
        first.dispose()
        const next = f.mount('pane', current.ref, error => failures.push(error))
        old.reject(new Error('late old failure'))
        first.dispose(); await tick()
        assert.equal(f.host.size(), 1)
        assert.deepEqual(failures, [])
        const reason = new Error('new source failed')
        current.reject(reason); await tick()
        assert.deepEqual(failures, [reason])
        next.dispose()
        assert.equal(f.host.size(), 0)
    } finally { await f.close() }
})

test('Host teardown leaves borrowed references untouched and ignores outstanding waits', async () => {
    const f = await fixture()
    const shared = reference('same-session')
    const failures: unknown[] = []
    try {
        const one = f.mount('pane-one', shared.ref, error => failures.push(error))
        f.mount('pane-two', shared.ref, error => failures.push(error))
        assert.equal(f.host.size(), 2, 'same-session occurrences are valid separate views')
        f.host.dispose(); f.host.dispose()
        shared.reject(new Error('read cancelled on Host departure')); await tick()
        one.dispose()
        assert.equal(f.host.size(), 0)
        assert.deepEqual(failures, [])
        assert.equal(shared.releases(), 0)
        assert.throws(() => f.mount('new-pane', shared.ref), /surface is disposed/)
    } finally { await f.close() }
})

test('a retired draft-transfer occurrence can coexist with its same-pane successor', async () => {
    const f = await fixture()
    const source = reference('source'), successor = reference('successor')
    const base = { paneId: 'pane', target: {} as HTMLElement, navigation: { paneId: 'pane' } as WorkspacePaneNavigation }
    try {
        const first = f.host.mount({ ...base, instanceId: 'source-instance', reference: source.ref })
        const next = f.host.mount({ ...base, instanceId: 'successor-instance', reference: successor.ref })
        assert.equal(f.host.size(), 2)
        source.resolve(); successor.resolve(); await tick()
        await first.dispose()
        assert.equal(f.host.size(), 1)
        assert.equal(successor.releases(), 0)
        await next.dispose()
    } finally { await f.close() }
})
