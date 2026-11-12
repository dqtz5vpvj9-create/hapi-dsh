/** Explicit Mark as read queries the original history without opening an execution. */
import type { SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import { remoteValue } from '../client-api.ts'
import type { AppReadPosition, AppSourceRoute } from '../workspace/app-service-types.ts'

export type SourceReadHead = (source: AppSourceRoute, signal: AbortSignal) => Promise<{ position: AppReadPosition; at: number } | null>

/** Control records and metadata changes do not introduce conversation content. */
function readableHead<T extends { readonly type: string; readonly event: { readonly type: string; readonly seq: number; readonly time: number } }>(entries: readonly T[]) {
    return entries.findLast(entry => entry.type === 'event' && ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(entry.event.type))
}

export function createSourceReadHead(hostId: string, ordinary: Pick<SessionRemote, 'events'>,
    hhpi?: Pick<HhpiRemoteApi, 'read'>): SourceReadHead {
    return async (source, signal) => {
        signal.throwIfAborted()
        if (source.hostId !== hostId) throw new Error('The reading position belongs to another Host')
        if (source.kind === 'hhpi') {
            if (!hhpi) return null
            const page = remoteValue(await hhpi.read({ sessionId: source.sessionId, limit: 160 }, signal))
            signal.throwIfAborted()
            if (page.session.id !== source.sessionId) throw new Error('The reading position belongs to another original session')
            const last = readableHead(page.entries)
            return last ? { position: { kind: 'hhpi', epoch: page.epoch, seq: last.event.seq }, at: last.event.time } : null
        }
        const page = remoteValue(await ordinary.events({ address: { kind: 'session', sessionId: source.sessionId as SessionId }, maxMessages: 1 }, signal))
        signal.throwIfAborted()
        const last = readableHead(page.records)
        return last ? { position: { kind: 'dsh', seq: last.event.seq }, at: last.event.time } : null
    }
}
