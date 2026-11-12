import type {} from '@deepseek-ai/dsh-api-session-controller/client'
/** Account- and generation-bound source services for one actual Host graph. */
import { parseSourceSessionId } from '../remote/protocol.ts';
import type { WorkspaceTarget } from '../workbench-types.ts';
import { sourceWorkspaceProxy, type SourceWorkspaceApi } from '../workspace/source-api.ts';
import type { WorkspaceAccess, WorkspaceAction, WorkspaceMutationResult, WorkspaceServices, WorkspaceUploadReceipt, WorkspaceUploadStatus, WorkspaceUploadTransfer } from '../workspace/service-types.ts';
import type { SourceFileClient } from './source-workspace-provider.ts';
import { createSourceUploadAppend } from './source-upload-transport.ts';

export interface SourceWorkspaceTransport { readonly hostId: string; readonly fetch: typeof fetch }
export interface CapturedWorkspaceAccess { readonly scope: string; readonly signal: AbortSignal; assertCurrent(): void }
export interface SourceWorkspaceAuthority { captureWorkspaceAccess(sessionId: string): CapturedWorkspaceAccess }
declare module '@deepseek-ai/cordis' {
    interface Context { sourceWorkspaceTransport: SourceWorkspaceTransport; sourceFiles: SourceFileClient }
}
const sameTarget = (left: WorkspaceTarget, right: WorkspaceTarget) => left.hostId === right.hostId && left.sessionId === right.sessionId;
const mismatch = () => new Error('The authenticated source workspace changed. Reopen the file before continuing.');

export function createSourceFileClient(api: SourceWorkspaceApi, authority: SourceWorkspaceAuthority, transport: SourceWorkspaceTransport): SourceFileClient {
    const append = createSourceUploadAppend(transport.fetch), hostId = transport.hostId;
    return { async resolve(sessionId, callerSignal) {
        const identity = parseSourceSessionId(sessionId), captured = authority.captureWorkspaceAccess(sessionId);
        const signal = AbortSignal.any([callerSignal, captured.signal]);
        const current = () => { captured.signal.throwIfAborted(); captured.assertCurrent(); };
        signal.throwIfAborted(); current();
        const response = await api.resolve({ sessionId }, signal); signal.throwIfAborted(); current();
        if (!response.ok) throw response.error;
        const description = structuredClone(response.value), wireTarget = description.binding.target;
        if (wireTarget.hostId !== 'local' || wireTarget.sessionId !== sessionId || description.binding.machineId !== identity.machineId) throw mismatch();
        const target = Object.freeze({ hostId, sessionId }), binding = Object.freeze({ ...description.binding, target });
        // The original wire binding remains private; the UI receives only its actual Host address.
        const source = sourceWorkspaceProxy(api, description, append);
        const accessFor = (access: WorkspaceAccess): WorkspaceAccess => {
            current(); access.signal.throwIfAborted();
            if (access.scope !== captured.scope) throw mismatch();
            return { scope: captured.scope, signal: AbortSignal.any([captured.signal, access.signal]), async assertAllowed(address, action) {
                current(); access.signal.throwIfAborted(); if (!sameTarget(address, wireTarget)) throw mismatch();
                await access.assertAllowed(target, action); current(); access.signal.throwIfAborted();
            } };
        };
        const invoke = async <T>(action: WorkspaceAction, access: WorkspaceAccess, call: (wire: WorkspaceAccess) => Promise<T>): Promise<T> => {
            const wire = accessFor(access); await wire.assertAllowed(wireTarget, action);
            const value = await call(wire); await wire.assertAllowed(wireTarget, action); return value;
        };
        const requestFor = <T extends { target: WorkspaceTarget }>(request: T): T => {
            if (!sameTarget(request.target, target)) throw mismatch(); return { ...request, target: wireTarget };
        };
        const resourceFor = <T extends { target: WorkspaceTarget }>(resource: T): T => {
            if (!sameTarget(resource.target, wireTarget)) throw mismatch(); return { ...resource, target };
        };
        const transferFor = (value: WorkspaceUploadTransfer): WorkspaceUploadTransfer => ({ ...value, target: resourceFor(value).target });
        const receiptFor = (result: WorkspaceMutationResult<WorkspaceUploadReceipt>): WorkspaceMutationResult<WorkspaceUploadReceipt> => result.status !== 'applied' ? result
            : { ...result, value: { ...result.value, resource: resourceFor(result.value.resource) } };
        const statusFor = (value: WorkspaceUploadStatus): WorkspaceUploadStatus => value.state === 'uploading' ? { ...value, transfer: transferFor(value.transfer) }
            : value.state === 'finished' ? { ...value, result: receiptFor(value.result) } : value;
        const services: WorkspaceServices = { binding, files: {
            read: (path, range, access) => invoke('read', access, wire => source.files.read(path, range, wire)),
            readBytes: (path, options, access) => invoke('read', access, wire => source.files.readBytes(path, options, wire)),
            stat: (path, access) => invoke('read', access, wire => source.files.stat(path, wire)),
            list: (path, access) => invoke('list', access, wire => source.files.list(path, wire)),
            async *changes(path, access) {
                const wire = accessFor(access); await wire.assertAllowed(wireTarget, 'watch');
                for await (const frame of source.files.changes(path, wire)) { await wire.assertAllowed(wireTarget, 'watch'); yield frame; }
                await wire.assertAllowed(wireTarget, 'watch');
            },
        }, documents: {
            open: (document, access) => invoke('read', access, async wire => { const value = await source.documents.open(document, wire); return { ...value, resource: resourceFor(value.resource) }; }),
            bytes: (document, options, access) => invoke('read', access, wire => source.documents.bytes(document, options, wire)),
            inspect: (path, access) => invoke('read', access, wire => source.documents.inspect(path, wire)),
            search: (query, limit, access) => invoke('read', access, wire => source.documents.search(query, limit, wire)),
            git: (request, access) => invoke('read', access, wire => source.documents.git(request, wire)),
        }, ...(source.mutations ? { mutations: {
            save: (request, access) => invoke('save', access, wire => source.mutations!.save(requestFor(request), wire)),
            manage: (request, access) => invoke('manage', access, wire => source.mutations!.manage(requestFor(request), wire)),
            receipt: (operationId, access) => invoke('read', access, wire => source.mutations!.receipt(operationId, wire)),
        } satisfies NonNullable<WorkspaceServices['mutations']> } : {}), ...(source.uploads ? { uploads: {
            begin: (request, access) => invoke('upload', access, async wire => transferFor(await source.uploads!.begin(requestFor(request), wire))),
            append: (request, access) => invoke('upload', access, wire => source.uploads!.append(requestFor(request), wire)),
            status: (request, access) => invoke('upload', access, async wire => statusFor(await source.uploads!.status(requestFor(request), wire))),
            finish: (request, access) => invoke('upload', access, async wire => receiptFor(await source.uploads!.finish(requestFor(request), wire))),
            cancel: (request, access) => invoke('upload', access, async wire => statusFor(await source.uploads!.cancel(requestFor(request), wire))),
        } satisfies NonNullable<WorkspaceServices['uploads']> } : {}) };
        current(); return { owner: { scope: captured.scope, binding }, services };
    } };
}
