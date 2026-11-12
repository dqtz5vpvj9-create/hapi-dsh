/** Internal source-workspace services. Authentication comes from the current Gateway invocation. */
import type { WorkspaceByteReadOptions, WorkspaceDirectoryListing, WorkspaceFileBytes, WorkspaceFileRange,
    WorkspaceFileStat, WorkspaceFileText, WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types';
import type { TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalInput, TerminalRetentionFrame,
    TerminalShell, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types';
import type { FileUploadValue, ImageUploadValue } from '@deepseek-ai/dsh-client-file-upload/types';
import type { RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol';
import type { SourceRoute } from '../shared/source-capability.ts';
import type { NativeTextFormat, WorkspaceDocumentRef, WorkspaceFileManageRequest, WorkspaceFileSaveRequest,
    WorkspaceResource, WorkspaceTarget, WorkspaceUploadChunk, WorkspaceUploadDestination, WorkspaceUploadRequest,
    WorkspaceUploadStart } from '../workbench-types.ts';

export type WorkspaceAction = 'read' | 'list' | 'watch' | 'save' | 'manage' | 'upload' | 'terminal';

/** Server-created call authority; none of these fields is accepted from a workspace request body. */
export interface WorkspaceAccess {
    /** Authenticated account/storage namespace, safe for cache and draft partitioning. */
    readonly scope: string;
    /** Request/peer/revocation cancellation. A cancelled view does not dispose a terminal owner. */
    readonly signal: AbortSignal;
    /** Check current server grants. Executors must check again at their actual mutation commit point. */
    assertAllowed(target: WorkspaceTarget, action: WorkspaceAction): void | Promise<void>;
}

/** Authoritative source metadata, resolved without creating an execution Agent. */
export interface WorkspaceBinding {
    readonly target: WorkspaceTarget;
    readonly machineId: string;
    /** Stable source-owned workspace identity, including reconfiguration to a different root. */
    readonly workspaceId: string;
    readonly root: string;
    readonly pathStyle: 'posix' | 'win32';
}

/** The official read-only Files results and path rules apply unchanged. */
export interface WorkspaceReadService {
    read(path: string, range: WorkspaceFileRange, access: WorkspaceAccess): Promise<WorkspaceFileText>;
    readBytes(path: string, options: WorkspaceByteReadOptions, access: WorkspaceAccess): Promise<WorkspaceFileBytes>;
    stat(path: string, access: WorkspaceAccess): Promise<WorkspaceFileStat>;
    list(path: string, access: WorkspaceAccess): Promise<WorkspaceDirectoryListing>;
    changes(path: string, access: WorkspaceAccess): AsyncIterable<WorkspaceFileWatchFrame>;
}

/** Text is decoded only for supported editable files; original bytes remain available separately. */
export interface WorkspaceDocument {
    readonly resource: WorkspaceResource;
    readonly fileName: string;
    readonly mimeType: string;
    readonly bytes: number;
    readonly version: string;
    readonly modified?: number;
    readonly writable: boolean;
    readonly text: string | null;
    readonly format?: NativeTextFormat;
}

export interface WorkspaceEntry {
    readonly absolutePath: string;
    readonly name: string;
    readonly type: 'file' | 'directory' | 'symlink';
    readonly version: string;
    readonly bytes: number;
    readonly modified?: number;
    readonly entryCount?: number;
}

/** A source may implement several documents through the same authorized file service. */
export interface WorkspaceDocumentService {
    open(document: WorkspaceDocumentRef, access: WorkspaceAccess): Promise<WorkspaceDocument>;
    bytes(document: WorkspaceDocumentRef, options: WorkspaceByteReadOptions, access: WorkspaceAccess): Promise<WorkspaceFileBytes>;
    inspect(path: string, access: WorkspaceAccess): Promise<WorkspaceEntry | null>;
    search(query: string, limit: number, access: WorkspaceAccess): Promise<readonly WorkspaceEntry[]>;
    git(request: { kind: 'status' | 'numstat' | 'diff'; path?: string; staged?: boolean },
        access: WorkspaceAccess): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Unknown outcomes are reconciled by operation identity; callers never blindly repeat a mutation. */
export type WorkspaceMutationResult<Value> =
    | { readonly status: 'applied'; readonly operationId: string; readonly value: Value }
    | { readonly status: 'conflict'; readonly operationId: string; readonly currentVersion: string | null }
    | { readonly status: 'rejected'; readonly operationId: string;
        readonly code: 'denied' | 'not-found' | 'invalid' | 'too-large' | 'unsupported'; readonly message: string }
    | { readonly status: 'indeterminate'; readonly operationId: string };

/** Version comparisons are source-owned. Ordinary read-then-write is not an external-process CAS. */
export interface WorkspaceMutationService {
    save(request: WorkspaceFileSaveRequest, access: WorkspaceAccess): Promise<WorkspaceMutationResult<WorkspaceFileStat>>;
    /** Creation/copy/move destinations do not overwrite existing entries. */
    manage(request: WorkspaceFileManageRequest, access: WorkspaceAccess): Promise<WorkspaceMutationResult<WorkspaceEntry | null>>;
    /** Read the original result without executing the original operation again. */
    receipt(operationId: string, access: WorkspaceAccess): Promise<WorkspaceMutationResult<WorkspaceFileStat | WorkspaceEntry | null> | null>;
}

export interface WorkspaceUploadTransfer {
    readonly uploadId: string;
    readonly target: WorkspaceTarget;
    readonly operationId: string;
    readonly destination: WorkspaceUploadDestination;
    readonly bytes: number;
    readonly receivedBytes: number;
    readonly chunkBytes: number;
    readonly maxBytes: number;
}

export type WorkspaceUploadReceipt =
    | { readonly kind: 'file'; readonly resource: WorkspaceResource; readonly file: WorkspaceFileStat }
    | { readonly kind: 'attachment'; readonly resource: WorkspaceResource; readonly value: FileUploadValue | ImageUploadValue };
export type WorkspaceUploadStatus =
    | { readonly state: 'uploading'; readonly transfer: WorkspaceUploadTransfer }
    | { readonly state: 'finished'; readonly result: WorkspaceMutationResult<WorkspaceUploadReceipt> }
    | { readonly state: 'cancelled' };

/** Binary chunks use the existing authenticated carrier, never an HHPI v1 addition or base64-only body. */
export interface WorkspaceUploadService {
    begin(request: WorkspaceUploadStart, access: WorkspaceAccess): Promise<WorkspaceUploadTransfer>;
    /** Accept only the current byte offset. After an uncertain reply, status decides where to resume. */
    append(request: WorkspaceUploadChunk, access: WorkspaceAccess): Promise<{ readonly receivedBytes: number }>;
    status(request: WorkspaceUploadRequest, access: WorkspaceAccess): Promise<WorkspaceUploadStatus>;
    finish(request: WorkspaceUploadRequest, access: WorkspaceAccess): Promise<WorkspaceMutationResult<WorkspaceUploadReceipt>>;
    /** Cancels only uncommitted bytes; it never undoes a committed source file. */
    cancel(request: WorkspaceUploadRequest, access: WorkspaceAccess): Promise<WorkspaceUploadStatus>;
}

/** User terminals run as the real source system user, independently of Agent sandbox mode. */
export interface WorkspaceTerminalOwner {
    readonly binding: WorkspaceBinding;
    readonly permissions: 'system-user';
    /** New after owner restart. An unavailable old process must never be replaced as recovery. */
    readonly lifetimeId: string;
    /** Source owner lifetime, independent of Pane and physical attachment cancellation. */
    readonly signal: AbortSignal;
}

/** Reuse the official terminal controller core and wire types; no executor Agent is constructed. */
export interface WorkspaceTerminalService {
    readonly owner: WorkspaceTerminalOwner;
    environment(access: WorkspaceAccess): Promise<TerminalEnvironment>;
    shells(access: WorkspaceAccess): Promise<TerminalShell[]>;
    list(access: WorkspaceAccess): Promise<WebTerminalInfo[]>;
    create(request: TerminalCreateRequest, access: WorkspaceAccess): Promise<WebTerminalInfo>;
    retain(id: WebTerminalId, access: WorkspaceAccess): AsyncIterable<TerminalRetentionFrame>;
    attach(id: WebTerminalId, input: AsyncIterable<TerminalInput>, access: WorkspaceAccess,
        inputWindow?: RemoteUplinkWindow): AsyncIterable<TerminalFrame>;
    rename(id: WebTerminalId, title: string, access: WorkspaceAccess): Promise<void>;
    close(id: WebTerminalId, access: WorkspaceAccess): Promise<void>;
}

/** Optional services describe registration, never grant permission or invite fallback execution. */
export interface WorkspaceServices {
    readonly binding: WorkspaceBinding;
    readonly files: WorkspaceReadService;
    readonly documents: WorkspaceDocumentService;
    readonly mutations?: WorkspaceMutationService;
    readonly uploads?: WorkspaceUploadService;
    readonly terminals?: WorkspaceTerminalService;
}

export interface WorkspaceProviders {
    /** The actual receiving Host, supplied by server configuration. */
    readonly localHostId: string;
    readonly 'local-dsh'?: (route: Extract<SourceRoute, { kind: 'local-dsh' }>, access: WorkspaceAccess) => Promise<WorkspaceServices>;
    readonly 'federated-dsh'?: (route: Extract<SourceRoute, { kind: 'federated-dsh' }>, access: WorkspaceAccess) => Promise<WorkspaceServices>;
    readonly hhpi?: (route: Extract<SourceRoute, { kind: 'hhpi' }>, access: WorkspaceAccess) => Promise<WorkspaceServices>;
}

declare module '@deepseek-ai/dsh-typert-protocol' {
    interface RemoteErrorDetailsMap {
        /** A source-workspace service was not installed or returned another source binding. */
        'workspace-service/unavailable': { readonly reason: 'unconfigured' | 'source-mismatch' };
        /** The call may have changed the source before access ended; reconcile its original operation. */
        'workspace-service/result-unavailable': { readonly outcome: 'indeterminate' };
    }
}
