/** Real address/SlotCore contracts; source network and renderer components are explicit fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { artifactResourceAddress, documentPaneTarget, parseArtifactResourceAddress, sessionFileArtifactPath, generatedMediaResourceAddress,
    parseGeneratedMediaResourceAddress, parseSourceDocumentResourceAddress, type ArtifactReference, type GeneratedMediaReference } from '../src/workspace/artifacts.ts'
import { artifactPresentation, artifactViewers, loadArtifact, readArtifactBytes, type ArtifactApi } from '../src/client/artifact-content.ts'
import { borrowArtifactBodies, DOCUMENT_PREFIX } from '../src/client/artifact-bodies.ts'
import { sourceAttachmentImageUrl, sourceDocumentImageUrl, sourceDocumentPath } from '../src/client/source-document-path.ts'
import { initialWorkspace, parseWorkspaceState, WorkspaceStore } from '../src/client/model.ts'
import { bindSourceResources } from '../src/workspace/legacy.ts'
import type { WorkspaceCatalogRow } from '../src/client/controller.ts'
import type { WorkbenchResponse } from '../src/workbench-types.ts'
import { MAX_DOCUMENT_BYTES } from '../src/workbench-types.ts'

const reference: ArtifactReference = { source: { sourceSessionId: 'real source', sourceHubId: 'original hub', machineId: 'machine-alpha' },
    document: { kind: 'artifact', artifactId: 'codex-artifact:opaque/encoded?locator', fileName: '报告 #1.pdf', mimeType: 'application/pdf' } }
function metadata(overrides: Partial<WorkbenchResponse<'nativeDocument'>> = {}): WorkbenchResponse<'nativeDocument'> {
    return { document: reference.document, fileName: reference.document.fileName, mimeType: reference.document.mimeType,
        size: 4, writable: false, text: null, downloadUrl: '/hapi-dsh/workbench/document?source=fixture', officePreview: false, ...overrides }
}
const fileArtifact = (path: string): string => `session-file:${Buffer.from(path).toString('base64url')}`
const base = 'https://workspace.example/dsh/'

test('queue thumbnails use the source-authorized artifact route for uploads outside cwd', () => {
    const file = { filename: '图.png', path: 'C:\\uploads\\图.png', mimeType: 'image/png', size: 10 }
    const url = new URL(sourceAttachmentImageUrl(reference.source, file, base)!)
    assert.equal(url.origin, new URL(base).origin)
    assert.equal(url.pathname, '/hapi-dsh/workbench/document')
    const request = JSON.parse(url.searchParams.get('request')!)
    assert.deepEqual(request.source, reference.source)
    assert.equal(request.document.kind, 'artifact')
    assert.equal(sessionFileArtifactPath(request.document.artifactId), file.path)
    assert.equal(sourceAttachmentImageUrl(reference.source, { ...file, mimeType: 'image/svg+xml' }, base), undefined)
    assert.equal(sourceAttachmentImageUrl(reference.source, file, 'file:///local.html'), undefined)
})

test('original session-file identities strictly decode real Unicode and Windows paths, never opaque locators', () => {
    for (const path of ['/repo/报告 #1?.md', 'C:\\project\\源码.ts', '../shared/notes.md']) assert.equal(sessionFileArtifactPath(fileArtifact(path)), path)
    for (const id of ['session-file:', 'session-file:A', 'session-file:YWJ=', 'session-file:_w', 'session-file:Zh', fileArtifact('/repo/\0secret'), reference.document.artifactId]) assert.equal(sessionFileArtifactPath(id), null, id)
    const target = documentPaneTarget('display-r3', { kind: 'artifact', artifactId: fileArtifact('/repo/报告 #1.md'), fileName: 'misleading.txt', mimeType: 'text/plain' }, reference.source)
    assert.equal(target.type, 'resource')
    assert.deepEqual(target.type === 'resource' && parseFileAddress(target.address), { scope: 'session', sessionId: 'display-r3', path: '/repo/报告 #1.md' })
})

test('opaque artifact addresses retain original source identity and never claim a file path', () => {
    const address = artifactResourceAddress(reference)
    assert.deepEqual(parseArtifactResourceAddress(address), reference)
    assert.equal(parseFileAddress(address), undefined)
    assert.deepEqual(documentPaneTarget('display-r4', reference.document, reference.source), { type: 'resource', address })
    assert.throws(() => documentPaneTarget('display-r4', reference.document), /original HAPI source/)
    for (const value of [address + '#fragment', address.replace('hapi-artifact/', 'user:credential@hapi-artifact/'), 'dsh-resource://hapi-artifact/session/one/%zz', 'dsh-resource://file/session/one/opaque']) assert.equal(parseArtifactResourceAddress(value), null)
})

test('generated media uses a distinct registry protocol with exact Hub/session/machine ownership', () => {
    const media: GeneratedMediaReference = { source: reference.source, document: { kind: 'generated-media', imageId: 'same/opaque?ID#media', fileName: '原始视频.mp4', mimeType: 'video/mp4' } }
    const address = generatedMediaResourceAddress(media)
    assert.equal(new URL(address).hostname, 'hapi-generated-media')
    assert.deepEqual(parseGeneratedMediaResourceAddress(address), media)
    assert.deepEqual(parseSourceDocumentResourceAddress(address), media)
    assert.equal(parseArtifactResourceAddress(address), null); assert.equal(parseFileAddress(address), undefined)
    assert.deepEqual(documentPaneTarget('current-display', media.document, media.source), { type: 'resource', address })
    assert.equal(parseGeneratedMediaResourceAddress(artifactResourceAddress(reference)), null)
    for (const invalid of [address + '#unowned', address.replace('hapi-generated-media/', 'owner:secret@hapi-generated-media/'),
        'dsh-resource://hapi-generated-media/session/one/%zz']) assert.equal(parseGeneratedMediaResourceAddress(invalid), null)
})

test('source Markdown media never resolves against Hub filesystem or invents an opaque artifact directory', () => {
    const relative = sourceDocumentImageUrl(reference.source, '../assets/chart%20one.png#page', base, '/repo/docs/README.md')!
    const request = JSON.parse(new URL(relative).searchParams.get('request')!)
    assert.equal(new URL(relative).pathname, '/hapi-dsh/workbench/document')
    assert.deepEqual(request, { source: reference.source, document: { kind: 'file', path: '/repo/docs/../assets/chart one.png', machineId: 'machine-alpha' } })
    assert.equal(sourceDocumentImageUrl(reference.source, './chart.png', base), undefined)
    assert.equal(sourceDocumentPath('https://elsewhere.test/photo.png', '/repo/doc.md'), undefined)
    assert.equal(sourceDocumentPath('file:///etc/passwd', '/repo/doc.md'), undefined)
    assert.equal(sourceDocumentPath('%00wrong', '/repo/doc.md'), undefined)
    assert.equal(sourceDocumentPath('%xx', '/repo/doc.md'), undefined)
    const absolute = sourceDocumentImageUrl(reference.source, '/repo/actual.png', base)!
    assert.equal(JSON.parse(new URL(absolute).searchParams.get('request')!).document.path, '/repo/actual.png')
    assert.equal(sourceDocumentPath('C:\\source\\图.png'), 'C:\\source\\图.png')
})

test('Office conversion and original downloads remain separate source-owned reads', async () => {
    const calls: unknown[] = [], urls: string[] = []
    const value = metadata({ fileName: 'real.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', officePreview: true })
    const api: ArtifactApi = {
        async nativeDocument(request) { calls.push(['document', request]); return { ok: true, value } },
        async nativePreview(request) { calls.push(['preview', request]); return { ok: true, value: { previewId: 'actual-preview', length: 4, version: 'actual-version', url: '/hapi-dsh/workbench/preview?actual' } } },
    }
    const fetcher: typeof fetch = async (input, init) => {
        urls.push(String(input)); assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.redirect, 'error')
        return new Response(new Uint8Array([37, 80, 68, 70]))
    }
    const signal = new AbortController().signal, loaded = await loadArtifact(api, reference, signal)
    const presentation = await artifactPresentation(api, loaded, 'pdf', base, signal, fetcher)
    assert.equal(presentation.converted, true)
    assert.deepEqual(calls, [['document', reference], ['preview', reference]])
    assert.equal(presentation.content.kind, 'bytes')
    assert.deepEqual(presentation.content.kind === 'bytes' && [...presentation.content.data], [37, 80, 68, 70])
    assert.equal(urls[0], 'https://workspace.example/hapi-dsh/workbench/preview?actual')
    assert.equal(loaded.metadata.downloadUrl, value.downloadUrl)
    assert.deepEqual(artifactViewers(value), ['pdf'])
})

test('source text is rendered verbatim and binary data is not fabricated into a readable document', async () => {
    const api: ArtifactApi = { nativeDocument: async () => ({ ok: true, value: metadata() }), nativePreview: async () => { throw new Error('Unexpected conversion') } }
    const loaded = { reference, metadata: metadata({ fileName: 'source.md', mimeType: 'text/markdown', text: '# Exact\n\nsource\n' }) }
    const presentation = await artifactPresentation(api, loaded, 'markdown', base, new AbortController().signal, async () => { throw new Error('Text must use its exact returned source') })
    assert.deepEqual(presentation.content, { kind: 'text', text: '# Exact\n\nsource\n', eof: true, pages: [{ offset: 1, text: '# Exact\n\nsource\n', lines: 4 }] })
    assert.deepEqual(artifactViewers(loaded.metadata), ['markdown', 'code', 'text'])
    assert.deepEqual(artifactViewers(metadata({ fileName: 'image.png', mimeType: 'image/png' })), ['image'])
    assert.deepEqual(artifactViewers(metadata({ fileName: 'render.html', mimeType: 'text/html', text: '<p>real</p>' })), ['html', 'code', 'text'])
    assert.deepEqual(artifactViewers(metadata({ fileName: 'archive.zip', mimeType: 'application/zip' })), [])
    await assert.rejects(artifactPresentation(api, { reference, metadata: metadata() }, 'text', base, new AbortController().signal), /readable text/)
})

test('closed artifact loads discard late source replies, and cross-origin download addresses are rejected before fetch', async () => {
    const controller = new AbortController()
    const api: ArtifactApi = { nativeDocument: async () => { controller.abort(); return { ok: true, value: metadata() } }, nativePreview: async () => { throw new Error('Unexpected conversion') } }
    await assert.rejects(loadArtifact(api, reference, controller.signal), { name: 'AbortError' })
    let fetched = false
    await assert.rejects(readArtifactBytes('https://other.test/document', base, new AbortController().signal, async () => { fetched = true; return new Response() }), /authenticated Host/)
    assert.equal(fetched, false)
})

test('source byte bounds apply to both declared and streamed lengths', async () => {
    let cancelled = false
    await assert.rejects(readArtifactBytes('/document', base, new AbortController().signal, async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-length': String(MAX_DOCUMENT_BYTES + 1) } })), /64 MiB/)
    assert.equal(cancelled, true)
    let sent = 0
    await assert.rejects(readArtifactBytes('/document', base, new AbortController().signal, async () => new Response(new ReadableStream<Uint8Array>({
        pull(stream) { sent++; stream.enqueue(new Uint8Array(MAX_DOCUMENT_BYTES / 2)); if (sent === 3) stream.close() },
    }))), /64 MiB/)
})

test('official PDF store handles and live replacement are reused without copying the parent document slot', async () => {
    const slots = new SlotCore()
    const root = slots.register({ name: 'root', children: {
        'sidebar.right.tab.document': { kind: 'keyed', scope: 'session' }, 'hapi.artifact.document': { kind: 'keyed', scope: 'session' },
    } } as never, (() => null) as never)
    const store = { create() { assert.fail('The adapter must never create a private store instance') } }
    const Pdf = () => null, Replacement = () => null
    const inject = () => ({ marker: 'original face' })
    const original = slots.register({ name: 'sidebar.right.tab.document', key: `${DOCUMENT_PREFIX}pdf`, store, inject } as never, Pdf as never)
    const close = borrowArtifactBodies({ slots } as unknown as Pick<Context, 'slots'>)
    const copied = slots.entriesOfSlot('hapi.artifact.document')[0]!
    assert.equal(copied.component, Pdf); assert.equal(copied.store, store); assert.equal(copied.inject, inject)
    assert.equal(copied.children, undefined)
    assert.equal(slots.entriesOfSlot('sidebar.right.tab.document')[0]!.component, Pdf)
    const replace = slots.register({ name: 'sidebar.right.tab.document', key: `${DOCUMENT_PREFIX}pdf`, priority: -1, store, inject } as never, Replacement as never)
    await Promise.resolve()
    assert.equal(slots.entriesOfSlot('hapi.artifact.document')[0]!.component, Replacement)
    replace(); await Promise.resolve()
    assert.equal(slots.entriesOfSlot('hapi.artifact.document')[0]!.component, Pdf)
    close(); assert.equal(slots.entriesOfSlot('hapi.artifact.document').length, 0)
    assert.equal(slots.entriesOfSlot('sidebar.right.tab.document')[0]!.component, Pdf)
    original(); root()
})

test('opaque HTML reuses the official body in static mode and never invokes relative-file lookup', () => {
    const slots = new SlotCore()
    const root = slots.register({ name: 'root', children: {
        'sidebar.right.tab.document': { kind: 'keyed', scope: 'session' }, 'hapi.artifact.document': { kind: 'keyed', scope: 'session' },
    } } as never, (() => null) as never)
    const Html = () => null, readRelated = () => { assert.fail('No opaque artifact filesystem base exists') }
    const original = slots.register({ name: 'sidebar.right.tab.document', key: `${DOCUMENT_PREFIX}html`, inject: () => ({ hooks: { interactivePreview: { getSnapshot: () => true } }, readRelated }) } as never, Html as never)
    const close = borrowArtifactBodies({ slots } as unknown as Pick<Context, 'slots'>)
    const entry = slots.entriesOfSlot('hapi.artifact.document')[0]!
    const face = entry.inject!() as { hooks: { interactivePreview: { getSnapshot(): boolean } }; readRelated: typeof readRelated }
    assert.equal(entry.component, Html); assert.equal(face.hooks.interactivePreview.getSnapshot(), false); assert.equal(face.readRelated, readRelated)
    close(); original(); root()
})

test('legacy document navigation persists without losing its original artifact reference', () => {
    let sequence = 0
    const nextId = () => `pane-${++sequence}`, store = new WorkspaceStore(initialWorkspace(nextId), nextId)
    store.openResource({ kind: 'document', sessionId: 'display-r1', sourceSessionId: 'source', sourceHubId: 'hub', document: reference.document })
    const pane = store.focusedPane()
    store.updateView(pane.id, { type: 'resource', address: sessionFileAddress('display-r1', '/repo/real.md'), params: { line: 2 } }, 'real.md')
    const restored = parseWorkspaceState(JSON.parse(JSON.stringify(store.getSnapshot())))
    const saved = restored.windows[0]!.root
    assert.equal(saved.type, 'pane')
    assert.equal(saved.type === 'pane' && saved.resource.kind === 'document' && saved.resource.document.kind === 'artifact' && saved.resource.document.artifactId, reference.document.artifactId)
    const row = { id: 'display-r2', sourceSessionId: 'display-r2', hostId: 'local', projectionValues: { hapi: { hapiSessionId: 'source', hubId: 'hub' } } } as unknown as WorkspaceCatalogRow
    const rebound = bindSourceResources(restored, { 'display-r2': row }).windows[0]!.root
    assert.equal(rebound.type, 'pane')
    const file = rebound.type === 'pane' && rebound.resource.kind === 'document' && rebound.resource.target?.type === 'resource' ? parseFileAddress(rebound.resource.target.address) : undefined
    assert.equal(file?.scope === 'session' && file.sessionId, 'display-r2')
})

test('a stalled source document ends in an explicit retryable failure instead of loading forever', async () => {
    const hang = async (): Promise<never> => { await new Promise<void>(() => {}); throw new Error('unreachable') }
    const stalledApi = { nativeDocument: hang, nativePreview: hang } as unknown as ArtifactApi
    // The Host call itself is lost: metadata waits forever without its deadline.
    await assert.rejects(loadArtifact(stalledApi, reference, new AbortController().signal, 5), /did not finish in time/)
    // The binary route sends headers and then stops. The body read must be
    // bounded too, not only the fetch call that delivered the headers.
    const stalledBody: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ start() { /* never enqueues */ } }))
    await assert.rejects(readArtifactBytes('/document', base, new AbortController().signal, stalledBody, 5), /did not finish in time/)
    // The fetch call never settles at all.
    const stalledFetch: typeof fetch = async () => { await new Promise<void>(() => {}); return new Response() }
    await assert.rejects(readArtifactBytes('/document', base, new AbortController().signal, stalledFetch, 5), /did not finish in time/)
    // A caller's own cancellation keeps abort semantics rather than being
    // reported as a stale source.
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(readArtifactBytes('/document', base, cancelled.signal, stalledBody), { name: 'AbortError' })
})

test('PDF preview renders complete source bytes and Office conversion waits for its own reply', async () => {
    // Rendering happens from complete bytes, never from a guessed URL.
    const api: ArtifactApi = { nativeDocument: async () => ({ ok: true, value: metadata({ fileName: 'source.pdf', mimeType: 'application/pdf' }) }),
        nativePreview: async () => { throw new Error('A plain PDF is not converted') } }
    const fetcher: typeof fetch = async () => new Response(new Uint8Array([37, 80, 68, 70]))
    const loaded = await loadArtifact(api, reference, new AbortController().signal)
    const presentation = await artifactPresentation(api, loaded, 'pdf', base, new AbortController().signal, fetcher)
    assert.equal(presentation.viewer, 'pdf'); assert.equal(presentation.converted, false)
    assert.deepEqual(presentation.content.kind === 'bytes' && [...presentation.content.data], [37, 80, 68, 70])
    // A conversion that never answers must not hold the preview open.
    const pending = { nativeDocument: async () => ({ ok: true, value: metadata({ fileName: 'source.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', officePreview: true }) }),
        nativePreview: async () => { await new Promise<void>(() => {}); throw new Error('unreachable') } } as unknown as ArtifactApi
    const office = await loadArtifact(pending, reference, new AbortController().signal)
    await assert.rejects(artifactPresentation(pending, office, 'pdf', base, new AbortController().signal, fetcher, 5), /did not finish in time/)
})
