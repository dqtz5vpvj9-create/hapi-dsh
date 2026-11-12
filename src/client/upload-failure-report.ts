import { HAPI_DSH_BUILD_ID } from '../build-info.ts';
import { uploadFailure, uploadFailureLimit, type UploadFailure, type UploadFailureReporter } from '../upload-diagnostics.ts';

/** Shared by all pane graphs through their existing workspace scope. Never delays an upload. */
export function createUploadFailureReporter(send?: (report: UploadFailure) => Promise<unknown>): UploadFailureReporter {
    const allowed = uploadFailureLimit(6);
    return (stage, source, error) => {
        try {
            if (!send || !allowed()) return;
            void Promise.resolve(send(uploadFailure(stage, source, HAPI_DSH_BUILD_ID, error))).catch(() => {});
        } catch { /* Private diagnostics cannot affect upload, progress, or retry. */ }
    };
}

/** Reports each already-visible error occurrence once, without reading its message. */
export function createComposerUploadFailureObserver(report: UploadFailureReporter) {
    const observed = new WeakMap<object, object>();
    return (source: UploadFailure['source'], attachments: readonly { file: object; id: string }[],
        uploads: Readonly<Record<string, { status: string; reason?: string }>>) => {
        for (const attachment of attachments) {
            const value = uploads[attachment.id];
            if (value?.status !== 'error') { observed.delete(attachment.file); continue; }
            if (observed.get(attachment.file) === value) continue;
            observed.set(attachment.file, value);
            report('composer-error', source, { reason: value.reason });
        }
    };
}
