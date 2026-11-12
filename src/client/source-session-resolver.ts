import { remoteValue } from '../client-api.ts'
import type { AppSourceRoute } from '../workspace/app-service-types.ts'
import { sourceAliasResultSchema, type SourceAliasApi } from '../workspace/source-alias-api.ts'
import { legacySourceReferenceSchema, type LegacySourceReference, type RecoveryReference } from '../workspace/source-aliases.ts'
import { SourceResolutionError, type SourceResolutionFailure } from './source-session-state.ts'

export class SourceAliasResolutionError extends SourceResolutionError {
    constructor(resolution: SourceResolutionFailure, message: string, readonly recovery: readonly RecoveryReference[]) { super(resolution, message) }
}

/** Resolve a finite migrated reference; the returned Host owns ordinary catalog/retain. */
export async function resolveOriginalSession(
    api: SourceAliasApi,
    reference: LegacySourceReference,
    signal: AbortSignal,
): Promise<AppSourceRoute> {
    signal.throwIfAborted()
    const request = legacySourceReferenceSchema.parse(reference)
    const result = sourceAliasResultSchema.parse(remoteValue(await api.resolve({ reference: request }, signal)))
    signal.throwIfAborted()
    const fail = (resolution: SourceResolutionFailure, message: string): never => {
        throw new SourceAliasResolutionError(resolution, message, 'recovery' in result ? result.recovery : [])
    }
    switch (result.status) {
        case 'resolved': return result.source
        case 'unmapped': return fail('not-found', 'This saved reference has no installed migration mapping. Its original reference is preserved for recovery or export.')
        case 'ambiguous': return fail('ambiguous', 'This saved reference has more than one migrated target. Choose its exact Host before restoring it.')
        case 'unavailable': return fail('not-connected', 'The mapped conversation is unavailable from its original Host. Reconnect that Host and retry; the saved reference is preserved.')
        case 'denied': case 'scope-invalid': return fail('denied', 'The current application account cannot restore this saved reference. Its original reference is preserved.')
        case 'aborted': return fail('transport', 'Restoring this saved reference was cancelled. Retry from the current connection.')
        default: return fail('identity', 'This saved reference is invalid. Preserve it for recovery instead of choosing another conversation.')
    }
}
