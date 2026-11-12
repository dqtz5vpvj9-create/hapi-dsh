/** Stable workspace address; the prefix is persisted and does not imply a HAPI source. */
export function sessionResourceId(hostId: string, sessionId: string): string {
    return hostId === 'local' ? sessionId : `hapi-remote:${encodeURIComponent(hostId)}:${encodeURIComponent(sessionId)}`
}

export function parseSessionResourceId(value: string): { hostId: string; sessionId: string } {
    if (!value.startsWith('hapi-remote:')) return { hostId: 'local', sessionId: value }
    const separator = value.indexOf(':', 'hapi-remote:'.length)
    if (separator < 0) throw new Error('Invalid remote conversation address')
    const hostId = decodeURIComponent(value.slice('hapi-remote:'.length, separator))
    const sessionId = decodeURIComponent(value.slice(separator + 1))
    if (!hostId || !sessionId || hostId === 'local') throw new Error('Invalid remote conversation address')
    return { hostId, sessionId }
}
