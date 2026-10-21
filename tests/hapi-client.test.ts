import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { HapiClient } from '../src/hapi/client.ts';
import { HapiRequestError } from '../src/codex/contracts.ts';
import { readServerEvents } from '../src/hapi/sse.ts';

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const auth = (): Response => json({ token: 'fixture-jwt' });
const base = { hubId: 'fixture-hub', url: 'http://127.0.0.1:39091', token: 'fixture-access-token', reconnectMinMs: 2, reconnectMaxMs: 5 };

test('the original health capability route is read-only and does not broaden proxy destinations', async () => {
    const calls: string[] = [], client = new HapiClient({ ...base, fetch: async input => {
        calls.push(String(input)); return String(input).endsWith('/auth') ? auth() : json({ capabilities: { titleSuggestion: true } });
    } });
    try {
        assert.deepEqual(await client.request('/health'), { capabilities: { titleSuggestion: true } });
        for (const path of ['/health?other=1', '//other.example/health', '/private', 'https://other.example/health']) await assert.rejects(client.request(path), /Invalid HAPI/);
        await assert.rejects(client.request('/health', { method: 'POST' }), /Invalid HAPI/);
        assert.deepEqual(calls, [`${base.url}/api/auth`, `${base.url}/health`]);
    } finally { await client.close(); }
});

test('a connection failure after a mutation is indeterminate and is never retried automatically', async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
    const client = new HapiClient({ ...base, fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('Authorization') });
        if (String(input).endsWith('/auth')) return auth();
        throw new TypeError('connection reset after server admission');
    } });
    try {
        await assert.rejects(client.sendMessage('thread/one', { localId: 'stable-request', text: 'test', deliveryMode: 'queue' }),
            (error: unknown) => error instanceof HapiRequestError && error.outcome === 'indeterminate');
        assert.equal(calls.filter(call => call.method === 'POST' && !call.url.endsWith('/auth')).length, 1);
        assert.equal(calls[0]?.authorization, null);
        assert.equal(calls[1]?.authorization, 'Bearer fixture-jwt');
        assert.match(calls[1]!.url, /thread%2Fone\/messages$/);
    } finally { await client.close(); }
});

test('a read rejected with 401 refreshes authentication once', async () => {
    let authCalls = 0;
    let reads = 0;
    const client = new HapiClient({ ...base, fetch: async (input) => {
        if (String(input).endsWith('/auth')) { authCalls++; return json({ token: `fixture-jwt-${authCalls}` }); }
        reads++;
        return reads === 1 ? json({ error: 'expired' }, 401) : json({ sessions: [] });
    } });
    try {
        assert.deepEqual(await client.listSessions(), []);
        assert.equal(authCalls, 2);
        assert.equal(reads, 2);
    } finally { await client.close(); }
});

test('document JSON response budgets bound streamed bytes and declared lengths independently of authentication', async () => {
    const value = { success: true, content: Buffer.from('original source bytes').toString('base64') };
    const wire = JSON.stringify(value), bytes = Buffer.byteLength(wire);
    let declared = false, calls = 0;
    const client = new HapiClient({ ...base, fetch: async input => {
        if (String(input).endsWith('/auth')) return auth();
        calls++;
        return new Response(wire, { headers: declared ? { 'Content-Length': String(bytes) } : {} });
    } });
    try {
        assert.deepEqual(await client.request('/api/sessions/original/file?path=report.txt', { maxResponseBytes: bytes }), value);
        await assert.rejects(client.request('/api/sessions/original/file?path=report.txt', { maxResponseBytes: bytes - 1 }), /exceeds the supported size/);
        declared = true;
        await assert.rejects(client.request('/api/sessions/original/file?path=report.txt', { maxResponseBytes: bytes - 1 }), /exceeds the supported size/);
        for (const maxResponseBytes of [0, NaN, Infinity, 90 * 1024 * 1024 + 1]) {
            await assert.rejects(client.request('/api/sessions/original/file?path=report.txt', { maxResponseBytes }), /Invalid HAPI response byte limit/);
        }
        assert.equal(calls, 3, 'A rejected response and an invalid budget must not trigger a retry');
    } finally { await client.close(); }
});

test('a mutation returning 401 is indeterminate because upstream can mask a downstream failure as authentication failure', async () => {
    let authCalls = 0;
    let mutations = 0;
    const client = new HapiClient({ ...base, fetch: async (input, init) => {
        if (String(input).endsWith('/auth')) { authCalls++; return auth(); }
        if (init?.method === 'POST') { mutations++; return json({ error: 'Invalid token' }, 401); }
        return json({ sessions: [] });
    } });
    try {
        await assert.rejects(client.sendMessage('one', { localId: 'stable-request', text: 'execute once', deliveryMode: 'queue' }),
            (error: unknown) => error instanceof HapiRequestError && error.outcome === 'indeterminate' && error.status === 401);
        assert.equal(mutations, 1);
        assert.equal(authCalls, 1);
        await client.listSessions();
        assert.equal(authCalls, 2, 'Next read refreshes credentials, without replaying the unknown write');
        assert.equal(mutations, 1);
    } finally { await client.close(); }
});

test('stale approvals are rejected; server failure remains indeterminate without replay', async () => {
    for (const [status, outcome] of [[409, 'rejected'], [503, 'indeterminate']] as const) {
        let submissions = 0;
        const client = new HapiClient({ ...base, fetch: async input => {
            if (String(input).endsWith('/auth')) return auth();
            submissions++;
            return json({ error: 'fixture-access-token should never be reflected', code: 'stale_request' }, status);
        } });
        try {
            await assert.rejects(client.approve('thread', 'approval', { decision: 'approved' }), (error: unknown) => {
                assert(error instanceof HapiRequestError);
                assert.equal(error.outcome, outcome);
                assert.equal(error.status, status);
                assert.equal(error.message.includes('fixture-access-token'), false);
                return true;
            });
            assert.equal(submissions, 1);
        } finally { await client.close(); }
    }
});

test('voice multipart keeps original recording bytes and lets fetch choose the boundary', async () => {
    const form = new FormData(); form.append('file', new Blob([Uint8Array.of(0, 127, 255)], { type: 'audio/webm' }), 'recording.webm');
    form.append('provider', 'openai');
    let submissions = 0;
    const client = new HapiClient({ ...base, fetch: async (input, init) => {
        if (String(input).endsWith('/auth')) return auth();
        submissions++; assert.equal(init?.redirect, 'manual');
        assert.equal(new Headers(init?.headers).get('Content-Type'), null);
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-jwt');
        assert.equal(init?.body, form);
        const request = new Request(String(input), init);
        assert.match(request.headers.get('Content-Type')!, /^multipart\/form-data; boundary=/);
        const uploaded = await request.formData(); const recording = uploaded.get('file') as File;
        assert.equal(recording.name, 'recording.webm'); assert.equal(recording.type, 'audio/webm');
        assert.deepEqual(new Uint8Array(await recording.arrayBuffer()), Uint8Array.of(0, 127, 255));
        return json({ text: 'transcribed words' });
    } });
    try {
        assert.deepEqual(await client.request('/api/voice/transcription', { method: 'POST', body: form }), { text: 'transcribed words' });
        assert.equal(submissions, 1);
    } finally { await client.close(); }
});

test('a multipart 401 never resubmits a recording whose outcome is unknown', async () => {
    let submissions = 0; let authentication = 0;
    const client = new HapiClient({ ...base, fetch: async (input) => {
        if (String(input).endsWith('/auth')) { authentication++; return auth(); }
        submissions++; return json({ error: 'authentication or downstream error' }, 401);
    } });
    const form = new FormData(); form.append('file', new Blob(['recording']), 'clip.webm');
    try {
        await assert.rejects(client.request('/api/voice/transcription', { method: 'POST', body: form }),
            (error: unknown) => error instanceof HapiRequestError && error.outcome === 'indeterminate' && error.status === 401);
        assert.equal(submissions, 1); assert.equal(authentication, 1);
    } finally { await client.close(); }
});

test('authentication is shared by concurrent reads and request redirects are not followed', async () => {
    let authCalls = 0;
    const client = new HapiClient({ ...base, fetch: async (input, init) => {
        assert.equal(init?.redirect, 'manual');
        if (String(input).endsWith('/auth')) { authCalls++; await delay(2); return auth(); }
        return json({ sessions: [] });
    } });
    try {
        assert.deepEqual(await Promise.all([client.listSessions(), client.listSessions(), client.listSessions()]), [[], [], []]);
        assert.equal(authCalls, 1);
    } finally { await client.close(); }
});

test('SSE decoder handles fragmented UTF-8, CRLF, multiline data, ID reset, and ignores incomplete EOF', async () => {
    const encoded = new TextEncoder().encode('\ufeff: heartbeat\r\nid: 4\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\nid:\n\nretry: 1500\n\ndata: incomplete');
    const body = new ReadableStream<Uint8Array>({
        start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    });
    const rows = [];
    for await (const row of readServerEvents(body, new AbortController().signal)) rows.push(row);
    assert.deepEqual(rows, [
        { id: '4', data: '{"text":\n"你好"}' }, { id: '', data: '' }, { retry: 1500, data: '' },
    ]);
});

test('SSE reconnect carries source cursor and preserves gap information without replaying mutations', async () => {
    let connections = 0;
    const cursors: Array<string | null> = [];
    let resolveGap: () => void = () => undefined;
    const gap = new Promise<void>(resolve => { resolveGap = resolve; });
    const events: string[] = [];
    const client = new HapiClient({ ...base, fetch: async (input, init) => {
        if (String(input).endsWith('/auth')) return auth();
        connections++;
        assert.equal(init?.method ?? 'GET', 'GET');
        cursors.push(new Headers(init?.headers).get('Last-Event-ID'));
        const text = connections === 1
            ? 'id: source-7\ndata: {"type":"connection-changed","data":{"status":"connected","resume":"ok"}}\n\n'
            : 'id: source-8\ndata: {"type":"connection-changed","data":{"status":"connected","resume":"gap"}}\n\n';
        return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const dispose = client.subscribe(event => {
        events.push(event.type);
        if (event.type === 'connection-changed' && event.data?.resume === 'gap') resolveGap();
    });
    try {
        await Promise.race([gap, delay(1000).then(() => { throw new Error('SSE reconnect timed out'); })]);
        assert.deepEqual(cursors.slice(0, 2), [null, 'source-7']);
        assert(events.every(event => event === 'connection-changed'));
    } finally { dispose(); await client.close(); }
});

test('wire contract changes fail visibly rather than accepting an invented empty history', async () => {
    const client = new HapiClient({ ...base, fetch: async input => String(input).endsWith('/auth') ? auth() : json({ messages: [] }) });
    try {
        await assert.rejects(client.readMessages('thread'), (error: unknown) => error instanceof HapiRequestError && error.code === 'protocol_mismatch');
    } finally { await client.close(); }
});

test('attachments are uploaded as bytes to the owning Runner; a local host path is never sent as the remote path', async () => {
    let upload: unknown;
    const client = new HapiClient({ ...base, fetch: async (input, init) => {
        if (String(input).endsWith('/auth')) return auth();
        assert.match(String(input), /thread\/upload$/);
        upload = JSON.parse(String(init?.body));
        return json({ success: true, path: '/runner/uploads/fixture.bin' });
    } });
    try {
        const result = await client.uploadAttachment('thread', 'example.bin', 'application/octet-stream', Uint8Array.of(1, 2, 3));
        assert.deepEqual(upload, { filename: 'example.bin', mimeType: 'application/octet-stream', content: 'AQID' });
        assert.equal(result.path, '/runner/uploads/fixture.bin');
        assert.equal(result.size, 3);
    } finally { await client.close(); }
});

test('native artifacts use authenticated opaque-ID reads, verified binary limits, and never follow redirects', async () => {
    const requests: string[] = [];
    let mode: 'binary' | 'redirect' | 'oversize' = 'binary';
    const client = new HapiClient({ ...base, fetch: async (input, init) => {
        if (String(input).endsWith('/auth')) return auth();
        requests.push(String(input));
        assert.equal(init?.redirect, 'manual');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-jwt');
        if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://unrelated.invalid/private' } });
        if (mode === 'oversize') return new Response('oversize fixture', { headers: { 'Content-Length': String(33 * 1024 * 1024) } });
        return new Response(Uint8Array.of(0, 1, 255), { headers: { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="%E5%9B%BE.png"' } });
    } });
    try {
        const artifact = await client.readArtifact('thread/a', 'opaque/artifact');
        assert.deepEqual([...artifact.data], [0, 1, 255]);
        assert.equal(artifact.fileName, '图.png');
        assert.equal(artifact.mimeType, 'image/png');
        assert.match(requests[0]!, /thread%2Fa\/artifacts\/opaque%2Fartifact$/);
        mode = 'redirect';
        await assert.rejects(client.readArtifact('thread', 'artifact'), /HTTP 302/);
        mode = 'oversize';
        await assert.rejects(client.readArtifact('thread', 'artifact'), /exceeds/);
        assert.equal(requests.length, 3);
    } finally { await client.close(); }
});

test('truncated successful mutation responses stay indeterminate without replay', async () => {
    let sends = 0;
    const client = new HapiClient({ ...base, fetch: async input => {
        if (String(input).endsWith('/auth')) return auth();
        sends++;
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error('socket closed')); } }));
    } });
    try {
        await assert.rejects(client.sendMessage('thread', { localId: 'stable', text: 'once', deliveryMode: 'queue' }),
            (error: unknown) => error instanceof HapiRequestError && error.outcome === 'indeterminate');
        assert.equal(sends, 1);
    } finally { await client.close(); }
});

test('a malformed business event cannot advance the cursor and forces full native reconciliation', async () => {
    const cursors: Array<string | null> = [];
    let finish: () => void = () => undefined;
    const reconciled = new Promise<void>(resolve => { finish = resolve; });
    const client = new HapiClient({ ...base, fetch: async (input, init) => {
        if (String(input).endsWith('/auth')) return auth();
        cursors.push(new Headers(init?.headers).get('Last-Event-ID'));
        const connected = 'id: good\ndata: {"type":"connection-changed","data":{"status":"connected","resume":"ok"}}\n\n';
        return new Response(cursors.length === 1 ? `${connected}id: malformed\ndata: {"type":"messages-consumed","sessionId":"thread"}\n\n` : connected,
            { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const release = client.subscribe(event => { if (event.type === 'connection-changed' && event.data?.status === 'connected' && event.data.resume === 'gap') finish(); });
    try {
        await Promise.race([reconciled, delay(1000).then(() => { throw new Error('Full reconciliation was not requested'); })]);
        assert.deepEqual(cursors.slice(0, 2), [null, null]);
    } finally { release(); await client.close(); }
});

test('a silent event connection is cancelled and reopened after the heartbeat deadline', async () => {
    let connections = 0;
    let cancelled = 0;
    let finish: () => void = () => undefined;
    const reopened = new Promise<void>(resolve => { finish = resolve; });
    const client = new HapiClient({ ...base, streamIdleTimeoutMs: 20, fetch: async input => {
        if (String(input).endsWith('/auth')) return auth();
        connections++;
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"connection-changed","data":{"status":"connected","resume":"ok"}}\n\n')); },
            cancel() { cancelled++; },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const release = client.subscribe(event => { if (event.type === 'connection-changed' && event.data?.status === 'connected' && connections === 2) finish(); });
    try {
        await Promise.race([reopened, delay(1000).then(() => { throw new Error('Silent stream was not reopened'); })]);
        assert.equal(connections, 2);
        assert.equal(cancelled, 1);
    } finally { release(); await client.close(); }
});

test('a non-header-safe or oversized event cursor is discarded before reconnect and forces a full snapshot', async () => {
    for (const invalidId of ['坏值', 'x'.repeat(1025), 'bad\tvalue']) {
        const cursors: Array<string | null> = [];
        let finish: () => void = () => undefined;
        const reconciled = new Promise<void>(resolve => { finish = resolve; });
        const client = new HapiClient({ ...base, fetch: async (input, init) => {
            if (String(input).endsWith('/auth')) return auth();
            cursors.push(new Headers(init?.headers).get('Last-Event-ID'));
            const connected = 'id: good\ndata: {"type":"connection-changed","data":{"status":"connected","resume":"ok"}}\n\n';
            return new Response(cursors.length === 1 ? `${connected}id: ${invalidId}\n\n` : connected,
                { headers: { 'Content-Type': 'text/event-stream' } });
        } });
        const release = client.subscribe(event => {
            if (event.type === 'connection-changed' && event.data?.status === 'connected' && event.data.resume === 'gap') finish();
        });
        try {
            await Promise.race([reconciled, delay(1000).then(() => { throw new Error('Bad cursor prevented reconnection'); })]);
            assert.deepEqual(cursors.slice(0, 2), [null, null]);
        } finally { release(); await client.close(); }
    }
});
