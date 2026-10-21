import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { NativeTerminalBridge, type NativeTerminalSocket } from '../src/hapi/terminal.ts';
import type { FederationMount } from '../src/hub/federation.ts';
import type { HapiSession } from '../src/codex/contracts.ts';

class SourceSocket implements NativeTerminalSocket {
    connected = false;
    writeable = true;
    disconnected = false;
    sent: Array<{ event: string; payload: unknown }> = [];
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    writable(): boolean { return this.connected && this.writeable; }
    on(event: string, listener: (...args: unknown[]) => void): void { this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]); }
    emit(event: string, payload: unknown): void { this.sent.push({ event, payload }); }
    emitInput(event: string, payload: unknown): void { assert.equal(this.writable(), true); this.emit(event, payload); }
    connect(): void { this.connected = true; this.trigger('connect'); }
    disconnect(): void { this.connected = false; this.disconnected = true; this.listeners.clear(); }
    trigger(event: string, payload?: unknown): void { for (const callback of this.listeners.get(event) ?? []) callback(payload); }
}
async function until(test: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!test()) { if (Date.now() > deadline) throw new Error('Timed out waiting for fixture transport'); await delay(5); }
}
async function harness() {
    const sockets: SourceSocket[] = [];
    const authorizedSources: unknown[] = [];
    let upgrade: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>) | undefined;
    const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
    const bridge = new NativeTerminalBridge({ socketAuthentication: async () => ({ url: 'https://fixture-source.invalid', path: '/mounted/socket.io/', token: 'fixture-server-only' }) }, {
        resolveSource: async source => { authorizedSources.push(source); if (source.machineId === 'wrong-machine') throw new Error('Source mismatch'); return {} as HapiSession; },
    }, { createSocket: authentication => { assert.equal(authentication.token, 'fixture-server-only'); assert.equal(authentication.path, '/mounted/socket.io/'); const socket = new SourceSocket(); sockets.push(socket); return socket; } });
    const mount: FederationMount = { webServer: { register: () => () => {}, registerUpgrade: route => { upgrade = route.handler; return () => { upgrade = undefined; }; } }, authorize: request => request.headers.authorization === 'fixture-browser-owner' ? undefined : 401 };
    bridge.mount(mount); server.on('upgrade', (request, socket, head) => { void upgrade?.(request, socket, head); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const endpoint = `ws://127.0.0.1:${address.port}/hapi-dsh/terminal`;
    const browsers: WebSocket[] = [];
    async function browser() {
        const socket = new WebSocket(endpoint, { headers: { authorization: 'fixture-browser-owner' } }); browsers.push(socket);
        const frames: Array<Record<string, unknown>> = [];
        socket.on('message', data => { frames.push(JSON.parse(data.toString()) as Record<string, unknown>); });
        await once(socket, 'open'); return { socket, frames };
    }
    return { endpoint, browser, sockets, authorizedSources, close: async () => {
        for (const socket of browsers) if (socket.readyState !== WebSocket.CLOSED) { const done = once(socket, 'close'); socket.close(); await done; }
        bridge.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

test('actual WebSocket bridge keeps HAPI credentials server-side, gates input on replay, and detach never kills PTY', async () => {
    const fixture = await harness();
    try {
        const { socket, frames } = await fixture.browser();
        socket.send(JSON.stringify({ type: 'open', source: { sourceSessionId: 'native', machineId: 'source-machine' }, terminalId: 'saved-terminal', cols: 80, rows: 24 }));
        await until(() => fixture.sockets[0]?.sent.length === 1);
        const source = fixture.sockets[0]!;
        assert.deepEqual(source.sent[0], { event: 'terminal:create', payload: { sessionId: 'native', terminalId: 'saved-terminal', cols: 80, rows: 24, replayProtocol: 1 } });
        socket.send(JSON.stringify({ type: 'write', data: 'never-before-ready' }));
        await until(() => frames.some(frame => frame.code === 'input-not-delivered'));
        assert.equal(source.sent.length, 1);
        source.trigger('terminal:output', { terminalId: 'saved-terminal', sessionId: 'wrong-source', data: 'must-not-leak', stream: { version: 1, epoch: 'epoch', startOffset: 0, endOffset: 13, replay: true } });
        source.trigger('terminal:output', { terminalId: 'saved-terminal', sessionId: 'native', data: 'hello', stream: { version: 1, epoch: 'epoch', startOffset: 0, endOffset: 5, replay: true } });
        source.trigger('terminal:ready', { terminalId: 'saved-terminal', sessionId: 'native', replayProtocol: 1 });
        await until(() => frames.some(frame => frame.type === 'ready'));
        socket.send(JSON.stringify({ type: 'write', data: 'pwd\r' }));
        await until(() => source.sent.length === 2);
        assert.deepEqual(source.sent[1], { event: 'terminal:write', payload: { terminalId: 'saved-terminal', data: 'pwd\r' } });
        assert.equal(JSON.stringify(frames).includes('fixture-server-only'), false);
        assert.equal(JSON.stringify(frames).includes('must-not-leak'), false);
        source.writeable = false;
        socket.send(JSON.stringify({ type: 'write', data: 'never-queue-this' }));
        await until(() => frames.filter(frame => frame.code === 'input-not-delivered').length === 2);
        assert.equal(source.sent.length, 2);
        const closed = once(socket, 'close'); socket.close(); await closed; await until(() => source.disconnected);
        assert.equal(source.sent.some(frame => /close|abort|stop/.test(frame.event)), false);
        const reopened = await fixture.browser();
        reopened.socket.send(JSON.stringify({ type: 'open', source: { sourceSessionId: 'native', machineId: 'source-machine' }, terminalId: 'saved-terminal', cols: 90, rows: 30, outputCursor: { epoch: 'epoch', offset: 5 } }));
        await until(() => fixture.sockets.length === 2 && fixture.sockets[1]!.sent.length === 1);
        assert.deepEqual((fixture.sockets[1]!.sent[0]!.payload as Record<string, unknown>).outputCursor, { epoch: 'epoch', offset: 5 });
        assert.equal(fixture.sockets[1]!.sent.some(frame => frame.event === 'terminal:write'), false);
    } finally { await fixture.close(); }
});

test('terminal rejects unauthenticated browser, wrong source machine and identity switching', async () => {
    const fixture = await harness();
    try {
        const denied = new WebSocket(fixture.endpoint); const rejected = once(denied, 'error'); await rejected;
        assert.equal(fixture.authorizedSources.length, 0); assert.equal(fixture.sockets.length, 0);
        const wrong = await fixture.browser();
        wrong.socket.send(JSON.stringify({ type: 'open', source: { sourceSessionId: 'native', machineId: 'wrong-machine' }, terminalId: 'terminal', cols: 80, rows: 24 }));
        await once(wrong.socket, 'close'); assert.equal(fixture.sockets.length, 0);
        const viewer = await fixture.browser();
        const frame = { type: 'open', source: { sourceSessionId: 'native' }, terminalId: 'terminal', cols: 80, rows: 24 };
        viewer.socket.send(JSON.stringify(frame)); await until(() => fixture.sockets.length === 1);
        const closed = once(viewer.socket, 'close'); viewer.socket.send(JSON.stringify({ ...frame, source: { sourceSessionId: 'other-native' } }));
        const [code] = await closed; assert.equal(code, 1008); assert.equal(fixture.authorizedSources.length, 2);
    } finally { await fixture.close(); }
});
