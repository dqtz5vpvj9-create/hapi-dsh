export type SourceErrorCode = 'INVALID_REQUEST' | 'TARGET_UNAVAILABLE' | 'HISTORY_UNAVAILABLE' | 'STALE_VERSION' | 'CAPACITY_EXCEEDED' | 'OUTCOME_UNKNOWN' | 'UNSUPPORTED' | 'DISPOSED';
export class SourceError extends Error {
    override readonly name = 'SourceError';
    constructor(readonly code: SourceErrorCode, message: string, readonly delivery?: 'not-dispatched') { super(message); }
}
/** Internal distinction carried over the existing authenticated denial error. */
export class SourceAccessDenied extends SourceError {
    constructor() { super('UNSUPPORTED', 'Access to this source resource was not granted.'); }
}
export function abortError(): DOMException { return new DOMException('The source read was cancelled.', 'AbortError'); }
/** A cancelled reader cannot cancel another reader's shared source work. */
export function waitFor<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = (): void => { cleanup(); reject(signal.reason ?? abortError()); };
        const cleanup = (): void => { signal.removeEventListener('abort', abort); };
        signal.addEventListener('abort', abort, { once: true });
        work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}
