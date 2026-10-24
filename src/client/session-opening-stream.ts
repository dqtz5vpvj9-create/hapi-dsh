import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionFollowRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { parseRemoteStreamClientMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { openingWindow } from '../shared/history-window.ts'

/** Select the same public follow window as the local Session provider. The
 * official pager still chooses the contiguous cut, cursor and hasMore. Older
 * page RPCs, live frames and all commands retain their original transport. */
export function openingHistoryMessage(message: string, opened: Set<string>): string {
    let frame
    try { frame = parseRemoteStreamClientMessage(message) } catch { return message }
    if (frame.type !== 'open' || frame.endpoint !== 'session/follow') return message
    const payload = frame.payload as { args?: { request?: unknown } } | null
    const request = payload?.args?.request
    if (!request || typeof request !== 'object' || Array.isArray(request)) return message
    const address = (request as SessionFollowRequest).address
    if (!address || typeof address !== 'object') return message
    const identity = JSON.stringify(address)
    // A reconnect can replace the retained window. Keep its original request
    // so a reader who has paged backwards does not lose that larger window.
    if (opened.has(identity)) return message
    const next = openingWindow(request as unknown as SessionFollowRequest)
    if (next === request) return message
    opened.add(identity)
    return JSON.stringify({ ...frame, payload: { ...payload, args: { ...payload?.args, request: next } } })
}

/** `opened` belongs to the Host graph, across physical socket reconnects. */
export function withOpeningHistory(socket: ConnectionWebSocket, opened: Set<string>): ConnectionWebSocket {
    return {
        get readyState() { return socket.readyState },
        send: message => socket.send(openingHistoryMessage(message, opened)),
        close: (code, reason) => socket.close(code, reason),
        addEventListener: socket.addEventListener.bind(socket),
        removeEventListener: socket.removeEventListener.bind(socket),
    }
}
