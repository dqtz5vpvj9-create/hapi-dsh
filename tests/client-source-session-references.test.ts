/** Production catalog selection/serialization and official source readers; only transport/catalog boundaries are fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ISessions, SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SourceSession, SourcePage, SourceEntry } from '../src/remote/protocol.ts'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import type { AppSourceRoute } from '../src/workspace/app-service-types.ts'
import type { WorkspaceCatalog, WorkspaceCatalogRow, WorkspaceHost } from '../src/client/controller.ts'
import { SourceSessionReferences } from '../src/client/source-session-references.ts'
import { createSessionSourceExporter, OriginalSourceExporter, type ExportPage } from '../src/client/source-export-state.ts'
import { WorkspaceApplicationIdentity } from '../src/client/application-identity.ts'
import { sessionResourceId } from '../src/shared/session-resource-id.ts'
import { codexInputSources, installRemoteInputTriggers } from '../src/client/remote-input-triggers.ts'
import { Context } from '@deepseek-ai/cordis'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { WorkspaceController } from '../src/client/controller.ts'
import { SourceEventIndex } from '../src/remote/event-index.ts'

const inputId = 'hhpi:sender:codex:codex:input' as SessionId
const signal = new AbortController().signal
const source = (route: Extract<AppSourceRoute, { kind: 'hhpi' }>): SourceSession => ({ ...route.identity, id: route.sessionId,
    title: 'Authorized conversation', cwd: '/test', updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [],
    capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } })
const event = (seq: number, text = `body-${seq}`) => ({ type: 'event', event: { type: 'user/message', seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
    data: { id: MessageId(`message-${seq}`), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } } satisfies SourceEntry)
const page = (text?: string): ExportPage => ({ version: 'fixed-cut', entries: [event(1, text)], before: '1', after: '1', hasBefore: true, hasAfter: false })
function fixture() {
    const application = new WorkspaceApplicationIdentity()
    application.set({ accountId: 'test-account', origin: 'https://test.invalid' }, 'device')
    const hosts = new Map<string, Pick<WorkspaceHost, 'sourceExporter'>>()
    const machines: { id: string; label: string }[] = []
    const catalog: WorkspaceCatalog = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
    const senderLifetime = new AbortController()
    const refs = new SourceSessionReferences({ hostId: 'local', application, capture(id) {
        assert.equal(id, inputId, 'source capture belongs to the submitting input, not a foreign graph')
        return { scope: 'sender-scope', signal: senderLifetime.signal, assertCurrent() { senderLifetime.signal.throwIfAborted() } }
    }, workspace: { getSnapshot: () => ({ catalog, machines }), host: id => hosts.get(id) } })
    const add = (route: AppSourceRoute, title = 'Authorized conversation') => {
        const id = sessionResourceId(route.hostId, route.sessionId) as SessionId
        const row: WorkspaceCatalogRow = { id, sourceSessionId: route.sessionId, hostId: route.hostId, hostLabel: `Host ${route.hostId}`,
            hostOnline: true, archived: false, pinned: false, displayTitle: title, title, cwd: '/test', running: false, blank: false,
            retainedBy: {}, updatedAt: 1, ...(route.kind === 'hhpi' ? { projectionValues: { hhpiSource: source(route), hhpiDiscovery: 'advertised' } } : {}) }
        catalog.ids.push(id); catalog.byId[id] = row
        return row
    }
    return { refs, application, hosts, catalog, senderLifetime, machines, add }
}
const hhpi: AppSourceRoute = { kind: 'hhpi', hostId: 'other-host', sessionId: 'hhpi:other-machine:other-source:codex:native',
    identity: { machineId: 'other-machine', sourceId: 'other-source', engine: 'codex', nativeId: 'native' } }

test('unified candidates reference readable local DSH, federated DSH and cross-machine HHPI through their own Host readers', async () => {
    const f = fixture(), requests: Array<{ host: string; request: unknown }> = []
    const routes: AppSourceRoute[] = [{ kind: 'local-dsh', hostId: 'local', sessionId: 'ordinary' },
        { kind: 'federated-dsh', hostId: 'runner', sessionId: 'ordinary' }, hhpi]
    for (const route of routes) {
        f.add(route)
        const list = { list: { getSnapshot: () => ({ byId: { [route.sessionId]: { displayTitle: 'Authorized conversation' } } }) } } as unknown as Pick<ISessions, 'list'>
        const reader = route.kind === 'hhpi' ? { read: async (request: Parameters<HhpiRemoteApi['read']>[0]) => {
            requests.push({ host: route.hostId, request })
            const value: SourcePage = { session: source(route), epoch: 'original-epoch', version: 2, entries: [],
                before: 1, after: 1, hasBefore: true, hasAfter: false, context: [] }
            return { ok: true as const, value: { ...value, entries: [event(1)] } }
        } } : undefined
        const ordinary: Pick<SessionRemote, 'events'> = { events: async request => {
            requests.push({ host: route.hostId, request }); return { ok: true, value: { cursor: 9, records: [event(1)], hasMore: true } }
        } }
        f.hosts.set(route.hostId, { sourceExporter: createSessionSourceExporter(list, route.hostId, () => true, ordinary, reader) })
    }
    const candidates = f.refs.candidates(inputId, 'authorized', signal)
    assert.equal(candidates.length, 3); assert.equal(requests.length, 0, 'catalog discovery never fetches transcripts')
    for (const candidate of candidates) {
        const serialized = await f.refs.serialize(inputId, candidate.value, signal), snapshot = JSON.parse(serialized.split('\n').slice(1).join('\n'))
        assert.deepEqual(snapshot.source, JSON.parse(candidate.value)); assert.equal(snapshot.messages[0].text, 'body-1')
        assert.equal(snapshot.omittedEarlier, true); assert.equal(snapshot.throughSeq, 1)
    }
    assert.equal(requests.length, 3, 'each selected reference reads exactly one latest window, never a full export')
    assert.deepEqual(requests.find(row => row.host === hhpi.hostId)?.request, { sessionId: hhpi.sessionId, limit: 160 })
})

test('candidate descriptions use existing machine/Host labels while complete machine identity remains in the route', () => {
    const f = fixture(); f.add(hhpi)
    f.machines.push({ id: hhpi.identity.machineId, label: 'Workstation' })
    f.hosts.set(hhpi.hostId, { sourceExporter: new OriginalSourceExporter(async () => { throw new Error('Discovery cannot read') }) })
    const candidate = f.refs.candidates(inputId, '', signal)[0]!
    assert.equal(candidate.name, candidate.label, 'the official menu must not render a full-identity alias beside the title')
    assert.equal(candidate.name, 'Authorized conversation')
    assert.match(candidate.description, /Workstation/); assert.match(candidate.description, /\/test/)
    assert.doesNotMatch(candidate.description, /other-machine|other-source/)
    assert.deepEqual(JSON.parse(candidate.value), hhpi)
})

test('a real tool-dense source index finds the recent conversation text within bounded pages, but never sends an empty reference', async () => {
    for (const mode of ['tool-tail', 'all-tools', 'epoch-change'] as const) {
        const f = fixture(); f.add(hhpi)
        const metadata = source(hhpi), index = new SourceEventIndex(':memory:', metadata), replacement = new SourceEventIndex(':memory:', metadata)
        const calls: Parameters<HhpiRemoteApi['read']>[0][] = []
        try {
            index.edit(metadata, () => {
                if (mode !== 'all-tools') index.put('question', { type: 'user/message', time: 1, surfaceOp: 'append', data: event(1, 'The original question before hundreds of tools').event.data })
                for (let count = 0; count < (mode === 'all-tools' ? 700 : 400); count++) index.put(`tool-${count}`, {
                    type: 'tool/call', time: count + 2, data: { turn: 1, step: count + 1, callId: ToolCallId(`tool-${count}`), name: 'commandExecution', arguments: '{"command":"fixture"}' } })
            })
            const exporter = createSessionSourceExporter({} as Pick<ISessions, 'list'>, hhpi.hostId, () => true, undefined, { read: async request => {
                calls.push(request)
                return { ok: true, value: (mode === 'epoch-change' && calls.length > 1 ? replacement : index).read(request) }
            } })
            f.hosts.set(hhpi.hostId, { sourceExporter: exporter })
            if (mode === 'tool-tail') {
                const value = await f.refs.serialize(inputId, JSON.stringify(hhpi), signal), snapshot = JSON.parse(value.slice(value.indexOf('\n') + 1))
                assert.equal(calls.length, 3); assert.equal(snapshot.searchedPages, 3)
                assert.equal(snapshot.textOnly, true); assert.equal(snapshot.omittedLater, true)
                assert.equal(snapshot.messages[0].text, 'The original question before hundreds of tools')
                assert.equal(snapshot.messages.length, 1); assert.ok(snapshot.latestSourceSeq > snapshot.messages[0].seq)
                assert.doesNotMatch(value, /commandExecution/)
            } else {
                await assert.rejects(f.refs.serialize(inputId, JSON.stringify(hhpi), signal), mode === 'all-tools' ? /four-page reference limit.*draft has been kept/ : /source replaced this history cursor/i)
                assert.equal(calls.length, mode === 'all-tools' ? 4 : 2)
            }
        } finally { index.dispose(); replacement.dispose() }
    }
})

test('native reference codec inserts complete route identity and serializes actual authorized context before send', async () => {
    const f = fixture(); f.add(hhpi)
    f.hosts.set(hhpi.hostId, { sourceExporter: new OriginalSourceExporter(async () => ({ title: 'Original', assertCurrent() {}, release() {},
        feed: { initial: page('The actual referenced answer'), read: async () => { throw new Error('No history scan') } } })) })
    const sources = codexInputSources({} as HhpiRemoteApi, () => ({ codex: {} }) as SourceSession, () => true, () => undefined, f.refs)
    const at = sources.find(row => row.name === 'source-sessions')!, session = { sessionId: inputId }
    const rows = await at.candidates(session, { query: 'Authorized', position: 'inline', drilled: false, signal })
    const picked = at.onPick({ session, candidate: rows[0]!, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 11, draftRev: 1 } })
    assert.ok(picked && picked !== 'handled' && 'insert' in picked)
    assert.deepEqual(JSON.parse(picked.insert.ref), hhpi)
    const serialized = await at.codec!.serialize(picked.insert.ref, signal, session)
    assert.equal(typeof serialized, 'string'); assert.match(String(serialized), /The actual referenced answer/)
    assert.doesNotMatch(String(serialized), /https?:\/\//, 'a browser link is not a replacement for conversation content')
})

test('account changes, caller cancellation and source removal during a reference read discard late content', async () => {
    for (const cause of ['account', 'cancel', 'remove'] as const) {
        const f = fixture(); f.add(hhpi)
        const entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>(), abort = new AbortController()
        f.hosts.set(hhpi.hostId, { sourceExporter: new OriginalSourceExporter(async (_source, signal) => {
            entered.resolve(); await reply.promise
            return { title: 'Private', assertCurrent() { signal.throwIfAborted() }, release() {}, feed: { initial: page('must not escape'), read: async () => page() } }
        }) })
        const reading = f.refs.serialize(inputId, JSON.stringify(hhpi), abort.signal)
        await entered.promise
        if (cause === 'account') f.application.set({ accountId: 'other-account', origin: 'https://test.invalid' }, 'device')
        else if (cause === 'cancel') abort.abort()
        else f.hosts.delete(hhpi.hostId)
        reply.resolve(); await assert.rejects(reading)
    }
})

test('offline/unlisted targets and Host ACL refusal cannot be sent as stale references', async () => {
    const f = fixture(), row = f.add(hhpi)
    let calls = 0
    f.hosts.set(hhpi.hostId, { sourceExporter: new OriginalSourceExporter(async () => { calls++; throw new Error('Host ACL denied') }) })
    f.catalog.byId[row.id] = { ...row, hostOnline: false }
    assert.equal(f.refs.candidates(inputId, '', signal).length, 0)
    await assert.rejects(f.refs.serialize(inputId, JSON.stringify(hhpi), signal), /offline/)
    assert.equal(calls, 0)
    f.catalog.byId[row.id] = row
    await assert.rejects(f.refs.serialize(inputId, JSON.stringify(hhpi), signal), /Host ACL denied/)
    assert.equal(calls, 1)
    f.catalog.ids = []
    await assert.rejects(f.refs.serialize(inputId, JSON.stringify(hhpi), signal), /no longer authorized/)
})

test('context is bounded UTF-8 user/assistant text with an explicit partial cut; metadata discovery is capped', async () => {
    const f = fixture()
    for (let index = 0; index < 50; index++) f.add({ kind: 'federated-dsh', hostId: 'runner', sessionId: `native-${index}` })
    const initial: ExportPage = { ...page(), entries: [event(1, 'older'), event(2, '\\"😀中文'.repeat(15000)),
        { type: 'event', event: { type: 'tool/call', seq: 3, time: 3, data: { content: [{ type: 'text', text: 'secret process' }] } } }] }
    f.hosts.set('runner', { sourceExporter: new OriginalSourceExporter(async () => ({ title: 'Tail', assertCurrent() {}, release() {},
        feed: { initial, read: async () => { throw new Error('No background scan') } } })) })
    const rows = f.refs.candidates(inputId, '', signal)
    assert.equal(rows.length, 40)
    const text = await f.refs.serialize(inputId, rows[0]!.value, signal), snapshot = JSON.parse(text.slice(text.indexOf('\n') + 1))
    assert.ok(new TextEncoder().encode(text).length <= 32 * 1024)
    assert.equal(snapshot.truncated, true); assert.equal(snapshot.omittedEarlier, true); assert.equal(snapshot.cut, 'fixed-cut')
    assert.doesNotMatch(text, /secret process|\\ud[89ab][0-9a-f]{2}/i)
    assert.equal(snapshot.messages.length, 1); assert.equal(snapshot.messages[0].seq, 2)
})


test('primary input reference installer uses the explicit navigation Host without a graph transport service', async () => {
    const f = fixture(); f.add(hhpi)
    f.hosts.set(hhpi.hostId, { sourceExporter: new OriginalSourceExporter(async () => { throw new Error('Discovery must not read history') }) })
    const ctx = new Context(), registered: InputTriggerSource[] = []
    const ready = Promise.withResolvers<void>()
    ctx.reflect.provide('sessions', { binding: () => undefined } as unknown as Context['sessions'])
    ctx.reflect.provide('locale', { getSnapshot: () => ({ active: 'en' }) } as unknown as Context['locale'])
    ctx.reflect.provide('hhpiSessions', {
        captureWorkspaceAccess: (id: string) => { assert.equal(id, inputId); return { scope: 'sender-scope', signal, assertCurrent() {} } },
    } as unknown as Context['hhpiSessions'])
    ctx.reflect.provide('hapiWorkspaceUi', { application: f.application } as unknown as Context['hapiWorkspaceUi'])
    ctx.reflect.provide('inputTriggers', { registerSource(value: InputTriggerSource) {
        registered.push(value); if (value.name === 'source-sessions') ready.resolve(); return () => {}
    } } as unknown as Context['inputTriggers'])
    const workspace = { getSnapshot: () => ({ catalog: f.catalog, machines: f.machines }), host: (id: string) => f.hosts.get(id) } as unknown as WorkspaceController
    assert.equal(ctx.get('sourceWorkspaceTransport'), undefined, 'the primary shell has no per-graph transport service')
    const stop = installRemoteInputTriggers(ctx, {} as HhpiRemoteApi, workspace, 'local')
    try {
        await ready.promise
        const at = registered.find(value => value.name === 'source-sessions')!
        const metadata = { ...source(hhpi), id: inputId, codex: {} }
        const session = { sessionId: inputId, binding: { session: { metadata: { getSnapshot: () => metadata } } } } as unknown as Parameters<InputTriggerSource['candidates']>[0]
        const candidates = await at.candidates(session, { query: 'Authorized', position: 'inline', drilled: false, signal })
        assert.equal(candidates.length, 1, 'the primary composer must offer authorized cross-Host conversation references')
        assert.deepEqual(JSON.parse(candidates[0]!.value!), hhpi)
    } finally { stop() }
})
