/** Transient source content for official DSH document renderers; never persisted into layout. */
import type { DocumentContent } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { MAX_DOCUMENT_BYTES, type NativeWorkbenchApi, type WorkbenchResponse } from '../workbench-types.ts'
import type { SourceDocumentReference } from '../workspace/artifacts.ts'
import { remoteValue } from '../client-api.ts'

export type ArtifactViewer = 'pdf' | 'markdown' | 'code' | 'text' | 'image' | 'html'
export interface LoadedArtifact { reference: SourceDocumentReference; metadata: WorkbenchResponse<'nativeDocument'> }
export interface ArtifactPresentation { viewer: ArtifactViewer; content: DocumentContent; converted: boolean }
export type ArtifactApi = Pick<NativeWorkbenchApi, 'nativeDocument' | 'nativePreview'>

/** A source operation that never settles must end in an explicit failure, not a permanent loading state. */
export const SOURCE_METADATA_DEADLINE_MS = 120_000
export const SOURCE_DOCUMENT_DEADLINE_MS = 180_000
const DOWNLOAD_DEADLINE_MS = 180_000
const STALLED = 'The source document did not finish in time. Check that its machine is online and retry; the original file can still be downloaded.'

/** Race one Host call against a deadline so a lost Remote response becomes a visible, retryable error. */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
        ])
    } finally { if (timer !== undefined) clearTimeout(timer) }
}

export function authenticatedSourceUrl(value: string, base: string): URL {
    const address = new URL(value, base)
    if (address.origin !== new URL(base).origin || !['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
        throw new Error('Source document bytes must use this authenticated Host')
    }
    return address
}

/** Reject as soon as the lifetime ends, so a stalled stream cannot outlive its deadline. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = (): void => reject(signal.reason)
        if (signal.aborted) { abort(); return }
        signal.addEventListener('abort', abort, { once: true })
        work.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
            error => { signal.removeEventListener('abort', abort); reject(error) })
    })
}

/** Bound streamed bytes as well as Content-Length; a source can change during a read. */
export async function readArtifactBytes(value: string, base: string, signal: AbortSignal, fetcher: typeof fetch = fetch,
    deadlineMs = DOWNLOAD_DEADLINE_MS): Promise<Uint8Array<ArrayBuffer>> {
    signal.throwIfAborted()
    // The body is bounded but the transport is not: a Host that stops sending
    // after its headers would otherwise keep the preview loading forever.
    const download = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)])
    const stalled = (): boolean => !signal.aborted && download.aborted
    try {
        const response = await abortable(fetcher(authenticatedSourceUrl(value, base).href, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: download }), download)
        if (!response.ok) throw new Error(`Source document download failed (${response.status})`)
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) { await response.body?.cancel(); throw new Error('Source document exceeds the 64 MiB preview limit') }
        if (!response.body) return new Uint8Array()
        const reader = response.body.getReader(), chunks: Uint8Array[] = []
        let length = 0
        try {
            while (true) {
                download.throwIfAborted()
                const part = await abortable(reader.read(), download)
                if (part.done) break
                length += part.value.byteLength
                if (length > MAX_DOCUMENT_BYTES) throw new Error('Source document exceeds the 64 MiB preview limit')
                chunks.push(part.value)
            }
        } catch (error) { await reader.cancel().catch(() => {}); throw error }
        finally { reader.releaseLock() }
        download.throwIfAborted()
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        return bytes
    } catch (error) {
        // Only the internal deadline becomes a stale explanation; caller
        // cancellation keeps its own abort semantics.
        throw stalled() ? new Error(STALLED, { cause: error }) : error
    }
}

export async function loadArtifact(api: ArtifactApi, reference: SourceDocumentReference, signal: AbortSignal,
    deadlineMs = SOURCE_METADATA_DEADLINE_MS): Promise<LoadedArtifact> {
    signal.throwIfAborted()
    const metadata = remoteValue(await withDeadline(api.nativeDocument(reference), deadlineMs, STALLED))
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
    base: string, signal: AbortSignal, fetcher: typeof fetch = fetch, deadlineMs = SOURCE_DOCUMENT_DEADLINE_MS): Promise<ArtifactPresentation> {
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
        const preview = remoteValue(await withDeadline(api.nativePreview({ ...reference, ...(metadata.hash ? { version: metadata.hash } : {}) }), deadlineMs, STALLED))
        signal.throwIfAborted()
        url = preview.url
    }
    return { viewer, converted, content: { kind: 'bytes', data: await readArtifactBytes(url, base, signal, fetcher, deadlineMs) } }
}
