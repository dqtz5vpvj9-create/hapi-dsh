import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HapiClient } from '../src/hapi/client.ts';
import { HapiRequestError } from '../src/codex/contracts.ts';
import { mountSourceBackup } from '../src/hapi/source-backup.ts';
import type { FederationMount } from '../src/hub/federation.ts';

test('SQLite snapshot uses one exact original POST with private authentication and no redirect or mutation retry', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new HapiClient({ hubId: 'hub', url: 'https://fixture.invalid/hapi', token: 'fixture-access', fetch: async (input, init) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) });
        if (String(input).endsWith('/auth')) return Response.json({ token: 'fixture-private-jwt' });
        return new Response('not a backup', { status: 302, headers: { location: 'https://another.invalid/private-copy' } });
    } });
    try {
        await assert.rejects(client.downloadSqliteBackup(new AbortController().signal), (error: unknown) => error instanceof HapiRequestError && error.status === 302 && !error.message.includes('fixture-private'));
        assert.equal(calls.length, 2); assert.equal(calls[1]?.url, 'https://fixture.invalid/hapi/api/storage/sqlite/backup');
        assert.equal(calls[1]?.init?.method, 'POST'); assert.equal(calls[1]?.init?.redirect, 'manual');
        assert.equal(new Headers(calls[1]?.init?.headers).get('authorization'), 'Bearer fixture-private-jwt');
    } finally { await client.close(); }
});

class ResponseFixture extends EventEmitter {
    destroyed = false; headersSent = false; statusCode = 0; completed = false;
    headers: Record<string, string> = {}; chunks: Buffer[] = [];
    writeHead(status: number, headers?: Record<string, string>) { this.statusCode = status; this.headers = headers ?? {}; this.headersSent = true; return this; }
    // Models the original compressor's callback-dropping write wrapper.
    write(value: Uint8Array | string): boolean { this.chunks.push(Buffer.from(value)); setImmediate(() => this.emit('drain')); return false; }
    end(value?: string) { if (value) this.chunks.push(Buffer.from(value)); this.completed = true; this.emit('finish'); }
    destroy() { this.destroyed = true; this.emit('close'); }
}
const request = (hubId = 'hub', extra: Partial<IncomingMessage> = {}) => Object.assign(Readable.from([JSON.stringify({ hubId })]), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hapi-backup': '1' }, ...extra,
}) as IncomingMessage;

test('backup stream respects actual drain, forwards exact bytes and never exposes upstream headers', async () => {
    let handler: Parameters<FederationMount['webServer']['register']>[0]['handler'] | undefined;
    const bytes = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(1024 * 1024, 9)]);
    let requests = 0, abort: AbortSignal | undefined;
    const remove = mountSourceBackup({ hubId: 'hub', downloadSqliteBackup: async signal => {
        requests++; abort = signal;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 65536) controller.enqueue(bytes.subarray(offset, offset + 65536)); controller.close();
        } }), { headers: { 'Content-Type': 'application/vnd.sqlite3', 'set-cookie': 'fixture-private-token' } });
    } }, { authorize: () => undefined, webServer: { register: route => { handler = route.handler; return () => { handler = undefined; }; } } as FederationMount['webServer'] });
    const response = new ResponseFixture(); await handler!(request(), response as unknown as ServerResponse);
    assert.equal(response.statusCode, 200); assert.equal(response.completed, true); assert.equal(response.destroyed, false);
    assert.deepEqual(Buffer.concat(response.chunks), bytes); assert.equal(response.headers['set-cookie'], undefined); assert.equal(requests, 1);
    assert.equal(abort?.aborted, true); remove(); assert.equal(handler, undefined);
});

test('backup rejects another Hub and malformed browser requests before accessing source; stream failure aborts download', async () => {
    let handler: Parameters<FederationMount['webServer']['register']>[0]['handler'] | undefined;
    let requests = 0;
    mountSourceBackup({ hubId: 'hub', downloadSqliteBackup: async () => {
        requests++; return new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('source disconnected')); } }), { headers: { 'content-type': 'application/vnd.sqlite3' } });
    } }, { authorize: () => undefined, webServer: { register: route => { handler = route.handler; return () => {}; } } as FederationMount['webServer'] });
    const wrong = new ResponseFixture(); await handler!(request('another-hub'), wrong as unknown as ServerResponse); assert.equal(wrong.statusCode, 409);
    const simple = new ResponseFixture(); await handler!(request('hub', { headers: { 'content-type': 'text/plain' } }), simple as unknown as ServerResponse); assert.equal(simple.statusCode, 400); assert.equal(requests, 0);
    const interrupted = new ResponseFixture(); await handler!(request(), interrupted as unknown as ServerResponse);
    assert.equal(interrupted.destroyed, true); assert.equal(interrupted.completed, false); assert.equal(requests, 1);
});
