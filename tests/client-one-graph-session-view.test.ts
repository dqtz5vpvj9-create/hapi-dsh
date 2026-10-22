/** Real pinned SlotRegistry; SessionReference readiness and DOM targets are
 * explicit protocol fixtures. Browser composition is covered by the shared-
 * graph Playwright spec, not claimed by this lifecycle test. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import type { SessionBinding, SessionFace, SessionReference, SessionSnapshot, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
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

function observable<T>(snapshot: T) {
    const listeners = new Set<() => void>()
    return { getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        subscriptions: () => listeners.size,
    }
}

/** Public faces with no older history; unexpected behavior calls fail loudly. */
function sessionSource(id: string) {
    const sessionId = id as SessionId
    const state = observable<SessionSnapshot>({ sessionId, pendingSubmissions: [], running: false, subagent: null,
        removed: false, openState: 'open', openError: null, hasMore: false, loadingOlder: false, promptError: null,
        blank: true, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false })
    const events = observable<SessionEventWindow>({ entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } })
    const unsupported = (): never => { throw new Error('No source operation belongs to the lifecycle fixture') }
    const session: SessionFace = { sessionId, getSnapshot: state.getSnapshot, subscribe: state.subscribe,
        projections: { faceOf: () => observable(undefined) },
        beginSubmission: unsupported, prompt: unsupported, readAttachment: unsupported, updateQueue: unsupported,
        cancel: unsupported, rename: unsupported, loadOlder: unsupported, loadThrough: unsupported, command: unsupported }
    const binding: SessionBinding = { sessionId, session, eventSource: events, ctx: new Context() as SessionBinding['ctx'] }
    return { binding, state, events }
}

function reference(id: string, source = sessionSource(id)) {
    let resolve!: (binding: SessionReference['binding']) => void
    let reject!: (reason: unknown) => void
    let releases = 0
    const ready = new Promise<SessionReference['binding']>((yes, no) => { resolve = yes; reject = no })
    const { binding } = source
    const ref: SessionReference = {
        sessionId: id as SessionId, binding, ready,
        release() { releases++ }, [Symbol.dispose]() { releases++ },
    }
    return { ref, source, resolve: () => resolve(binding), reject, releases: () => releases }
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
    const document = { defaultView: null } as Document
    const surfaces: Array<{ attributes: Map<string, string>; listeners: Set<EventListenerOrEventListenerObject>; state: ReturnType<typeof observable<{ focused: boolean; visible: boolean }>> }> = []
    const surface = (paneId: string) => {
        const attributes = new Map<string, string>([['data-hapi-host', 'fixture-host']])
        const listeners = new Set<EventListenerOrEventListenerObject>()
        const state = observable({ focused: true, visible: true })
        // The protocol target is connected, with no real DOM rendering/layout.
        // Distinct event kinds may share a callback, as in the browser helper.
        const byType = new Map<string, EventListenerOrEventListenerObject>()
        const target = {
            ownerDocument: document, isConnected: true, hidden: false,
            closest: () => target,
            getAttribute: (name: string) => attributes.get(name) ?? null,
            setAttribute: (name: string, value: string) => { attributes.set(name, value) },
            removeAttribute: (name: string) => { attributes.delete(name) },
            addEventListener(type: string, listener: EventListenerOrEventListenerObject) { byType.set(type, listener); listeners.add(listener) },
            removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
                if (byType.get(type) === listener) byType.delete(type)
                if (![...byType.values()].includes(listener)) listeners.delete(listener)
            },
        } as unknown as HTMLElement
        surfaces.push({ attributes, listeners, state })
        return { paneId, target, navigation: { paneId, state } as unknown as WorkspacePaneNavigation }
    }
    const mount = (paneId: string, ref: SessionReference, onError?: (error: unknown) => void) => host.mount({
        ...surface(paneId), reference: ref,
        ...(onError ? { onError } : {}),
    })
    return { root, host, mount, surface, surfaces, plugin, close: () => root.fiber.dispose() }
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
        assert.equal(shared.source.state.subscriptions(), 2)
        assert.equal(shared.source.events.subscriptions(), 2)
        assert.ok(f.surfaces.every(surface => surface.state.subscriptions() === 1 && surface.listeners.size > 0))
        f.host.dispose(); f.host.dispose()
        assert.equal(shared.source.state.subscriptions(), 0)
        assert.equal(shared.source.events.subscriptions(), 0)
        assert.ok(f.surfaces.every(surface => surface.state.subscriptions() === 0 && surface.listeners.size === 0))
        assert.ok(f.surfaces.every(surface => !surface.attributes.has('data-hapi-initial-history')))
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
    try {
        const first = f.host.mount({ ...f.surface('pane'), instanceId: 'source-instance', reference: source.ref })
        const next = f.host.mount({ ...f.surface('pane'), instanceId: 'successor-instance', reference: successor.ref })
        assert.equal(f.host.size(), 2)
        source.resolve(); successor.resolve(); await tick()
        await first.dispose()
        assert.equal(f.host.size(), 1)
        assert.equal(successor.releases(), 0)
        await next.dispose()
    } finally { await f.close() }
})

test('a closed loading occurrence cannot poison a surviving reference to the same official Session face', async () => {
    const f = await fixture()
    const source = sessionSource('shared-initial-window')
    const old = reference('shared-initial-window', source), current = reference('shared-initial-window', source)
    try {
        const first = f.mount('closed-pane', old.ref)
        const survivor = f.mount('surviving-pane', current.ref)
        await first.dispose()
        old.reject(new Error('the closed occurrence released its waiting reference'))
        current.resolve()
        await tick(); await new Promise(resolve => setTimeout(resolve, 1))
        assert.equal(f.surfaces[0]!.attributes.has('data-hapi-initial-history'), false)
        assert.equal(f.surfaces[1]!.attributes.get('data-hapi-initial-history'), 'ready')
        assert.equal(source.state.subscriptions(), 1)
        assert.equal(source.events.subscriptions(), 1)
        assert.equal(f.host.size(), 1)
        assert.equal(current.releases(), 0)
        await survivor.dispose()
        assert.equal(source.state.subscriptions(), 0)
        assert.equal(source.events.subscriptions(), 0)
    } finally { await f.close() }
})
