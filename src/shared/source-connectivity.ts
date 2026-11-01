/** Availability is independent of the native engine's capabilities and last execution state. */
import type { SourceSession } from '../remote/protocol.ts'

export function sourceIsOffline(session: SourceSession): boolean {
    return session.connection ? session.connection.state === 'offline' : session.status === 'offline'
}

/** Timestamp transitions only; polling an unchanged source must not manufacture history revisions. */
export function sourceOnlineConnection(previous?: SourceSession, now = Date.now()): NonNullable<SourceSession['connection']> {
    return previous?.connection?.state === 'online' ? previous.connection : { state: 'online', observedAt: now }
}

export function sourceOffline(session: SourceSession, now = Date.now()): SourceSession {
    if (session.connection?.state === 'offline') return session
    return { ...session, connection: { state: 'offline', observedAt: now } }
}
