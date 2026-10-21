/** Original HAPI protocol fixtures with a real authenticated HTTP download boundary. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { HapiSessionExtras, exportMarkdown } from '../src/hapi/session-extras.ts';
import type { HapiSession } from '../src/codex/contracts.ts';
import type { WorkbenchSource } from '../src/workbench-types.ts';

const source: WorkbenchSource = { sourceHubId: 'source-hub', sourceSessionId: 'source-session', machineId: 'source-machine' };
const limits = { maxBytesPerFile: 32, maxAttachmentsPerEntry: 2, maxBytesPerEntry: 64, maxBytesPerSession: 128, allowedMimeTypes: ['text/plain'] };
const attachment = { id: 'original-attachment', filename: 'note.txt', mimeType: 'text/plain', size: 8, path: 'hapi-hub:scratchlist/fixture/source-session/original-attachment' };
const payload = { schemaVersion: 2, exportedAt: 1700000000000, session: { id: source.sourceSessionId, metadata: { name: 'A source conversation', machineId: source.machineId } },
    messages: [{ id: 'source-user', createdAt: 1700000000000, content: { role: 'user', content: { text: 'A message', attachments: [attachment] } }, originalExtra: 'preserve me' }],
    scratchlist: [{ entryId: 'note', text: 'A parked note', createdAt: 1, updatedAt: 1, attachments: [attachment] }], originalUnknownField: { keep: true } };

async function fixture(t: TestContext) {
    const session: HapiSession = { id: source.sourceSessionId, namespace: 'fixture', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, thinking: false, thinkingAt: 1,
        metadataVersion: 1, agentStateVersion: 1, metadata: { machineId: source.machineId!, path: '/source', flavor: 'codex' }, agentState: {} };
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const state = { payload: payload as unknown, requestResult: { success: true, attachment } as unknown };
    const extras = new HapiSessionExtras({ hubId: source.sourceHubId!, getSession: async () => session,
        request: async (path, options) => {
            calls.push({ path, method: options?.method ?? 'GET', ...(options?.body === undefined ? {} : { body: options.body }) });
            if (path.endsWith('/scratchlist/limits')) return { limits };
            if (path.endsWith('/scratchlist') && !options?.method) return { entries: payload.scratchlist };
            return state.requestResult;
        },
        readBinary: async path => {
            calls.push({ path, method: 'GET' });
            return { data: path.includes('/attachments/') ? Buffer.from('the note') : Buffer.from(JSON.stringify(state.payload)),
                mimeType: path.includes('/attachments/') ? 'text/html' : 'application/json', fileName: 'original-source-file.html', status: 200, headers: {} };
        },
    });
    let handler: ((request: IncomingMessage, response: ServerResponse) => void | Promise<void>) | undefined;
    extras.mount({ authorize: request => request.headers.cookie === 'fixture=authorized' ? undefined : 401,
        webServer: { register: route => { handler = route.handler; return () => { handler = undefined; }; }, registerUpgrade: () => () => {} } });
    const server = createServer((request, response) => { if (handler) void handler(request, response); else { response.writeHead(404); response.end(); } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
    t.after(async () => { extras.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    return { extras, calls, session, state, read: (url: string, authenticated = true) => fetch(`${origin}${url}`, { headers: authenticated ? { cookie: 'fixture=authorized' } : {} }) };
}

test('notes and export cannot cross source Hub or stale machine ownership', async t => {
    const env = await fixture(t);
    await assert.rejects(env.extras.sourceNotes({ source: { ...source, sourceHubId: 'other-hub' } }), /different Hub/);
    await assert.rejects(env.extras.sourceExport({ source: { ...source, machineId: 'another-machine' }, format: 'json' }), /ownership changed/);
    assert.equal(env.calls.length, 0);
    const notes = await env.extras.sourceNotes({ source });
    assert.deepEqual(notes.entries, payload.scratchlist);
    assert.equal((await env.read(notes.attachmentUrls[attachment.id]!, false)).status, 401);
    const download = await env.read(notes.attachmentUrls[attachment.id]!);
    assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); assert.equal(await download.text(), 'the note');
});

test('original export warnings require an explicit force, and JSON keeps every source field', async t => {
    const env = await fixture(t); const warning = { type: 'warning', count: 50001, limit: 50000, estimatedBytes: 1000000 };
    env.state.payload = warning;
    assert.deepEqual(await env.extras.sourceExport({ source, format: 'json' }), warning);
    assert.equal(env.calls.length, 1); assert.equal(env.calls[0]!.path.endsWith('?force=true'), false);
    env.state.payload = payload;
    const result = await env.extras.sourceExport({ source, format: 'json', force: true }); assert.equal(result.type, 'ready');
    if (result.type !== 'ready') throw new Error('Expected the explicit export');
    assert.equal(env.calls.at(-1)!.path, '/api/sessions/source-session/export?force=true');
    assert.equal((await env.read(result.url, false)).status, 401);
    const download = await env.read(result.url); assert.equal(await download.text(), JSON.stringify(payload));
    env.session.metadata!.machineId = 'replacement-machine';
    assert.equal((await env.read(result.url)).status, 409);
});

test('a mismatched export is never cached and expired download handles cannot be reused', async t => {
    const env = await fixture(t);
    env.state.payload = { ...payload, session: { ...payload.session, id: 'someone-else' } };
    await assert.rejects(env.extras.sourceExport({ source, format: 'json' }), /different source session/);
    env.state.payload = payload;
    const result = await env.extras.sourceExport({ source, format: 'json' }); assert.equal(result.type, 'ready');
    if (result.type !== 'ready') throw new Error('Expected export');
    const url = new URL(result.url, 'http://fixture'); const value = JSON.parse(url.searchParams.get('request')!);
    value.id = '11111111-1111-4111-8111-111111111111'; url.searchParams.set('request', JSON.stringify(value));
    assert.equal((await env.read(`${url.pathname}${url.search}`)).status, 410);
});

test('source upload limits reject malformed or oversized bytes before a write and uncertain upload ownership remains uncertain', async t => {
    const env = await fixture(t); const input = { source, filename: 'note.txt', mimeType: 'text/plain', content: Buffer.from('the note').toString('base64') };
    for (const change of [{ content: 'invalid base64!' }, { content: Buffer.alloc(33).toString('base64') }, { mimeType: 'image/png' }]) {
        await assert.rejects(env.extras.sourceNoteUpload({ ...input, ...change }), /source note limits/);
    }
    assert.equal(env.calls.some(call => call.method === 'POST'), false);
    env.state.requestResult = { success: true };
    await assert.rejects(env.extras.sourceNoteUpload(input), /source identity/);
    assert.equal(env.calls.filter(call => call.method === 'POST').length, 1);
});

test('markdown export retains unknown original events, note attachment identities and message metadata', () => {
    const markdown = exportMarkdown({ ...payload, messages: [{ id: 'unknown-event', createdAt: 1700000000000, content: { role: 'agent', content: { type: 'future-event', data: { text: '``` original bytes' } } } }] });
    assert.match(markdown, /A parked note/); assert.match(markdown, /original-attachment/);
    assert.match(markdown, /future-event/); assert.match(markdown, /unknown-event/); assert.match(markdown, /````json/);
});

test('title suggestions retain original source ownership, health capability and one original generation POST', async t => {
    const env = await fixture(t); env.session.metadata!.name = 'Original source title';
    env.state.requestResult = { capabilities: { titleSuggestion: true, unrelated: 'private configuration is not forwarded' } };
    assert.deepEqual(await env.extras.sourceTitleTools({ source }), { title: 'Original source title', suggestionAvailable: true });
    env.state.requestResult = { title: 'A reviewed title', privateProviderValue: 'never forwarded' };
    assert.deepEqual(await env.extras.sourceTitleSuggestion({ source }), { title: 'A reviewed title' });
    await assert.rejects(env.extras.sourceTitleSuggestion({ source: { ...source, machineId: 'wrong-machine' } }), /ownership changed/);
    await assert.rejects(env.extras.sourceTitleTools({ source: { ...source, sourceHubId: 'wrong-hub' } }), /different Hub/);
    assert.equal(env.calls.filter(row => row.method === 'POST').length, 1);
    assert.equal(env.calls.find(row => row.method === 'POST')?.path, '/api/sessions/source-session/title-suggestion');
});
