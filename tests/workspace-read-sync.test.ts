/** Real sidebar/outbox with the actual application SQLite service; no Hub API or source history. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceCatalogRow, WorkspaceController } from '../src/client/controller.ts'
import { SidebarState } from '../src/workspace/sidebar-state.ts'
import { SourceReadSync, type AppReadApi, type SourceReadStatus, type SourceReadSyncOptions } from '../src/workspace/read-sync.ts'
import { ReadStateService } from '../src/workspace/read-state-service.ts'
import { sourceSessionId } from '../src/remote/protocol.ts'
import { sourceRoute } from '../src/shared/source-capability.ts'
import type { AppServiceContext, AppServiceRequest, AppSourceRoute } from '../src/workspace/app-service-types.ts'
const scope = { accountId: 'account', origin: 'https://workspace.example' }
const identity = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'original' }
const route: AppSourceRoute = { kind: 'hhpi', hostId: 'local', sessionId: sourceSessionId(identity), identity }
const position = (seq: number, epoch = 'epoch') => ({ kind: 'hhpi' as const, epoch, seq })
const ok = <T>(value: T) => ({ ok: true as const, value })
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)) }
function fixture(memory = new Map<string, string>(), displayId = 'display') {
    const listeners = new Set<() => void>(), errors: unknown[] = []
    const stored: string[] = []
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { stored.push(key); memory.set(key, value) } }
    const sidebar = new SidebarState(storage, 'sidebar')
    const row = { id: displayId, hostId: 'local', updatedAt: 40 }
    const snapshot = { catalog: { byId: { [displayId]: row } } }
    const controller = { sidebar, options: { storageKey: 'workspace', storage }, getSnapshot: () => snapshot,
        store: { focusedPane: () => ({ resource: { kind: 'chat', sessionId: displayId } }) },
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, report: (error: unknown) => { errors.push(error) },
    } as unknown as WorkspaceController
    const options: SourceReadSyncOptions = { scope, deviceId: 'device', routeForRow: () => route, headForRow: async () => ({ position: position(40), at: 40 }) }
    return { controller, sidebar, errors, memory, options, stored, listeners, row }
}

test('metadata-only updates use the original readable position without fabricating a seen timestamp', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), context = { scope, authorizeSource() {} }
    const row = view.row
    row.updatedAt = 9000
    await service.appReadStateWrite(context, { source: route, deviceId: 'old-client', operationId: 'original-body-read', expectedRevision: 0,
        intent: { kind: 'seen', position: position(449), at: 4490 } })
    let queries = 0, head = { position: position(449), at: 4490 }
    const sync = new SourceReadSync(view.controller, apiFor(service), { ...view.options,
        headForRow: async () => { queries++; return head } })
    try {
        await sync.refresh(); await flush()
        assert.equal(view.sidebar.isUnread('display', row.updatedAt), false, 'a model/settings timestamp is not a new conversation message')
        assert.equal(view.sidebar.getSnapshot().seen.display, 4490)
        assert.equal((await service.appReadState(context, { source: route }))?.revision, 1, 'derived display state does not submit a synthetic read')
        await sync.refresh(); await flush(); assert.equal(queries, 1, 'the same source metadata version reuses its readable head')
        row.updatedAt = 10000; head = { position: position(450), at: 4500 }
        await sync.refresh(); await flush()
        assert.equal(view.sidebar.isUnread('display', row.updatedAt), true, 'genuine new original content remains unread')
        assert.equal(queries, 2)
        sync.commitReading('display', route, position(450), 4500); await flush()
        assert.equal(view.sidebar.isUnread('display', row.updatedAt), false)
        assert.equal(view.sidebar.getSnapshot().seen.display, 4500)
        view.sidebar.markUnread('display', 10000); await flush()
        await sync.refresh()
        assert.equal(view.sidebar.isUnread('display', row.updatedAt), true, 'explicit unread dominates a matching content head')
        view.sidebar.requestMarkSeen('display'); await flush()
        assert.equal(view.sidebar.isUnread('display', row.updatedAt), false)
        assert.equal(queries, 2, 'explicit read reuses the unchanged original content head')
    } finally { sync.dispose(); service.close() }
})

test('a late readable-head result cannot clear a newer unread intent or label a changed source row', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), context = { scope, authorizeSource() {} }
    const row = view.row
    row.updatedAt = 9000
    await service.appReadStateWrite(context, { source: route, deviceId: 'old-client', operationId: 'original', expectedRevision: 0,
        intent: { kind: 'seen', position: position(449), at: 4490 } })
    const entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<{ position: ReturnType<typeof position>; at: number } | null>()
    const sync = new SourceReadSync(view.controller, apiFor(service), { ...view.options,
        headForRow: () => { entered.resolve(); return reply.promise } })
    try {
        const refreshing = sync.refresh(); await entered.promise
        view.sidebar.markUnread('display', 9001)
        row.updatedAt = 10000
        reply.resolve({ position: position(449), at: 4490 }); await refreshing; await flush()
        assert.equal(view.sidebar.isUnread('display', 10000), true)
        assert.notEqual((await service.appReadState(context, { source: route }))?.manualUnreadAt, null)
        assert.equal(view.sidebar.getSnapshot().seen.display, 4490)
    } finally { reply.resolve(null); sync.dispose(); service.close() }
})

test('necessary head reconciliation is capped at four sources and two concurrent requests per refresh', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), context = { scope, authorizeSource() {} }
    const routes = Array.from({ length: 1221 }, (_, index): AppSourceRoute => ({ kind: 'federated-dsh', hostId: 'runner', sessionId: `native-${index}` }))
    const rows = Object.fromEntries(routes.map(source => [source.sessionId, { id: source.sessionId, hostId: source.hostId, updatedAt: 9000 }]))
    view.controller.getSnapshot = (() => ({ catalog: { byId: rows } })) as unknown as WorkspaceController['getSnapshot']
    for (const [index, source] of routes.entries()) await service.appReadStateWrite(context, { source, deviceId: 'other', operationId: `original-${index}`, expectedRevision: 0,
        intent: { kind: 'seen', position: { kind: 'dsh', seq: 8 }, at: 80 } })
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), queried: string[] = []
    let active = 0, peak = 0
    const sync = new SourceReadSync(view.controller, apiFor(service), { ...view.options,
        routeForRow: row => routes.find(source => source.sessionId === row.id)!, headForRow: async row => {
            queried.push(row.id); active++; peak = Math.max(peak, active); if (active === 2) entered.resolve()
            try { await gate.promise; return { position: { kind: 'dsh', seq: 8 }, at: 80 } } finally { active-- }
        } })
    try {
        const refreshing = sync.refresh(); await entered.promise
        assert.equal(queried.length, 2); assert.equal(peak, 2)
        const reentered = sync.refresh(); await flush()
        assert.equal(queried.length, 2, 'a reentrant refresh shares the same bounded head batch')
        gate.resolve(); await Promise.all([refreshing, reentered]); await flush()
        assert.equal(queried.length, 4); assert.equal(peak, 2)
        await sync.refresh(); await flush()
        assert.equal(queried.length, 8); assert.equal(new Set(queried).size, 8, 'unchanged resolved heads are not read again')
    } finally { gate.resolve(); sync.dispose(); service.close() }
})

test('a persistently failing head prefix cannot starve healthy sources in later refreshes', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), context = { scope, authorizeSource() {} }
    const routes = Array.from({ length: 8 }, (_, index): AppSourceRoute => ({ kind: 'federated-dsh', hostId: 'runner', sessionId: `native-${index}` }))
    const rows = Object.fromEntries(routes.map(source => [source.sessionId, { id: source.sessionId, hostId: source.hostId, updatedAt: 9000 }]))
    view.controller.getSnapshot = (() => ({ catalog: { byId: rows } })) as unknown as WorkspaceController['getSnapshot']
    for (const [index, source] of routes.entries()) await service.appReadStateWrite(context, { source, deviceId: 'other', operationId: `original-${index}`, expectedRevision: 0,
        intent: { kind: 'seen', position: { kind: 'dsh', seq: 8 }, at: 80 } })
    const denied = new Set(routes.slice(0, 4).map(source => source.sessionId)), queried: string[] = []
    const sync = new SourceReadSync(view.controller, apiFor(service), { ...view.options,
        routeForRow: row => routes.find(source => source.sessionId === row.id)!, headForRow: async row => {
            queried.push(row.id)
            if (denied.has(row.id)) throw new Error('The original source grant is unavailable')
            return { position: { kind: 'dsh', seq: 8 }, at: 80 }
        } })
    try {
        await sync.refresh(); await flush()
        assert.deepEqual(queried, routes.slice(0, 4).map(source => source.sessionId))
        assert.equal(routes.every(source => view.sidebar.isUnread(source.sessionId, 9000)), true, 'unknown source heads never clear the badge')
        await sync.refresh(); await flush()
        assert.deepEqual(queried.slice(4), routes.slice(4).map(source => source.sessionId))
        assert.equal(routes.slice(4).every(source => !view.sidebar.isUnread(source.sessionId, 9000)), true, 'healthy sources make progress after the denied prefix')
        assert.equal(routes.slice(0, 4).every(source => view.sidebar.isUnread(source.sessionId, 9000)), true)
        await sync.refresh(); await flush()
        assert.equal(queried.length, 12, 'failed sources remain eligible for a bounded recovery attempt')
        assert.equal((await service.appReadState(context, { source: routes[4]! }))?.revision, 1, 'head reconciliation never writes a fabricated seen')
    } finally { sync.dispose(); service.close() }
})

test('durable read outbox recovery completes before optional source-head reads settle', async () => {
    const memory = new Map<string, string>(), first = fixture(memory), service = new ReadStateService({ path: ':memory:' })
    const context = { scope, authorizeSource() {} }, api = apiFor(service)
    const offline = new SourceReadSync(first.controller, api, { ...first.options, isOnline: () => false })
    offline.commitReading('display', route, position(451), 4510); offline.dispose()
    await service.appReadStateWrite(context, { source: route, deviceId: 'other', operationId: 'old-original', expectedRevision: 0,
        intent: { kind: 'seen', position: position(449), at: 4490 } })
    const view = fixture(memory); view.row.updatedAt = 9000
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const sync = new SourceReadSync(view.controller, api, { ...view.options,
        headForRow: async () => { entered.resolve(); await gate.promise; throw new Error('Optional source head unavailable') } })
    const refreshing = sync.refresh()
    try {
        await entered.promise
        const state = await service.appReadState(context, { source: route })
        assert.deepEqual(state?.seen, { position: position(451), at: 4510 }, 'restored user intent does not wait for optional head timeouts')
        await refreshing
        assert.equal(view.sidebar.getSnapshot().readStatus.display, 'ready')
        const key = [...memory.keys()].find(key => key.includes('app-read-outbox'))!
        assert.deepEqual(JSON.parse(memory.get(key)!), [])
    } finally { gate.resolve(); await refreshing; await flush(); sync.dispose(); service.close() }
})

test('a stale seen CAS does not retry across another client manual-unread revision', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), context = { scope, authorizeSource() {} }, api = apiFor(service)
    const sync = new SourceReadSync(view.controller, api, view.options)
    try {
        await sync.refresh()
        await service.appReadStateWrite(context, { source: route, deviceId: 'other', operationId: 'newer-unread', expectedRevision: 0,
            intent: { kind: 'unread', at: 42 } })
        sync.commitReading('display', route, position(40), 40); await flush()
        const state = await service.appReadState(context, { source: route })
        assert.equal(state?.revision, 1); assert.equal(state?.manualUnreadAt, 42)
        assert.equal(view.sidebar.isUnread('display', 40), true)
    } finally { sync.dispose(); service.close() }
})
function apiFor(service: ReadStateService, context: AppServiceContext = { scope, authorizeSource() {} }): AppReadApi {
    return { appReadState: async value => ok(await service.appReadState(context, value)),
        appReadStates: async value => ok(await service.appReadStates(context, value)),
        appReadStateWrite: async value => ok(await service.appReadStateWrite(context, value)) }
}

function pairedFixture() {
    const view = fixture(), unavailable: AppSourceRoute = { kind: 'federated-dsh', hostId: 'offline-runner', sessionId: 'original-dsh' }
    const rows = { display: { id: 'display', hostId: 'local', updatedAt: 40 }, unavailable: { id: 'unavailable', hostId: unavailable.hostId, updatedAt: 40 } }
    view.controller.getSnapshot = (() => ({ catalog: { byId: rows } })) as unknown as WorkspaceController['getSnapshot']
    const options: SourceReadSyncOptions = { ...view.options, routeForRow: row => row.id === 'display' ? route : unavailable }
    return { ...view, options, unavailable }
}

test('a catalog refresh resolves each original route once and publishes each status batch once', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), api = apiFor(service)
    const routes = Array.from({ length: 500 }, (_, index) => sourceRoute('local', sourceSessionId({ ...identity, nativeId: `source-${index}` }), 'local'))
    const rows = Object.fromEntries(routes.map(source => [source.sessionId, { id: source.sessionId, hostId: source.hostId, sourceSessionId: source.sessionId, updatedAt: 1 }]))
    view.controller.getSnapshot = (() => ({ catalog: { byId: rows } })) as unknown as WorkspaceController['getSnapshot']
    let parsed = 0, notified = 0
    const stop = view.sidebar.subscribe(() => { notified++; for (const listener of [...view.listeners]) listener() })
    const sync = new SourceReadSync(view.controller, api, { ...view.options,
        routeForRow(row) { parsed++; return sourceRoute(row.hostId, row.sourceSessionId, 'local') },
    })
    try {
        await sync.refresh()
        assert.equal(parsed, 500, 'status acceptance and sidebar publication must not reparse every catalog row per source')
        assert.equal(notified, 4, 'three admitted status batches and one watermark adoption are four publications')
        assert.equal(view.stored.filter(key => key === 'sidebar').length, 4)
        await sync.refresh()
        assert.equal(parsed, 500)
        assert.equal(notified, 4, 'unchanged confirmed state does not republish')
        assert.equal(view.stored.filter(key => key === 'sidebar').length, 4, 'unchanged confirmed state does not persist')
        const source = routes[0]!
        sync.commitReading(source.sessionId, source, position(8), 8); await flush()
        assert.deepEqual((await service.appReadState({ scope, authorizeSource() {} }, { source }))?.seen, { position: position(8), at: 8 })
        assert.equal(view.sidebar.getSnapshot().seen[source.sessionId], 8)
        assert.equal(parsed, 500, 'a real visible-reader commit reuses only the exact current route')
    } finally { stop(); sync.dispose(); service.close() }
})

test('catalog replacement invalidates route indexes before an older account-scoped response can publish', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), api = apiFor(service)
    const replacement = sourceRoute('other-host', sourceSessionId({ ...identity, nativeId: 'replacement' }), 'local')
    let rows = { display: { id: 'display', hostId: route.hostId, sourceSessionId: route.sessionId, updatedAt: 1 } }
    view.controller.getSnapshot = (() => ({ catalog: { byId: rows } })) as unknown as WorkspaceController['getSnapshot']
    await service.appReadStateWrite({ scope, authorizeSource() {} }, { source: route, deviceId: 'other', operationId: 'read-original', expectedRevision: 0,
        intent: { kind: 'seen', position: position(7), at: 7 } })
    const reply = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let first = true, writes = 0
    const sync = new SourceReadSync(view.controller, { ...api, appReadStates: async request => {
        const value = await api.appReadStates(request)
        if (first) { first = false; entered.resolve(); await reply.promise }
        return value
    }, appReadStateWrite: async request => { writes++; return api.appReadStateWrite(request) } }, { ...view.options,
        routeForRow: row => sourceRoute(row.hostId, row.sourceSessionId, 'local'),
    })
    try {
        const refreshing = sync.refresh(); await entered.promise
        rows = { display: { ...rows.display, hostId: replacement.hostId, sourceSessionId: replacement.sessionId } }
        for (const listener of [...view.listeners]) listener()
        reply.resolve(); await refreshing
        assert.equal(view.sidebar.getSnapshot().seen.display, undefined, 'old source acknowledgement cannot populate a reused display row')
        assert.equal(view.sidebar.getSnapshot().readStatus.display, undefined)
        sync.commitReading('display', route, position(9), 9); await flush()
        assert.equal(writes, 0, 'an old route cannot submit through the new catalog row')
        await sync.refresh()
        sync.commitReading('display', replacement, position(2, 'replacement-epoch'), 10); await flush()
        assert.equal(writes, 1)
        assert.deepEqual((await service.appReadState({ scope, authorizeSource() {} }, { source: replacement }))?.seen,
            { position: position(2, 'replacement-epoch'), at: 10 })
    } finally { reply.resolve(); sync.dispose(); service.close() }
})

test('sidebar status batches publish only their changed final values', () => {
    const view = fixture()
    let notified = 0
    view.sidebar.subscribe(() => { notified++ })
    view.sidebar.setReadStatuses([{ id: 'display', value: 'ready' }, { id: 'alias', value: 'ready' }])
    assert.equal(notified, 1); assert.equal(view.stored.length, 1)
    view.sidebar.setReadStatuses([{ id: 'display', value: 'pending' }, { id: 'display', value: 'ready' }, { id: 'alias', value: 'ready' }])
    view.sidebar.setReadStatus('alias', 'ready')
    assert.equal(notified, 1); assert.equal(view.stored.length, 1)
    view.sidebar.setReadStatuses([{ id: 'display', value: 'pending' }, { id: 'alias', value: 'error' }])
    assert.equal(notified, 2); assert.equal(view.stored.length, 2)
})

test('one revoked or offline source cannot discard another source watermark in the same refresh batch', async () => {
    const view = pairedFixture(), service = new ReadStateService({ path: ':memory:' })
    await service.appReadStateWrite({ scope, authorizeSource() {} }, { source: route, deviceId: 'other-device', operationId: 'visible-read', expectedRevision: 0,
        intent: { kind: 'seen', position: position(40), at: 40 } })
    const api = apiFor(service, { scope, authorizeSource(source) { if (source.hostId === 'offline-runner') throw new Error('The original source grant is unavailable') } })
    const sync = new SourceReadSync(view.controller, api, view.options)
    try {
        await sync.refresh()
        assert.equal(view.sidebar.getSnapshot().seen.display, 40, 'an authorized source still adopts its server watermark')
        assert.equal(view.sidebar.getSnapshot().readStatus.display, 'ready')
        assert.equal(view.sidebar.getSnapshot().readStatus.unavailable, 'error')
        assert.equal(view.errors.length, 0, 'optional background source bookkeeping never owns the global workspace notice')
    } finally { sync.dispose(); service.close() }
})

test('a failed source outbox does not block a healthy source intent and keeps its original operation for recovery', async () => {
    const view = pairedFixture(), service = new ReadStateService({ path: ':memory:' })
    let denied = false
    const api = apiFor(service, { scope, authorizeSource(source) { if (denied && source.hostId === 'offline-runner') throw new Error('Source offline') } })
    const writes: AppServiceRequest<'appReadStateWrite'>[] = []
    const sync = new SourceReadSync(view.controller, { ...api, appReadStateWrite: async request => { writes.push(request); return api.appReadStateWrite(request) } }, view.options)
    try {
        await sync.refresh(); denied = true
        sync.commitReading('unavailable', view.unavailable, { kind: 'dsh', seq: 8 }, 8)
        sync.commitReading('display', route, position(41), 41); await flush()
        assert.equal((await service.appReadState({ scope, authorizeSource() {} }, { source: route }))?.seen?.position.seq, 41,
            'the healthy outbox continues after the first source rejects')
        const outboxKey = [...view.memory.keys()].find(key => key.includes('app-read-outbox'))!
        const pending = JSON.parse(view.memory.get(outboxKey)!) as AppServiceRequest<'appReadStateWrite'>[]
        assert.equal(pending.length, 1); assert.deepEqual(pending[0]?.source, view.unavailable)
        const originalOperation = pending[0]!.operationId
        denied = false; await sync.refresh(); await flush()
        assert.equal((await service.appReadState({ scope, authorizeSource() {} }, { source: view.unavailable }))?.seen?.position.seq, 8)
        assert.deepEqual(JSON.parse(view.memory.get(outboxKey)!), [])
        assert.equal(writes.filter(request => request.source.hostId === view.unavailable.hostId).every(request => request.operationId === originalOperation), true)
    } finally { sync.dispose(); service.close() }
})

test('individual recovery has at most four in-flight source reads', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), api = apiFor(service)
    const routes = Array.from({ length: 11 }, (_, index): AppSourceRoute => ({ kind: 'federated-dsh', hostId: 'runner', sessionId: `source-${index}` }))
    const rows = Object.fromEntries(routes.map(source => [source.sessionId, { id: source.sessionId, hostId: source.hostId, updatedAt: 1 }]))
    view.controller.getSnapshot = (() => ({ catalog: { byId: rows } })) as unknown as WorkspaceController['getSnapshot']
    const gate = Promise.withResolvers<void>(), firstFour = Promise.withResolvers<void>()
    let active = 0, peak = 0, reads = 0
    const sync = new SourceReadSync(view.controller, { ...api, appReadStates: async () => { throw new Error('One source in the batch is unavailable') },
        appReadState: async () => { reads++; active++; peak = Math.max(peak, active); if (reads === 4) firstFour.resolve()
            try { await gate.promise; return ok(null) } finally { active-- } },
    }, { ...view.options, routeForRow: row => routes.find(source => source.sessionId === row.id)! })
    try {
        const refreshing = sync.refresh(); await firstFour.promise
        assert.equal(reads, 4); assert.equal(peak, 4)
        gate.resolve(); await refreshing
        assert.equal(reads, 11); assert.equal(peak, 4)
        assert.equal(Object.values(view.sidebar.getSnapshot().readStatus).every(status => status === 'ready'), true)
    } finally { gate.resolve(); sync.dispose(); service.close() }
})

test('a cancelled or unauthenticated application invocation does not fall back to individual source reads', async () => {
    for (const error of [new RemoteError('gateway/cancelled', 'Connection closed', {}),
        new RemoteError('remote-access/denied', 'Application connection ended', { action: 'appServices/appReadStates', reason: 'no-allow' })]) {
        const view = fixture(), service = new ReadStateService({ path: ':memory:' }), api = apiFor(service)
        let individual = 0
        const sync = new SourceReadSync(view.controller, { ...api, appReadStates: async () => { throw error }, appReadState: async request => { individual++; return api.appReadState(request) } }, view.options)
        try { await sync.refresh(); assert.equal(individual, 0); assert.equal(view.sidebar.getSnapshot().readStatus.display, 'error') }
        finally { sync.dispose(); service.close() }
    }
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), api = apiFor(service), batch = Promise.withResolvers<Awaited<ReturnType<AppReadApi['appReadStates']>>>()
    let individual = 0
    const sync = new SourceReadSync(view.controller, { ...api, appReadStates: () => batch.promise, appReadState: async request => { individual++; return api.appReadState(request) } }, view.options)
    try {
        const refreshing = sync.refresh(); await flush(); sync.dispose(); batch.reject(new Error('Old account response'))
        await refreshing; assert.equal(individual, 0); assert.equal(view.errors.length, 0)
    } finally { sync.dispose(); service.close() }
})

test('catalog refresh and legacy focus marks cannot publish read evidence; manual mark queries exact source head', async () => {
    const service = new ReadStateService({ path: ':memory:' }), view = fixture(), api = apiFor(service)
    let queries = 0
    const sync = new SourceReadSync(view.controller, api, { ...view.options, headForRow: async () => { queries++; return { position: position(40), at: 40 } } })
    try {
        await sync.refresh(); view.sidebar.markSeen('display', 999); await flush()
        assert.equal(await service.appReadState({ scope, authorizeSource() {} }, { source: route }), null)
        view.sidebar.requestMarkSeen('display'); await flush()
        const state = await service.appReadState({ scope, authorizeSource() {} }, { source: route })
        assert.equal(queries, 1); assert.deepEqual(state?.seen, { position: position(40), at: 40 })
        assert.equal(view.sidebar.getSnapshot().seen.display, 40)
        view.sidebar.requestMarkSeen('display'); await flush()
        assert.equal(view.sidebar.getSnapshot().readStatus.display, 'ready', 'an already confirmed exact head is ready without another write')
        assert.equal((await service.appReadState({ scope, authorizeSource() {} }, { source: route }))?.revision, state?.revision)
    } finally { sync.dispose(); service.close() }
})

test('manual mark read stays unavailable when no original head exists and never reports local success', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' })
    const sync = new SourceReadSync(view.controller, apiFor(service), { ...view.options, headForRow: async () => null })
    try {
        await sync.refresh(); view.sidebar.markUnread('display', 40); await flush()
        view.sidebar.requestMarkSeen('display'); await flush()
        assert.equal(view.sidebar.getSnapshot().readStatus.display, 'unavailable')
        assert.equal(view.sidebar.canMarkSeen('display'), false)
        assert.notEqual(view.sidebar.getSnapshot().unread.display, undefined)
    } finally { sync.dispose(); service.close() }
})

test('a newer unread intent survives an older in-flight visible-reader acknowledgement', async () => {
    const service = new ReadStateService({ path: ':memory:' }), view = fixture(), api = apiFor(service), writes: AppServiceRequest<'appReadStateWrite'>[] = []
    let reply!: () => void
    const sync = new SourceReadSync(view.controller, { ...api, appReadStateWrite: async request => {
        writes.push(request); const result = await api.appReadStateWrite(request)
        if (writes.length === 1) return new Promise(resolve => { reply = () => resolve(result) })
        return result
    } }, view.options)
    try {
        await sync.refresh(); sync.commitReading('display', route, position(40), 40); await flush()
        view.sidebar.markUnread('display', 41); reply(); await flush()
        assert.equal(writes.length, 2); assert.equal(writes[1]?.intent.kind, 'unread')
        assert.equal(writes[1]?.expectedRevision, 1); assert.notEqual(view.sidebar.getSnapshot().unread.display, undefined)
    } finally { sync.dispose(); service.close() }
})

test('offline recovery follows full original route through display replacement and does not cross account scope', async () => {
    const previous = fixture(), service = new ReadStateService({ path: ':memory:' }), api = apiFor(service)
    const offline = new SourceReadSync(previous.controller, { ...api, appReadStates: async () => { throw new Error('offline') }, appReadState: async () => { throw new Error('offline') } }, previous.options)
    previous.sidebar.markUnread('display', 40); await offline.refresh(); offline.dispose()
    const current = fixture(previous.memory, 'replacement'), sync = new SourceReadSync(current.controller, api, current.options)
    try {
        await sync.refresh(); await flush()
        assert.notEqual(current.sidebar.getSnapshot().unread.replacement, undefined)
        const keys = [...current.memory.keys()].filter(key => key.includes('app-read-outbox'))
        assert.equal(keys.length, 1); assert.deepEqual(JSON.parse(current.memory.get(keys[0]!)!), [])
        assert.equal((await service.appReadState({ scope: { ...scope, accountId: 'other' }, authorizeSource() {} }, { source: route })), null)
    } finally { sync.dispose(); service.close() }
})

test('an old generation conflict cannot overwrite a newer source generation or regress its watermark', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), api = apiFor(service)
    const sync = new SourceReadSync(view.controller, api, view.options)
    try {
        await sync.refresh()
        await service.appReadStateWrite({ scope, authorizeSource() {} }, { source: route, deviceId: 'other', operationId: 'new-source', expectedRevision: 0,
            intent: { kind: 'seen', position: position(2, 'new-epoch'), at: 50 } })
        sync.commitReading('display', route, position(99), 99); await flush()
        assert.deepEqual((await service.appReadState({ scope, authorizeSource() {} }, { source: route }))?.seen, { position: position(2, 'new-epoch'), at: 50 })
        assert.equal(view.sidebar.getSnapshot().seen.display, 50)
    } finally { sync.dispose(); service.close() }
})

test('badge readiness distinguishes refresh failure from confirmed empty application state', async () => {
    const view = fixture(), states: SourceReadStatus[] = [], service = new ReadStateService({ path: ':memory:' }), api = apiFor(service)
    let offline = false
    const sync = new SourceReadSync(view.controller, { ...api, appReadStates: async value => { if (offline) throw new Error('offline'); return api.appReadStates(value) },
        appReadState: async value => { if (offline) throw new Error('offline'); return api.appReadState(value) } }, view.options, state => { states.push(state) })
    try {
        await sync.refresh(); offline = true; await sync.refresh(); offline = false; await sync.refresh()
        assert.deepEqual(states, ['pending', 'ready', 'pending', 'error', 'pending', 'ready'])
    } finally { sync.dispose(); service.close() }
})

test('a common app transport failure makes one request, retains the local read, and replays an unknown acknowledgement once', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), api = apiFor(service)
    let offline = false, lostAck = true, individual = 0
    const writes: AppServiceRequest<'appReadStateWrite'>[] = []
    const transport = () => new RemoteError('gateway/internal', 'client api: appServices/appReadStates failed: Failed to fetch', {})
    const sync = new SourceReadSync(view.controller, { ...api,
        appReadStates: async request => { if (offline) return { ok: false, error: transport() }; return api.appReadStates(request) },
        appReadState: async request => { individual++; return api.appReadState(request) },
        appReadStateWrite: async request => {
            writes.push(request); const result = await api.appReadStateWrite(request)
            if (lostAck) { lostAck = false; throw new RemoteError('gateway/internal', 'client api: appServices/appReadStateWrite failed: Failed to fetch', {}) }
            return result
        },
    }, view.options)
    try {
        await sync.refresh(); sync.commitReading('display', route, position(8), 8); await flush()
        assert.equal(view.sidebar.getSnapshot().seen.display, 8, 'actual reader evidence remains visible locally during an unknown acknowledgement')
        const outboxKey = [...view.memory.keys()].find(key => key.includes('app-read-outbox'))!
        const original = JSON.parse(view.memory.get(outboxKey)!)[0]
        offline = true; await sync.refresh()
        assert.equal(individual, 0, 'a disconnected app carrier cannot be repaired by fanning out every source')
        assert.equal(view.errors.length, 0, 'no raw appServices error is promoted into the global chat notice')
        assert.equal(JSON.parse(view.memory.get(outboxKey)!)[0].operationId, original.operationId)
        offline = false; await sync.refresh()
        assert.deepEqual(JSON.parse(view.memory.get(outboxKey)!), [])
        assert.equal(writes.length, 2); assert.equal(writes[0]!.operationId, writes[1]!.operationId)
        assert.equal((await service.appReadState({ scope, authorizeSource() {} }, { source: route }))?.revision, 1,
            'unknown acknowledgement recovery must not apply the same read twice')
    } finally { sync.dispose(); service.close() }
})

test('retries back off to one minute, pause offline, and reconcile on reconnect without rewriting repeated reader commits', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), api = apiFor(service)
    let offline = false, fail = true, reads = 0, writes = 0
    const sync = new SourceReadSync(view.controller, { ...api,
        appReadStates: async request => { reads++; if (fail) throw new TypeError('Failed to fetch'); return api.appReadStates(request) },
        appReadStateWrite: async request => { writes++; return api.appReadStateWrite(request) },
    }, { ...view.options, isOnline: () => !offline })
    try {
        sync.start(); await flush(); assert.equal(reads, 1)
        for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
            const before: number = reads
            t.mock.timers.tick(delay - 1); await flush(); assert.equal(reads, before)
            t.mock.timers.tick(1); await flush(); assert.equal(reads, before + 1)
        }
        offline = true; t.mock.timers.tick(60000); await flush()
        const stopped = reads
        sync.commitReading('display', route, position(12), 12)
        const persisted = view.stored.length
        sync.commitReading('display', route, position(12), 12)
        assert.equal(view.stored.length, persisted, 'the same pending reader commit keeps its operation and does no extra storage write')
        assert.equal(view.sidebar.getSnapshot().seen.display, 12)
        t.mock.timers.tick(120000); await flush(); assert.equal(reads, stopped); assert.equal(writes, 0)
        fail = false; offline = false; sync.reconnect(); await flush()
        assert.equal(reads, stopped + 1); assert.equal(writes, 1)
        assert.equal(view.sidebar.getSnapshot().readStatus.display, 'ready')
        t.mock.timers.tick(15000); await flush(); assert.equal(writes, 1, 'successful reconciliation returns to polling without another write')
        sync.dispose(); t.mock.timers.tick(60000); await flush(); assert.equal(reads, stopped + 2)
        assert.equal(view.errors.length, 0)
    } finally { sync.dispose(); service.close() }
})

test('a reconnect received during an old failing refresh is not lost behind that in-flight request', async () => {
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), api = apiFor(service)
    const old = Promise.withResolvers<Awaited<ReturnType<AppReadApi['appReadStates']>>>()
    let reads = 0
    const sync = new SourceReadSync(view.controller, { ...api,
        appReadStates: request => ++reads === 1 ? old.promise : api.appReadStates(request),
    }, view.options)
    try {
        sync.start(); await flush(); sync.commitReading('display', route, position(10), 10); sync.reconnect(); await flush()
        assert.equal(reads, 2)
        assert.equal(view.sidebar.getSnapshot().seen.display, 10)
        assert.equal(view.sidebar.getSnapshot().readStatus.display, 'ready')
        assert.equal((await service.appReadState({ scope, authorizeSource() {} }, { source: route }))?.revision, 1)
        assert.equal(view.errors.length, 0)
        old.reject(new TypeError('Failed to fetch')); await flush()
        assert.equal(view.sidebar.getSnapshot().readStatus.display, 'ready', 'the superseded carrier may fail late without undoing recovery')
    } finally { old.resolve(ok([])); sync.dispose(); service.close() }
})

test('a half-open read has a thirty-second budget and retries without waiting for its late carrier result', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const view = fixture(), service = new ReadStateService({ path: ':memory:' }), api = apiFor(service)
    const stuck = Promise.withResolvers<Awaited<ReturnType<AppReadApi['appReadStates']>>>()
    let reads = 0, oldSignal: AbortSignal | undefined
    const sync = new SourceReadSync(view.controller, { ...api, appReadStates: (request, signal) => {
        if (++reads === 1) { oldSignal = signal; return stuck.promise }
        return api.appReadStates(request)
    } }, view.options)
    try {
        sync.start(); await flush(); sync.commitReading('display', route, position(11), 11)
        t.mock.timers.tick(29999); await flush(); assert.equal(reads, 1); assert.equal(oldSignal?.aborted, false)
        t.mock.timers.tick(1); await flush(); assert.equal(oldSignal?.aborted, true)
        t.mock.timers.tick(1000); await flush(); assert.equal(reads, 2)
        assert.equal((await service.appReadState({ scope, authorizeSource() {} }, { source: route }))?.seen?.position.seq, 11)
        stuck.resolve(ok([null])); await flush()
        assert.equal(view.sidebar.getSnapshot().seen.display, 11); assert.equal(view.errors.length, 0)
    } finally { stuck.resolve(ok([null])); sync.dispose(); service.close() }
})
