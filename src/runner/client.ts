import { randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { DSH_VERSION } from '../cli/config.ts';
import { type RunnerConfig, runnerToken } from './config.ts';
import { CHUNK_BYTES, MAX_CHANNELS, MAX_FRAME_BYTES, MAX_SOCKET_BYTES, RUNNER_PATH, filterHeaders, safeSocketClose, validateUpstreamPath, type FederationFrame, type WireHeaders } from './protocol.ts';
import { bytes, Tunnel } from './tunnel.ts';

interface HttpRequestState { opening: Promise<ClientRequest>; abort: AbortController; done: boolean }
interface SocketState { socket?: WebSocket; cancelled: boolean; queue: Promise<void> }
export interface RunnerClientOptions {
    config: RunnerConfig;
    /** Exact local listener returned by the official webServer service. */
    origin: string;
    /** Official connection.authenticatedUrl callback; the returned token never leaves this process. */
    authenticatedUrl(origin: string): string;
    dshVersion?: string;
    status?(state: 'connecting' | 'connected' | 'disconnected'): void;
}

/** Owns only a reverse transport; official DSH owns all sessions, approvals, tools and persistence. */
export class RunnerClient {
    private readonly lifetime = new AbortController();
    private readonly generation = randomUUID();
    private readonly requests = new Map<string, HttpRequestState>();
    private readonly sockets = new Map<string, SocketState>();
    private tunnel?: Tunnel;
    private socket?: WebSocket;
    private running?: Promise<void>;
    private cookie?: { value: string; expiresAt: number };
    private cookieRequest?: Promise<string>;

    constructor(private readonly options: RunnerClientOptions) {
        const origin = new URL(options.origin);
        if (origin.hostname !== '127.0.0.1' || !['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.username || origin.password) {
            throw new Error('Runner transport requires the official loopback DSH origin');
        }
    }

    start(): void {
        if (this.running) throw new Error('Runner client already started');
        runnerToken(this.options.config);
        this.running = this.run();
    }

    private async run(): Promise<void> {
        let failures = 0;
        while (!this.lifetime.signal.aborted) {
            this.options.status?.('connecting');
            let connected = false;
            try { connected = await this.connect(); } catch { /* Credential and upstream diagnostics never include their response bodies. */ }
            if (this.lifetime.signal.aborted) break;
            this.options.status?.('disconnected');
            failures = connected ? 0 : failures + 1;
            const pause = Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
            try { await delay(pause / 2 + Math.random() * pause / 2, undefined, { signal: this.lifetime.signal }); }
            catch { break; }
        }
    }

    private connect(): Promise<boolean> {
        const url = new URL(`${this.options.config.hub.url}/`);
        url.pathname = `${url.pathname.replace(/\/$/, '')}${RUNNER_PATH}`;
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('machine', this.options.config.machine.id);
        return new Promise((resolve) => {
            const socket = new WebSocket(url, { headers: { authorization: `Bearer ${runnerToken(this.options.config)}` },
                handshakeTimeout: 15_000, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, followRedirects: false });
            this.socket = socket;
            let connected = false;
            let helloTimer: ReturnType<typeof setTimeout> | undefined;
            socket.on('error', () => {});
            socket.once('close', () => {
                if (helloTimer) clearTimeout(helloTimer);
                if (this.socket === socket) delete this.socket;
                resolve(connected);
            });
            socket.once('open', () => {
                if (this.lifetime.signal.aborted) { socket.close(1000); return; }
                const tunnel = new Tunnel(socket, async (frame) => {
                    if (!connected) {
                        if (frame.type !== 'welcome') { tunnel.close(1002); return; }
                        connected = true;
                        if (helloTimer) clearTimeout(helloTimer);
                        this.options.status?.('connected');
                        return;
                    }
                    await this.receive(tunnel, frame);
                }, () => {
                    if (this.tunnel === tunnel) delete this.tunnel;
                    this.cancelChannels();
                });
                this.tunnel = tunnel;
                helloTimer = setTimeout(() => tunnel.close(1008), 10_000);
                helloTimer.unref();
                void tunnel.send({ type: 'hello', protocol: 1, machineId: this.options.config.machine.id,
                    name: this.options.config.machine.name, dshVersion: this.options.dshVersion ?? DSH_VERSION, generation: this.generation }).catch(() => tunnel.close(1011));
            });
        });
    }

    private async credential(): Promise<string> {
        if (this.cookie && this.cookie.expiresAt > Date.now() + 60_000) return this.cookie.value;
        if (this.cookieRequest) return this.cookieRequest;
        this.cookieRequest = (async () => {
            const response = await fetch(this.options.authenticatedUrl(this.options.origin), { redirect: 'manual', signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]) });
            await response.body?.cancel();
            const cookies = response.headers.getSetCookie();
            const value = cookies.filter((cookie) => cookie.startsWith('dsh-auth-')).map((cookie) => cookie.split(';')[0]).join('; ');
            if (response.status !== 303 || !value) throw new Error('Official DSH browser credential exchange failed');
            // Refresh daily, earlier than the official default absolute lifetime; no failed mutation is replayed.
            this.cookie = { value, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
            return value;
        })();
        try { return await this.cookieRequest; }
        finally { delete this.cookieRequest; }
    }

    private async receive(tunnel: Tunnel, frame: FederationFrame): Promise<void> {
        if (!('id' in frame)) { tunnel.close(1002); return; }
        if (frame.type === 'http-open') {
            if (this.requests.has(frame.id) || this.sockets.has(frame.id)) { tunnel.close(1002); return; }
            if (this.requests.size + this.sockets.size >= MAX_CHANNELS) {
                await tunnel.send({ type: 'http-error', id: frame.id, code: 'limit-exceeded' }); return;
            }
            this.openHttp(tunnel, frame);
        } else if (frame.type === 'data' && frame.lane === 'request') {
            const state = this.requests.get(frame.id);
            if (!state || state.abort.signal.aborted) return;
            try {
                const request = await state.opening;
                if (!state.abort.signal.aborted) await new Promise<void>((resolve, reject) => request.write(Buffer.from(frame.data, 'base64'), (error) => error ? reject(error) : resolve()));
            } catch { /* The opener owns the HTTP failure frame; late request bytes are discarded. */ }
        } else if (frame.type === 'http-end' && frame.lane === 'request') {
            const state = this.requests.get(frame.id);
            if (state && !state.abort.signal.aborted) {
                try { (await state.opening).end(); } catch { /* The opener already reported failure. */ }
            }
        } else if (frame.type === 'http-cancel') {
            const state = this.requests.get(frame.id);
            this.requests.delete(frame.id);
            state?.abort.abort();
        } else if (frame.type === 'ws-open') {
            if (this.requests.has(frame.id) || this.sockets.has(frame.id)) { tunnel.close(1002); return; }
            if (this.requests.size + this.sockets.size >= MAX_CHANNELS) {
                await tunnel.send({ type: 'ws-close', id: frame.id, code: 1013, reason: 'Runner channel limit reached' }); return;
            }
            const state: SocketState = { cancelled: false, queue: Promise.resolve() };
            this.sockets.set(frame.id, state);
            void this.openSocket(tunnel, frame, state).catch(() => {
                this.sockets.delete(frame.id);
                void tunnel.send({ type: 'ws-close', id: frame.id, code: 1011, reason: 'DSH socket unavailable' }).catch(() => {});
            });
        } else if (frame.type === 'data' && frame.lane === 'socket') {
            const socket = this.sockets.get(frame.id)?.socket;
            if (socket?.readyState === WebSocket.OPEN) await new Promise<void>((resolve, reject) => socket.send(Buffer.from(frame.data, 'base64'), { binary: frame.binary === true }, (error) => error ? reject(error) : resolve()));
        } else if (frame.type === 'ws-close') {
            const state = this.sockets.get(frame.id);
            this.sockets.delete(frame.id);
            if (state) { state.cancelled = true; state.socket?.close(safeSocketClose(frame.code), frame.reason); }
        }
    }

    private openHttp(tunnel: Tunnel, frame: Extract<FederationFrame, { type: 'http-open' }>): void {
        const abort = new AbortController();
        const state: HttpRequestState = { abort, done: false, opening: Promise.resolve(undefined as unknown as ClientRequest) };
        this.requests.set(frame.id, state);
        const fail = (): void => {
            if (state.done || abort.signal.aborted) return;
            state.done = true;
            this.requests.delete(frame.id);
            abort.abort();
            void tunnel.send({ type: 'http-error', id: frame.id, code: 'upstream-unavailable' }).catch(() => {});
        };
        state.opening = (async () => {
            const cookie = await this.credential();
            abort.signal.throwIfAborted();
            const url = new URL(validateUpstreamPath(frame.path), this.options.origin);
            const headers = Object.fromEntries(filterHeaders(frame.headers, 'request'));
            headers.cookie = cookie;
            headers.origin = this.options.origin;
            const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: frame.method, headers, signal: abort.signal });
            request.on('error', fail);
            request.once('response', (response) => {
                void (async () => {
                    const responseHeaders: WireHeaders = [];
                    for (let at = 0; at < response.rawHeaders.length; at += 2) responseHeaders.push([response.rawHeaders[at]!, response.rawHeaders[at + 1]!]);
                    await tunnel.send({ type: 'http-head', id: frame.id, status: response.statusCode ?? 502, headers: filterHeaders(responseHeaders, 'response') });
                    for await (const raw of response) {
                        const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                        for (let at = 0; at < data.byteLength; at += CHUNK_BYTES) await tunnel.sendData(frame.id, 'response', data.subarray(at, at + CHUNK_BYTES));
                    }
                    state.done = true;
                    this.requests.delete(frame.id);
                    await tunnel.send({ type: 'http-end', id: frame.id, lane: 'response' });
                })().catch(fail);
            });
            return request;
        })();
        void state.opening.catch(fail);
    }

    private async openSocket(tunnel: Tunnel, frame: Extract<FederationFrame, { type: 'ws-open' }>, state: SocketState): Promise<void> {
        const cookie = await this.credential();
        if (state.cancelled || !tunnel.isOpen) return;
        const url = new URL(validateUpstreamPath(frame.path), this.options.origin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url, frame.protocols, { headers: { cookie, origin: this.options.origin }, maxPayload: MAX_SOCKET_BYTES,
            perMessageDeflate: false, handshakeTimeout: 15_000, followRedirects: false });
        state.socket = socket;
        socket.on('error', () => {});
        socket.once('open', () => {
            void tunnel.send({ type: 'ws-ready', id: frame.id, protocol: socket.protocol }).catch(() => socket.close(1011));
        });
        socket.on('message', (data, binary) => {
            socket.pause();
            state.queue = state.queue.then(() => tunnel.sendData(frame.id, 'socket', bytes(data), binary)).then(() => {
                if (socket.readyState === WebSocket.OPEN) socket.resume();
            }).catch(() => socket.close(1011));
        });
        socket.once('close', (code, reason) => {
            this.sockets.delete(frame.id);
            void tunnel.send({ type: 'ws-close', id: frame.id, code: safeSocketClose(code), reason: reason.toString('utf8') }).catch(() => {});
        });
    }

    private cancelChannels(): void {
        for (const state of this.requests.values()) state.abort.abort();
        this.requests.clear();
        for (const state of this.sockets.values()) { state.cancelled = true; state.socket?.terminate(); }
        this.sockets.clear();
    }

    async stop(): Promise<void> {
        this.lifetime.abort();
        this.tunnel?.close(1000);
        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
        this.cancelChannels();
        await this.running;
        delete this.cookie;
    }
}
