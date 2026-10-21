/** Source identities stay addresses; opaque artifact ids never become filesystem paths. */
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { nativeDocumentRefSchema, workbenchSourceSchema, type NativeDocumentRef, type WorkbenchSource } from '../workbench-types.ts'
import type { DshPaneTarget } from './dsh-view.ts'

export const ARTIFACT_PROTOCOL = 'hapi-artifact'
export const GENERATED_MEDIA_PROTOCOL = 'hapi-generated-media'
export const ARTIFACT_TAB_KIND = 'hapi-artifact'
export const ARTIFACT_TAB_ID = 'hapi-dsh/artifact'
export type ArtifactDocumentRef = Extract<NativeDocumentRef, { kind: 'artifact' }>
export interface ArtifactReference { source: WorkbenchSource; document: ArtifactDocumentRef }
export type GeneratedMediaDocumentRef = Extract<NativeDocumentRef, { kind: 'generated-media' }>
export interface GeneratedMediaReference { source: WorkbenchSource; document: GeneratedMediaDocumentRef }
export type SourceDocumentReference = ArtifactReference | GeneratedMediaReference

/** Decode only the original HAPI file-artifact grammar, including strict UTF-8. */
export function sessionFileArtifactPath(id: string): string | null {
    if (!id.startsWith('session-file:')) return null
    const encoded = id.slice('session-file:'.length)
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1 || encoded.length > 43_692) return null
    try {
        const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))
        // Reject noncanonical spare bits; different ids must not silently alias.
        if (btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== encoded) return null
        const path = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
        if (!path || path.length > 8192 || /[\u0000-\u001f\u007f]/u.test(path)) return null
        return path
    } catch { return null }
}

/** A durable artifact URL carries its actual source address independently of display generations. */
export function artifactResourceAddress(reference: ArtifactReference): string {
    const source = workbenchSourceSchema.parse(reference.source), document = nativeDocumentRefSchema.parse(reference.document)
    if (document.kind !== 'artifact') throw new Error('Expected an opaque source artifact')
    const address = new URL(`dsh-resource://${ARTIFACT_PROTOCOL}/session/${encodeURIComponent(source.sourceSessionId)}/${encodeURIComponent(document.artifactId)}`)
    if (source.sourceHubId) address.searchParams.set('hub', source.sourceHubId)
    if (source.machineId) address.searchParams.set('machine', source.machineId)
    address.searchParams.set('name', document.fileName)
    address.searchParams.set('mime', document.mimeType)
    if (address.href.length > 16_384) throw new Error('The original artifact address exceeds the workspace resource limit')
    return address.href
}

export function parseArtifactResourceAddress(value: string): ArtifactReference | null {
    try {
        if (value.length > 16_384) return null
        const address = new URL(value)
        if (address.protocol !== 'dsh-resource:' || address.hostname !== ARTIFACT_PROTOCOL || address.username || address.password || address.port || address.hash) return null
        const segments = address.pathname.split('/')
        if (segments.length !== 4 || segments[1] !== 'session') return null
        const source = workbenchSourceSchema.parse({ sourceSessionId: decodeURIComponent(segments[2]!),
            ...(address.searchParams.has('hub') ? { sourceHubId: address.searchParams.get('hub') } : {}),
            ...(address.searchParams.has('machine') ? { machineId: address.searchParams.get('machine') } : {}),
        })
        const document = nativeDocumentRefSchema.parse({ kind: 'artifact', artifactId: decodeURIComponent(segments[3]!),
            fileName: address.searchParams.get('name') ?? '', mimeType: address.searchParams.get('mime') ?? '',
        })
        if (document.kind !== 'artifact') return null
        return { source, document }
    } catch { return null }
}

/** Generated media has its own actual source registry and never becomes an artifact or file path. */
export function generatedMediaResourceAddress(reference: GeneratedMediaReference): string {
    const source = workbenchSourceSchema.parse(reference.source), document = nativeDocumentRefSchema.parse(reference.document)
    if (document.kind !== 'generated-media') throw new Error('Expected an original generated media reference')
    const address = new URL(`dsh-resource://${GENERATED_MEDIA_PROTOCOL}/session/${encodeURIComponent(source.sourceSessionId)}/${encodeURIComponent(document.imageId)}`)
    if (source.sourceHubId) address.searchParams.set('hub', source.sourceHubId)
    if (source.machineId) address.searchParams.set('machine', source.machineId)
    address.searchParams.set('name', document.fileName); address.searchParams.set('mime', document.mimeType)
    if (address.href.length > 16_384) throw new Error('The generated media address exceeds the workspace resource limit')
    return address.href
}

export function parseGeneratedMediaResourceAddress(value: string): GeneratedMediaReference | null {
    try {
        if (value.length > 16_384) return null
        const address = new URL(value)
        if (address.protocol !== 'dsh-resource:' || address.hostname !== GENERATED_MEDIA_PROTOCOL || address.username || address.password || address.port || address.hash) return null
        const segments = address.pathname.split('/')
        if (segments.length !== 4 || segments[1] !== 'session') return null
        const source = workbenchSourceSchema.parse({ sourceSessionId: decodeURIComponent(segments[2]!),
            ...(address.searchParams.has('hub') ? { sourceHubId: address.searchParams.get('hub') } : {}),
            ...(address.searchParams.has('machine') ? { machineId: address.searchParams.get('machine') } : {}),
        })
        const document = nativeDocumentRefSchema.parse({ kind: 'generated-media', imageId: decodeURIComponent(segments[3]!),
            fileName: address.searchParams.get('name') ?? '', mimeType: address.searchParams.get('mime') ?? '',
        })
        if (document.kind !== 'generated-media') return null
        return { source, document }
    } catch { return null }
}

export function parseSourceDocumentResourceAddress(value: string): SourceDocumentReference | null {
    return parseArtifactResourceAddress(value) ?? parseGeneratedMediaResourceAddress(value)
}

/** Files use the official protocol. Only genuinely opaque documents need the source-owned tab. */
export function documentPaneTarget(displaySessionId: string, document: NativeDocumentRef, source?: WorkbenchSource): DshPaneTarget {
    const path = document.kind === 'file' ? document.path : document.kind === 'artifact' ? sessionFileArtifactPath(document.artifactId) : null
    if (path !== null) return { type: 'resource', address: sessionFileAddress(displaySessionId, path) }
    if (!source) throw new Error('This artifact still requires its original HAPI source session. Its saved reference is preserved.')
    if (document.kind === 'generated-media') return { type: 'resource', address: generatedMediaResourceAddress({ source, document }) }
    if (document.kind !== 'artifact') throw new Error('Invalid artifact reference')
    return { type: 'resource', address: artifactResourceAddress({ source, document }) }
}
