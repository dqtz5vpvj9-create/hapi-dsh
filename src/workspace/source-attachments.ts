import { SourceArtifactDocuments, type ReadGeneratedSourceDocument } from './source-artifacts.ts';
import type { WorkspaceDocumentService } from './service-types.ts';
/** Official immutable attachment storage in the Codex source execution world. */
import type { Context } from '@deepseek-ai/cordis';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import { isImageAdmissionError, type ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { SOURCE_INPUT_IMAGE_LIMITS } from '../shared/source-image-limits.ts';
import { registerStoredCodexUpload, storedCodexUpload } from '../remote/codex-uploads.ts';
import type { WorkspaceUploadStart } from '../workbench-types.ts';
import type { WorkspaceAccess, WorkspaceBinding, WorkspaceMutationResult, WorkspaceUploadReceipt } from './service-types.ts';

export class SourceAttachments {
    private readonly store: LocalAttachmentStore;
    constructor(ctx: Context, private readonly options: { directory: string; receipts?: string | undefined; generated?: ReadGeneratedSourceDocument }) {
        // Browser preparation fits this policy before transmission. The ordinary
        // source admission still validates media; it is not an upload-size bypass.
        this.store = new LocalAttachmentStore(ctx, LocalAttachmentStore.Config({ dshHome: options.directory,
            ...SOURCE_INPUT_IMAGE_LIMITS, normalizedImageMaxPixels: SOURCE_INPUT_IMAGE_LIMITS.maxImagePixels,
            normalizedImageMaxDimension: SOURCE_INPUT_IMAGE_LIMITS.maxImageDimension,
            normalizedImageMaxBytes: SOURCE_INPUT_IMAGE_LIMITS.maxImageBytes }));
    }
    documents(binding: WorkspaceBinding, fallback: WorkspaceDocumentService): WorkspaceDocumentService {
        return new SourceArtifactDocuments({ receipts: this.options.receipts, store: this.store,
            ...(this.options.generated ? { generated: this.options.generated } : {}) }).compose(binding, fallback);
    }
    async receipt(binding: WorkspaceBinding, request: WorkspaceUploadStart, access: WorkspaceAccess): Promise<WorkspaceMutationResult<WorkspaceUploadReceipt> | null> {
        access.signal.throwIfAborted(); await access.assertAllowed(binding.target, 'upload');
        if (!this.options.receipts) return null;
        const original = await storedCodexUpload(this.options.receipts, binding.target.sessionId, request.operationId, access.signal);
        await access.assertAllowed(binding.target, 'upload');
        if (!original?.value) return null;
        return { status: 'applied', operationId: request.operationId, value: { kind: 'attachment',
            resource: { target: binding.target, document: { kind: 'artifact', id: request.operationId } }, value: original.value } };
    }
    async commit(binding: WorkspaceBinding, request: WorkspaceUploadStart, path: string, access: WorkspaceAccess): Promise<WorkspaceMutationResult<WorkspaceUploadReceipt>> {
        const check = async () => { access.signal.throwIfAborted(); await access.assertAllowed(binding.target, 'upload'); };
        await check();
        if (!this.options.receipts) return { status: 'rejected', operationId: request.operationId, code: 'unsupported', message: 'Attachment receipts are not registered on this source.' };
        if (request.destination.kind !== 'attachment') throw new Error('The upload does not name an attachment.');
        const receipts = this.options.receipts;
        const name = request.destination.name, receiptId = request.operationId as FileUploadReceiptId;
        const resource = { target: binding.target, document: { kind: 'artifact' as const, id: request.operationId } };
        const mime = request.mimeType;
        if (mime.startsWith('image/')) {
            if (!SOURCE_INPUT_IMAGE_LIMITS.mediaTypes.includes(mime as ImageMediaType)) return {
                status: 'rejected', operationId: request.operationId, code: 'unsupported', message: 'This source cannot use that image format.' };
            if (request.bytes > SOURCE_INPUT_IMAGE_LIMITS.maxImageBytes) return {
                status: 'rejected', operationId: request.operationId, code: 'too-large', message: 'Prepare this image on the sending device before uploading it.' };
            let image;
            try { image = await this.store.saveImage({ data: await readFile(path, { signal: access.signal }), mediaType: mime as ImageMediaType, name }); }
            catch (error) {
                if (!isImageAdmissionError(error)) throw error;
                return { status: 'rejected', operationId: request.operationId, code: 'invalid', message: 'The source could not read this image. Your original attachment is kept.' };
            }
            await check();
            await registerStoredCodexUpload(receipts, request.operationId, { sessionId: binding.target.sessionId,
                path: this.store.imageHostPath(image), name: image.name ?? name, bytes: image.bytes, image: true, mimeType: image.mediaType, value: { receiptId, image } }, access.signal);
            await check();
            return { status: 'applied', operationId: request.operationId, value: { kind: 'attachment', resource, value: { receiptId, image } } };
        }
        const file = await this.store.saveFileStream({ data: createReadStream(path, { signal: access.signal }), name, signal: access.signal });
        await check();
        await registerStoredCodexUpload(receipts, request.operationId, { sessionId: binding.target.sessionId,
            path: this.store.fileHostPath(file), name: file.name, bytes: file.bytes, image: false, mimeType: mime, value: { receiptId, file } }, access.signal);
        await check();
        return { status: 'applied', operationId: request.operationId, value: { kind: 'attachment', resource, value: { receiptId, file } } };
    }
}
