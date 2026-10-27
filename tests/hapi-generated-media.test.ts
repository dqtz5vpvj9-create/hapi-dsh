import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { HapiRequestError, type HapiMessage, type HapiSession } from '../src/codex/contracts.ts'
import { HapiClient } from '../src/hapi/client.ts'
import { MAX_SOURCE_GENERATED_MEDIA, sourceGeneratedMediaImporter } from '../src/hapi/generated-media.ts'
import { ObservedContent } from '../src/hapi-agent/content.ts'
import { parseObservedMessage } from '../src/hapi-agent/parser.ts'
import { ObservedProjector } from '../src/hapi-agent/projector.ts'
import { sourceGeneratedMediaRecordOf } from '../src/hapi-agent/generated-media-record.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
type Media = { bytes: Uint8Array; mimeType: string; fileName: string; status?: number; declaredSize?: number }

/** HAPI HTTP payloads are fixtures; authentication, limits, parsing and the
 * on-disk DSH AttachmentStore run their unchanged production implementations. */
async function environment() {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-generated-media-'))
    const ctx = new Context(), store = new LocalAttachmentStore(ctx, { dshHome: join(directory, 'official-store') })
    const sources = new Map<string, HapiSession>(), values = new Map<string, Media>()
    const calls: Array<{ path: string; authorization: string | null; redirect: RequestRedirect | undefined }> = []
    let unavailable = false, wrongSource = false
    const source = (id: string, machineId: string) => {
        const value: HapiSession = { id, namespace: 'fixture', seq: 1, createdAt: 1000, updatedAt: 1000,
            active: true, activeAt: 1000, thinking: false, thinkingAt: 1000, metadataVersion: 1, agentStateVersion: 1,
            metadata: { path: `/fixture/${machineId}`, machineId, flavor: 'claude', claudeSessionId: `${id}-thread` },
            agentState: { requests: {}, completedRequests: {} }, model: 'fixture-model' }
        sources.set(id, value); return value
    }
    source('one', 'machine-one'); source('two', 'machine-two')
    const client = new HapiClient({ hubId: 'generated-media-fixture', url: 'http://127.0.0.1:39091', token: 'fixture-access-token',
        fetch: async (input, init) => {
            const url = new URL(String(input))
            if (url.pathname === '/api/auth') return json({ token: 'fixture-jwt' })
            calls.push({ path: url.pathname, authorization: new Headers(init?.headers).get('Authorization'), redirect: init?.redirect })
            if (unavailable) throw new TypeError('Fixture source offline')
            const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
            const found = sources.get(parts[2] ?? '')
            if (!found) return json({ error: 'Source not found' }, 404)
            if (parts.length === 3) return json({ session: wrongSource ? { ...found, id: 'another-source' } : found })
            if (parts[3] !== 'generated-images' || parts.length !== 5) return json({ error: 'Unknown fixture route' }, 404)
            const media = values.get(JSON.stringify([found.id, parts[4]]))
            if (!media) return json({ error: 'Generated media is no longer registered on the original Runner' }, 404)
            return new Response(Uint8Array.from(media.bytes), { status: media.status ?? 200, headers: {
                'Content-Type': media.mimeType, 'Content-Length': String(media.declaredSize ?? media.bytes.byteLength),
                'Content-Disposition': `inline; filename="${encodeURIComponent(media.fileName)}"`,
            } })
        } })
    return { directory, ctx, store, client, calls, source, sources,
        import: sourceGeneratedMediaImporter(store, client),
        set(sourceId: string, imageId: string, media: Media) { values.set(JSON.stringify([sourceId, imageId]), media) },
        unavailable(value: boolean) { unavailable = value }, wrongSource(value: boolean) { wrongSource = value },
        async close() { await client.close(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) },
    }
}

function row(imageId: string, fileName = 'generated.png'): HapiMessage {
    return { id: 'media-row', seq: 2, localId: null, createdAt: 1002, content: { role: 'agent',
        content: { type: 'codex', data: { type: 'generated-image', id: 'media-event', imageId, fileName, mimeType: 'image/png',
            source: { ingress: 'mcp', toolName: 'display_image' } } } } }
}
async function fileBytes(store: LocalAttachmentStore, attachment: FileAttachmentRef): Promise<Buffer> {
    const chunks: Uint8Array[] = []; for await (const chunk of store.readFileStream(attachment)) chunks.push(chunk)
    return Buffer.concat(chunks)
}

test('a provenance-bearing generated image uses its authenticated source route and the real image decoder', async () => {
    const app = await environment()
    try {
        const sourceId = 'source/with space', imageId = 'opaque/../https://elsewhere.invalid/picture?x=1#two'
        app.source(sourceId, 'machine-original'); app.set(sourceId, imageId, { bytes: PNG, mimeType: 'image/png', fileName: '原始图片.png' })
        const items = parseObservedMessage(row(imageId)); assert.equal(items.length, 1)
        const item = items[0]!; assert.ok('parts' in item)
        assert.deepEqual(item.parts, [{ type: 'generated-media', media: { imageId, fileName: 'generated.png', mimeType: 'image/png' } }])
        const content = new ObservedContent(app.directory, 'display-source', sourceId, { importGeneratedMedia: app.import })
        await content.prepare(items)
        const block = content.get(item)?.[0]; assert.equal(block?.type, 'image'); assert.ok(block?.type === 'image')
        assert.equal(block.attachment.name, '原始图片.png')
        assert.deepEqual(Buffer.from((await app.store.readImage(block.attachment)).data), PNG)
        assert.deepEqual(app.calls.map(value => value.path), [
            `/api/sessions/${encodeURIComponent(sourceId)}`,
            `/api/sessions/${encodeURIComponent(sourceId)}/generated-images/${encodeURIComponent(imageId)}`,
        ])
        assert.ok(app.calls.every(value => value.authorization === 'Bearer fixture-jwt' && value.redirect === 'manual'))
    } finally { await app.close() }
})

test('identical opaque IDs from two original sessions cannot reuse the other Runner media', async () => {
    const app = await environment()
    try {
        app.set('one', 'same-id', { bytes: Buffer.from('Machine one audio bytes'), mimeType: 'audio/wav', fileName: 'one.wav' })
        app.set('two', 'same-id', { bytes: Buffer.from('Machine two video bytes'), mimeType: 'video/mp4', fileName: 'two.mp4' })
        const one = await app.import('one', { imageId: 'same-id', fileName: 'hint.png', mimeType: 'image/png' })
        const two = await app.import('two', { imageId: 'same-id', fileName: 'hint.png', mimeType: 'image/png' })
        assert.ok(one.type === 'file' && two.type === 'file')
        assert.equal((await fileBytes(app.store, one.attachment)).toString(), 'Machine one audio bytes')
        assert.equal((await fileBytes(app.store, two.attachment)).toString(), 'Machine two video bytes')
        assert.notEqual(one.attachment.attachmentId, two.attachment.attachmentId)
        assert.deepEqual(app.calls.filter(value => value.path.includes('generated-images')).map(value => value.path),
            ['/api/sessions/one/generated-images/same-id', '/api/sessions/two/generated-images/same-id'])
    } finally { await app.close() }
})

test('binary MIME and verified bytes control image admission; source hints cannot turn HTML into an image', async () => {
    const app = await environment()
    try {
        app.set('one', 'unknown', { bytes: PNG, mimeType: 'application/octet-stream', fileName: 'sniffed.png' })
        const image = await app.import('one', { imageId: 'unknown', fileName: 'hint.txt', mimeType: null })
        assert.ok(image.type === 'image'); assert.equal(image.attachment.mediaType, 'image/png')
        app.set('one', 'html', { bytes: Buffer.from('<h1>Exact source document</h1>'), mimeType: 'text/html', fileName: '../../source.html' })
        const document = await app.import('one', { imageId: 'html', fileName: 'fake.png', mimeType: 'image/png' })
        assert.ok(document.type === 'file'); assert.equal(document.attachment.name, 'source.html')
        assert.equal((await fileBytes(app.store, document.attachment)).toString(), '<h1>Exact source document</h1>')
        app.set('one', 'invalid', { bytes: PNG.subarray(0, 9), mimeType: 'image/png', fileName: 'invalid.png' })
        await assert.rejects(app.import('one', { imageId: 'invalid', fileName: 'invalid.png', mimeType: 'image/png' }))
    } finally { await app.close() }
})

test('expired or offline media stays visibly unavailable and can be read later without poisoning its durable cache', async () => {
    const app = await environment()
    try {
        const content = new ObservedContent(app.directory, 'display-one', 'one', { importGeneratedMedia: app.import })
        const missing = parseObservedMessage(row('late')); await content.prepare(missing)
        const placeholder = JSON.stringify(content.get(missing[0]!))
        assert.match(placeholder, /Source resource unavailable: [^\]]+\.png/)
        assert.doesNotMatch(placeholder, /HTTP 404|\/mnt\/|ENOENT/, 'the transcript must not leak transport or filesystem details')
        app.set('one', 'late', { bytes: PNG, mimeType: 'image/png', fileName: 'late.png' })
        app.unavailable(true)
        const offline = parseObservedMessage(row('late')); await content.prepare(offline)
        assert.match(JSON.stringify(content.get(offline[0]!)), /Source resource unavailable/)
        app.unavailable(false)
        const ready = parseObservedMessage(row('late')); await content.prepare(ready)
        const block = content.get(ready[0]!)?.[0]; assert.ok(block?.type === 'image')
        const saved = await readFile(join(app.directory, 'display-one.source-resources.json'), 'utf8')
        assert.ok(saved.includes('sha256:')); assert.ok(!saved.includes(PNG.toString('base64')))
        const reads = app.calls.length; app.unavailable(true)
        const restored = new ObservedContent(app.directory, 'display-one', 'one', { importGeneratedMedia: app.import })
        const again = parseObservedMessage(row('late')); await restored.prepare(again)
        assert.deepEqual(restored.get(again[0]!), [block]); assert.equal(app.calls.length, reads)
        const differentSource = new ObservedContent(app.directory, 'display-two', 'two', { importGeneratedMedia: app.import })
        const foreign = parseObservedMessage(row('late')); await differentSource.prepare(foreign)
        assert.match(JSON.stringify(differentSource.get(foreign[0]!)), /Source resource unavailable/)
        assert.equal(app.calls.length, reads + 1)
    } finally { await app.close() }
})

test('source identity, original 25 MiB limit and complete nonempty bodies are checked before successful admission', async () => {
    const app = await environment()
    try {
        const ref = { imageId: 'media', fileName: 'media.png', mimeType: 'image/png' }
        app.wrongSource(true)
        await assert.rejects(app.import('one', ref), /source identity changed/)
        assert.equal(app.calls.filter(value => value.path.includes('generated-images')).length, 0)
        app.wrongSource(false)
        app.set('one', 'media', { bytes: PNG, mimeType: 'image/png', fileName: 'oversize.png', declaredSize: MAX_SOURCE_GENERATED_MEDIA + 1 })
        await assert.rejects(app.import('one', ref), /exceeds/)
        app.set('one', 'media', { bytes: PNG, mimeType: 'image/png', fileName: 'partial.png', status: 206 })
        await assert.rejects(app.import('one', ref), error => error instanceof HapiRequestError && error.outcome === 'indeterminate' && /partial/.test(error.message))
        app.set('one', 'media', { bytes: new Uint8Array(), mimeType: 'image/png', fileName: 'empty.png' })
        await assert.rejects(app.import('one', ref), /empty/)
        const before = app.calls.length
        await assert.rejects(app.import('one', { ...ref, imageId: 'bad\nidentity' }), /identity/)
        assert.equal(app.calls.length, before)
    } finally { await app.close() }
})

test('a URL resource remains a link and missing source identity never silently becomes an empty assistant message', async () => {
    const app = await environment()
    try {
        const url = row('ignored')
        const envelope = url.content as { content: { data: Record<string, unknown> } }
        envelope.content.data.source = { type: 'url', url: 'https://example.invalid/original.png' }
        const noId = row(''); const missing = noId.content as { content: { data: Record<string, unknown> } }; delete missing.content.data.imageId
        const items = [...parseObservedMessage(url), ...parseObservedMessage({ ...noId, id: 'missing-media-row' })]
        const content = new ObservedContent(app.directory, 'display-one', 'one', { importGeneratedMedia: app.import }); await content.prepare(items)
        assert.deepEqual(content.get(items[0]!), [{ type: 'text', text: '[generated.png](https://example.invalid/original.png)' }])
        assert.match(JSON.stringify(content.get(items[1]!)), /Source content unavailable.*requires its source resource/)
        assert.equal(app.calls.length, 0)
    } finally { await app.close() }
})

test('generated files preserve admitted bytes and native identity in an owned record instead of an unsupported assistant block', async () => {
    const app = await environment()
    try {
        const bytes = Uint8Array.of(0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109)
        app.set('one', 'movie', { bytes, mimeType: 'video/mp4', fileName: 'source-movie.mp4' })
        const items = parseObservedMessage(row('movie', 'hint.png'))
        const content = new ObservedContent(app.directory, 'display-one', 'one', { importGeneratedMedia: app.import }); await content.prepare(items)
        const imported = content.get(items[0]!)?.[0]; assert.ok(imported?.type === 'file')
        const id = SessionId('generated-file-display'), projector = new ObservedProjector(Session.create(id), {
            model: () => 'fixture-model', submittedMessage: () => undefined, content: item => content.get(item), stream: () => {},
        })
        projector.beginHistorySeed(); projector.apply(items)
        const session = Session.create(id, projector.historySeed()); projector.finishHistorySeed(session)
        const events = session.snapshotEvents(), answer = events.find(value => value.type === 'assistant/message')!
        assert.deepEqual(answer.data.message.content, [])
        const records = events.flatMap(event => { const raw = pluginRecordOf(event); const record = raw && sourceGeneratedMediaRecordOf(raw); return record ? [record] : [] })
        assert.deepEqual(records, [{ messageId: answer.data.message.id, sourceRowId: 'media-row', surfaceSeq: answer.seq,
            turn: 1, step: 1, files: [{ blockIndex: 0, imageId: 'movie', fileName: 'source-movie.mp4', mimeType: 'image/png', attachment: imported.attachment }] }])
        assert.equal(projector.sourceMessageDisplaySeq('media-row'), answer.seq)
        assert.deepEqual(await fileBytes(app.store, imported.attachment), Buffer.from(bytes))
        assert.ok(events.every((event, index) => index === 0 || event.seq === events[index - 1]!.seq + 1))
        projector.apply(items); assert.equal(session.snapshotEvents().length, events.length)
    } finally { await app.close() }
})
