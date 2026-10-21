/**
 * Restore and error-state classifiers with explicit catalog fakes. These tests
 * prove the decision logic only; they do not claim coverage of a real Host,
 * Hub or Runner.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionBinding, SessionListState, SessionReference, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceState } from '../src/client/model.ts'
import { panes, parseWorkspaceState } from '../src/client/model.ts'
import {
    bindingFailureState, displaySessionBaseId, displaySessionRevision, invalidPaneAddressState, isSourceDisplaySessionId,
    paneOpenState, waitForCatalogSession, type PaneOpenContext,
} from '../src/client/catalog-readiness.ts'
import { WorkspaceController, type WorkspaceOptions } from '../src/client/controller.ts'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { bindSourceResources, displayGenerationRow, sourceRow } from '../src/workspace/legacy.ts'

const HASH_A = '0123456789abcdef0123456789abcdef'
const HASH_B = 'fedcba9876543210fedcba9876543210'

function context(patch: Partial<PaneOpenContext> = {}): PaneOpenContext {
    return { kind: 'display', label: 'Lab', hostId: 'local', sessionId: 'display', currentHubId: 'hub',
        sourcePhase: 'ready', localPhase: 'ready', hostRegistered: true, hostOnline: true, settled: true, ...patch }
}

test('display session generation helpers only treat a revision suffix as a generation', () => {
    assert.equal(isSourceDisplaySessionId(`hapi-observed-${HASH_A}`), true)
    assert.equal(isSourceDisplaySessionId(`hapi-codex-${HASH_A}-r3`), true)
    assert.equal(isSourceDisplaySessionId('hapi-observed-not-a-hash'), false)
    assert.equal(displaySessionBaseId(`hapi-observed-${HASH_A}-r12`), `hapi-observed-${HASH_A}`)
    assert.equal(displaySessionRevision(`hapi-observed-${HASH_A}-r12`), 12)
    assert.equal(displaySessionRevision(`hapi-observed-${HASH_A}`), undefined)
})

test('a busy catalog is transient, never a reported missing session', () => {
    for (const state of [
        paneOpenState(context({ localPhase: 'pending' })),
        paneOpenState(context({ settled: false })),
        paneOpenState(context({ kind: 'source', sourceSessionId: 's', sourcePhase: 'pending' })),
    ]) {
        assert.equal(state.reason, 'catalog-loading')
        assert.equal(state.transient, true)
        assert.match(state.message, /still loading/i)
        assert.match(state.nextStep, /automatically/i)
    }
    const ordinary = paneOpenState(context({ kind: 'display', sourcePhase: 'unavailable' }))
    assert.notEqual(ordinary.reason, 'source-offline', 'an ordinary DSH session never depends on the HAPI Hub')
    assert.equal(ordinary.reason, 'session-not-listed')
})

test('source offline keeps the pane waiting and says execution is not interrupted', () => {
    const state = paneOpenState(context({ kind: 'source', sourceSessionId: 'orig', sourcePhase: 'unavailable', machineLabel: 'Laptop' }))
    assert.equal(state.reason, 'source-offline')
    assert.equal(state.transient, true)
    assert.match(state.message, /Laptop/)
    assert.match(state.message, /unreachable/i)
    assert.match(state.nextStep, /reopens by itself/i)
    assert.doesNotMatch(state.message, /source=/)
})

test('offline and unregistered Hosts are distinguished from a missing session', () => {
    const offline = paneOpenState(context({ label: 'Lab machine', hostOnline: false }))
    assert.equal(offline.reason, 'host-offline')
    assert.equal(offline.transient, true)
    assert.match(offline.message, /Lab machine is offline/)
    const unregistered = paneOpenState(context({ label: '', hostRegistered: false, hostId: 'hapi-remote:x:y' }))
    assert.equal(unregistered.reason, 'host-offline')
    assert.match(unregistered.message, /machine that owns this pane/)
    assert.doesNotMatch(unregistered.message, /hapi-remote/)
})

test('a calm catalog turns an absence into a specific cause and a next step', () => {
    const archived = paneOpenState(context({ archived: true }))
    assert.equal(archived.reason, 'session-archived')
    assert.equal(archived.transient, false)
    assert.equal(archived.retryable, true)
    assert.match(archived.nextStep, /unarchive/i)

    const archivedSource = paneOpenState(context({ kind: 'source', sourceSessionId: 'orig', sourceLifecycle: 'archived' }))
    assert.equal(archivedSource.reason, 'source-archived')
    assert.match(archivedSource.message, /original HAPI session is archived/i)

    const deleted = paneOpenState(context({ kind: 'source', sourceSessionId: 'orig', savedHubId: 'old-hub', currentHubId: 'new-hub' }))
    assert.equal(deleted.reason, 'source-hub-changed')
    assert.equal(deleted.transient, false)
    assert.match(deleted.message, /no longer listed/i)
    assert.match(deleted.message, /different HAPI Hub identity/)
    assert.doesNotMatch(deleted.message, /old-hub|new-hub/)
    assert.match(deleted.detail, /savedHub=old-hub/)
    assert.match(deleted.nextStep, /sidebar/i)

    const unlisted = paneOpenState(context({ sessionId: 'ordinary-display' }))
    assert.equal(unlisted.reason, 'session-not-listed')
    assert.match(unlisted.nextStep, /sidebar/i)
})

test('binding, permission and address failures keep raw transport text in detail only', () => {
    const denied = bindingFailureState({ ...context({ kind: 'source', sourceSessionId: 'orig' }), error: '403 Forbidden: unauthorized session' })
    assert.equal(denied.reason, 'binding-denied')
    assert.equal(denied.retryable, true)
    assert.doesNotMatch(denied.message, /403|Forbidden/)
    assert.match(denied.detail, /403 Forbidden/)
    const failed = bindingFailureState({ ...context({}), error: 'transport closed while attaching' })
    assert.equal(failed.reason, 'binding-failed')
    assert.match(failed.message, /could not attach/i)
    assert.match(failed.detail, /transport closed/)
    const invalid = invalidPaneAddressState('hapi-remote:bad%encoding:source', new Error('URI malformed'))
    assert.equal(invalid.reason, 'address-invalid')
    assert.equal(invalid.retryable, false)
    assert.match(invalid.nextStep, /Close the pane/)
})

test('an exhausted catalog wait names the retry path instead of exposing an internal id', async () => {
    const id = 'hapi-observed-x' as SessionId
    const list = { getSnapshot: () => ({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} }) as SessionListState,
        subscribe: () => () => {} }
    await assert.rejects(waitForCatalogSession({ list, async refresh() {} }, id, new AbortController().signal, { timeoutMs: 5, retryMs: 1 }),
        (error: unknown) => error instanceof Error && error.name === 'SessionCatalogTimeout'
            && /catalog may still be attaching/.test(error.message) && !/hapi-observed-x/.test(error.message))
})

function fixture() {
    const listeners = new Set<() => void>()
    const refs: Array<SessionReference & { source: string; released: boolean }> = []
    let snapshot: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
    const publish = (): void => { for (const listener of [...listeners]) listener() }
    const project = (id: string, projectionValues: SessionSummary['projectionValues']): void => {
        const row = snapshot.byId[id as SessionId]
        if (!row) throw new Error('Missing fake row')
        snapshot = { ...snapshot, byId: { ...snapshot.byId, [id]: { ...row, projectionValues } as SessionSummary } }
        publish()
    }
    const add = (id: string, projectionValues?: SessionSummary['projectionValues']): void => {
        snapshot = { ...snapshot, ids: [...new Set([...snapshot.ids, id as SessionId])], byId: { ...snapshot.byId,
            [id]: { id: id as SessionId, displayTitle: id, running: false, blank: false, updatedAt: 1, retainedBy: {},
                ...(projectionValues ? { projectionValues } : {}) },
        } }
        publish()
    }
    const sessions: WorkspaceOptions['sessions'] = {
        list: { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } },
        retain(target, options) {
            const id = typeof target === 'string' ? target : target.childSessionId
            const binding = { sessionId: id, session: { rename: async () => ({ ok: true, value: undefined }) } } as unknown as SessionBinding
            const reference: SessionReference & { source: string; released: boolean } = {
                sessionId: id, binding, ready: Promise.resolve(binding), source: options.source, released: false,
                release() { reference.released = true },
                [Symbol.dispose]() { reference.release() },
            }
            refs.push(reference)
            return reference
        },
        async using(target, options, operation) {
            const reference = sessions.retain(target, options)
            try { return await operation(reference) } finally { reference.release() }
        },
        refresh: async () => { publish() },
        create: async request => (request?.sessionId ?? 'created') as SessionId,
        search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
    }
    const navigation: WorkspaceOptions['navigation'] = {
        openSession: () => {},
        startSession: () => {},
        archiveSession: async () => {},
        unarchiveSession: async () => {},
        pinSession: async () => {},
        unpinSession: async () => {},
        forkSession: async id => `${id}-fork` as SessionId,
    }
    const memory = new Map<string, string>()
    const options: WorkspaceOptions = {
        sessions, navigation, storageKey: 'workspace-test',
        storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value) } },
        nextId: (() => { let sequence = 0; return () => `test-${++sequence}` })(),
    }
    return { sessions, options, refs, add, project, memory, publish }
}

const savedLayout = (resource: Record<string, unknown>): WorkspaceState => parseWorkspaceState({
    schemaVersion: 1, revision: 1,
    windows: [{ id: 'w1', name: 'W1', autoName: true, root: { type: 'pane', id: 'p1', resource } }],
    activeWindowId: 'w1', focused: { w1: 'p1' }, zoomed: {},
})
const savedChat = (resource: Record<string, unknown>): string => JSON.stringify(savedLayout(resource))
const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })
const focusedResource = (controller: WorkspaceController) => controller.store.focusedPane().resource

test('a restored source pane re-binds the next display generation instead of claiming unavailability', async () => {
    const source = fixture()
    const oldId = `hapi-observed-${HASH_A}-r1`, nextId = `hapi-observed-${HASH_A}-r2`
    source.memory.set('workspace-test', savedChat({ kind: 'chat', sessionId: oldId, sourceSessionId: 'orig-native', sourceHubId: 'hub' }))
    const controller = new WorkspaceController({ ...source.options, catalogSettleMs: 5 })
    const paneId = panes(controller.store.getSnapshot().windows[0]!.root)[0]!.id
    assert.equal(controller.getSnapshot().leases.get(paneId)!.status, 'opening')
    assert.equal(controller.getSnapshot().leases.get(paneId)!.reason, 'catalog-loading')
    source.add(nextId, { hapiObserved: { ownership: 'hapi-runner', hubId: 'hub', hapiSessionId: 'orig-native' } } as never)
    await wait(1)
    const lease = controller.getSnapshot().leases.get(paneId)!
    assert.equal(lease.status, 'ready')
    assert.equal(lease.sessionId, nextId)
    assert.deepEqual(focusedResource(controller), { kind: 'chat', sessionId: nextId, sourceSessionId: 'orig-native', sourceHubId: 'hub' })
    controller.dispose()
})

test('a saved display-only pane upgrades to the original identity so a later restore does not depend on the display id', async () => {
    const source = fixture()
    const oldId = `hapi-codex-${HASH_B}-r1`, nextId = `hapi-codex-${HASH_B}-r2`
    source.memory.set('workspace-test', savedChat({ kind: 'chat', sessionId: oldId }))
    const controller = new WorkspaceController({ ...source.options, catalogSettleMs: 5 })
    source.add(nextId, { hapi: { engine: 'codex', hubId: 'hub', hapiSessionId: 'native-source' } } as never)
    await wait(1)
    assert.deepEqual(focusedResource(controller), { kind: 'chat', sessionId: nextId, sourceSessionId: 'native-source', sourceHubId: 'hub' })
    assert.equal(controller.getSnapshot().leases.get(controller.store.focusedPane().id)!.status, 'ready')
    controller.dispose()
})

test('a calm missing target reports the typed cause and reopens automatically when the identity appears', async () => {
    const source = fixture()
    source.memory.set('workspace-test', savedChat({ kind: 'chat', sessionId: 'gone-display' }))
    const controller = new WorkspaceController({ ...source.options, catalogSettleMs: 5 })
    const paneId = panes(controller.store.getSnapshot().windows[0]!.root)[0]!.id
    const waiting = controller.getSnapshot().leases.get(paneId)!
    assert.equal(waiting.status, 'opening')
    assert.equal(waiting.reason, 'catalog-loading')
    await wait(40)
    const failed = controller.getSnapshot().leases.get(paneId)!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.reason, 'session-not-listed')
    assert.match(failed.error!, /sidebar/)
    assert.equal(failed.waitingForCatalog, true)
    assert.equal(source.refs.length, 0, 'no guessed retain target')
    source.add('gone-display')
    await wait(1)
    assert.equal(controller.getSnapshot().leases.get(paneId)!.status, 'ready')
    controller.dispose()
})

test('unrelated row updates do not turn a settled missing pane back into loading', async () => {
    const source = fixture()
    source.memory.set('workspace-test', savedChat({ kind: 'chat', sessionId: 'missing-display' }))
    const controller = new WorkspaceController({ ...source.options, catalogSettleMs: 5 })
    const paneId = panes(controller.store.getSnapshot().windows[0]!.root)[0]!.id
    source.add('other-display')
    await wait(40)
    assert.equal(controller.getSnapshot().leases.get(paneId)!.status, 'failed')
    // A title/token/projection update on another row is not catalog progress.
    source.project('other-display', { hapiObserved: { ownership: 'hapi-runner', hubId: 'hub', hapiSessionId: 'other-source' } } as never)
    await wait(5)
    const lease = controller.getSnapshot().leases.get(paneId)!
    assert.equal(lease.status, 'failed')
    assert.equal(lease.reason, 'session-not-listed')
    controller.dispose()
})

test('a deleted original HAPI session is reported after the catalog settles, without dumping its id into the message', async () => {
    const source = fixture()
    source.memory.set('workspace-test', savedChat({ kind: 'chat', sessionId: `hapi-observed-${HASH_A}-r1`, sourceSessionId: 'deleted-source', sourceHubId: 'hub' }))
    const controller = new WorkspaceController({ ...source.options, catalogSettleMs: 5 })
    controller.setSourceCatalog([], 'hub')
    const paneId = panes(controller.store.getSnapshot().windows[0]!.root)[0]!.id
    await wait(40)
    const failed = controller.getSnapshot().leases.get(paneId)!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.reason, 'source-not-found')
    assert.doesNotMatch(failed.error!, /deleted-source/)
    assert.match(failed.detail!, /source=deleted-source/)
    source.add(`hapi-observed-${HASH_A}-r2`, { hapiObserved: { ownership: 'hapi-runner', hubId: 'hub', hapiSessionId: 'deleted-source' } } as never)
    await wait(1)
    assert.equal(controller.getSnapshot().leases.get(paneId)!.status, 'ready')
    controller.dispose()
})

test('a same session id on another Hub is never substituted for the saved source identity', async () => {
    const source = fixture()
    const saved = { kind: 'chat', sessionId: `hapi-observed-${HASH_A}-r1`, sourceSessionId: 'orig-source', sourceHubId: 'old-hub' }
    source.memory.set('workspace-test', savedChat(saved))
    const controller = new WorkspaceController({ ...source.options, catalogSettleMs: 5 })
    const paneId = panes(controller.store.getSnapshot().windows[0]!.root)[0]!.id
    controller.setSourceCatalog([], 'new-hub')
    // The current Hub lists a different session that happens to share the
    // original source id (and even looks like a display generation of it).
    source.add(`hapi-observed-${HASH_A}-r2`, { hapiObserved: { ownership: 'hapi-runner', hubId: 'new-hub', hapiSessionId: 'orig-source' } } as never)
    await wait(40)
    const lease = controller.getSnapshot().leases.get(paneId)!
    assert.equal(lease.status, 'failed')
    assert.equal(lease.reason, 'source-hub-changed')
    assert.equal(lease.reference, undefined)
    assert.equal(source.refs.length, 0, 'another Hub\'s session must never be retained')
    assert.deepEqual(focusedResource(controller), saved, 'the saved Hub identity and display id stay untouched')
    assert.match(lease.error!, /different HAPI Hub identity/)
    assert.match(lease.nextStep!, /sidebar/i)
    controller.dispose()
})

test('a saved document target on another Hub is never re-bound or rewritten', async () => {
    const source = fixture()
    const oldDisplay = `hapi-observed-${HASH_A}-r1`
    const saved = { kind: 'document', sessionId: oldDisplay, sourceSessionId: 'orig-source', sourceHubId: 'old-hub',
        document: { kind: 'file', path: '/repo/review.md' },
        target: { type: 'resource', address: sessionFileAddress(oldDisplay, '/repo/review.md') } }
    source.memory.set('workspace-test', savedChat(saved))
    const controller = new WorkspaceController({ ...source.options, catalogSettleMs: 5 })
    const paneId = panes(controller.store.getSnapshot().windows[0]!.root)[0]!.id
    controller.setSourceCatalog([], 'new-hub')
    // The other Hub exposes the same original session id under the next display
    // generation; the restore must not adopt it or rewrite the file target.
    source.add(`hapi-observed-${HASH_A}-r2`, { hapiObserved: { ownership: 'hapi-runner', hubId: 'new-hub', hapiSessionId: 'orig-source' } } as never)
    await wait(40)
    const lease = controller.getSnapshot().leases.get(paneId)!
    assert.equal(lease.status, 'failed')
    assert.equal(lease.reason, 'source-hub-changed')
    assert.equal(source.refs.length, 0)
    assert.deepEqual(focusedResource(controller), saved, 'display id, Hub identity, document and target are untouched')
    controller.dispose()
})

test('an archived display conversation is classified as archived so the user can restore it', async () => {
    const source = fixture()
    source.memory.set('workspace-test', savedChat({ kind: 'chat', sessionId: 'archived-display' }))
    const controller = new WorkspaceController({ ...source.options, catalogSettleMs: 5,
        workspaceState: { getSnapshot: () => ({ archivedSessionIds: ['archived-display'], pinnedSessionIds: [] as string[] }), subscribe: () => () => {} },
    })
    controller.setSourceCatalog([], 'hub')
    const paneId = panes(controller.store.getSnapshot().windows[0]!.root)[0]!.id
    await wait(40)
    const failed = controller.getSnapshot().leases.get(paneId)!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.reason, 'session-archived')
    assert.match(failed.nextStep!, /unarchive/i)
    controller.dispose()
})

test('an offline source Hub leaves source panes in a waiting state rather than a failure', async () => {
    const source = fixture()
    source.memory.set('workspace-test', savedChat({ kind: 'chat', sessionId: `hapi-observed-${HASH_A}`, sourceSessionId: 'orig-source', sourceHubId: 'hub' }))
    const controller = new WorkspaceController({ ...source.options, catalogSettleMs: 5 })
    controller.setSourceCatalog([], 'hub', { hosts: [], connected: false })
    const paneId = panes(controller.store.getSnapshot().windows[0]!.root)[0]!.id
    const lease = controller.getSnapshot().leases.get(paneId)!
    assert.equal(lease.status, 'opening')
    assert.equal(lease.reason, 'source-offline')
    assert.match(lease.nextStep!, /reopens by itself/i)
    controller.dispose()
})

test('saved identity binding is idempotent, generation aware and never guesses between candidates', () => {
    const row = (id: string, source?: { sessionId: string; hubId?: string }): Parameters<typeof sourceRow>[1][string] => ({
        id: id as SessionId, hostId: 'local', hostLabel: 'DSH', hostOnline: true, sourceSessionId: source?.sessionId ?? id,
        archived: false, pinned: false, displayTitle: id, running: false, blank: false, updatedAt: 1, retainedBy: {},
        ...(source ? { projectionValues: { hapiObserved: { ownership: 'hapi-runner', hubId: source.hubId, hapiSessionId: source.sessionId } } as never } : {}),
    })
    const base = `hapi-observed-${HASH_A}`
    const rows = { [`${base}-r2`]: row(`${base}-r2`, { sessionId: 'orig', hubId: 'hub' }) }
    const state = savedLayout({ kind: 'chat', sessionId: `${base}-r1` })
    const bound = bindSourceResources(state, rows)
    assert.deepEqual(panes(bound.windows[0]!.root)[0]!.resource, { kind: 'chat', sessionId: `${base}-r2`, sourceSessionId: 'orig', sourceHubId: 'hub' })
    assert.equal(bindSourceResources(bound, rows), bound, 'a resolved layout is stable')
    assert.equal(displayGenerationRow(`${base}-r1`, rows)?.id, `${base}-r2`)
    assert.equal(displayGenerationRow(`${base}-r3`, rows), undefined, 'older revisions never win')
    const ambiguous = { [`${base}-r2`]: rows[`${base}-r2`]!, [`${base}-r3`]: row(`${base}-r3`) }
    assert.equal(displayGenerationRow(`${base}-r1`, ambiguous), undefined, 'two candidates are never guessed')
    // A saved Hub is an exact boundary: no unique-match fallback exists.
    assert.equal(sourceRow({ kind: 'chat', sessionId: 'old', sourceSessionId: 'orig', sourceHubId: 'old-hub' },
        { [`${base}-r2`]: row(`${base}-r2`, { sessionId: 'orig', hubId: 'new-hub' }) }), undefined)
    const crossHub = savedLayout({ kind: 'chat', sessionId: `${base}-r1`, sourceSessionId: 'orig', sourceHubId: 'old-hub' })
    assert.equal(bindSourceResources(crossHub, { [`${base}-r2`]: row(`${base}-r2`, { sessionId: 'orig', hubId: 'new-hub' }) }), crossHub,
        'a restore never re-binds across Hub identities')
    const sameHub = savedLayout({ kind: 'chat', sessionId: `${base}-r1`, sourceSessionId: 'orig', sourceHubId: 'hub' })
    assert.equal(sourceRow(panes(crossHub.windows[0]!.root)[0]!.resource as never,
        { [`${base}-r2`]: row(`${base}-r2`, { sessionId: 'orig', hubId: 'hub' }) }), undefined,
        'the candidate must also match the saved Hub exactly')
    assert.equal(panes(bindSourceResources(sameHub, { [`${base}-r2`]: row(`${base}-r2`, { sessionId: 'orig', hubId: 'hub' }) }).windows[0]!.root)[0]!.resource.kind, 'chat')
})
