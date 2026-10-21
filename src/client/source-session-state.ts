export type SourceResolutionFailure = 'not-found' | 'removed' | 'denied' | 'transport' | 'not-ready' | 'ambiguous' | 'identity' | 'unknown'
export type SourceResolutionStatus = 'loading' | SourceResolutionFailure

export class SourceResolutionError extends Error {
    constructor(readonly resolution: SourceResolutionFailure, message: string, options?: ErrorOptions) { super(message, options) }
}

/** Status comes from the original response, never from an absent catalog row or English wording. */
export function sourceResolutionFailure(error: unknown): SourceResolutionFailure {
    if (error instanceof SourceResolutionError) return error.resolution
    if (!error || typeof error !== 'object') return 'unknown'
    const details = Reflect.get(error, 'details'), data = details && typeof details === 'object' ? details : error
    const status: unknown = Reflect.get(data, 'status'), outcome: unknown = Reflect.get(data, 'outcome')
    const code: unknown = Reflect.get(data, 'sourceCode') ?? Reflect.get(error, 'code')
    if (status === 401 || status === 403) return 'denied'
    if (status === 410 || code === 'source_removed') return 'removed'
    if (status === 404 || code === 'source_not_found') return 'not-found'
    if (code === 'source_hub_mismatch' || code === 'source_identity_mismatch') return 'identity'
    if (code === 'source_not_ready') return 'not-ready'
    if (outcome === 'indeterminate' || typeof status === 'number' && (status >= 500 || status === 408 || status === 429)
        || typeof code === 'string' && /^(?:transport|connection|network)(?:[/:_-]|$)/.test(code)) return 'transport'
    return 'unknown'
}
