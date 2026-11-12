/** Attachment failure facts only. No identity, arbitrary text, or payload fields cross this boundary. */
import { z } from 'zod';

export const uploadFailureStages = ['source-and-image-preparation', 'image-preparation', 'source-resolution', 'draft-checkpoint',
    'upload-begin', 'upload-status', 'upload-chunk', 'upload-finish', 'upload-receipt', 'completed-progress', 'composer-error'] as const;
const names = ['Error', 'TypeError', 'RangeError', 'DOMException', 'AbortError', 'NotAllowedError', 'NotFoundError',
    'InvalidStateError', 'QuotaExceededError', 'DataCloneError', 'SecurityError', 'UnknownError', 'TransactionInactiveError', 'unknown'] as const;
const codes = ['unknown', 'upload/http', 'workspace-service/unavailable', 'workspace-service/result-unavailable',
    'remote-access/denied', 'hhpi/source', 'gateway/internal', 'gateway/timeout', 'session/not-found', 'session/attachment-invalid',
    'subagent/attachment-invalid', 'IMAGE_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'IMAGE_DIMENSION_TOO_LARGE',
    'IMAGE_TYPE_MISMATCH', 'UNSUPPORTED_IMAGE_TYPE', 'SUBAGENT_FILE_UNSUPPORTED'] as const;
export const uploadFailureSchema = z.strictObject({
    stage: z.enum(uploadFailureStages), source: z.enum(['hhpi', 'ordinary']),
    build: z.string().max(64).regex(/^(?:[a-f0-9]{12,64}|development)$/),
    name: z.enum(names), code: z.enum(codes), status: z.number().int().min(100).max(599).optional(),
});
export type UploadFailure = z.infer<typeof uploadFailureSchema>;
export type UploadFailureReporter = (stage: UploadFailure['stage'], source: UploadFailure['source'], error: unknown) => void;

export function uploadFailure(stage: UploadFailure['stage'], source: UploadFailure['source'], build: string, error: unknown): UploadFailure {
    const read = (key: string): unknown => { try { return error && typeof error === 'object' ? Reflect.get(error, key) : undefined; } catch { return undefined; } };
    const name = read('name'), code = read('code') ?? read('reason'), status = read('status');
    return uploadFailureSchema.parse({ stage, source, build,
        name: names.includes(name as typeof names[number]) ? name : 'unknown',
        code: codes.includes(code as typeof codes[number]) ? code : 'unknown',
        ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    });
}

/** One bounded counter, with no per-user key or retained reports. */
export function uploadFailureLimit(maximum: number, now: () => number = Date.now): () => boolean {
    let start = now(), count = 0;
    return () => { const time = now(); if (time - start >= 60_000) { start = time; count = 0; } return count++ < maximum; };
}
