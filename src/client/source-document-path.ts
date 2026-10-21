/** Resolve authored paths only within an explicitly identified HAPI source. */
import { isAbsoluteWorkspacePath, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import { WORKBENCH_DOCUMENT_PATH, type WorkbenchSource } from '../workbench-types.ts'

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
