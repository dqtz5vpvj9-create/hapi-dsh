/**
 * Routing references adapted from HAPI shared/src/documents.ts at 0f8ef697.
 * Copyright HAPI contributors. SPDX-License-Identifier: AGPL-3.0-only
 * File bytes, editor drafts and execution state never enter a layout document.
 */
export type DocumentRef =
    | { kind: 'file'; path: string; machineId?: string }
    | { kind: 'artifact'; artifactId: string; fileName: string; mimeType: string }

export function parseDocumentRef(value: unknown): DocumentRef {
    if (!value || typeof value !== 'object') throw new Error('Invalid document reference')
    const field = (key: string, max: number, empty = false): string => {
        const item: unknown = Reflect.get(value, key)
        if (typeof item !== 'string' || (!empty && !item.length) || item.length > max) throw new Error('Invalid document reference')
        return item
    }
    if (Reflect.get(value, 'kind') === 'file') {
        const machineId: unknown = Reflect.get(value, 'machineId')
        return { kind: 'file', path: field('path', 8192), ...(machineId === undefined ? {} : { machineId: field('machineId', 256) }) }
    }
    if (Reflect.get(value, 'kind') === 'artifact') return { kind: 'artifact', artifactId: field('artifactId', 8192), fileName: field('fileName', 1024, true), mimeType: field('mimeType', 256, true) }
    throw new Error('Invalid document reference')
}

function normalizedFilePath(path: string): string {
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path)
    const value = windows ? path.replaceAll('\\', '/').toLowerCase() : path
    const prefix = value.startsWith('//') && windows ? '//' : value.startsWith('/') ? '/' : ''
    const segments: string[] = []
    for (const part of value.slice(prefix.length).split('/')) {
        if (!part || part === '.') continue
        if (part === '..' && segments.length && segments.at(-1) !== '..') segments.pop()
        else if (part !== '..' || !prefix) segments.push(part)
    }
    return prefix + segments.join('/')
}

export function documentKey(resource: { sessionId: string; sourceSessionId?: string; sourceHubId?: string; document: DocumentRef }): string {
    const ref = resource.document
    const session = resource.sourceSessionId ?? resource.sessionId
    return JSON.stringify(ref.kind === 'file'
        ? ['file', resource.sourceHubId ?? '', ref.machineId ?? session, normalizedFilePath(ref.path)]
        : ['artifact', resource.sourceHubId ?? '', session, ref.artifactId])
}

export function documentName(ref: DocumentRef): string {
    return (ref.kind === 'file' ? ref.path.split(/[\\/]/).at(-1) : ref.fileName) || 'Document'
}
