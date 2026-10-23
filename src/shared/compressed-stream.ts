import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver';

export const COMPRESSED_STREAM_PATH = '/hapi-dsh/remote.mux';
const OFFICIAL_STREAM_PATH = '/api/remote.mux';
export interface StreamCarrierServices {
    webServer: {
        getOrigin(): string;
        registerUpgrade(route: { path: string; handler(req: IncomingMessage, socket: Duplex, head: Buffer): void }): () => void;
    };
    connection: { requestRejection(req: IncomingMessage): number | undefined };
}

/** The official Connection accepts a physical socket factory from its carrier.
 * Preserve any carrier already supplied by a desktop/worker assembly. */
export const compressedStreamInjection: IndexInjection = { kind: 'script', placement: 'head', text: `(()=>{
  if(globalThis.__DSH_TRANSPORT__)return;
  globalThis.__DSH_TRANSPORT__={createWebSocket(url){
    const target=new URL(url),local=new URL(document.baseURI);
    local.protocol=local.protocol==='https:'?'wss:':'ws:';
    if(target.origin===local.origin&&target.pathname==='${OFFICIAL_STREAM_PATH}')target.pathname='${COMPRESSED_STREAM_PATH}';
    return new WebSocket(target.href);
  }};
})()` };

/** Lossless transport for the existing Gateway, not a second RPC dispatcher.
 * The official endpoint still admits the Peer, authorizes every call, owns
 * heartbeat/cancellation/reconnect, and generates all protocol messages.
 * Only the browser hop negotiates permessage-deflate. No projection is cut. */
export function mountCompressedStream(services: StreamCarrierServices): () => void {
    const protocols = new WeakMap<IncomingMessage, string>();
    const server = new WebSocketServer({ noServer: true, autoPong: false,
        perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true,
            zlibDeflateOptions: { level: 5 }, concurrencyLimit: 4 },
        handleProtocols: (_offered, request) => protocols.get(request) || false });
    const connections = new Set<() => void>();
    const unregister = services.webServer.registerUpgrade({ path: COMPRESSED_STREAM_PATH, handler(request, socket, head) {
        const reject = (status: number): void => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
        const denied = services.connection.requestRejection(request);
        if (denied) { reject(denied); return; }
        const origin = services.webServer.getOrigin(), url = new URL(OFFICIAL_STREAM_PATH, origin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const offered = request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim());
        const upstream = new WebSocket(url, offered, { perMessageDeflate: false, autoPong: false,
            handshakeTimeout: 15_000, followRedirects: false,
            // DSH signs cookies for the public Host authority. Loopback is
            // only the network destination; preserve the admitted audience
            // and Origin exactly, including behind a TLS reverse proxy.
            headers: { host: request.headers.host!, ...(request.headers.origin ? { origin: request.headers.origin } : {}),
                ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
                ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) } });
        let browser: WebSocket | undefined;
        const dispose = (): void => { upstream.terminate(); browser?.terminate(); socket.destroy(); };
        connections.add(dispose);
        socket.once('close', () => { if (!browser) upstream.terminate(); });
        upstream.once('close', () => { connections.delete(dispose); });
        socket.on('error', dispose);
        upstream.on('error', () => { if (browser) browser.close(1011, 'Host stream interrupted'); else reject(502); });
        upstream.once('unexpected-response', (_request, response) => { response.resume(); reject(response.statusCode ?? 502); upstream.terminate(); });
        upstream.once('open', () => {
            // Upstream can immediately emit a frame after its handshake.
            // Pause until the browser handshake and forwarding listeners exist.
            upstream.pause();
            if (socket.destroyed) { upstream.terminate(); return; }
            protocols.set(request, upstream.protocol);
            try {
                server.handleUpgrade(request, socket, head, peer => {
                    browser = peer;
                    const forward = (source: WebSocket, destination: WebSocket): void => {
                        source.on('message', (bytes, binary) => {
                            source.pause();
                            if (destination.readyState !== WebSocket.OPEN) { source.close(1011, 'Host stream interrupted'); return; }
                            destination.send(bytes, { binary }, error => {
                                if (error) dispose(); else if (source.readyState === WebSocket.OPEN) source.resume();
                            });
                        });
                        // Do not answer upstream heartbeats on behalf of a dead
                        // browser: its actual Pong must reach the official owner.
                        source.on('ping', bytes => { if (destination.readyState === WebSocket.OPEN) destination.ping(bytes); });
                        source.on('pong', bytes => { if (destination.readyState === WebSocket.OPEN) destination.pong(bytes); });
                        source.once('close', (code, reason) => {
                            if (destination.readyState === WebSocket.OPEN) {
                                if (code === 1005) destination.close();
                                else if (code === 1006) destination.terminate();
                                else destination.close(code, reason);
                            }
                        });
                    };
                    peer.on('error', dispose);
                    forward(upstream, peer); forward(peer, upstream);
                    upstream.resume();
                });
            } catch { dispose(); }
            finally { protocols.delete(request); }
        });
    } });
    return () => { unregister(); for (const close of connections) close(); connections.clear(); server.close(); };
}
