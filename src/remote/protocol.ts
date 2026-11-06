import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/types'
/** HHPI source wire, v1. Native DSH continues using its unchanged federation wire. */
import type { CodexAccessBridge } from './codex-access-bridge.ts';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';

export interface SourceIdentity { machineId: string; sourceId: string; engine: string; nativeId: string }
export function sourceSessionId(source: SourceIdentity): string {
    return `hhpi:${[source.machineId, source.sourceId, source.engine, source.nativeId].map(encodeURIComponent).join(':')}`;
}
/** Prefix recognition also captures invalid IDs, so they never fall through to local resources. */
export function isSourceSessionId(value: string): boolean { return value.startsWith('hhpi:'); }
export function parseSourceSessionId(value: string): SourceIdentity {
    const parts = value.split(':');
    if (parts.length !== 5 || parts.shift() !== 'hhpi') throw new Error('Invalid source session identity');
    let decoded: string[];
    try { decoded = parts.map(decodeURIComponent); } catch { throw new Error('Invalid source session identity'); }
    if (decoded.some(part => part.length === 0 || part.includes('\0'))) throw new Error('Invalid source session identity');
    const [machineId, sourceId, engine, nativeId] = decoded as [string, string, string, string];
    const identity = { machineId, sourceId, engine, nativeId };
    if (sourceSessionId(identity) !== value) throw new Error('Non-canonical source session identity');
    return identity;
}

/** seq is allocated once by the source index, never by a browser or a page. */
export interface SourceEntry { type: 'event'; event: SessionEvent }
export interface SourceCapabilities { send: boolean; steer: boolean; cancel: boolean; approve: boolean; files: boolean; images?: boolean | undefined }
export interface SourceApproval { id: string; method: string; turnId: string | null; itemId: string | null; params: Record<string, unknown> }
export interface SourceSession extends SourceIdentity {
    id: string; title: string; cwd: string; updatedAt: number;
    status: 'idle' | 'running' | 'waiting' | 'offline'; activeTurnId: string | null;
    /** Legacy status=offline remains readable; new sources retain execution state across outages. */
    connection?: { state: 'online' | 'offline'; observedAt: number } | undefined;
    capabilities: SourceCapabilities; pendingRequests: SourceApproval[];
    codex?: { model: string | null; reasoningEffort: string | null; parentThreadId: string | null; agentNickname: string | null; settings?: Record<string, unknown> | undefined } | undefined;
    /** Exact pre-cutover resource, advertised only by its verified native owner. */
    legacyOrigin?: { hubId: string; sessionId: string } | undefined;
}
export interface SourceReadRequest { sessionId: string; before?: number; after?: number; around?: number; limit?: number; epoch?: string }
export interface SourcePage {
    session: SourceSession; epoch: string; version: number; entries: SourceEntry[];
    /** Exclusive boundaries of body entries; dependencies never advance these. */
    before: number | null; after: number | null; hasBefore: boolean; hasAfter: boolean;
    context: number[];
}
export interface SourceChanges {
    session: SourceSession; epoch: string; base: number; version: number; reset: boolean;
    upserts: SourceEntry[]; removed: number[];
}
export interface SourceChangesRequest { sessionId: string; epoch: string; version: number }
export interface SourceOperation {
    sessionId: string; operationId: string; kind: 'send' | 'steer' | 'cancel' | 'approve';
    text?: string; turnId?: string; requestId?: string;
    response?: Record<string, unknown>;
    files?: string[];
    images?: Array<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string }>;
    decision?: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
}
export interface SourceReceipt {
    operationId: string; sessionId: string; status: 'accepted' | 'rejected' | 'indeterminate';
    message: string; turnId?: string;
    /** A native write was proven not to have been dispatched. Only this result permits the same ID to retry. */
    retryable?: true;
    /** Native user-message coordinates, never inferred from matching text. */
    observed?: { epoch: string; seq: number };
    /** The original execution owner durably stores this exact local ID; this says nothing about native execution or completion. */
    ownerAdmission?: { localId: string; state: 'queued' | 'dispatching' | 'indeterminate' | 'consumed' };
}
export interface SourceUploadRequest { sessionId: string; operationId: string; name: string; data: string }
export interface SourceResourceRequest { sessionId: string; path: string }
export interface SourceResource { encoding: 'base64'; content: string; mimeType: string; attachment?: ImageAttachmentRef }
export interface SourceCreateRequest { sourceId: string; operationId: string; cwd?: string }
export interface SourceCreationReceipt { sourceId: string; operationId: string; status: 'accepted' | 'rejected' | 'indeterminate'; message: string; session?: SourceSession }
export interface SourceCatalog { protocol: 1; legacyHapi: boolean; storageScope?: string; sessions: SourceSession[]; sources: Array<{ id: string; machineId: string; engine: string; online: boolean; create: boolean }> }

/** Each adapter owns its native protocol and operations. It never creates a DSH Agent. */
export interface SourceAdapter {
    readonly id: string; readonly machineId: string; readonly engine: string;
    readonly nativeAccess?: CodexAccessBridge;
    upload?(request: SourceUploadRequest, signal?: AbortSignal): Promise<FileUploadValue>;
    list(signal?: AbortSignal): Promise<SourceSession[]>;
    /** Resolve an authorized original identity without waiting for the complete directory. */
    resolve?(sessionId: string, signal?: AbortSignal): Promise<SourceSession>;
    read(request: SourceReadRequest, signal?: AbortSignal): Promise<SourcePage>;
    changes(request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges>;
    operate(request: SourceOperation): Promise<SourceReceipt>;
    /** Read an existing immutable operation identity without creating or executing it. */
    receipt?(request: SourceOperation, signal?: AbortSignal): Promise<SourceReceipt | null>;
    create?(request: SourceCreateRequest): Promise<SourceCreationReceipt>;
    readResource?(request: SourceResourceRequest, signal?: AbortSignal): Promise<SourceResource>;
    dispose(): void | Promise<void>;
}
export interface DirectCodexConfig {
    id: string; machineId: string; engine: 'codex'; endpoint?: string;
    command?: string; args?: string[]; cwd?: string; codexHome?: string;
    /** shared/default: explicit sends may resume the same persisted thread when
     * the operator verified that all writers use the native cross-process lock.
     * exclusive: the operator assigns this Codex home to this app-server and
     * also permits explicit resume on older runtimes. Reads never resume. */
    ownership?: 'shared' | 'exclusive';
    /** Operator-verified source capability; never inferred from a version string. */
    writerLock?: 'native';
    /** Source-local, read-only native metadata helper for a forwarded app-server. */
    historyMetadata?: { command: string; args?: string[] };
}
/** Native DSH body stays in its official persistence; the existing owner retains all writes. */
export interface DirectDshConfig {
    id: string; machineId: string; engine: 'dsh'; root: string;
    owner: { hubId: string; url: string; tokenEnv: string };
}
export type DirectSourceConfig = DirectCodexConfig | DirectDshConfig;
