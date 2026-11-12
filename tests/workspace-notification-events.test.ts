/** Production observer/journal/adapter. Native RPC and the output delivery boundary are controlled. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc, NativeNotification, NativeRequest } from '../src/remote/codex-rpc.ts';
import { SourceGateway } from '../src/remote/gateway.ts';
import { sourceSessionId } from '../src/remote/protocol.ts';
import type { AppNotification } from '../src/notification-types.ts';
import type { AppServiceContext, AppSourceRoute } from '../src/workspace/app-service-types.ts';
import { SourceAttentionJournal, SourceNotificationObserver, attentionFromDshEvent,
    type SourceAttentionBatch, type SourceAttentionEvent, type SourceAttentionFeed } from '../src/workspace/notification-events.ts';

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const scope = { accountId: 'original-account', origin: 'https://workspace.example' };
const identity = { machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread' };
const route: AppSourceRoute = { kind: 'hhpi', hostId: 'host', identity, sessionId: sourceSessionId(identity) };
const event = (id: string): SourceAttentionEvent => ({ id, kind: 'completed', position: { kind: 'native', turnId: id }, createdAt: 1000 });
const context: AppServiceContext = { scope, authorizeSource(source) { assert.deepEqual(source, route); } };

test('initial head, bounded journal gaps and reconnect replay never become old completion alerts', async () => {
    const lifetime = new AbortController(), journal = new SourceAttentionJournal(lifetime.signal, 2);
    const first = new AbortController(), stream = journal.notificationEvents(route.sessionId, undefined, first.signal)[Symbol.asyncIterator]();
    const baseline = (await stream.next()).value!;
    assert.equal(baseline.reset, true); assert.deepEqual(baseline.events, []);
    journal.publish(route.sessionId, event('old-one'));
    journal.publish(route.sessionId, event('old-two'));
    const recovered = journal.notificationEvents(route.sessionId, baseline.cursor, first.signal)[Symbol.asyncIterator]();
    assert.equal((await recovered.next()).value!.replay, true);
    journal.publish(route.sessionId, event('third'));
    const gap = (await stream.next()).value!;
    assert.equal(gap.reset, true); assert.deepEqual(gap.events, []);
    const next = stream.next(); journal.publish(route.sessionId, event('fresh'));
    assert.equal((await next).value!.events[0]?.id, 'fresh');
    journal.reset();
    const reset = (await stream.next()).value!;
    assert.equal(reset.reset, true); assert.notEqual(reset.cursor.epoch, gap.cursor.epoch);
    first.abort(); await stream.return?.(); await recovered.return?.(); lifetime.abort();
});

test('observer publishes exact new targets, isolates accounts and stops an idle feed on grant loss', async () => {
    const lifetime = new AbortController(), grant = new AbortController(), journal = new SourceAttentionJournal(lifetime.signal);
    const notices: AppNotification[] = [], states: string[] = [];
    const observer = new SourceNotificationObserver(async (_context, notice) => { notices.push(notice); });
    const observed = observer.observe({ context, source: route, feed: journal, authorizationSignal: grant.signal, status: state => states.push(state) });
    await flush();
    const request: SourceAttentionEvent = { id: 'request-one', kind: 'request', requestId: 'original-request',
        position: { kind: 'native', turnId: 'original-turn', itemId: 'original-tool' }, createdAt: 1001 };
    journal.publish(route.sessionId, request); await flush();
    assert.deepEqual(notices[0]?.target, { kind: 'request', source: route, requestId: 'original-request', position: request.position });
    assert.equal(notices[0]?.body, ''); assert.equal(notices[0]?.scope.accountId, scope.accountId);
    assert.throws(() => observer.observe({ context, source: route, feed: journal, authorizationSignal: grant.signal }), /already observes/);
    const other = observer.observe({ context: { ...context, scope: { ...scope, accountId: 'another-account' } }, source: route,
        feed: journal, authorizationSignal: grant.signal });
    await flush(); journal.publish(route.sessionId, event('fresh')); await flush();
    assert.deepEqual(new Set(notices.filter(notice => notice.kind === 'completed').map(notice => notice.scope.accountId)), new Set([scope.accountId, 'another-account']));
    grant.abort(); await Promise.all([observed.done, other.done]);
    journal.publish(route.sessionId, event('after-revocation')); await flush();
    assert.equal(notices.some(notice => notice.id.includes('after-revocation')), false);
    assert.equal(states.at(-1), 'closed'); await observer.close(); lifetime.abort();
});

test('recovered events and discontinuous batches show recovery and do not generate notices', { timeout: 5000 }, async t => {
    const published = Promise.withResolvers<void>();
    const grant = new AbortController(), seen: AppNotification[] = [], states: string[] = [];
    let opens = 0;
    const feed: SourceAttentionFeed = { async *notificationEvents(_session, saved, signal) {
        opens++;
        if (opens === 1) {
            yield { cursor: { epoch: 'source', version: 3 }, base: 0, reset: true, replay: true, events: [] };
            yield { cursor: { epoch: 'source', version: 4 }, base: 3, reset: false, replay: true, events: [event('recovered-old')] };
            yield { cursor: { epoch: 'source', version: 6 }, base: 5, reset: false, replay: false, events: [event('unreported-gap')] };
        } else {
            assert.equal(saved, undefined);
            yield { cursor: { epoch: 'source', version: 6 }, base: 0, reset: true, replay: true, events: [] };
            yield { cursor: { epoch: 'source', version: 7 }, base: 6, reset: false, replay: false, events: [event('new-after-recovery')] };
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        }
    } };
    const observer = new SourceNotificationObserver(async (_context, value) => { seen.push(value); published.resolve(); }, { reconnectMs: 0 });
    const observed = observer.observe({ context, source: route, feed, authorizationSignal: grant.signal, status: value => states.push(value) });
    t.after(async () => { grant.abort(); await observed.done; await observer.close(); });
    await published.promise;
    assert.deepEqual(seen.map(value => value.target.position), [{ kind: 'native', turnId: 'new-after-recovery' }]);
    assert.ok(states.includes('recovering'));
    grant.abort(); await observed.done; await observer.close();
});

test('an authorization change during a source response blocks publication', async () => {
    let allowed = true;
    const grant = new AbortController(), output: AppNotification[] = [];
    const feed: SourceAttentionFeed = { async *notificationEvents() {
        yield { cursor: { epoch: 'source', version: 1 }, base: 0, reset: true, replay: true, events: [] };
        allowed = false;
        yield { cursor: { epoch: 'source', version: 2 }, base: 1, reset: false, replay: false, events: [event('not-authorized')] };
    } };
    const observer = new SourceNotificationObserver(async (_context, notice) => { output.push(notice); });
    const observed = observer.observe({ context: { scope, authorizeSource() { if (!allowed) throw new Error('Denied'); } },
        source: route, feed, authorizationSignal: grant.signal });
    await observed.done; assert.deepEqual(output, []); await observer.close();
});

test('actual Codex source attention uses its existing RPC and never opens transcript or attachment history', async t => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-attention-');
    let notify: (value: NativeNotification) => void = () => {}, request: (value: NativeRequest) => void = () => {}, disconnect: () => void = () => {};
    const calls: string[] = [], grant = new AbortController();
    const native = { id: identity.nativeId, name: 'Synthetic', createdAt: 1, updatedAt: 1, cwd: '/synthetic',
        status: { type: 'active' }, source: 'cli', modelProvider: 'fixture', preview: '' };
    const rpc = { online: true, currentGeneration: 1, connect: async () => ({}), dispose: async () => {},
        onNotification(listener: typeof notify) { notify = listener; return () => {}; }, onRequest(listener: typeof request) { request = listener; return () => {}; },
        onDisconnect(listener: typeof disconnect) { disconnect = listener; return () => {}; },
        async request(method: string, params: Record<string, unknown>) {
            calls.push(method); assert.equal(method, 'thread/read'); assert.equal(params.includeTurns, false); return { thread: native };
        },
    } as unknown as CodexRpc;
    const adapter = new DirectCodexAdapter({ id: identity.sourceId, machineId: identity.machineId, engine: 'codex' }, directory,
        { rpc, readMetadata: async () => { throw new Error('Notification observation must not load native history'); } });
    const gateway = new SourceGateway([adapter]);
    t.after(async () => { grant.abort(); await gateway.dispose(); await rm(directory, { recursive: true, force: true }); });
    const stream = gateway.notificationEvents(route.sessionId, undefined, () => true, grant.signal)[Symbol.asyncIterator]();
    assert.equal((await stream.next()).value!.reset, true);
    const completion = stream.next();
    notify({ method: 'turn/completed', params: { threadId: native.id, turn: { id: 'native-turn', status: 'completed', items: [] } } });
    const completed = (await completion).value!;
    assert.deepEqual(completed.events[0]?.position, { kind: 'native', turnId: 'native-turn' });
    const pending = stream.next();
    request({ method: 'item/commandExecution/requestApproval', id: 17, generation: 1,
        params: { threadId: native.id, turnId: 'native-turn', itemId: 'native-tool', command: 'sensitive original command' } });
    const approval = (await pending).value!.events[0]!;
    assert.equal(approval.requestId, JSON.stringify([1, 'number', 17]));
    assert.deepEqual(approval.position, { kind: 'native', turnId: 'native-turn', itemId: 'native-tool' });
    assert.equal(JSON.stringify(approval).includes('sensitive'), false);
    assert.deepEqual(calls, ['thread/read']);
    assert.equal((await readdir(directory)).includes('history'), false);
    const waiting = stream.next(); disconnect(); await assert.rejects(waiting, /connection changed/);
});

test('native DSH attention uses original event coordinates and excludes interruptions and body events', () => {
    const position = { kind: 'hhpi' as const, epoch: 'source-epoch', seq: 42 };
    assert.deepEqual(attentionFromDshEvent({ type: 'turn/end', seq: 42, time: 123, data: { reason: { kind: 'error' } } }, position), {
        id: '["turn/end",42]', kind: 'failed', position, createdAt: 123,
    });
    assert.equal(attentionFromDshEvent({ type: 'turn/end', seq: 42, time: 123, data: { reason: { kind: 'aborted' } } }, position), undefined);
    assert.equal(attentionFromDshEvent({ type: 'assistant/message', seq: 42, time: 123, data: { content: 'private text' } }, position), undefined);
});
