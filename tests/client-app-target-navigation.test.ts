/** Production notification navigation; Host lookup/reading resolver are explicit boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppTargetNavigation } from '../src/client/app-target-navigation.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'
import type { AppNotificationTarget } from '../src/workspace/app-service-types.ts'
import type { WorkspaceHost } from '../src/client/controller.ts'
import type { PaneReadingTarget } from '../src/client/reading-intent.ts'
import type { SourceNavigationApi } from '../src/workspace/source-navigation-api.ts'
import { WorkspaceStore, panes, type PaneNode, type WorkspaceState } from '../src/client/model.ts'
import { sessionResourceId } from '../src/client/controller.ts'
const identity = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread' }
const target: AppNotificationTarget = { kind: 'request', source: { kind: 'hhpi', hostId: 'remote-machine', sessionId: sourceSessionId(identity), identity },
    position: { kind: 'native', turnId: 'original-turn', itemId: 'original-item' }, requestId: 'original-request' }
function fixture(locate: SourceNavigationApi['locatePosition']) {
    const opened: Array<{ id: string; reading: PaneReadingTarget | undefined }> = []
    let host = { id: 'remote-machine', locateSourcePosition: locate } as WorkspaceHost
    let layout = {} as WorkspaceState
    let resource: PaneNode['resource'] = { kind: 'empty' }, veto = false
    const open = createAppTargetNavigation({ host: id => id === host.id ? host : undefined,
        openSession(id, _beside, reading) { opened.push({ id, reading }); if (!veto) resource = { kind: 'chat', sessionId: id } },
        store: { getSnapshot: () => layout, focusedPane: () => ({ id: 'pane', resource } as PaneNode), focus() {} } })
    return { open, opened, replaceHost() { host = { ...host } }, veto() { veto = true }, manualNavigate() { layout = {} as WorkspaceState } }
}
test('settled request returns to the original item and epoch; a pending request opens only its own card', async () => {
    const calls: unknown[] = [], env = fixture(async request => { calls.push(request); return { ok: true, value: { epoch: 'original-epoch', seq: 42 } } })
    await env.open(target, 'pending', new AbortController().signal)
    assert.equal(calls.length, 0); assert.deepEqual(env.opened[0]?.reading, { kind: 'approval', requestId: 'original-request' })
    await env.open(target, 'settled', new AbortController().signal)
    assert.deepEqual(calls, [{ sessionId: target.source.sessionId, position: { turnId: 'original-turn', itemId: 'original-item' } }])
    assert.deepEqual(env.opened[1]?.reading, { kind: 'message', messageId: '42', origin: 'notification', epoch: 'original-epoch' })
    assert.notEqual(env.opened[1]?.id, target.source.sessionId, 'remote machine remains part of the workspace resource')
})
test('late position lookup cannot replace newer navigation or a reconnected source', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<SourceNavigationApi['locatePosition']>>>(), env = fixture(() => pending.promise)
    const old = env.open(target, 'settled', new AbortController().signal)
    const failed = assert.rejects(old, /newer navigation/)
    await env.open(target, 'pending', new AbortController().signal)
    pending.resolve({ ok: true, value: { epoch: 'epoch', seq: 3 } }); await failed
    assert.equal(env.opened.length, 1)
    const next = Promise.withResolvers<Awaited<ReturnType<SourceNavigationApi['locatePosition']>>>(), changed = fixture(() => next.promise)
    const unresolved = changed.open(target, 'settled', new AbortController().signal), rejected = assert.rejects(unresolved, /connection changed/)
    changed.replaceHost(); next.resolve({ ok: true, value: { epoch: 'epoch', seq: 3 } }); await rejected
    assert.equal(changed.opened.length, 0)
    const delayed = Promise.withResolvers<Awaited<ReturnType<SourceNavigationApi['locatePosition']>>>(), manual = fixture(() => delayed.promise)
    const navigation = manual.open(target, 'settled', new AbortController().signal), superseded = assert.rejects(navigation, /newer navigation/)
    manual.manualNavigate(); delayed.resolve({ ok: true, value: { epoch: 'epoch', seq: 3 } }); await superseded
    assert.equal(manual.opened.length, 0)
})
test('unavailable target, logout cancellation and a dirty-document veto never report navigation success', async () => {
    const unavailable = fixture(async () => { throw new Error('Original item was removed') })
    await assert.rejects(unavailable.open(target, 'settled', new AbortController().signal), /removed/)
    assert.equal(unavailable.opened.length, 0)
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(unavailable.open(target, 'pending', cancelled.signal)); assert.equal(unavailable.opened.length, 0)
    unavailable.veto(); await assert.rejects(unavailable.open(target, 'pending', new AbortController().signal), /open document/)
})
test('native DSH approval notification uses its call position rather than pretending the audit ID is a browser card key', async () => {
    const env = fixture(async () => { throw new Error('Native DSH already has an original sequence') })
    await env.open({ kind: 'request', source: { kind: 'federated-dsh', hostId: 'remote-machine', sessionId: 'native-dsh-session' },
        requestId: 'audit-id', position: { kind: 'dsh', seq: 12 } }, 'pending', new AbortController().signal)
    assert.deepEqual(env.opened[0]?.reading, { kind: 'message', messageId: '12', origin: 'notification' })
})

function paneFixture(locate: SourceNavigationApi['locatePosition']) {
    const resourceId = sessionResourceId(target.source.hostId, target.source.sessionId)
    const store = new WorkspaceStore({ schemaVersion: 1, revision: 0, activeWindowId: 'window', focused: { window: 'origin' }, zoomed: {},
        windows: [{ id: 'window', name: 'Fixture', root: { type: 'split', id: 'split', axis: 'horizontal', weights: [1, 1], children: [
            { type: 'pane', id: 'origin', resource: { kind: 'chat', sessionId: resourceId } },
            { type: 'pane', id: 'search', resource: { kind: 'view', sessionId: resourceId, viewId: 'search-view', target: { type: 'tab', kind: 'hhpi-native-navigation' } } },
        ] } }] })
    const opened: Array<{ paneId: string; reading?: PaneReadingTarget }> = [], host = { id: target.source.hostId, locateSourcePosition: locate } as WorkspaceHost
    const open = createAppTargetNavigation({ host: id => id === host.id ? host : undefined, store,
        openSession(id, _beside, reading) { opened.push({ paneId: store.focusedPane().id, ...(reading ? { reading } : {}) }); store.openSession(id) } })
    const destination = { hostId: target.source.hostId, paneId: 'origin', sessionId: target.source.sessionId }
    return { store, open, opened, destination, pane: (id: string) => store.getSnapshot().windows.flatMap(window => panes(window.root)).find(pane => pane.id === id)! }
}

test('source history lands in its captured conversation after focus changes and preserves the search secondary page for return', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<SourceNavigationApi['locatePosition']>>>(), f = paneFixture(() => pending.promise)
    const opening = f.open(target, 'settled', new AbortController().signal, f.destination)
    f.store.focus('search')
    pending.resolve({ ok: true, value: { epoch: 'exact-epoch', seq: 577 } }); await opening
    assert.deepEqual(f.opened, [{ paneId: 'origin', reading: { kind: 'message', messageId: '577', origin: 'notification', epoch: 'exact-epoch' } }])
    assert.equal(f.pane('search').resource.kind, 'view', 'the source query and its Return action keep their own view')
    await f.open({ kind: 'reading', source: target.source, position: { kind: 'hhpi', epoch: 'exact-epoch', seq: 73 } }, undefined, new AbortController().signal, f.destination)
    assert.equal(f.opened[1]?.paneId, 'origin'); assert.equal(f.pane('search').resource.kind, 'view')
})

for (const mutation of ['closed', 'other-source'] as const) test(`a late native locator cannot replace a sibling when its original conversation was ${mutation}`, async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<SourceNavigationApi['locatePosition']>>>(), f = paneFixture(() => pending.promise)
    const opening = f.open(target, 'settled', new AbortController().signal, f.destination), rejected = assert.rejects(opening, /original conversation pane changed/)
    if (mutation === 'closed') f.store.closePane('origin')
    else { f.store.focus('origin'); f.store.openSession('a-different-source-thread') }
    f.store.focus('search'); pending.resolve({ ok: true, value: { epoch: 'exact-epoch', seq: 577 } }); await rejected
    assert.deepEqual(f.opened, []); assert.equal(f.pane('search').resource.kind, 'view')
})
