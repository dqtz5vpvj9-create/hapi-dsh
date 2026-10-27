import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { DSH_VERSION } from '../cli/config.ts';
import { CHUNK_BYTES, MACHINE_PREFIX, MACHINES_PATH, MAX_CHANNELS, MAX_FRAME_BYTES, MAX_SOCKET_BYTES, RUNNER_PATH, SOCKET_PATH,
    filterHeaders, safeSocketClose, validateUpstreamPath, validIdentifier, type FederatedMachine, type FederationFrame, type WireHeaders } from '../runner/protocol.ts';
import { bytes, Tunnel } from '../runner/tunnel.ts';
import { identityMatches, runtimeIdentity, RUNTIME_PROTOCOL, type RuntimeIdentityV1 } from '../runner/identity.ts';
import { matchesPairingToken, readPairingStore, type PairedMachine } from './federation-credentials.ts';

export type { FederatedMachine } from '../runner/protocol.ts';
export interface FederationMount {
    webServer: {
        register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void;
        registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void> }): () => void;
    };
    authorize(req: IncomingMessage): number | undefined;
}

interface RunnerState { machine: FederatedMachine; tunnel: Tunnel; credentialHash: string }
interface HttpChannel { owner: Tunnel; request: IncomingMessage; response: ServerResponse; writer: ResponseWriter; timer: ReturnType<typeof setTimeout>; done: boolean }
interface SocketChannel {
    owner: Tunnel;
    request: IncomingMessage;
    stream: Duplex;
    head: Buffer;
    protocols: string[];
    socket?: WebSocket;
    timer?: ReturnType<typeof setTimeout>;
    pendingClose?: () => void;
    queue: Promise<void>;
}

function rawHeaders(request: IncomingMessage): WireHeaders {
    const result: WireHeaders = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) result.push([request.rawHeaders[index]!, request.rawHeaders[index + 1]!]);
    return filterHeaders(result, 'request');
}

function rejectUpgrade(socket: Duplex, status: number): void {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * The official compression middleware preserves write()/drain backpressure,
 * but does not forward write callbacks. One drain listener per response also
 * stays bounded when that middleware forwards it to a compression stream.
 */
class ResponseWriter {
    private closed = false;
    private wake: (() => void) | undefined;
    private readonly drained = (): void => { const wake = this.wake; this.wake = undefined; wake?.(); };
    private readonly ended = (): void => { this.closed = true; this.drained(); };
    constructor(private readonly response: ServerResponse) {
        response.on('drain', this.drained);
        response.once('close', this.ended);
        response.once('error', this.ended);
    }
    async write(data: Buffer): Promise<void> {
        if (this.closed || this.response.destroyed || this.response.writableEnded) return;
        await new Promise<void>(resolve => {
            this.wake = resolve;
            try { if (this.response.write(data)) this.drained(); }
            catch { this.ended(); this.response.destroy(); }
            // A synchronous close/error must not leave a newly installed waiter.
            if (this.closed || this.response.destroyed || this.response.writableEnded) this.drained();
        });
    }
    dispose(): void {
        this.ended();
        this.response.off('drain', this.drained);
        this.response.off('close', this.ended);
        this.response.off('error', this.ended);
    }
}

/** Authenticated, identity-preserving proxy for complete official DSH Web transports. */
export class FederationHub {
    private paired = new Map<string, PairedMachine>();
    private readonly runners = new Map<string, RunnerState>();
    private readonly previous = new Map<string, FederatedMachine>();
    private readonly http = new Map<string, HttpChannel>();
    private readonly sockets = new Map<string, SocketChannel>();
    private readonly listeners = new Set<() => void>();
    private readonly runnerServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });
    private readonly selectedProtocols = new WeakMap<IncomingMessage, string>();
    private readonly browserServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_SOCKET_BYTES,
        handleProtocols: (_offered, request) => this.selectedProtocols.get(request) || false });
    private readonly disposers: Array<() => void> = [];
    private watcher?: FSWatcher;
    private refreshTimer?: ReturnType<typeof setInterval>;
    private refresh: Promise<void> = Promise.resolve();
    private mounted = false;
    private closed = false;

    private readonly identity: RuntimeIdentityV1;

    constructor(private readonly options: { credentialsFile: string; httpIdleTimeoutMs?: number; identity?: RuntimeIdentityV1 }) {
        this.identity = options.identity ?? runtimeIdentity({ dshVersion: DSH_VERSION });
    }

    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    private changed(): void { for (const listener of this.listeners) { try { listener(); } catch { /* observers cannot break transport cleanup */ } } }

    listMachines(): FederatedMachine[] {
        return [...this.paired.values()].map((paired) => {
            const state = this.runners.get(paired.id)?.machine ?? this.previous.get(paired.id);
            return { id: paired.id, dshVersion: DSH_VERSION, baseUrl: `${MACHINE_PREFIX}/${encodeURIComponent(paired.id)}/`,
                socketUrl: `${SOCKET_PATH}?machine=${encodeURIComponent(paired.id)}`, ...state, name: paired.name, online: this.runners.has(paired.id) };
        }).sort((a, b) => a.name.localeCompare(b.name));
    }

    async refreshCredentials(): Promise<void> {
        const operation = this.refresh.then(async () => {
            let store;
            try { store = await readPairingStore(this.options.credentialsFile); }
            catch (error) {
                this.paired.clear();
                for (const state of this.runners.values()) state.tunnel.close(1008);
                this.changed();
                throw error;
            }
            if (this.closed) return;
            this.paired = new Map(store.machines.map((machine) => [machine.id, machine]));
            for (const [id, state] of this.runners) if (this.paired.get(id)?.tokenHash !== state.credentialHash) state.tunnel.close(1008);
            this.changed();
        });
        this.refresh = operation.catch(() => {});
        return operation;
    }

    async mount({ webServer, authorize }: FederationMount): Promise<void> {
        if (this.mounted || this.closed) throw new Error('FederationHub can be mounted only once');
        await this.refreshCredentials();
        this.mounted = true;
        this.disposers.push(webServer.register({ kind: 'exact', path: MACHINES_PATH, handler: (req, res) => {
            const rejection = authorize(req);
            if (rejection) { res.writeHead(rejection); res.end(); return; }
            if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ machines: this.listMachines() }));
        } }));
        this.disposers.push(webServer.register({ kind: 'prefix', path: MACHINE_PREFIX, handler: async (req, res) => {
            const rejection = authorize(req);
            if (rejection) { res.writeHead(rejection); res.end(); return; }
            await this.proxyHttp(req, res);
        } }));
        this.disposers.push(webServer.registerUpgrade({ path: RUNNER_PATH, handler: (req, socket, head) => this.admitRunner(req, socket, head) }));
        this.disposers.push(webServer.registerUpgrade({ path: SOCKET_PATH, handler: (req, socket, head) => {
            const rejection = authorize(req);
            if (rejection) { rejectUpgrade(socket, rejection); return; }
            this.admitBrowserSocket(req, socket, head);
        } }));
        try { this.watcher = watch(dirname(this.options.credentialsFile), () => { void this.refreshCredentials().catch(() => {}); }); }
        catch { /* A not-yet-created pairing directory is picked up by the periodic refresh. */ }
        this.refreshTimer = setInterval(() => { void this.refreshCredentials().catch(() => {}); }, 15_000);
        this.refreshTimer.unref();
    }

    private async admitRunner(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        await this.refreshCredentials();
        const url = new URL(request.url ?? '/', 'http://hub.local');
        const id = url.searchParams.get('machine');
        const paired = id ? this.paired.get(id) : undefined;
        const header = request.headers.authorization;
        const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!paired || !matchesPairingToken(token, paired.tokenHash)) { rejectUpgrade(socket, 401); return; }
        if (this.runners.has(paired.id)) { rejectUpgrade(socket, 409); return; }
        this.runnerServer.handleUpgrade(request, socket, head, (ws) => {
            let established = false;
            const timeout = setTimeout(() => tunnel.close(1008), 10_000);
            timeout.unref();
            const tunnel = new Tunnel(ws, async (frame) => {
                if (!established) {
                    if (frame.type !== 'hello' || frame.protocol !== RUNTIME_PROTOCOL || frame.machineId !== paired.id
                        || frame.dshVersion !== DSH_VERSION || !identityMatches(frame.identity, this.identity)
                        || this.runners.has(paired.id) || this.paired.get(paired.id)?.tokenHash !== paired.tokenHash || this.closed) {
                        tunnel.close(1008); return;
                    }
                    established = true;
                    clearTimeout(timeout);
                    const machine: FederatedMachine = { id: paired.id, name: paired.name, online: true, dshVersion: frame.dshVersion,
                        generation: frame.generation, connectedAt: Date.now(), baseUrl: `${MACHINE_PREFIX}/${encodeURIComponent(paired.id)}/`,
                        socketUrl: `${SOCKET_PATH}?machine=${encodeURIComponent(paired.id)}` };
                    this.runners.set(paired.id, { machine, tunnel, credentialHash: paired.tokenHash });
                    await tunnel.send({ type: 'welcome', protocol: RUNTIME_PROTOCOL, identity: this.identity });
                    this.changed();
                    return;
                }
                await this.handleRunnerFrame(tunnel, frame);
            }, () => {
                clearTimeout(timeout);
                const state = this.runners.get(paired.id);
                if (state?.tunnel === tunnel) {
                    this.runners.delete(paired.id);
                    this.previous.set(paired.id, { ...state.machine, online: false, disconnectedAt: Date.now() });
                    this.changed();
                }
                this.endChannels(tunnel);
            });
        });
    }

    private channels(owner: Tunnel): number {
        return [...this.http.values(), ...this.sockets.values()].filter((channel) => channel.owner === owner).length;
    }

    private async proxyHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? '/', 'http://hub.local');
        const relative = url.pathname.slice(MACHINE_PREFIX.length + 1);
        const slash = relative.indexOf('/');
        let id: string;
        try { id = decodeURIComponent(slash < 0 ? relative : relative.slice(0, slash)); }
        catch { response.writeHead(400); response.end(); return; }
        const state = this.runners.get(id);
        if (!state) { response.writeHead(this.paired.has(id) ? 503 : 404, { 'cache-control': 'no-store' }); response.end('Runner is offline'); return; }
        if (this.channels(state.tunnel) >= MAX_CHANNELS) { response.writeHead(429); response.end(); return; }
        const path = validateUpstreamPath(`${slash < 0 ? '/' : relative.slice(slash)}${url.search}`);
        const channelId = randomUUID();
        response.on('error', () => {});
        const channel: HttpChannel = { owner: state.tunnel, request, response, writer: new ResponseWriter(response), done: false, timer: setTimeout(() => {
            this.failHttp(channelId, 504);
            void state.tunnel.send({ type: 'http-cancel', id: channelId }).catch(() => {});
        }, this.options.httpIdleTimeoutMs ?? 300_000) };
        channel.timer.unref();
        this.http.set(channelId, channel);
        response.once('close', () => {
            if (channel.done) return;
            this.removeHttp(channelId);
            void state.tunnel.send({ type: 'http-cancel', id: channelId }).catch(() => {});
        });
        try {
            await state.tunnel.send({ type: 'http-open', id: channelId, method: request.method ?? 'GET', path, headers: rawHeaders(request) });
            for await (const raw of request) {
                channel.timer.refresh();
                const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                for (let at = 0; at < data.byteLength; at += CHUNK_BYTES) await state.tunnel.sendData(channelId, 'request', data.subarray(at, at + CHUNK_BYTES));
            }
            await state.tunnel.send({ type: 'http-end', id: channelId, lane: 'request' });
        } catch {
            this.failHttp(channelId, 502);
            void state.tunnel.send({ type: 'http-cancel', id: channelId }).catch(() => {});
        }
    }

    private admitBrowserSocket(request: IncomingMessage, socket: Duplex, head: Buffer): void {
        const url = new URL(request.url ?? '/', 'http://hub.local');
        const machineId = url.searchParams.get('machine');
        let path: string;
        try { path = validateUpstreamPath(url.searchParams.get('path')); }
        catch { rejectUpgrade(socket, 400); return; }
        const state = machineId ? this.runners.get(machineId) : undefined;
        if (!state) { rejectUpgrade(socket, 503); return; }
        if (this.channels(state.tunnel) >= MAX_CHANNELS) { rejectUpgrade(socket, 429); return; }
        const offered = request.headers['sec-websocket-protocol'];
        const protocols = typeof offered === 'string' ? offered.split(',').map((part) => part.trim()) : [];
        if (protocols.length > 16 || new Set(protocols).size !== protocols.length
            || protocols.some((protocol) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(protocol))) { rejectUpgrade(socket, 400); return; }
        // Complete the browser handshake only after the real plugin has selected its subprotocol.
        const id = randomUUID();
        const channel: SocketChannel = { owner: state.tunnel, request, stream: socket, head, protocols, queue: Promise.resolve() };
        this.sockets.set(id, channel);
        socket.pause();
        channel.pendingClose = () => {
            this.removeSocket(id);
            void state.tunnel.send({ type: 'ws-close', id, code: 1001, reason: 'Browser disconnected' }).catch(() => {});
        };
        socket.once('close', channel.pendingClose);
        socket.once('error', channel.pendingClose);
        channel.timer = setTimeout(() => {
            this.failSocket(id, 504);
            void state.tunnel.send({ type: 'ws-close', id, code: 1011, reason: 'DSH handshake timed out' }).catch(() => {});
        }, 20_000);
        channel.timer.unref();
        void state.tunnel.send({ type: 'ws-open', id, path, protocols }).catch(() => this.failSocket(id, 502));
    }

    private activateSocket(id: string, channel: SocketChannel, protocol: string): void {
        if (channel.socket || protocol && !channel.protocols.includes(protocol)) { channel.owner.close(1002); return; }
        if (channel.stream.destroyed) { this.removeSocket(id); return; }
        this.selectedProtocols.set(channel.request, protocol);
        try {
            this.browserServer.handleUpgrade(channel.request, channel.stream, channel.head, (browser) => {
                this.detachPendingSocket(channel);
                channel.socket = browser;
                browser.on('error', () => browser.terminate());
                browser.on('message', (data, binary) => {
                    browser.pause();
                    channel.queue = channel.queue.then(() => channel.owner.sendData(id, 'socket', bytes(data), binary)).then(() => {
                        if (browser.readyState === WebSocket.OPEN) browser.resume();
                    }).catch(() => browser.close(1011, 'Runner transport unavailable'));
                });
                browser.once('close', (code, reason) => {
                    this.removeSocket(id);
                    void channel.owner.send({ type: 'ws-close', id, code: safeSocketClose(code), reason: reason.toString('utf8') }).catch(() => {});
                });
                browser.resume();
            });
        } catch {
            this.failSocket(id, 502);
            void channel.owner.send({ type: 'ws-close', id, code: 1011, reason: 'Browser handshake failed' }).catch(() => {});
        } finally { this.selectedProtocols.delete(channel.request); }
    }

    private detachPendingSocket(channel: SocketChannel): void {
        if (channel.timer) { clearTimeout(channel.timer); delete channel.timer; }
        if (channel.pendingClose) {
            channel.stream.off('close', channel.pendingClose);
            channel.stream.off('error', channel.pendingClose);
            delete channel.pendingClose;
        }
    }

    private removeSocket(id: string): SocketChannel | undefined {
        const channel = this.sockets.get(id);
        if (channel) { this.detachPendingSocket(channel); this.sockets.delete(id); }
        return channel;
    }

    private failSocket(id: string, status: number): void {
        const channel = this.removeSocket(id);
        if (!channel) return;
        if (channel.socket) channel.socket.close(1012, 'Runner disconnected');
        else {
            channel.stream.on('error', () => {});
            rejectUpgrade(channel.stream, status);
            channel.stream.resume();
        }
    }

    private async handleRunnerFrame(owner: Tunnel, frame: FederationFrame): Promise<void> {
        if (!('id' in frame) || !validIdentifier(frame.id)) { owner.close(1002); return; }
        const http = this.http.get(frame.id);
        const socket = this.sockets.get(frame.id);
        if (http && http.owner !== owner || socket && socket.owner !== owner) { owner.close(1008); return; }
        if (frame.type === 'http-head' && http && !http.response.headersSent) {
            http.timer.refresh();
            const headers = filterHeaders(frame.headers, 'response').map(([name, value]): [string, string] => {
                if (name.toLowerCase() === 'location' && value.startsWith('/') && !value.startsWith('//')) {
                    const machineId = [...this.runners].find(([, state]) => state.tunnel === owner)?.[0];
                    return [name, `${MACHINE_PREFIX}/${encodeURIComponent(machineId ?? '')}${value}`];
                }
                return [name, value];
            });
            http.response.writeHead(frame.status, headers.flat());
        } else if (frame.type === 'data' && frame.lane === 'response' && http) {
            http.timer.refresh();
            if (!http.response.headersSent) throw new Error('Runner sent body before response headers');
            await http.writer.write(Buffer.from(frame.data, 'base64'));
        } else if (frame.type === 'http-end' && frame.lane === 'response' && http) {
            this.removeHttp(frame.id);
            http.response.end();
        } else if (frame.type === 'http-error' && http) {
            this.failHttp(frame.id, frame.code === 'limit-exceeded' ? 413 : 502);
        } else if (frame.type === 'ws-ready' && socket) {
            this.activateSocket(frame.id, socket, frame.protocol);
        } else if (frame.type === 'data' && frame.lane === 'socket' && socket) {
            const browser = socket.socket;
            if (browser?.readyState === WebSocket.OPEN) await new Promise<void>((resolve, reject) => {
                browser.send(Buffer.from(frame.data, 'base64'), { binary: frame.binary === true }, (error) => error ? reject(error) : resolve());
            });
        } else if (frame.type === 'ws-close' && socket) {
            if (socket.socket) socket.socket.close(safeSocketClose(frame.code), frame.reason);
            else this.failSocket(frame.id, 502);
        }
        // Late data for a cancelled channel is acknowledged and discarded; it is never replayed.
    }

    private removeHttp(id: string): HttpChannel | undefined {
        const channel = this.http.get(id);
        if (channel) { channel.done = true; channel.writer.dispose(); clearTimeout(channel.timer); this.http.delete(id); }
        return channel;
    }

    private failHttp(id: string, status: number): void {
        const channel = this.removeHttp(id);
        if (!channel) return;
        if (channel.response.headersSent) channel.response.destroy();
        else { channel.response.writeHead(status, { 'cache-control': 'no-store' }); channel.response.end('Runner request was interrupted; delivery was not retried'); }
    }

    private endChannels(owner: Tunnel): void {
        for (const [id, channel] of this.http) if (channel.owner === owner) this.failHttp(id, 502);
        for (const [id, channel] of this.sockets) if (channel.owner === owner) this.failSocket(id, 502);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.watcher?.close();
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        for (const dispose of this.disposers.reverse()) dispose();
        for (const state of this.runners.values()) state.tunnel.close(1001);
        for (const ws of [...this.runnerServer.clients, ...this.browserServer.clients]) ws.terminate();
        this.listeners.clear();
        await Promise.all([this.runnerServer, this.browserServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
}
