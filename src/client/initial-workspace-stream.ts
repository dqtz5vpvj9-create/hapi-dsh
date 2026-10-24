import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import { parseRemoteStreamClientMessage, type RemoteStreamClientMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol'

/** Let an explicit pane bind its Session before the official Workspace restore policy starts. */
export function deferInitialWorkspaceStream(socket: ConnectionWebSocket, ready: Promise<void>, signal: AbortSignal): ConnectionWebSocket {
    let waiting = true
    let closed = false
    const pending = new Map<string, string>()
    const discard = (): void => { closed = true; pending.clear(); signal.removeEventListener('abort', discard) }
    socket.addEventListener('close', discard, { once: true })
    signal.addEventListener('abort', discard, { once: true })
    if (signal.aborted) discard()
    void ready.then(() => {
        waiting = false
        if (!closed && socket.readyState === 1) for (const message of pending.values()) socket.send(message)
        pending.clear()
        signal.removeEventListener('abort', discard)
    }, discard)
    return {
        get readyState() { return socket.readyState },
        send(message) {
            if (waiting && !closed) {
                let frame: RemoteStreamClientMessage
                try { frame = parseRemoteStreamClientMessage(message) } catch { socket.send(message); return }
                if (frame.type === 'open' && frame.endpoint === 'workspace/follow') {
                    pending.set(frame.streamId, message)
                    return
                }
                if (frame.type === 'cancel' && pending.delete(frame.streamId)) return
            }
            socket.send(message)
        },
        close(code, reason) { discard(); socket.close(code, reason) },
        addEventListener: socket.addEventListener.bind(socket),
        removeEventListener: socket.removeEventListener.bind(socket),
    }
}
