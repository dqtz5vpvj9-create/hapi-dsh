/** Resolve authored paths only within an explicitly identified HAPI source. */
import { isAbsoluteWorkspacePath, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import { WORKBENCH_DOCUMENT_PATH, type WorkbenchSource } from '../workbench-types.ts'
import type { QueuedAttachment } from '../codex/projection-types.ts'

export function sourceDocumentPath(destination: string, documentPath?: string): string | undefined {
    const suffix = destination.search(/[?#]/u)
    let path: string
    try { path = decodeURIComponent(suffix < 0 ? destination : destination.slice(0, suffix)) }
    catch { return undefined }
    if (!path || /[\u0000-\u001f\u007f]/u.test(path)) return undefined
    const windowsDrive = /^[a-z]:[/\\]/iu.test(path)
    if (!windowsDrive && /^[a-z][a-z\d+.-]*:/iu.test(path)) return undefined
    if (isAbsoluteWorkspacePath(path)) return path
    return documentPath && isAbsoluteWorkspacePath(documentPath) ? pathPartsOf(documentPath).directory + path : undefined
}

/** Same authenticated binary route as a source download, now with a real session and machine. */
export function sourceDocumentUrl(source: WorkbenchSource, path: string, base: string): string {
    const address = new URL(WORKBENCH_DOCUMENT_PATH, base)
    if (!['http:', 'https:'].includes(address.protocol)) throw new Error('Source media requires the authenticated Web Host')
    address.searchParams.set('request', JSON.stringify({ source, document: { kind: 'file', path, ...(source.machineId ? { machineId: source.machineId } : {}) } }))
    return address.href
}

export function sourceDocumentImageUrl(source: WorkbenchSource, destination: string, base: string, documentPath?: string): string | undefined {
    const path = sourceDocumentPath(destination, documentPath)
    return path === undefined ? undefined : sourceDocumentUrl(source, path, base)
}

/** Uploads can be outside cwd: the original Runner's artifact route authorizes them. */
export function sourceAttachmentImageUrl(source: WorkbenchSource, attachment: QueuedAttachment, base: string): string | undefined {
    if (!/^image\/(png|jpeg|webp|gif|avif|bmp)$/i.test(attachment.mimeType) || !attachment.path) return undefined
    const encoded = btoa(Array.from(new TextEncoder().encode(attachment.path), byte => String.fromCharCode(byte)).join(''))
        .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    const address = new URL(WORKBENCH_DOCUMENT_PATH, base)
    if (!['http:', 'https:'].includes(address.protocol)) return undefined
    address.searchParams.set('request', JSON.stringify({ source, document: { kind: 'artifact', artifactId: `session-file:${encoded}`,
        fileName: attachment.filename, mimeType: attachment.mimeType } }))
    return address.href
}
