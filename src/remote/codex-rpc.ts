/** Native Codex app-server JSON-RPC. Transport reconnect never retries a write. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';
import { SourceError, waitFor } from './errors.ts';
import type { DirectCodexConfig } from './protocol.ts';

export interface NativeNotification { method: string; params: Record<string, unknown> }
export interface NativeRequest extends NativeNotification { id: string | number; generation: number }
export interface NativeInitialize { userAgent: string; codexHome: string; platformFamily: string; platformOs: string }
interface Pending {
    resolve(value: unknown): void; reject(error: unknown): void;
    timer: ReturnType<typeof setTimeout>; write: boolean; dispatched: boolean;
}
interface Connection {
    generation: number; child?: ChildProcessWithoutNullStreams; socket?: WebSocket;
    closed: boolean; stopped: Promise<void>; send(line: string): Promise<void>; close(): void;
}
const MAX_FRAME = 16 * 1024 * 1024;
const MAX_PENDING = 128;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export class CodexRpcError extends Error {
    override readonly name = 'CodexRpcError';
    constructor(readonly code: number, message: string) { super(message); }
}
export class CodexRpc {
    private connection: Connection | undefined;
    private opening: Promise<NativeInitialize> | undefined;
    private initialized: NativeInitialize | undefined;
    private generation = 0;
    private nextId = 0;
    private disposed = false;
    private readonly connections = new Set<Connection>();
    private disposing: Promise<void> | undefined;
    private readonly pending = new Map<string, Pending>();
    private readonly notifications = new Set<(value: NativeNotification) => void>();
    private readonly requests = new Set<(value: NativeRequest) => void>();
    private readonly disconnects = new Set<() => void>();

    constructor(private readonly config: DirectCodexConfig, private readonly timeoutMs = 30_000) {}
    get online(): boolean { return Boolean(this.initialized && this.connection && !this.connection.closed); }
    get currentGeneration(): number { return this.connection?.generation ?? this.generation; }
    onNotification(listener: (value: NativeNotification) => void): () => void { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
    onRequest(listener: (value: NativeRequest) => void): () => void { this.requests.add(listener); return () => { this.requests.delete(listener); }; }
    onDisconnect(listener: () => void): () => void { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }

    connect(signal?: AbortSignal): Promise<NativeInitialize> {
        if (this.disposed) return Promise.reject(new SourceError('DISPOSED', 'The native source connection is closed.'));
        signal?.throwIfAborted();
        if (this.initialized && this.online) return Promise.resolve(this.initialized);
        if (!this.opening) {
            const opening = this.open().then(async connection => {
                if (this.disposed) { connection.close(); throw new SourceError('DISPOSED', 'The native source connection is closed.'); }
                this.connection = connection;
                const response = await this.requestOn(connection, 'initialize', {
                    clientInfo: { name: 'hhpi', title: 'HHPI remote agent access', version: '1' },
                    capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true },
                }, false);
                if (!record(response) || typeof response.userAgent !== 'string' || typeof response.codexHome !== 'string') {
                    throw new SourceError('UNSUPPORTED', 'The native app-server returned an unsupported initialization response.');
                }
                await connection.send(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
                this.initialized = response as unknown as NativeInitialize;
                return this.initialized;
            }).catch(error => {
                if (this.connection) this.lost(this.connection);
                throw error;
            }).finally(() => { if (this.opening === opening) this.opening = undefined; });
            this.opening = opening;
        }
        return waitFor(this.opening, signal);
    }

    private async open(): Promise<Connection> {
        const generation = ++this.generation;
        if (this.config.endpoint) {
            const socket = new WebSocket(this.config.endpoint, { maxPayload: MAX_FRAME, followRedirects: false, handshakeTimeout: this.timeoutMs });
            const connection: Connection = { generation, socket, closed: false, stopped: new Promise<void>(resolve => { socket.once('close', () => { resolve(); }); }),
                send: line => new Promise((resolve, reject) => {
                    if (connection.closed || socket.readyState !== WebSocket.OPEN) { reject(new SourceError('TARGET_UNAVAILABLE', 'The native socket is closed.')); return; }
                    if (socket.bufferedAmount > MAX_FRAME) { reject(new SourceError('CAPACITY_EXCEEDED', 'The native socket is applying backpressure.')); return; }
                    socket.send(line.trimEnd(), error => error ? reject(error) : resolve());
                }),
                close: () => { socket.terminate(); },
            };
            this.track(connection);
            socket.on('message', bytes => { this.receive(connection, bytes.toString()); });
            socket.on('close', () => { this.lost(connection); });
            socket.on('error', () => { this.lost(connection); });
            await new Promise<void>((resolve, reject) => {
                const done = (): void => { cleanup(); resolve(); };
                const error = (): void => { cleanup(); reject(new SourceError('TARGET_UNAVAILABLE', 'The native app-server WebSocket could not be opened.')); };
                const cleanup = (): void => { socket.off('open', done); socket.off('error', error); socket.off('close', error); };
                socket.once('open', done); socket.once('error', error); socket.once('close', error);
            });
            return connection;
        }
        const child = spawn(this.config.command ?? 'codex', this.config.args ?? ['app-server'], {
            ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
            env: { ...process.env, ...(this.config.codexHome ? { CODEX_HOME: this.config.codexHome } : {}) },
            stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
        });
        const connection: Connection = { generation, child, closed: false, stopped: new Promise<void>(resolve => { child.once('close', () => { resolve(); }); }),
            send: line => new Promise((resolve, reject) => {
                if (connection.closed || child.stdin.destroyed) { reject(new SourceError('TARGET_UNAVAILABLE', 'The native app-server input is closed.')); return; }
                if (child.stdin.writableLength > MAX_FRAME) { reject(new SourceError('CAPACITY_EXCEEDED', 'The native app-server is applying backpressure.')); return; }
                child.stdin.write(line, error => error ? reject(error) : resolve());
            }),
            close: () => { child.stdin.end(); child.kill('SIGTERM'); },
        };
        this.track(connection);
        const decoder = new StringDecoder('utf8'); let buffer = '';
        child.stdout.on('data', (chunk: Buffer) => {
            buffer += decoder.write(chunk);
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
                if (line.trim()) this.receive(connection, line);
                if (connection.closed) return;
            }
            if (Buffer.byteLength(buffer) > MAX_FRAME) this.lost(connection);
        });
        // Always drain stderr; it may contain source-local paths or model content and is never persisted in HHPI logs.
        child.stderr.resume();
        child.stdin.on('error', () => { this.lost(connection); });
        child.on('exit', () => { this.lost(connection); });
        child.on('error', () => { this.lost(connection); });
        await new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', () => { reject(new SourceError('TARGET_UNAVAILABLE', 'The native Codex app-server executable could not be started.')); });
        });
        return connection;
    }

    private receive(connection: Connection, line: string): void {
        if (connection.closed) return;
        let value: unknown;
        try { if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('frame limit'); value = JSON.parse(line); }
        catch { this.lost(connection); return; }
        if (!record(value)) { this.lost(connection); return; }
        if (typeof value.method === 'string') {
            const params = record(value.params) ? value.params : {};
            if (typeof value.id === 'string' || typeof value.id === 'number') {
                const request = { id: value.id, method: value.method, params, generation: connection.generation };
                if (!this.requests.size) {
                    void this.respond(request, undefined, { code: -32601, message: 'This native request is not supported by the connected viewer.' }).catch(() => {});
                } else for (const listener of [...this.requests]) listener(request);
            } else for (const listener of [...this.notifications]) listener({ method: value.method, params });
            return;
        }
        if (typeof value.id !== 'string' && typeof value.id !== 'number') return;
        const key = `${connection.generation}:${String(value.id)}`, pending = this.pending.get(key);
        if (!pending) return; // An individually cancelled read has no consumer; it does not cancel shared source work.
        this.pending.delete(key); clearTimeout(pending.timer);
        if (record(value.error) && typeof value.error.code === 'number') pending.reject(new CodexRpcError(value.error.code, typeof value.error.message === 'string' ? value.error.message : 'The native app-server rejected this request.'));
        else if ('result' in value) pending.resolve(value.result);
        else pending.reject(new SourceError(pending.write ? 'OUTCOME_UNKNOWN' : 'TARGET_UNAVAILABLE', 'The native app-server returned an invalid response.'));
    }

    private requestOn(connection: Connection, method: string, params: unknown, write: boolean, signal?: AbortSignal): Promise<unknown> {
        if (connection.closed || this.disposed) return Promise.reject(new SourceError('TARGET_UNAVAILABLE', 'The native source is unavailable. Nothing was dispatched.'));
        signal?.throwIfAborted();
        if (this.pending.size >= MAX_PENDING) return Promise.reject(new SourceError('CAPACITY_EXCEEDED', 'The native source request limit has been reached. Nothing was dispatched.'));
        const id = `hhpi-${++this.nextId}`, key = `${connection.generation}:${id}`;
        const line = JSON.stringify({ id, method, params }) + '\n';
        if (Buffer.byteLength(line) > MAX_FRAME) return Promise.reject(new SourceError('CAPACITY_EXCEEDED', 'The native source request exceeds the frame limit. Nothing was dispatched.'));
        const work = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(key);
                reject(new SourceError(write ? 'OUTCOME_UNKNOWN' : 'TARGET_UNAVAILABLE', write ? 'The native operation acknowledgement timed out; it must not be retried automatically.' : 'The native source read timed out.'));
            }, this.timeoutMs);
            const pending: Pending = { resolve, reject, timer, write, dispatched: true };
            this.pending.set(key, pending);
            void connection.send(line).catch(() => {
                if (this.pending.get(key) !== pending) return;
                this.pending.delete(key); clearTimeout(timer);
                reject(new SourceError(write ? 'OUTCOME_UNKNOWN' : 'TARGET_UNAVAILABLE', 'The native transport failed while dispatching the request.'));
            });
        });
        // Remove only this read's pending waiter. Never cancel or resend a native write on a browser disconnect.
        const abort = (): void => { const pending = this.pending.get(key); if (pending) { this.pending.delete(key); clearTimeout(pending.timer); pending.reject(signal!.reason); } };
        if (signal && !write) { signal.addEventListener('abort', abort, { once: true }); void work.finally(() => { signal.removeEventListener('abort', abort); }).catch(() => {}); }
        return work;
    }
    async request<T>(method: string, params: unknown, options: { write?: boolean; signal?: AbortSignal } = {}): Promise<T> {
        await this.connect(options.signal);
        options.signal?.throwIfAborted();
        return this.requestOn(this.connection!, method, params, options.write === true, options.signal) as Promise<T>;
    }
    async respond(request: NativeRequest, result?: unknown, error?: { code: number; message: string }): Promise<void> {
        const connection = this.connection;
        if (!connection || connection.closed || request.generation !== connection.generation) throw new SourceError('TARGET_UNAVAILABLE', 'This approval belongs to an expired native connection. Nothing was dispatched.');
        try { await connection.send(JSON.stringify({ id: request.id, ...(error ? { error } : { result: result ?? null }) }) + '\n'); }
        catch { throw new SourceError('OUTCOME_UNKNOWN', 'The native approval response may have been delivered. It must not be resent.'); }
    }
    private lost(connection: Connection): void {
        if (connection.closed) return;
        connection.closed = true; connection.close();
        for (const [key, pending] of this.pending) {
            if (!key.startsWith(`${connection.generation}:`)) continue;
            this.pending.delete(key); clearTimeout(pending.timer);
            pending.reject(new SourceError(pending.write && pending.dispatched ? 'OUTCOME_UNKNOWN' : 'TARGET_UNAVAILABLE', 'The native source disconnected. No operation is retried automatically.'));
        }
        if (this.connection === connection) { this.connection = undefined; this.initialized = undefined; for (const listener of [...this.disconnects]) listener(); }
    }
    private track(connection: Connection): void {
        this.connections.add(connection);
        void connection.stopped.then(() => { this.connections.delete(connection); });
    }
    /** Release an owned native process only when the source itself is disposed, never when a Pane closes. */
    dispose(): Promise<void> {
        if (this.disposing) return this.disposing;
        this.disposed = true;
        const connections = [...this.connections];
        for (const connection of connections) this.lost(connection);
        this.notifications.clear(); this.requests.clear(); this.disconnects.clear();
        this.disposing = Promise.all(connections.map(async connection => {
            const force = setTimeout(() => { connection.child?.kill('SIGKILL'); connection.socket?.terminate(); }, 3000);
            try { await connection.stopped; } finally { clearTimeout(force); }
        })).then(() => {});
        return this.disposing;
    }
}
