/** Live editor cache; durable recovery is handled by native-document-journal. */
import type { NativeDocumentRef, WorkbenchResponse, WorkbenchSource } from '../workbench-types.ts';
import { documentKey } from '../workspace/documents.ts';
import type { WorkspaceDocumentRef } from '../workbench-types.ts';
import type { WorkspaceDocument } from '../workspace/service-types.ts';
import type { SourceFileOwner } from './source-file-mutation-journal.ts';

export interface SourceTextSelection { start: number; end: number; direction: 'forward' | 'backward' | 'none' }
export interface SourceDocumentDraft {
    base: WorkspaceDocument; text: string; uncertain: boolean;
    pending: { operationId: string; text: string; baselineVersion: string } | null;
    selection?: SourceTextSelection | undefined;
}
const sourceDrafts = new Map<string, SourceDocumentDraft>();
export function sourceDocumentDraftKey(owner: SourceFileOwner, document: WorkspaceDocumentRef): string {
    const { binding } = owner;
    return JSON.stringify([owner.scope, binding.target.hostId, binding.target.sessionId, binding.machineId, binding.workspaceId, document]);
}
export function sourceDocumentDraft(owner: SourceFileOwner, document: WorkspaceDocumentRef): SourceDocumentDraft | undefined {
    return sourceDrafts.get(sourceDocumentDraftKey(owner, document));
}
export function rememberSourceDocumentDraft(owner: SourceFileOwner, document: WorkspaceDocumentRef, draft: SourceDocumentDraft): void {
    const key = sourceDocumentDraftKey(owner, document);
    if (draft.text === draft.base.text && !draft.uncertain && !draft.pending) sourceDrafts.delete(key);
    else sourceDrafts.set(key, draft);
}
export function discardSourceDocumentDraft(owner: SourceFileOwner, document: WorkspaceDocumentRef): void { sourceDrafts.delete(sourceDocumentDraftKey(owner, document)); }

export interface NativeDocumentDraft { base: WorkbenchResponse<'nativeDocument'>; text: string; uncertain: boolean }
const drafts = new Map<string, NativeDocumentDraft>();
export function nativeDocumentDraftKey(source: WorkbenchSource, document: NativeDocumentRef): string {
    if (document.kind === 'generated-media') return JSON.stringify(['generated-media', source.sourceHubId ?? '', source.sourceSessionId, document.imageId]);
    return documentKey({ sessionId: source.sourceSessionId, sourceSessionId: source.sourceSessionId,
        ...(source.sourceHubId === undefined ? {} : { sourceHubId: source.sourceHubId }), document });
}
export function nativeDocumentDraft(source: WorkbenchSource, document: NativeDocumentRef): NativeDocumentDraft | undefined { return drafts.get(nativeDocumentDraftKey(source, document)); }
export function rememberNativeDocumentDraft(source: WorkbenchSource, document: NativeDocumentRef, draft: NativeDocumentDraft): void {
    const identity = nativeDocumentDraftKey(source, document);
    if (draft.text === draft.base.text && !draft.uncertain) drafts.delete(identity);
    else drafts.set(identity, draft);
}
export function discardNativeDocumentDraft(source: WorkbenchSource, document: NativeDocumentRef): void { drafts.delete(nativeDocumentDraftKey(source, document)); }
export function hasDirtyNativeDocument(resource: { kind: string; sessionId?: string; sourceSessionId?: string; sourceHubId?: string; document?: NativeDocumentRef }): boolean {
    if (resource.kind !== 'document' || !resource.document || !resource.sourceSessionId) return false;
    return drafts.has(nativeDocumentDraftKey({ sourceSessionId: resource.sourceSessionId, ...(resource.sourceHubId === undefined ? {} : { sourceHubId: resource.sourceHubId }) }, resource.document));
}
