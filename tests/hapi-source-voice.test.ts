/** Real HTTP/WS carriers with explicit provider fixtures; no model or microphone is exercised. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { SourceVoiceService, type SourceVoiceClient } from '../src/hapi/source-voice.ts';
import { HapiRequestError, type HapiSession } from '../src/codex/contracts.ts';
import type { FederationMount } from '../src/hub/federation.ts';
import { VOICE_TRANSCRIPTION_PATH, VOICE_PROXY_PATHS } from '../src/voice-types.ts';

const source = { sourceHubId: 'voice-hub', sourceSessionId: 'source-one', machineId: 'runner-one' };
const session: HapiSession = { id: source.sourceSessionId, active: true, thinking: false, activeAt: 1, updatedAt: 1, metadataVersion: 1, agentStateVersion: 1,
    namespace: 'fixture', seq: 1, createdAt: 1, thinkingAt: 0, metadata: { machineId: source.machineId, path: '/source/project', flavor: 'codex', name: 'Original voice source' },
    agentState: { requests: { approval: { tool: 'exec_command', arguments: { command: 'fixture' } }, question: { tool: 'request_user_input', arguments: {} } } } };
function client(): SourceVoiceClient & { calls: Array<{ path: string; options: Parameters<SourceVoiceClient['request']>[1] }> } {
    const calls: Array<{ path: string; options: Parameters<SourceVoiceClient['request']>[1] }> = [];
    return { hubId: source.sourceHubId, calls, getSession: async () => structuredClone(session),
        readMessages: async () => ({ messages: [{ id: 'source-message', seq: 1, localId: null, createdAt: 1, content: { role: 'assistant', content: [{ type: 'text', text: 'Original machine answer' }] } }],
            page: { direction: 'latest', limit: 50, epoch: 1, reset: false, nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: 1, nextAfterAt: 1, snapshotHeadAt: 1, snapshotHeadSeq: 1, hasMore: false } }),
        socketAuthentication: async () => ({ url: 'http://127.0.0.1', path: '/source-prefix/socket.io/', token: 'fixture-jwt-only' }),
        request: async (path, options) => {
            calls.push({ path, options });
            if (path === '/api/voice/backend') return { backend: 'gemini-live', backends: ['gemini-live'] };
            if (path === '/api/voice/transcription/providers') return { providers: [{ id: 'openai', label: 'OpenAI', modes: ['standard', 'realtime'] }] };
            if (path.endsWith('gemini-token')) return { allowed: true, apiKey: 'DO-NOT-EXPOSE', wsUrl: 'wss://untrusted.invalid' };
            if (path.endsWith('/transcription')) return { text: 'fixture audio recognized' };
            throw new HapiRequestError('Unconfirmed source write', 'indeterminate', 401);
        } };
}
async function mount(service: SourceVoiceService) {
    const routes = new Map<string, Parameters<FederationMount['webServer']['register']>[0]['handler']>();
    const upgrades = new Map<string, Parameters<FederationMount['webServer']['registerUpgrade']>[0]['handler']>();
    const http = createServer((request, response) => { const route = routes.get(new URL(request.url!, 'http://fixture').pathname); if (route) void route(request, response); else { response.writeHead(404); response.end(); } });
    http.on('upgrade', (request, socket, head) => { const route = upgrades.get(new URL(request.url!, 'http://fixture').pathname); if (route) void route(request, socket, head); else socket.destroy(); });
    service.mount({ webServer: {
        register: route => { routes.set(route.path, route.handler); return () => { routes.delete(route.path); }; },
        registerUpgrade: route => { upgrades.set(route.path, route.handler); return () => { upgrades.delete(route.path); }; },
    }, authorize: request => request.headers.cookie === 'fixture=authorized' ? undefined : 401 });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve)); const address = http.address(); assert.ok(address && typeof address !== 'string');
    return { url: `http://127.0.0.1:${address.port}`, close: async () => { service.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } };
}

test('voice context is bound to immutable source identity, contains original messages and distinguishes structured questions', async () => {
    const transport = client(), service = new SourceVoiceService(transport);
    try {
        await assert.rejects(service.sourceVoiceContext({ source: { ...source, sourceHubId: 'other' } }), /different source Hub/);
        await assert.rejects(service.sourceVoiceContext({ source: { ...source, machineId: 'other' } }), /different source session or machine/);
        const context = await service.sourceVoiceContext({ source }); assert.match(context.plan.bootstrap, /Original machine answer/);
        assert.deepEqual(context.source, source); assert.equal(context.approvals[0]?.answerable, true); assert.equal(context.approvals[1]?.answerable, false);
        assert.equal(JSON.stringify(context).includes('namespace'), false);
        const abort = new AbortController(); abort.abort(); await assert.rejects(service.sourceVoiceContext({ source }, abort.signal));
    } finally { service.close(); }
});

test('voice proxy credentials never expose original Hub JWT, upstream URLs or provider keys and unknown PUT is sent once', async () => {
    const transport = client(), service = new SourceVoiceService(transport);
    try {
        assert.deepEqual(await service.sourceVoiceToken({ backend: 'gemini-live' }), { allowed: true, backend: 'gemini-live', socketPath: VOICE_PROXY_PATHS['gemini-live'] });
        await assert.rejects(service.sourceVoiceUpdateCredentials({ update: { openai: 'fixture-not-a-key' } }), /Unconfirmed source write/);
        assert.equal(transport.calls.filter(call => call.options?.method === 'PUT').length, 1);
        assert.equal((await service.sourceVoiceCapabilities({})).providers[0]?.id, 'openai');
    } finally { service.close(); }
});

test('authenticated audio upload forwards actual multipart bytes once; unauthorized and duplicate fields never reach the source', async () => {
    const transport = client(), fixture = await mount(new SourceVoiceService(transport));
    try {
        const form = (): FormData => { const value = new FormData(); value.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'recording.webm', { type: 'audio/webm' })); value.set('provider', 'openai'); value.set('mode', 'standard'); return value; };
        assert.equal((await fetch(fixture.url + VOICE_TRANSCRIPTION_PATH, { method: 'POST', body: form() })).status, 401); assert.equal(transport.calls.length, 0);
        const result = await fetch(fixture.url + VOICE_TRANSCRIPTION_PATH, { method: 'POST', headers: { cookie: 'fixture=authorized' }, body: form() });
        assert.equal(result.status, 200); assert.deepEqual(await result.json(), { text: 'fixture audio recognized' });
        const posted = transport.calls[0]!.options!.body; assert.ok(posted instanceof FormData); const file = posted.get('file'); assert.ok(file instanceof File);
        assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3, 4]); assert.equal(posted.get('mode'), 'standard');
        const invalid = form(); invalid.append('provider', 'groq');
        assert.equal((await fetch(fixture.url + VOICE_TRANSCRIPTION_PATH, { method: 'POST', headers: { cookie: 'fixture=authorized' }, body: invalid })).status, 400);
        assert.equal(transport.calls.length, 1);
    } finally { await fixture.close(); }
});

test('voice WebSocket uses only fixed original prefixed route with server-side JWT and ends without reconnect or payload replay', async () => {
    const sourceServer = createServer(), upstream = new WebSocketServer({ server: sourceServer });
    await new Promise<void>(resolve => sourceServer.listen(0, '127.0.0.1', resolve)); const address = sourceServer.address(); assert.ok(address && typeof address !== 'string');
    const transport = client(); transport.socketAuthentication = async () => ({ url: `http://127.0.0.1:${address.port}`, path: '/source-prefix/socket.io/', token: 'fixture-jwt-only' });
    const fixture = await mount(new SourceVoiceService(transport)); const paths: URL[] = [], payloads: string[] = []; let sourcePeer: WebSocket | undefined;
    upstream.on('connection', (peer, request) => { sourcePeer = peer; paths.push(new URL(request.url!, 'http://fixture')); peer.send(JSON.stringify({ setupComplete: {} })); peer.on('message', data => { payloads.push(data.toString()); peer.send(data.toString()); }); });
    const browser = new WebSocket(fixture.url.replace('http:', 'ws:') + VOICE_PROXY_PATHS['gemini-live'], { headers: { cookie: 'fixture=authorized' } });
    try {
        await once(browser, 'open'); const ready = once(browser, 'message'); browser.send(JSON.stringify({ type: 'hapi.voice.connect', language: 'zh', voice: 'Aoede', affectiveDialog: true }));
        const [message] = await ready; assert.match(String(message), /setupComplete/); assert.equal(paths[0]?.pathname, '/source-prefix/api/voice/gemini-ws');
        assert.equal(paths[0]?.searchParams.get('token'), 'fixture-jwt-only'); assert.equal(paths[0]?.searchParams.get('language'), 'zh');
        const echo = once(browser, 'message'); browser.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ data: 'AAAA', mimeType: 'audio/pcm;rate=16000' }] } })); await echo;
        assert.equal(payloads.length, 1); const ended = once(browser, 'close'); sourcePeer!.close(1000); await ended;
        assert.equal(paths.length, 1); assert.equal(payloads.length, 1);
    } finally { browser.terminate(); await fixture.close(); for (const peer of upstream.clients) peer.terminate(); await new Promise<void>(resolve => upstream.close(() => resolve())); await new Promise<void>(resolve => sourceServer.close(() => resolve())); }
});
