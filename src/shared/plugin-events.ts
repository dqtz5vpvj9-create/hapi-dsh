import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { MACHINE_PREFIX, validMachineId } from '../runner/protocol.ts';

export const PLUGIN_EVENTS_PATH = '/hapi-dsh/plugin-events';
export interface PluginEventServices {
    webServer: {
        getOrigin(): string;
        registerUpgrade(route: { path: string; handler(req: IncomingMessage, socket: Duplex, head: Buffer): void }): () => void;
    };
    connection: { requestRejection(req: IncomingMessage): number | undefined };
    hasHost(id: string): boolean;
}

/**
 * Carry the unchanged official plugin event response without consuming one of
 * a browser's six HTTP/1 connections per Host. This is a transport adapter, not
 * an alternative graph or HMR protocol. It cannot target arbitrary endpoints.
 */
export function mountPluginEvents(services: PluginEventServices): () => void {
    const server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 });
    const active = new Map<WebSocket, AbortController>();
    const send = async (peer: WebSocket, value: string | Uint8Array): Promise<void> => {
        if (peer.readyState !== WebSocket.OPEN) throw new Error('Plugin event observer disconnected');
        if (peer.bufferedAmount > 16 * 1024 * 1024) throw new Error('Plugin event observer is too slow');
        await new Promise<void>((resolve, reject) => peer.send(value, { binary: typeof value !== 'string' }, error => error ? reject(error) : resolve()));
    };
    const remove = services.webServer.registerUpgrade({ path: PLUGIN_EVENTS_PATH, handler(request, socket, head) {
        const reject = (status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        const denied = services.connection.requestRejection(request);
        if (denied) { reject(denied); return; }
        const host = new URL(request.url ?? '/', 'http://workspace').searchParams.get('host');
        if (!host || host !== 'local' && (!validMachineId(host) || !services.hasHost(host))) { reject(404); return; }
        server.handleUpgrade(request, socket, head, peer => {
            const lifetime = new AbortController(); active.set(peer, lifetime);
            peer.once('close', () => { lifetime.abort(); active.delete(peer); });
            peer.on('error', () => { lifetime.abort(); peer.terminate(); });
            // This channel is a read-only response stream. Client payloads are
            // never translated into a request or forwarded to any source.
            peer.on('message', () => peer.close(1008, 'Plugin event channel is read-only'));
            void (async () => {
                const origin = services.webServer.getOrigin();
                const path = host === 'local' ? '/plugins/events' : `${MACHINE_PREFIX}/${encodeURIComponent(host)}/plugins/events`;
                const headers = new Headers({ accept: 'text/event-stream', origin });
                // Only the already-authorized local Host sees its own cookie.
                // Federation replaces it with the Runner credential server-side.
                if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
                const source = await fetch(new URL(path, origin), { headers, signal: lifetime.signal, redirect: 'manual' });
                const publicHeaders = [...source.headers].filter(([key]) => ['content-type', 'cache-control'].includes(key));
                await send(peer, JSON.stringify({ type: 'head', status: source.status, headers: publicHeaders }));
                if (source.body) {
                    const reader = source.body.getReader();
                    try {
                        for (;;) { const chunk = await reader.read(); if (chunk.done) break; await send(peer, chunk.value); }
                    } finally { reader.releaseLock(); }
                }
                await send(peer, JSON.stringify({ type: 'end' })); peer.close(1000);
            })().catch(async () => {
                if (lifetime.signal.aborted) return;
                try { await send(peer, JSON.stringify({ type: 'error', message: 'The original Host plugin event stream was interrupted.' })); }
                catch { /* An observer that has gone away cannot consume an error. */ }
                peer.close(1011, 'Plugin event stream interrupted');
            }).finally(() => { lifetime.abort(); });
        });
    } });
    return () => {
        remove(); for (const [peer, abort] of active) { abort.abort(); peer.close(1001, 'Workspace stopping'); }
        active.clear(); server.close();
    };
}
