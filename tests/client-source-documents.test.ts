/** Production address/content/client guards; the authenticated source wire is the explicit fixture. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceDocumentAddress, parseWorkspaceDocumentAddress, workspaceAttachmentResource } from '../src/workspace/artifacts.ts'
import { artifactViewers, loadWorkspaceArtifact, readWorkspaceArtifactBytes, workspaceArtifactPresentation } from '../src/client/artifact-content.ts'
import { createSourceFileClient } from '../src/client/source-workspace-client.ts'
import type { SourceWorkspaceApi, SourceWorkspaceDescription } from '../src/workspace/source-api.ts'
import type { WorkspaceDocument } from '../src/workspace/service-types.ts'
import type { WorkspaceResource } from '../src/workbench-types.ts'

const sessionId = 'hhpi:machine:source:codex:thread', hostId = 'runner-host'
function fixture() {
    const resource: WorkspaceResource = { target: { hostId, sessionId }, document: { kind: 'artifact', id: 'exact receipt 中文 空格' } }
    const description: SourceWorkspaceDescription = { binding: { target: { hostId: 'local', sessionId }, machineId: 'machine', workspaceId: 'workspace', root: '/source', pathStyle: 'posix' },
        registered: { files: true, documents: true, mutations: false, uploads: false, terminals: false } }
    let current = new AbortController(), scope = 'account-one', version = 'receipt-version', data = new Uint8Array([0,255,1]), gate: Promise<void> | undefined
    const calls: string[] = []
    const metadata = (): WorkspaceDocument => ({ resource: { target: description.binding.target, document: resource.document }, fileName: '报告 空格', mimeType: 'application/pdf', bytes: data.length, version, writable: false, text: null })
    const api = { async resolve() { return { ok: true, value: description } },
        async openDocument() { calls.push('metadata'); return { ok: true, value: metadata() } },
        async readDocumentBytes() { calls.push('bytes'); const value = { absolutePath: '', version, bytes: data.length, data, offset: 0, eof: true }; await gate; return { ok: true, value } },
    } as unknown as SourceWorkspaceApi
    const client = createSourceFileClient(api, { captureWorkspaceAccess() { const captured = current; return { scope, signal: captured.signal, assertCurrent() { captured.signal.throwIfAborted() } } } },
        { hostId, fetch: async () => { throw new Error('Document bytes must use their own Remote, never global fetch') } })
    return { resource, client, api, calls,
        block(value: Promise<void>) { gate = value }, swap() { current.abort(); current = new AbortController(); scope = 'account-two' },
        revise() { version = 'next-source-version' }, text(value: string, mimeType = 'text/markdown') { data = new TextEncoder().encode(value); const original = api.openDocument; api.openDocument = async (...args) => { const result = await original(...args); return result.ok ? { ok: true, value: { ...result.value, text: value, mimeType } } : result } },
    }
}
const signal = () => new AbortController().signal

test('source document addresses retain exact Host/session/opaque identities without client-supplied MIME or filesystem guesses', () => {
    const f = fixture(), address = workspaceDocumentAddress(f.resource)
    assert.deepEqual(parseWorkspaceDocumentAddress(address), f.resource)
    assert.equal(parseWorkspaceDocumentAddress(address + '?mime=text/html'), null)
    assert.equal(parseWorkspaceDocumentAddress(address + '#latest'), null)
    assert.equal(parseWorkspaceDocumentAddress(address.replace('hhpi-document/', 'hapi-artifact/')), null)
    assert.throws(() => workspaceDocumentAddress({ ...f.resource, target: { hostId, sessionId: 'display-alias' } }))
    const card = workspaceAttachmentResource(f.resource.target, { attachmentId: 'sha256:opaque', name: '中文 / 名字.pdf' })
    assert.deepEqual(parseWorkspaceDocumentAddress(workspaceDocumentAddress(card)), card)
    assert.equal(card.document.kind === 'artifact' && card.document.id, 'attachment:sha256%3Aopaque/%E4%B8%AD%E6%96%87%20%2F%20%E5%90%8D%E5%AD%97.pdf')
})

test('extensionless PDF and binary originals use the same captured source service and survive explicit reload', async () => {
    const f = fixture(), loaded = await loadWorkspaceArtifact(f.client, f.resource, signal())
    assert.deepEqual(artifactViewers(loaded.metadata), ['pdf'])
    const presentation = await workspaceArtifactPresentation(loaded, 'pdf', signal())
    assert.deepEqual(presentation.content, { kind: 'bytes', data: new Uint8Array([0,255,1]) })
    assert.equal(presentation.converted, false)
    assert.deepEqual(await readWorkspaceArtifactBytes(loaded, signal()), new Uint8Array([0,255,1]))
    const reopened = await loadWorkspaceArtifact(f.client, parseWorkspaceDocumentAddress(workspaceDocumentAddress(f.resource))!, signal())
    assert.equal(reopened.metadata.fileName, '报告 空格')
    assert.deepEqual(await readWorkspaceArtifactBytes(reopened, signal()), new Uint8Array([0,255,1]))
    assert.deepEqual(artifactViewers({ ...loaded.metadata, mimeType: 'audio/ogg', text: null }), [])
    assert.deepEqual(artifactViewers({ ...loaded.metadata, mimeType: 'video/mp4', text: null }), [])
})

test('foreign Host addresses and forged document results are refused before any original bytes can be consumed', async () => {
    const f = fixture()
    await assert.rejects(loadWorkspaceArtifact(f.client, { ...f.resource, target: { hostId: 'another-host', sessionId } }, signal()), /another Host/)
    assert.equal(f.calls.length, 0)
    const original = f.api.openDocument
    f.api.openDocument = async (...args) => { const result = await original(...args); return result.ok ? { ok: true, value: { ...result.value, resource: { target: result.value.resource.target, document: { kind: 'artifact', id: 'other-receipt' } } } } : result }
    await assert.rejects(loadWorkspaceArtifact(f.client, f.resource, signal()), /another document/)
    assert.equal(f.calls.includes('bytes'), false)
})

test('a late binary result after account replacement cannot be displayed or downloaded by the new account', async () => {
    const f = fixture(), loaded = await loadWorkspaceArtifact(f.client, f.resource, signal()), gate = Promise.withResolvers<void>()
    f.block(gate.promise)
    const reading = readWorkspaceArtifactBytes(loaded, signal())
    await Promise.resolve(); f.swap(); gate.resolve()
    await assert.rejects(reading)
    await assert.rejects(readWorkspaceArtifactBytes(loaded, signal()))
    const reopened = await loadWorkspaceArtifact(f.client, f.resource, signal())
    assert.equal(reopened.context.owner.scope, 'account-two')
})

test('opaque version changes and partial original bytes fail explicitly while Markdown remains source-authoritative', async () => {
    const f = fixture(); f.text('# 中文 原文')
    const loaded = await loadWorkspaceArtifact(f.client, f.resource, signal()), view = await workspaceArtifactPresentation(loaded, 'markdown', signal())
    assert.equal(view.content.kind === 'text' && view.content.text, '# 中文 原文')
    f.revise()
    await assert.rejects(workspaceArtifactPresentation(loaded, 'text', signal()), /changed/)
    await assert.rejects(readWorkspaceArtifactBytes(loaded, signal()), /changed/)
    const next = await loadWorkspaceArtifact(f.client, f.resource, signal()), original = f.api.readDocumentBytes
    f.api.readDocumentBytes = async (...args) => { const result = await original(...args); return result.ok ? { ok: true, value: { ...result.value, eof: false } } : result }
    await assert.rejects(readWorkspaceArtifactBytes(next, signal()), /complete original/)
})
