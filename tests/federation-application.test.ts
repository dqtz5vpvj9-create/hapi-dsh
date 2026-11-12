/** Real paired TCP/HTTP/WebSocket tunnel, actual Session/journals/application routes. Native Codex and grant decisions are explicit boundaries. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types';
import { FederationHub, type FederationMount } from '../src/hub/federation.ts';
import { addPairing, revokePairing } from '../src/hub/federation-credentials.ts';
import { RunnerClient } from '../src/runner/client.ts';
import { createRunnerConfig } from '../src/runner/config.ts';
import { runtimeIdentity } from '../src/runner/identity.ts';
import { MAX_CHANNELS } from '../src/runner/protocol.ts';
import { DSH_VERSION } from '../src/cli/config.ts';
import { mountSourceAttentionRoutes, SOURCE_ATTENTION_PATH, type SourceAttentionRouteServices } from '../src/workspace/source-attention-route.ts';
import { createSourceAttentionClient } from '../src/workspace/source-attention-client.ts';
import { SourceAttentionAggregateJournal, SourceNotificationObserver, type SourceAttentionEvent } from '../src/workspace/notification-events.ts';
import { NativeDshAttention } from '../src/workspace/native-dsh-attention.ts';
import type { AppNotificationTarget, AppSourceRoute } from '../src/workspace/app-service-types.ts';
import type { SourceSession } from '../src/remote/protocol.ts';

const machineId = 'fixture-attention-runner', sourceId = 'native-codex';
const canonical = `hhpi:${machineId}:${sourceId}:codex:short-lived-thread`;
async function until(condition: () => boolean, message: string) {
    const deadline = Date.now() + 5000;
    while (!condition()) { if (Date.now() > deadline) throw new Error(message); await delay(5); }
}
async function fixture(t: TestContext, maxEvents = 2048) {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-runner-attention-'), credentialsFile = join(directory, 'pairings.json');
    const token = await addPairing(credentialsFile, machineId, 'Synthetic Runner');
    const lifetime = new AbortController(), journal = new SourceAttentionAggregateJournal(lifetime.signal, maxEvents), native = new NativeDshAttention(lifetime.signal);
    const ctx = new Context(); await ctx.plugin(SessionStore);
    const session = (ctx.sessions as unknown as SessionStore).create(SessionId('native-never-opened-in-pane'));
    ctx.on('session/event', (owner, event) => native.accept(owner, event));
    let sourceAllowed = true, sessionAllowed = true, connectionAllowed = true, pendingRequest = true, oversized = false, hold = false;
    const calls: string[] = [], upstreamRequests: Array<{ method: string | undefined; path: string }> = [], activePolls = new Set<ServerResponse>();
    const routes: Array<Parameters<SourceAttentionRouteServices['webServer']['register']>[0]> = [];
    const metadata: SourceSession = { id: canonical, machineId, sourceId, engine: 'codex', nativeId: 'short-lived-thread', title: 'Synthetic', cwd: '/synthetic',
        updatedAt: 1, status: 'waiting', activeTurnId: 'original-turn', capabilities: { send: true, steer: true, cancel: true, approve: true, files: true }, pendingRequests: [] };
    const gateway: Parameters<typeof mountSourceAttentionRoutes>[1]['gateway'] = {
        async *attentionEvents(_source, cursor, _access, signal) { calls.push('attentionEvents'); yield* journal.attentionEvents(cursor, signal); },
        async resolve(id, _access, signal) { calls.push(`resolve:${id}`); signal?.throwIfAborted(); assert.equal(id, canonical);
            return { ...metadata, pendingRequests: pendingRequest ? [{ id: 'exact-request', kind: 'approval', title: 'Synthetic', turnId: 'original-turn', itemId: 'original-item', method: 'synthetic', params: {} } as never] : [] }; },
    };
    const services: SourceAttentionRouteServices = {
        connection: { browserPeer: { principal: { kind: 'owner' } } as never, requestRejection(request) { return connectionAllowed && request.headers.cookie === 'dsh-auth-attention=private' ? undefined : 401; } },
        remoteAccess: { decide(request) { return request.resources.every(resource => resource.kind === 'hhpiSource' ? sourceAllowed : sessionAllowed) ? { kind: 'allow' } : { kind: 'deny', reason: 'no-allow' }; } } as SourceAttentionRouteServices['remoteAccess'],
        webServer: { register(route) { routes.push(route); return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1); }; } },
    };
    const source = { id: sourceId, machineId, engine: 'codex', command: 'synthetic-private-config-must-not-be-returned' };
    const stopRoutes = mountSourceAttentionRoutes(services, { machineId, sources: [source, { id: 'retired-dsh-source', machineId, engine: 'dsh' }], gateway, native, signal: lifetime.signal,
        nativeSessionExists: async id => !!ctx.sessions.get(SessionId(id)),
    });
    const upstream = createServer((request, response) => {
        if (request.url === '/?token=fixture-launch') { response.writeHead(303, { 'set-cookie': 'dsh-auth-attention=private; HttpOnly; Path=/', location: '/' }); response.end(); return; }
        upstreamRequests.push({ method: request.method, path: request.url ?? '/' });
        const pathname = new URL(request.url ?? '/', 'http://runner.local').pathname;
        if (hold || oversized && pathname === `${SOURCE_ATTENTION_PATH}/catalog`) {
            if (hold) { activePolls.add(response); response.once('close', () => activePolls.delete(response)); return; }
            response.writeHead(200); response.end(Buffer.alloc(1024 * 1024 + 1, 97)); return;
        }
        if (pathname === `${SOURCE_ATTENTION_PATH}/poll`) { activePolls.add(response); response.once('close', () => activePolls.delete(response)); }
        const route = routes.find(route => route.path === pathname);
        if (!route) { response.writeHead(404); response.end(); return; }
        void Promise.resolve(route.handler(request, response)).catch(() => { response.destroy(); });
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); const address = upstream.address(); assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const hubRoutes: Array<Parameters<FederationMount['webServer']['register']>[0]> = [], upgrades = new Map<string, (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>>();
    const host = createServer((request, response) => {
        const pathname = new URL(request.url ?? '/', 'http://host.local').pathname;
        const route = hubRoutes.find(route => route.kind === 'exact' ? route.path === pathname : pathname === route.path || pathname.startsWith(`${route.path}/`));
        if (!route) { response.writeHead(404); response.end(); return; }
        void Promise.resolve(route.handler(request, response)).catch(() => response.destroy());
    });
    host.on('upgrade', (request, socket, head) => { const handler = upgrades.get(new URL(request.url ?? '/', 'http://host.local').pathname); if (handler) void Promise.resolve(handler(request, socket, head)).catch(() => socket.destroy()); else socket.destroy(); });
    host.listen(0, '127.0.0.1'); await once(host, 'listening'); const hostAddress = host.address(); assert.ok(hostAddress && typeof hostAddress === 'object');
    const identity = runtimeIdentity({ dshVersion: DSH_VERSION }), hub = new FederationHub({ credentialsFile, identity });
    await hub.mount({ authorize: () => 401, webServer: {
        register(route) { hubRoutes.push(route); return () => { const index = hubRoutes.indexOf(route); if (index >= 0) hubRoutes.splice(index, 1); }; },
        registerUpgrade(route) { upgrades.set(route.path, route.handler); return () => upgrades.delete(route.path); },
    } });
    const runners: RunnerClient[] = [], config = createRunnerConfig(`http://127.0.0.1:${hostAddress.port}`, { id: machineId, token, dshHome: directory });
    const connectRunner = async () => {
        let connected = false;
        const runner = new RunnerClient({ config, origin, identity, authenticatedUrl: value => new URL('/?token=fixture-launch', value).href,
            status: state => { connected = state === 'connected'; } });
        runners.push(runner); runner.start();
        await until(() => connected && hub.listMachines().some(machine => machine.id === machineId && machine.online), 'The paired Runner did not connect');
        return runner;
    };
    const runner = await connectRunner();
    const client = createSourceAttentionClient(hub, { pollWaitMs: 30 });
    t.after(async () => { lifetime.abort(); stopRoutes(); await Promise.all(runners.map(runner => runner.stop())); await hub.close(); upstream.closeAllConnections(); host.closeAllConnections();
        await Promise.all([new Promise<void>(resolve => upstream.close(() => resolve())), new Promise<void>(resolve => host.close(() => resolve()))]);
        await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
    const publish = (id = 'short-completed', sessionId = canonical) => journal.publish(sessionId, { id, kind: 'completed', position: { kind: 'native', turnId: 'original-turn', itemId: 'original-item' }, createdAt: 1 });
    return { hub, runner, connectRunner, client, native, session, journal, lifetime, directory, credentialsFile, origin, calls, upstreamRequests, activePolls, publish,
        denySource() { sourceAllowed = false; }, denySession() { sessionAllowed = false; }, denyConnection() { connectionAllowed = false; }, settle() { pendingRequest = false; },
        oversized(value: boolean) { oversized = value; }, hold(value: boolean) { hold = value; } };
}
const sourceRoute = (): AppSourceRoute => ({ kind: 'hhpi', hostId: machineId, sessionId: canonical, identity: { sourceId, machineId, engine: 'codex', nativeId: 'short-lived-thread' } });
const requestTarget = (): Extract<AppNotificationTarget, { kind: 'request' }> => ({ kind: 'request', source: sourceRoute(), requestId: 'exact-request', position: { kind: 'native', turnId: 'original-turn', itemId: 'original-item' } });

test('exact offline alias location checks the original Runner session without opening an execution owner', async t => {
    const f = await fixture(t), native: AppSourceRoute = { kind: 'federated-dsh', hostId: machineId, sessionId: f.session.id };
    assert.deepEqual(await f.client.locate(machineId, native, f.lifetime.signal), native);
    assert.equal(await f.client.locate(machineId, { ...native, sessionId: 'not-an-original-session' }, f.lifetime.signal), null);
    assert.deepEqual(await f.client.locate(machineId, sourceRoute(), f.lifetime.signal), sourceRoute());
    const reads = f.upstreamRequests.length;
    await assert.rejects(f.client.locate('another-host', native, f.lifetime.signal), /another original Host/);
    assert.equal(f.upstreamRequests.length, reads);
    f.denySession();
    await assert.rejects(f.client.locate(machineId, native, f.lifetime.signal), /did not locate/);
    assert.ok(f.upstreamRequests.every(request => request.method === 'GET'));
    assert.ok(f.upstreamRequests.every(request => request.path.startsWith(`${SOURCE_ATTENTION_PATH}/locate?`)));
});

test('a paired Runner delivers short native-source tasks before any Pane or session catalog exists', async t => {
    const f = await fixture(t), sources = await f.client.listSources(machineId, f.lifetime.signal);
    assert.deepEqual(sources, [{ id: 'native-dsh', machineId, engine: 'dsh', routeKind: 'federated-dsh' }, { id: sourceId, machineId, engine: 'codex', routeKind: 'hhpi' }]);
    const descriptor = sources[1]!, signal = new AbortController(), iterator = f.client.feed(machineId, descriptor).attentionEvents(undefined, signal.signal)[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.reset, true);
    f.publish(); const batch = (await iterator.next()).value!;
    assert.equal(batch.reset, false); assert.equal(batch.replay, false); assert.equal(batch.events[0]?.sessionId, canonical); assert.equal(batch.events[0]?.event.id, 'short-completed');
    assert.deepEqual(f.calls, ['attentionEvents', 'attentionEvents'], 'no directory, transcript or session resolution discovers this completed short task');
    signal.abort(); await iterator.return?.();
    assert.ok(f.upstreamRequests.every(request => request.method === 'GET'));
    assert.ok(!JSON.stringify(sources).includes('synthetic-private-config'));
})

test('Host background notification observation uses the paired feed with no mounted Pane', async t => {
    const f = await fixture(t), source = (await f.client.listSources(machineId, f.lifetime.signal))[1]!, published: AppNotificationTarget[] = [];
    const observer = new SourceNotificationObserver(async (_context, notification) => { published.push(notification.target); });
    const observation = observer.observeSource({ hostId: machineId, source, feed: f.client.feed(machineId, source), authorizationSignal: f.lifetime.signal,
        context: { scope: { accountId: 'synthetic-account', origin: 'https://application.invalid' }, authorizeSource: value => f.client.authorize(machineId, value, f.lifetime.signal) } });
    t.after(() => observer.close()); await until(() => f.activePolls.size > 0, 'The background source never admitted an idle poll');
    f.publish(); await until(() => published.length === 1, 'The task completion never reached the Host notification owner');
    assert.deepEqual(published[0], { kind: 'reading', source: sourceRoute(), position: { kind: 'native', turnId: 'original-turn', itemId: 'original-item' } });
    await observation.stop();
})

test('the same paired application feed carries committed native DSH positions and exact approval audit IDs', async t => {
    const f = await fixture(t), source = (await f.client.listSources(machineId, f.lifetime.signal))[0]!, stop = new AbortController();
    const iterator = f.client.feed(machineId, source).attentionEvents(undefined, stop.signal)[Symbol.asyncIterator](); await iterator.next();
    f.session.append('turn/start', { turn: 1 }); f.session.append('step/start', { turn: 1, step: 1 });
    f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic original task' }] }), { surfaceOp: 'append' });
    const call = f.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('original-call'), name: 'synthetic', arguments: '{}' });
    f.session.append('approval/asked', { id: ApprovalRequestId('original-audit'), toolName: 'synthetic', callId: ToolCallId('original-call') });
    const request = (await iterator.next()).value!.events[0]!.event;
    assert.equal(request.requestId, 'original-audit'); assert.deepEqual(request.position, { kind: 'dsh', seq: call.seq });
    const target = { kind: 'request' as const, source: { kind: 'federated-dsh' as const, hostId: machineId, sessionId: f.session.id }, position: request.position, requestId: request.requestId! };
    assert.equal(await f.client.requestState(machineId, target, stop.signal), 'pending');
    f.session.append('approval/decided', { id: ApprovalRequestId('original-audit'), outcome: 'allowed-once' });
    assert.equal(await f.client.requestState(machineId, target, stop.signal), 'settled');
    const answer = f.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'Synthetic completion' }] }) }, { surfaceOp: 'append' });
    f.session.append('step/end', { turn: 1, step: 1 }); f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const complete = (await iterator.next()).value!.events[0]!.event;
    assert.equal(complete.kind, 'completed'); assert.deepEqual(complete.position, { kind: 'dsh', seq: answer.seq });
    stop.abort(); await iterator.return?.();
})

test('idle 204 polls retain the original cursor and old/overflow cursors reset without replaying completions', async t => {
    const f = await fixture(t, 2), source = (await f.client.listSources(machineId, f.lifetime.signal))[1]!, stop = new AbortController();
    const iterator = f.client.feed(machineId, source).attentionEvents(undefined, stop.signal)[Symbol.asyncIterator](), first = (await iterator.next()).value!;
    const waiting = iterator.next(); await until(() => f.upstreamRequests.filter(request => request.path.includes('/poll?')).length >= 3, 'The bounded idle poll did not resume');
    const queries = f.upstreamRequests.filter(request => request.path.includes('/poll?')).slice(1).map(request => new URL(request.path, f.origin).searchParams.get('cursor'));
    assert.ok(queries.every(cursor => cursor === JSON.stringify(first.cursor)));
    f.publish(); assert.equal((await waiting).value?.events[0]?.event.id, 'short-completed'); stop.abort(); await iterator.return?.();
    f.publish('second'); f.publish('third'); f.publish('fourth');
    const resumed = f.client.feed(machineId, source).attentionEvents(first.cursor, f.lifetime.signal)[Symbol.asyncIterator](), reset = (await resumed.next()).value!;
    assert.equal(reset.reset, true); assert.equal(reset.replay, true); assert.deepEqual(reset.events, []); assert.equal(reset.cursor.version, 4); await resumed.return?.();
})

test('source/session revocation and foreign Host targets are checked before releasing application data', async t => {
    const f = await fixture(t); await f.client.authorize(machineId, sourceRoute(), f.lifetime.signal);
    assert.equal(await f.client.requestState(machineId, requestTarget(), f.lifetime.signal), 'pending'); f.settle();
    assert.equal(await f.client.requestState(machineId, requestTarget(), f.lifetime.signal), 'settled');
    const count = f.upstreamRequests.length;
    await assert.rejects(f.client.authorize('another-host', sourceRoute(), f.lifetime.signal), /another original Host/); assert.equal(f.upstreamRequests.length, count);
    f.denySession(); await assert.rejects(f.client.authorize(machineId, sourceRoute(), f.lifetime.signal), /403/);
    const source = (await f.client.listSources(machineId, f.lifetime.signal))[1]!, stop = new AbortController(), iterator = f.client.feed(machineId, source).attentionEvents(undefined, stop.signal)[Symbol.asyncIterator]();
    await iterator.next(); f.publish(); const batch = (await iterator.next()).value!; assert.deepEqual(batch.events, []);
    f.denySource(); await assert.rejects(iterator.next(), /403/); stop.abort(); await iterator.return?.();
})

test('cancellation, disconnect and pairing removal release real pending Runner requests', async t => {
    const f = await fixture(t), source = (await f.client.listSources(machineId, f.lifetime.signal))[1]!, first = new AbortController();
    const one = f.client.feed(machineId, source).attentionEvents(undefined, first.signal)[Symbol.asyncIterator](); await one.next();
    const pending = assert.rejects(one.next()); await until(() => f.activePolls.size > 0, 'No actual source HTTP poll was opened'); first.abort(); await pending;
    await until(() => f.activePolls.size === 0, 'Cancellation left the original upstream HTTP poll open');
    const two = f.client.feed(machineId, source).attentionEvents(undefined, f.lifetime.signal)[Symbol.asyncIterator](); await two.next();
    const revoked = assert.rejects(two.next(), /disconnected|unavailable|authorized/); await until(() => f.activePolls.size > 0, 'No pending poll existed at revocation');
    await revokePairing(f.credentialsFile, machineId); await f.hub.refreshCredentials(); await revoked;
    await until(() => !f.hub.listMachines().some(machine => machine.id === machineId), 'The revoked machine remained in the paired inventory');
    await assert.rejects(f.client.listSources(machineId, f.lifetime.signal), /unavailable|authorized/);
})

test('a disconnected paired Runner resumes the original cursor and delivers a short task completed while transport was absent', async t => {
    const f = await fixture(t), source = (await f.client.listSources(machineId, f.lifetime.signal))[1]!;
    const original = f.client.feed(machineId, source).attentionEvents(undefined, f.lifetime.signal)[Symbol.asyncIterator](); await original.next();
    f.publish('before-disconnect'); const admitted = (await original.next()).value!;
    const disconnected = assert.rejects(original.next(), /disconnected|unavailable/);
    await until(() => f.activePolls.size > 0, 'The source did not have a pending HTTP poll');
    await f.runner.stop(); await disconnected;
    await until(() => !f.hub.listMachines().some(machine => machine.online), 'The Runner transport did not disconnect');
    f.publish('completed-while-disconnected'); await f.connectRunner();
    const resumed = f.client.feed(machineId, source).attentionEvents(admitted.cursor, f.lifetime.signal)[Symbol.asyncIterator](), batch = (await resumed.next()).value!;
    assert.equal(batch.reset, false); assert.equal(batch.replay, false); assert.equal(batch.base, admitted.cursor.version);
    assert.equal(batch.cursor.epoch, admitted.cursor.epoch); assert.equal(batch.events[0]?.event.id, 'completed-while-disconnected');
    await resumed.return?.();
})

test('application body/path/channel limits fail locally and release capacity without replaying a request', async t => {
    const f = await fixture(t); f.oversized(true);
    await assert.rejects(f.client.listSources(machineId, f.lifetime.signal), /exceeded 1 MiB/);
    f.oversized(false); assert.equal((await f.client.listSources(machineId, f.lifetime.signal)).length, 2);
    await assert.rejects(f.hub.readApplication(machineId, '/api/mutate', f.lifetime.signal), /read-only/);
    f.hold(true); const controllers = Array.from({ length: MAX_CHANNELS }, () => new AbortController());
    const pending = controllers.map(controller => f.hub.readApplication(machineId, `${SOURCE_ATTENTION_PATH}/catalog`, controller.signal));
    const settled = Promise.allSettled(pending); // Observe cancellation before aborting the real pending requests.
    await assert.rejects(f.hub.readApplication(machineId, `${SOURCE_ATTENTION_PATH}/catalog`, f.lifetime.signal), /channel limit/);
    for (const controller of controllers) controller.abort();
    assert.ok((await settled).every(result => result.status === 'rejected'));
    f.hold(false); assert.equal((await f.client.listSources(machineId, f.lifetime.signal)).length, 2);
    assert.ok(f.upstreamRequests.every(request => request.method === 'GET'));
})

test('malformed source event identities and expired Runner authentication never cross the paired read boundary', async t => {
    const f = await fixture(t), source = (await f.client.listSources(machineId, f.lifetime.signal))[1]!, iterator = f.client.feed(machineId, source).attentionEvents(undefined, f.lifetime.signal)[Symbol.asyncIterator]();
    await iterator.next(); f.publish('wrong-source', 'hhpi:another-machine:another-source:codex:thread'); await assert.rejects(iterator.next(), /502/);
    f.denyConnection(); await assert.rejects(f.client.listSources(machineId, f.lifetime.signal), /401/);
})
