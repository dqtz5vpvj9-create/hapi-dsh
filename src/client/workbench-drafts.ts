/** Live editor cache; durable recovery is handled by native-document-journal. */
import type { NativeDocumentRef, WorkbenchResponse, WorkbenchSource } from '../workbench-types.ts';
import { documentKey } from '../workspace/documents.ts';

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
