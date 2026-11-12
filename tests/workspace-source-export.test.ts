/** Actual exporter/controller; only the authenticated source page transport is controlled. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ISessions, SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HhpiRemoteApi } from '../src/hhpi-api.ts'
import { SourceExportController, OriginalSourceExporter, createSessionSourceExporter, SOURCE_EXPORT_FORMAT_KEY,
    downloadPreparedSourceExport, type SourceExportApi, type ExportPage } from '../src/client/source-export-state.ts'
import type { AppSourceRoute } from '../src/workspace/app-service-types.ts'
import type { SourcePage, SourceSession } from '../src/remote/protocol.ts'
import { SourceEventIndex, type EventInput } from '../src/remote/event-index.ts'
const source: AppSourceRoute = { kind: 'hhpi', hostId: 'original-host', sessionId: 'hhpi:machine:source:codex:native',
    identity: { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'native' } }
const session: SourceSession = { ...source.identity!, id: source.sessionId, title: 'Original full conversation', cwd: '/source', updatedAt: 100,
    activeTurnId: null, status: 'idle', pendingRequests: [], capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } }
const row = (seq: number) => ({ type: 'event' as const, event: { type: 'user/message', seq, time: seq + 1,
    data: { role: 'user', content: [{ type: 'text', text: `source-${seq}` }, { type: 'image', attachment: { attachmentId: 'original-image-ref', mediaType: 'image/png', bytes: 123, width: 64, height: 32 } }, { type: 'file', attachment: { attachmentId: 'original-file-ref', name: 'file.bin', bytes: 256 } }] } } })
const ready = { type: 'ready' as const, fileName: 'original.json', bytes: 2, blob: new Blob(['{}']) }
const sessions = { list: { getSnapshot: () => ({ byId: {} }) } } as unknown as Pick<ISessions, 'list'>

test('HHPI export walks original source pages, retains rich structure and checks source revision after the complete read', async () => {
    const requests: Parameters<HhpiRemoteApi['read']>[0][] = []
    const api = createSessionSourceExporter(sessions, source.hostId, () => true, undefined, { read: async request => {
        requests.push(request); const old = request.before !== undefined
        const page: SourcePage = { session, epoch: 'original-epoch', version: 7, entries: (old ? [row(0), row(1)] : [row(2), row(3)]) as never,
            before: old ? 0 : 2, after: old ? 1 : 3, hasBefore: !old, hasAfter: old, context: [] }
        return { ok: true, value: page }
    } })
    const result = await api.sourceExport({ source, format: 'json' }, new AbortController().signal)
    assert.equal(result.type, 'ready'); if (result.type !== 'ready') return
    const payload = JSON.parse(await result.blob.text())
    assert.deepEqual(payload.source, source); assert.deepEqual(payload.events.map((value: { seq: number }) => value.seq), [0, 1, 2, 3])
    assert.deepEqual(payload.events[0].data, row(0).event.data)
    assert.deepEqual(requests, [{ sessionId: source.sessionId, limit: 160 }, { sessionId: source.sessionId, epoch: 'original-epoch', limit: 160, before: 2 },
        { sessionId: source.sessionId, epoch: 'original-epoch', limit: 160 }])
})

test('ordinary and federated DSH exports use the official cold events API with one fixed throughSeq cut', async () => {
    for (const kind of ['local-dsh', 'federated-dsh'] as const) {
        const route: AppSourceRoute = { kind, hostId: kind, sessionId: 'native-dsh' }, requests: Parameters<SessionRemote['events']>[0][] = []
        const api = createSessionSourceExporter(sessions, route.hostId, () => true, { events: async request => {
            requests.push(request)
            return { ok: true, value: { cursor: 3, records: (request.beforeSeq !== undefined ? [row(0), row(1)] : [row(2), row(3)]) as never, hasMore: request.beforeSeq === undefined } }
        } })
        const result = await api.sourceExport({ source: route, format: 'markdown' }, new AbortController().signal)
        assert.equal(result.type, 'ready'); if (result.type !== 'ready') continue
        const text = await result.blob.text(); assert.match(text, /source-0/); assert.match(text, /source-3/); assert.match(text, /original-image-ref/)
        assert.deepEqual(requests.map(value => [value.throughSeq, value.beforeSeq]), [[undefined, undefined], [3, 2], [3, undefined]])
    }
})

test('cold native index pages export only after one stable content verification; earlier rewrites or later publication fail', async () => {
    for (const mode of ['cold', 'earlier-rewrite', 'late-publication', 'epoch-rewrite', 'account-change'] as const) {
        const index = new SourceEventIndex(':memory:', session)
        const user = (seq: number, text = `original-${seq}`): EventInput => ({ type: 'user/message', time: seq, surfaceOp: 'append',
            data: { id: `message-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } as EventInput)
        const append = (from: number, through: number) => index.edit(session, () => {
            for (let seq = from; seq <= through; seq++) index.put(`item-${seq}`, user(seq), [], seq)
        })
        append(5, 6)
        const versions: number[] = [], requests: Array<number | undefined> = []
        let current = true, revalidating = false
        const api = createSessionSourceExporter(sessions, source.hostId, () => current, undefined, { read: async request => {
            requests.push(request.before)
            const from = request.before === undefined ? 5 : request.before === 5 ? 3 : 1, through = from + 1
            if (!index.sequence(`item-${from}`)) append(from, through)
            if (request.before === undefined && index.count === 6) {
                if (!revalidating && mode === 'earlier-rewrite') index.edit(session, () => index.put('item-3', user(3, 'changed outside the head')))
                if (revalidating && mode === 'late-publication') index.edit(session, () => index.put('item-2', user(2, 'changed during verification')))
                if (!revalidating && mode === 'account-change') current = false
                revalidating = true
            }
            if (request.before === 3 && mode === 'epoch-rewrite') index.edit(session, () => index.removeFrom(6))
            const page = index.read({ ...request, limit: 2 }, { from, through })
            page.hasBefore = from > 1; page.hasAfter = through < 6
            versions.push(page.version)
            return { ok: true, value: page }
        } })
        try {
            const result = api.sourceExport({ source, format: 'json' }, new AbortController().signal)
            if (mode !== 'cold') {
                await assert.rejects(result, mode === 'account-change' ? /generation changed/ : /history changed|replaced this history/)
                continue
            }
            const exported = await result
            assert.equal(exported.type, 'ready'); if (exported.type !== 'ready') continue
            const value = JSON.parse(await exported.blob.text())
            assert.deepEqual(value.events.map((event: { seq: number }) => event.seq), [1, 2, 3, 4, 5, 6])
            assert.deepEqual(versions, [1, 2, 3, 3, 3, 3, 3, 3])
            assert.deepEqual(requests, [undefined, 5, 3, undefined, undefined, 5, 3, undefined])
        } finally { index.dispose() }
    }
})

test('a changed revision, missing cursor or lost account generation yields no partial export', async () => {
    const initial: ExportPage = { version: 'source-v1', entries: [row(2)], before: '2', after: '2', hasBefore: true, hasAfter: false }
    for (const mode of ['revision', 'cursor', 'account']) {
        let released = false
        const exporter = new OriginalSourceExporter(async () => ({ title: 'Source', assertCurrent() { if (mode === 'account') throw new Error('account replaced') }, release() { released = true },
            feed: { initial: mode === 'cursor' ? { ...initial, before: null } : initial, async read() { return { ...initial, version: 'source-v2', hasBefore: false } } } }))
        await assert.rejects(exporter.sourceExport({ source, format: 'json' }, new AbortController().signal), mode === 'revision' ? /history changed/ : mode === 'cursor' ? /cursor did not advance/ : /account replaced/)
        assert.equal(released, true)
    }
})

test('controller format preference and large-export confirmation preserve the exact original source', async () => {
    const requests: Parameters<SourceExportApi['sourceExport']>[0][] = [], saved = new Map<string, string>()
    const controller = new SourceExportController({ sourceExport: async request => { requests.push(request); return request.force ? ready : { type: 'warning', count: 10001, limit: 10000, estimatedBytes: 4096 } } }, source,
        { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value) } })
    try {
        assert.equal(controller.getSnapshot().format, 'json'); assert.equal(await controller.prepare(true), null)
        assert.equal(await controller.prepare(), null); assert.equal(controller.getSnapshot().result?.type, 'warning')
        const prepared = await controller.prepare(true); assert.equal(await (await downloadPreparedSourceExport(prepared!)).text(), '{}')
        assert.deepEqual(requests, [{ source, format: 'json' }, { source, format: 'json', force: true }])
        assert.equal(saved.get(SOURCE_EXPORT_FORMAT_KEY), 'json'); controller.setFormat('markdown'); assert.equal(controller.getSnapshot().result, null)
    } finally { controller.dispose() }
})

test('closing ignores late preparation, aborts the source read and never starts a second export', async () => {
    let finish!: (value: typeof ready) => void, signal: AbortSignal | undefined, calls = 0
    const controller = new SourceExportController({ sourceExport: async (_request, observed) => { signal = observed; calls++; return new Promise(resolve => { finish = resolve }) } }, source)
    const pending = controller.prepare(); assert.equal(await controller.prepare(), null); assert.equal(calls, 1)
    controller.dispose(); assert.equal(signal?.aborted, true); finish(ready); assert.equal(await pending, null); assert.equal(controller.getSnapshot().result, null)
})

test('preference failure remains visible while the original source export succeeds', async () => {
    const controller = new SourceExportController({ sourceExport: async () => ready }, source,
        { getItem: () => 'markdown', setItem() { throw new Error('device storage full') } })
    try { assert.equal(controller.getSnapshot().format, 'markdown'); assert.ok(await controller.prepare()); assert.equal(controller.getSnapshot().persistenceError, 'device storage full') }
    finally { controller.dispose() }
})

test('Markdown renders real DSH/Codex message bodies, proposed plans, attachment references and folded tool details', async () => {
    const events = [
        { type: 'user/message', seq: 0, time: 1, data: { id: 'user-original', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Please review this patch.' },
            { type: 'file', attachment: { attachmentId: 'file-source-id', name: 'patch.diff', bytes: 128 } }] } },
        { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { id: 'codex:native:turn:plan', role: 'assistant', content: [
            { type: 'text', text: '<proposed_plan>\n1. Read the patch.\n2. Run the focused tests.\n</proposed_plan>' },
            { type: 'tool-call', id: 'call-original', name: 'codex.commandExecution', arguments: '{"command":"npm test"}' },
        ] }, stream: [] } },
        { type: 'tool/call', seq: 2, time: 3, data: { turn: 1, step: 1, callId: 'call-original', name: 'codex.commandExecution', arguments: '{"command":"npm test"}' } },
        { type: 'tool/result', seq: 3, time: 4, data: { turn: 1, step: 1, message: { id: 'call-original:result', role: 'tool', toolCallId: 'call-original', content: [{ type: 'text', text: 'Tests passed: 12/12.' }] } } },
        { type: 'assistant/message', seq: 4, time: 5, data: { turn: 1, step: 2, message: { id: 'final-original', role: 'assistant', content: [{ type: 'text', text: 'The patch is ready.\n\n```ts\nexport const value = 42\n```' },
            { type: 'image', attachment: { attachmentId: 'image-source-id', mediaType: 'image/png', bytes: 4096, width: 640, height: 480, name: 'result.png' } }] }, stream: [] } },
    ]
    const page: ExportPage = { version: 'actual-source-v1', entries: events.map(event => ({ type: 'event', event })), before: '0', after: '4', hasBefore: false, hasAfter: false }
    const api = new OriginalSourceExporter(async () => ({ title: 'Conversation', assertCurrent() {}, release() {}, feed: { initial: page, read: async () => page } }))
    const result = await api.sourceExport({ source, format: 'markdown' }, new AbortController().signal)
    assert.equal(result.type, 'ready'); if (result.type !== 'ready') return
    const text = await result.blob.text()
    assert.match(text, /## User\n/); assert.match(text, /Please review this patch\./)
    assert.match(text, /### Proposed plan\n\n1\. Read the patch/); assert.equal(text.includes('<proposed_plan>'), false)
    assert.match(text, /<summary>Tool result · codex\.commandExecution<\/summary>/); assert.match(text, /Tests passed: 12\/12/)
    assert.match(text, /The patch is ready\.\n\n```ts/); assert.match(text, /patch\.diff/); assert.match(text, /file-source-id/); assert.match(text, /image-source-id/)
    assert.match(text, /external bytes are not embedded/); assert.equal(text.includes('"stream"'), false)
    assert.equal((text.match(/"command":"npm test"/gu) ?? []).length, 1)
})

test('the actual large-source walk releases its window for a warning and exports the complete cut only after confirmation', async () => {
    let releases = 0
    const pages = [10000, 5000, 0].map(start => ({ version: 'one-source-cut', entries: Array.from({ length: 5000 }, (_, index) => row(start + index)),
        before: String(start), after: String(start + 4999), hasBefore: start > 0, hasAfter: start < 10000 }))
    const api = new OriginalSourceExporter(async () => ({ title: 'Large conversation', assertCurrent() {}, release() { releases++ },
        feed: { initial: pages[0]!, read: async request => request.kind === 'latest' ? pages[0]! : request.cursor === '10000' ? pages[1]! : pages[2]! } }))
    const warning = await api.sourceExport({ source, format: 'json' }, new AbortController().signal)
    assert.equal(warning.type, 'warning'); assert.equal(releases, 1)
    const full = await api.sourceExport({ source, format: 'json', force: true }, new AbortController().signal)
    assert.equal(full.type, 'ready'); assert.equal(releases, 2)
    if (full.type === 'ready') assert.equal(JSON.parse(await full.blob.text()).events.length, 15000)
})
