import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import { sourceIdentity } from '../workspace/legacy.ts'
import { waitForCatalogSession } from './catalog-readiness.ts'
import { SourceResolutionError } from './source-session-state.ts'

/** A Host resolution is usable only after this official graph confirms its source projection. */
export async function resolveOriginalSession(
    api: Pick<HapiRemoteApi, 'sourceSessionResolve'>,
    sessions: Pick<ISessions, 'list' | 'refresh'>,
    source: { hubId: string; sourceSessionId: string },
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted()
    const requested = { hubId: source.hubId, sourceSessionId: source.sourceSessionId }
    const result = remoteValue(await api.sourceSessionResolve(requested))
    signal.throwIfAborted()
    if (result.hubId !== requested.hubId || result.sourceSessionId !== requested.sourceSessionId) throw new SourceResolutionError('identity', 'The Host returned another original session. Its display has not been opened.')
    try { await waitForCatalogSession(sessions, result.sessionId as SessionId, signal, {
        accept: row => {
            const identity = sourceIdentity(row)
            return identity?.hubId === requested.hubId && identity.sessionId === requested.sourceSessionId
        },
    }) } catch (error) {
        signal.throwIfAborted()
        throw new SourceResolutionError('not-ready', 'The original session is loaded, but this Client has not received its verified source identity yet. Retry after its connection recovers.', { cause: error })
    }
}
