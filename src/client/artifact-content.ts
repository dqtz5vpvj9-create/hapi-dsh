/** Transient source content for official DSH document renderers; never persisted into layout. */
import type { DocumentContent } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { MAX_DOCUMENT_BYTES, type NativeWorkbenchApi, type WorkbenchResponse } from '../workbench-types.ts'
import type { SourceDocumentReference } from '../workspace/artifacts.ts'
import { remoteValue } from '../client-api.ts'

export type ArtifactViewer = 'pdf' | 'markdown' | 'code' | 'text' | 'image' | 'html'
export interface LoadedArtifact { reference: SourceDocumentReference; metadata: WorkbenchResponse<'nativeDocument'> }
export interface ArtifactPresentation { viewer: ArtifactViewer; content: DocumentContent; converted: boolean }
export type ArtifactApi = Pick<NativeWorkbenchApi, 'nativeDocument' | 'nativePreview'>

export function authenticatedSourceUrl(value: string, base: string): URL {
    const address = new URL(value, base)
    if (address.origin !== new URL(base).origin || !['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
        throw new Error('Source document bytes must use this authenticated Host')
    }
    return address
}

/** Bound streamed bytes as well as Content-Length; a source can change during a read. */
export async function readArtifactBytes(value: string, base: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Uint8Array<ArrayBuffer>> {
    signal.throwIfAborted()
    const response = await fetcher(authenticatedSourceUrl(value, base).href, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal })
    if (!response.ok) throw new Error(`Source document download failed (${response.status})`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) { await response.body?.cancel(); throw new Error('Source document exceeds the 64 MiB preview limit') }
    if (!response.body) return new Uint8Array()
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let length = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const part = await reader.read()
            if (part.done) break
            length += part.value.byteLength
            if (length > MAX_DOCUMENT_BYTES) throw new Error('Source document exceeds the 64 MiB preview limit')
            chunks.push(part.value)
        }
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
    finally { reader.releaseLock() }
    signal.throwIfAborted()
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
}

export async function loadArtifact(api: ArtifactApi, reference: SourceDocumentReference, signal: AbortSignal): Promise<LoadedArtifact> {
    signal.throwIfAborted()
    const metadata = remoteValue(await api.nativeDocument(reference))
    signal.throwIfAborted()
    return { reference, metadata }
}

/** Viewer choices follow actual source content. No binary file is guessed into source text. */
export function artifactViewers(metadata: WorkbenchResponse<'nativeDocument'>, candidates: readonly { id: string }[] = []): ArtifactViewer[] {
    const name = metadata.fileName.toLowerCase(), mime = metadata.mimeType.split(';', 1)[0]!.trim().toLowerCase()
    if (metadata.officePreview || mime === 'application/pdf' || name.endsWith('.pdf')) return ['pdf']
    if (/^image\/(?:png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(mime)) return metadata.text === null ? ['image'] : ['image', 'text']
    if (metadata.text === null) return []
    if (/\.html?$/.test(name) || mime === 'text/html') return ['html', 'code', 'text']
    if (/\.(?:md|markdown|mdown)$/.test(name) || mime === 'text/markdown') return ['markdown', 'code', 'text']
    return candidates.some(value => value.id === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/code') ? ['code', 'text'] : ['text', 'code']
}

export async function artifactPresentation(api: ArtifactApi, loaded: LoadedArtifact, viewer: ArtifactViewer,
    base: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ArtifactPresentation> {
    const { metadata, reference } = loaded
    signal.throwIfAborted()
    if (viewer === 'text' || viewer === 'code' || viewer === 'markdown') {
        if (metadata.text === null) throw new Error('The source did not identify this document as readable text')
        return { viewer, converted: false, content: { kind: 'text', text: metadata.text, eof: true,
            pages: [{ offset: 1, text: metadata.text, lines: metadata.text.split('\n').length }],
        } }
    }
    const converted = viewer === 'pdf' && metadata.officePreview
    let url = metadata.downloadUrl
    if (converted) {
        const preview = remoteValue(await api.nativePreview({ ...reference, ...(metadata.hash ? { version: metadata.hash } : {}) }))
        signal.throwIfAborted()
        url = preview.url
    }
    return { viewer, converted, content: { kind: 'bytes', data: await readArtifactBytes(url, base, signal, fetcher) } }
}
