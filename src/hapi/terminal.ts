/** Authenticated DSH WebSocket → original HAPI /terminal Socket.IO namespace. */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Manager } from 'socket.io-client';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { HapiClient } from './client.ts';
import type { NativeWorkbench } from './workbench.ts';
import type { FederationMount } from '../hub/federation.ts';
import { WORKBENCH_TERMINAL_PATH, terminalClientFrameSchema, terminalOutputStreamSchema, type TerminalServerFrame } from '../workbench-types.ts';

export interface NativeTerminalAuthentication { url: string; path: string; token: string }
/** An injected transport keeps tests on the actual bridge protocol without a shell. */
export interface NativeTerminalSocket {
    readonly connected: boolean;
    writable(): boolean;
    on(event: string, listener: (...args: unknown[]) => void): void;
    emit(event: string, payload: unknown): void;
    emitInput(event: string, payload: unknown): void;
    connect(): void;
    disconnect(): void;
}
export function createNativeTerminalSocket(authentication: NativeTerminalAuthentication): NativeTerminalSocket {
    const manager = new Manager(authentication.url, {
        path: authentication.path, autoConnect: false, reconnection: false,
        transports: ['websocket'], timeout: 15_000,
    });
    const socket = manager.socket('/terminal', { auth: { token: authentication.token } });
    return {
        get connected() { return socket.connected; },
        writable: () => socket.connected && manager.engine?.transport.writable === true,
        on: (event, listener) => { socket.on(event, listener); },
        emit: (event, payload) => { socket.emit(event, payload); },
        // Socket.IO's default sendBuffer must never replay a keystroke after a
        // disconnect. The bridge additionally reports unwritable transports.
        emitInput: (event, payload) => { socket.volatile.emit(event, payload); },
        connect: () => { socket.connect(); },
        disconnect: () => { socket.removeAllListeners(); socket.disconnect(); },
    };
}
const terminalOutput = z.object({ terminalId: z.string(), sessionId: z.string().optional(), data: z.string().max(4 * 1024 * 1024), stream: terminalOutputStreamSchema.optional() });
const terminalReady = z.object({ terminalId: z.string(), sessionId: z.string().optional(), replayProtocol: z.literal(1).optional() });
const terminalExit = z.object({ terminalId: z.string(), sessionId: z.string().optional(), code: z.number().int().nullable(), signal: z.string().nullable() });
const terminalError = z.object({ terminalId: z.string(), sessionId: z.string().optional(), message: z.string().max(8192) });

export interface NativeTerminalBridgeOptions {
    createSocket?: (authentication: NativeTerminalAuthentication) => NativeTerminalSocket;
    maxConnections?: number;
}
export class NativeTerminalBridge {
    private readonly server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 128 * 1024 });
    private dispose: (() => void) | undefined;
    private readonly sockets = new Set<WebSocket>();
    private readonly factory: (authentication: NativeTerminalAuthentication) => NativeTerminalSocket;
    constructor(private readonly client: Pick<HapiClient, 'socketAuthentication'>, private readonly workbench: Pick<NativeWorkbench, 'resolveSource'>, private readonly options: NativeTerminalBridgeOptions = {}) {
        this.factory = options.createSocket ?? createNativeTerminalSocket;
    }
    mount({ webServer, authorize }: FederationMount): void {
        if (this.dispose) throw new Error('Native terminal bridge is already mounted');
        this.dispose = webServer.registerUpgrade({ path: WORKBENCH_TERMINAL_PATH, handler: (request, socket, head) => {
            const rejection = authorize(request);
            if (rejection !== undefined) { reject(socket, rejection); return; }
            if (this.sockets.size >= (this.options.maxConnections ?? 64)) { reject(socket, 429); return; }
            this.accept(request, socket, head);
        } });
    }
    close(): void {
        this.dispose?.(); this.dispose = undefined;
        for (const socket of this.sockets) socket.close(1001, 'Workbench stopped');
        this.server.close();
    }
    private accept(request: IncomingMessage, socket: Duplex, head: Buffer): void {
        this.server.handleUpgrade(request, socket, head, browser => {
            this.sockets.add(browser);
            browser.on('error', () => browser.terminate());
            let upstream: NativeTerminalSocket | undefined;
            let opening = false;
            let terminalId: string | undefined;
            let sourceSessionId: string | undefined;
            let ready = false;
            let replay = false;
            let blocked = false;
            const timer = setTimeout(() => browser.close(1008, 'A terminal identity is required'), 10_000);
            timer.unref();
            const send = (frame: TerminalServerFrame): void => {
                if (browser.readyState !== WebSocket.OPEN) return;
                if (browser.bufferedAmount > 8 * 1024 * 1024) { browser.close(1013, 'Output receiver is too slow; reconnect using its cursor'); return; }
                browser.send(JSON.stringify(frame), error => { if (error) browser.terminate(); });
            };
            const fail = (message: string, code: Extract<TerminalServerFrame, { type: 'error' }>['code'] = 'unavailable'): void => {
                send({ type: 'error', message, code });
                browser.close(1011, 'Native terminal unavailable');
            };
            const owns = (payload: { terminalId: string; sessionId?: string | undefined }): boolean => payload.terminalId === terminalId && (payload.sessionId === undefined || payload.sessionId === sourceSessionId);
            browser.once('close', () => {
                clearTimeout(timer); this.sockets.delete(browser);
                // The upstream disconnect handler detaches the viewer and keeps
                // the PTY/replay buffer until the source's normal idle policy.
                // Never emit terminal:close or an agent lifecycle command.
                upstream?.disconnect();
            });
            browser.on('message', (data, binary) => {
                if (binary) { browser.close(1003, 'Only JSON terminal frames are supported'); return; }
                let value: unknown;
                try { value = JSON.parse(data.toString()); } catch { browser.close(1007, 'Invalid terminal frame'); return; }
                const parsed = terminalClientFrameSchema.safeParse(value);
                if (!parsed.success) { browser.close(1008, 'Invalid terminal request'); return; }
                const frame = parsed.data;
                if (frame.type === 'open') {
                    if (opening) { browser.close(1008, 'One source terminal is allowed per connection'); return; }
                    opening = true; terminalId = frame.terminalId; sourceSessionId = frame.source.sourceSessionId;
                    void (async () => {
                        try {
                            await this.workbench.resolveSource(frame.source);
                            const authentication = await this.client.socketAuthentication();
                            if (browser.readyState !== WebSocket.OPEN) return;
                            upstream = this.factory(authentication);
                            upstream.on('connect', () => {
                                clearTimeout(timer);
                                if (browser.readyState !== WebSocket.OPEN) { upstream?.disconnect(); return; }
                                upstream?.emit('terminal:create', { sessionId: sourceSessionId, terminalId, cols: frame.cols, rows: frame.rows, replayProtocol: 1, ...(frame.outputCursor === undefined ? {} : { outputCursor: frame.outputCursor }) });
                            });
                            upstream.on('terminal:output', payload => {
                                const output = terminalOutput.safeParse(payload);
                                if (!output.success) { fail('The source returned incompatible terminal output', 'protocol'); return; }
                                if (!owns(output.data)) return;
                                if (output.data.stream?.replay) replay = true;
                                if (output.data.stream?.gap) blocked = true;
                                send({ type: 'output', data: output.data.data, ...(output.data.stream === undefined ? {} : { stream: output.data.stream }) });
                            });
                            upstream.on('terminal:ready', payload => {
                                const result = terminalReady.safeParse(payload);
                                if (!result.success || !owns(result.data)) return;
                                ready = true;
                                if (result.data.replayProtocol !== 1) blocked = true;
                                send({ type: 'ready', ...(result.data.replayProtocol === undefined ? {} : { replayProtocol: result.data.replayProtocol }) });
                            });
                            upstream.on('terminal:exit', payload => {
                                const result = terminalExit.safeParse(payload);
                                if (!result.success || !owns(result.data)) return;
                                ready = false; send({ type: 'exit', code: result.data.code, signal: result.data.signal });
                            });
                            upstream.on('terminal:error', payload => {
                                const result = terminalError.safeParse(payload);
                                if (result.success && owns(result.data)) { ready = false; send({ type: 'error', message: result.data.message, code: 'source-error' }); }
                            });
                            upstream.on('connect_error', () => fail('The owning HAPI terminal connection was rejected or is unavailable'));
                            upstream.on('disconnect', () => { ready = false; fail('The owning HAPI terminal disconnected. Output will resume from the accepted cursor.'); });
                            upstream.connect();
                        } catch { fail('The source session is unavailable or belongs to another machine'); }
                    })();
                    return;
                }
                if (!upstream?.connected || !upstream.writable() || !ready || !replay || blocked) {
                    if (frame.type === 'write') send({ type: 'error', message: 'This input was not delivered. Wait for the source terminal and replay to be ready.', code: 'input-not-delivered' });
                    return;
                }
                if (frame.type === 'write') upstream.emitInput('terminal:write', { terminalId, data: frame.data });
                else upstream.emitInput('terminal:resize', { terminalId, cols: frame.cols, rows: frame.rows });
            });
        });
    }
}
function reject(socket: Duplex, status: number): void { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
