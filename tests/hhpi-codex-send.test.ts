import { nativeMetadataFixture, sliceNativeEntries } from './fixtures/hhpi-native-metadata.ts';
/** Production adapter, history and durable ledger; only the native RPC boundary is synthetic.
 * Cross-process writer exclusion is covered separately with the pinned native binary. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import { CodexRpcError, type CodexRpc, type NativeNotification, type NativeRequest } from '../src/remote/codex-rpc.ts';
import { OperationLedger } from '../src/remote/operation-ledger.ts';
import { SourceError } from '../src/remote/errors.ts';
import type { NativeThread } from '../src/remote/codex-native.ts';
import { sourceSessionId, type DirectCodexConfig, type SourceOperation } from '../src/remote/protocol.ts';

interface FixtureOptions {
    ownership?: 'shared' | 'exclusive';
    loaded?: boolean;
    busy?: boolean;
    metadataUnavailable?: boolean;
    queuedClientId?: 'exact' | 'foreign';
    writerLock?: boolean;
    resume?: 'reject' | 'wrong-id' | 'ack-lost';
    turnAckLost?: boolean;
    observedClientId?: 'exact' | 'foreign';
    preflightFailures?: number;
    trailingMessages?: number;
    approvalDelivery?: 'not-dispatched' | 'unknown';
    resumeGate?: Promise<void>;
    loadedCheck?: () => void;
    resumeSettings?: Record<string, unknown>;
}
interface Call { method: string; params: Record<string, unknown>; write: boolean }
const identity = { sourceId: 'native-source', machineId: 'native-machine', engine: 'codex', nativeId: 'original-thread' } as const;
const sessionId = sourceSessionId(identity);
const operation = (operationId: string, kind: SourceOperation['kind'] = 'send'): SourceOperation => ({
    sessionId, operationId, kind, text: 'hello', ...(kind === 'steer' || kind === 'cancel' ? { turnId: 'original-turn' } : {}),
});

async function fixture(t: TestContext, options: FixtureOptions = {}) {
    const privateHome = await mkdtemp(join('/mnt/cache/data-cache', 'hhpi-codex-send-'));
    const directory = join(privateHome, 'source');
    const native: NativeThread = { id: identity.nativeId, cwd: privateHome, createdAt: 1, updatedAt: 2,
        name: 'Persisted original thread', status: { type: options.busy ? 'active' : 'idle' } };
    const calls: Call[] = [];
    let loaded = options.loaded ?? false;
    let clock = Date.now();
    let preflightFailures = options.preflightFailures ?? 0;
    const received: string[] = [];
    const queue: Array<{ id: string; clientUserMessageId: string; input: unknown }> = [];
    let notify: (frame: NativeNotification) => void = () => {};
    let requestApproval: (request: NativeRequest) => void = () => {};
    let disconnected: () => void = () => {};
    let generation = 1;
    const resumeStarted = Promise.withResolvers<void>();
    let responseAttempts = 0;
    const responses: Array<{ id: NativeRequest['id']; result: unknown }> = [];
    const nativeItems = () => [{ turnId: 'historical-turn', item: {
                id: 'historical-answer', type: 'agentMessage', text: 'Original persisted history',
            } }, ...received.map((clientId, index) => ({ turnId: 'historical-turn', item: { id: `native-user-${index}`, type: 'userMessage', clientId,
                content: [{ type: 'text', text: 'hello' }] } })), ...Array.from({ length: options.trailingMessages ?? 0 }, (_, index) => ({
                    turnId: 'historical-turn', item: { id: `later-answer-${index}`, type: 'agentMessage', text: `Later persisted answer ${index}` },
                }))];
    const metadata = nativeMetadataFixture(() => [{ turn: { id: 'historical-turn', status: 'completed', startedAt: 1, completedAt: 2 }, items: nativeItems().map(entry => entry.item) }]);
    const readMetadata = options.metadataUnavailable ? async () => { throw new SourceError('HISTORY_UNAVAILABLE', 'Synthetic unavailable consumed-message index'); } : metadata;
    const rpc = {
        online: true, get currentGeneration() { return generation; },
        connect: async () => ({ userAgent: 'hhpi/0.165.0 (Linux 6.8; x86_64) unknown (hhpi; 1)', codexHome: privateHome, platformFamily: 'unix', platformOs: 'linux' }),
        dispose: async () => {},
        onNotification: (listener: typeof notify) => { notify = listener; return () => {}; },
        onRequest: (listener: typeof requestApproval) => { requestApproval = listener; return () => {}; }, onDisconnect: (listener: () => void) => { disconnected = listener; return () => {}; },
        respond: async (request: NativeRequest, result: unknown) => {
            responseAttempts++;
            if (options.approvalDelivery === 'not-dispatched' && responseAttempts === 1) throw new SourceError('CAPACITY_EXCEEDED', 'Synthetic closed write admission', 'not-dispatched');
            responses.push({ id: request.id, result });
            if (options.approvalDelivery === 'unknown') throw new SourceError('OUTCOME_UNKNOWN', 'Synthetic lost native response acknowledgement');
            notify({ method: 'serverRequest/resolved', params: { threadId: native.id, requestId: request.id } });
        },
        request: async (method: string, params: Record<string, unknown>, requestOptions?: { write?: boolean }) => {
            calls.push({ method, params: structuredClone(params), write: requestOptions?.write === true });
            if (method === 'thread/loaded/list') {
                options.loadedCheck?.();
                if (preflightFailures-- > 0) throw new SourceError('TARGET_UNAVAILABLE', 'Synthetic failed preflight read');
                return { data: loaded ? [native.id] : [], nextCursor: null };
            }
            if (method === 'thread/list') return { data: [native], nextCursor: null };
            if (method === 'thread/read') return { thread: native };
            if (method === 'thread/settings/update') return { threadId: native.id };
            if (method === 'thread/turns/list') return { data: [{ id: 'historical-turn', status: 'completed', startedAt: 1, completedAt: 2 }], nextCursor: null };
            if (method === 'thread/items/list') return sliceNativeEntries(nativeItems(), params);
            if (method === 'thread/resume') {
                resumeStarted.resolve();
                await options.resumeGate;
                if (options.resume === 'reject') throw new CodexRpcError(-32600,
                    `thread ${native.id} already has an active writer`);
                loaded = true;
                if (options.resume === 'ack-lost') throw new SourceError('OUTCOME_UNKNOWN', 'The native resume acknowledgement was lost.');
                return { ...options.resumeSettings, thread: options.resume === 'wrong-id' ? { ...native, id: 'different-native-thread' } : native };
            }
            if (method === 'thread/queue/list') return { data: queue, nextCursor: null };
            if (method === 'thread/queue/add') {
                const queuedSubmission = { id: `queued-${queue.length}`, clientUserMessageId: options.queuedClientId === 'foreign' ? 'another-operation' : String(params.clientUserMessageId), input: params.input };
                if (options.busy) queue.push(queuedSubmission);
                if (options.observedClientId) received.push(options.observedClientId === 'exact' ? String(params.clientUserMessageId) : 'another-operation');
                if (options.turnAckLost) throw new SourceError('OUTCOME_UNKNOWN', 'The native queue acknowledgement was lost.');
                return { queuedSubmission };
            }
            if (method === 'turn/steer') {
                if (options.observedClientId) received.push(options.observedClientId === 'exact' ? String(params.clientUserMessageId) : 'another-operation');
                if (options.turnAckLost) throw new SourceError('OUTCOME_UNKNOWN', 'The native steering acknowledgement was lost.');
                return { turnId: params.expectedTurnId };
            }
            if (method === 'turn/interrupt') return {};
            if (method === 'turn/start') {
                if (options.observedClientId) received.push(options.observedClientId === 'exact' ? String(params.clientUserMessageId) : 'another-operation');
                if (options.turnAckLost) throw new SourceError('OUTCOME_UNKNOWN', 'The native turn acknowledgement was lost.');
                return { turn: { id: 'new-native-turn' } };
            }
            throw new Error(`Unexpected native method: ${method}`);
        },
    } as unknown as CodexRpc;
    const config: DirectCodexConfig = { id: identity.sourceId, machineId: identity.machineId, engine: 'codex',
        ownership: options.ownership ?? 'shared', ...(options.writerLock === false ? {} : { writerLock: 'native' }) };
    let adapter = new DirectCodexAdapter(config, directory, { rpc, readMetadata, pollMs: 60_000, now: () => clock });
    t.after(async () => { await adapter.dispose(); await rm(privateHome, { recursive: true, force: true }); });
    return {
        get adapter() { return adapter; }, directory, calls, responses, requestApproval: (request: NativeRequest) => requestApproval(request),
        writes: () => calls.filter(call => call.write),
        advanceRecovery() { clock += 60_000; },
        resumeStarted: resumeStarted.promise,
        reconnect() { ++generation; disconnected(); },
        async restart() { await adapter.dispose(); adapter = new DirectCodexAdapter(config, directory, { rpc, readMetadata, pollMs: 60_000, now: () => clock }); },
    };
}

test('shared cold history remains a pure read, then explicit send resumes the original native ID exactly once', async t => {
    const f = await fixture(t);
    const [session] = await f.adapter.list(); assert.ok(session);
    const page = await f.adapter.read({ sessionId });
    assert.ok(page.entries.some(entry => entry.event.type === 'assistant/message'));
    const abort = new AbortController();
    const changes = f.adapter.changes({ sessionId, epoch: page.epoch, version: page.version }, abort.signal)[Symbol.asyncIterator]();
    try { assert.equal((await changes.next()).value?.version, page.version); }
    finally { abort.abort(); await changes.return?.(); }
    assert.deepEqual(f.writes(), [], 'catalog, paging and follow must not acquire native execution');

    const send = operation('cold-send');
    const receipt = await f.adapter.operate(send);
    assert.equal(receipt.status, 'accepted');
    assert.equal(session.capabilities.send, true, 'persisted native history must allow an explicit send attempt');
    assert.equal(receipt.turnId, undefined, 'queue admission does not claim that a new turn started');
    assert.deepEqual(receipt.ownerAdmission, { localId: send.operationId, state: 'queued' });
    assert.deepEqual(f.writes().map(call => [call.method, call.params]), [
        ['thread/resume', { threadId: identity.nativeId, excludeTurns: true }],
        ['thread/queue/add', { threadId: identity.nativeId, clientUserMessageId: send.operationId,
            input: [{ type: 'text', text: 'hello', text_elements: [] }] }],
    ]);
    assert.deepEqual(await f.adapter.operate(send), receipt, 'repeated operation identity returns the durable receipt');
    assert.equal(f.writes().length, 2);
});

test('an explicit send joins the exact loaded thread once before queueing, without starting another turn', async t => {
    const f = await fixture(t, { loaded: true });
    const receipt = await f.adapter.operate(operation('loaded-send'));
    assert.equal(receipt.status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add']);
    assert.equal(f.writes()[1]?.params.threadId, identity.nativeId);
});

test('explicit settings join only the exact loaded generation; receipt reads and reconnect do not join or repeat settings', async t => {
    const f = await fixture(t, { loaded: true, writerLock: true });
    const update = { sourceId: identity.sourceId, operationId: 'settings-first', method: 'thread/settings/update', params: { threadId: identity.nativeId, effort: 'high' } };
    assert.equal((await f.adapter.nativeAccess.call(update)).status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/settings/update']);
    assert.deepEqual(f.writes()[0]!.params, { threadId: identity.nativeId, excludeTurns: true });
    f.reconnect();
    const before = f.writes().length;
    assert.equal((await f.adapter.nativeAccess.call(update, true)).status, 'accepted');
    await f.adapter.nativeAccess.call({ sourceId: identity.sourceId, method: 'thread/read', params: { threadId: identity.nativeId, includeTurns: false } });
    assert.equal(f.writes().length, before);
    assert.equal((await f.adapter.nativeAccess.call({ ...update, operationId: 'settings-next' })).status, 'accepted');
    assert.deepEqual(f.writes().slice(before).map(call => call.method), ['thread/resume', 'thread/settings/update']);
});

test('settings never cold-resume an unloaded thread or join an unverified shared writer', async t => {
    for (const options of [{ loaded: false, writerLock: true }, { loaded: true, writerLock: false }]) {
        const f = await fixture(t, options);
        const result = await f.adapter.nativeAccess.call({ sourceId: identity.sourceId, operationId: 'settings-denied', method: 'thread/settings/update',
            params: { threadId: identity.nativeId, effort: 'high' } });
        assert.equal(result.status, 'rejected');
        assert.deepEqual(f.writes(), []);
    }
});

test('subscription joins are generation-scoped; reads and original accepted receipts never join again', async t => {
    const f = await fixture(t, { loaded: true });
    const original = operation('subscribed-first');
    assert.equal((await f.adapter.operate(original)).status, 'accepted');
    assert.equal((await f.adapter.operate(operation('subscribed-second'))).status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add', 'thread/queue/add']);
    f.reconnect(); f.advanceRecovery();
    await f.adapter.list(); await f.adapter.read({ sessionId });
    assert.equal((await f.adapter.receipt(original))?.status, 'accepted');
    assert.equal((await f.adapter.operate(original)).status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add', 'thread/queue/add']);
    assert.equal((await f.adapter.operate(operation('subscribed-new-generation'))).status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add', 'thread/queue/add', 'thread/resume', 'thread/queue/add']);
    for (const call of f.writes().filter(call => call.method === 'thread/resume')) assert.deepEqual(call.params, { threadId: identity.nativeId, excludeTurns: true });
});

test('concurrent explicit admissions share one exact subscription join', async t => {
    const gate = Promise.withResolvers<void>(), secondCheck = Promise.withResolvers<void>();
    let waitingForSecond = false;
    const f = await fixture(t, { loaded: true, busy: true, resumeGate: gate.promise, loadedCheck: () => { if (waitingForSecond) secondCheck.resolve(); } });
    const first = f.adapter.operate(operation('concurrent-one'));
    await f.resumeStarted; waitingForSecond = true;
    const second = f.adapter.operate(operation('concurrent-two'));
    try {
        await secondCheck.promise;
        assert.equal(f.writes().filter(call => call.method === 'thread/resume').length, 1);
        assert.equal(f.writes().filter(call => call.method === 'thread/queue/add').length, 0);
    } finally { gate.resolve(); }
    assert.equal((await first).status, 'accepted'); assert.equal((await second).status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add', 'thread/queue/add']);
    assert.deepEqual(new Set(f.writes().filter(call => call.method === 'thread/queue/add').map(call => call.params.clientUserMessageId)), new Set(['concurrent-one', 'concurrent-two']));
});

test('a connection replaced during a subscription join cannot admit an input using the old acknowledgement', async t => {
    const gate = Promise.withResolvers<void>(), f = await fixture(t, { loaded: true, resumeGate: gate.promise });
    const pending = f.adapter.operate(operation('changed-during-join'));
    await f.resumeStarted; f.reconnect(); gate.resolve();
    assert.equal((await pending).status, 'rejected');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume']);
    f.advanceRecovery();
    await f.adapter.list(); await f.adapter.read({ sessionId });
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume'], 'readback cannot continue the failed preflight');
});

test('an explicitly resumed source connection is already subscribed for its next queue admission', async t => {
    const f = await fixture(t, { loaded: true, resumeSettings: { activePermissionProfile: { id: ':workspace' }, approvalPolicy: 'on-request', collaborationMode: { mode: 'plan' } } });
    const joined = await f.adapter.nativeAccess.call({ sourceId: identity.sourceId, operationId: 'explicit-resume', method: 'thread/resume', params: { threadId: identity.nativeId, excludeTurns: true } });
    assert.equal(joined.status, 'accepted');
    assert.deepEqual((await f.adapter.resolve(sessionId)).codex?.settings, { activePermissionProfile: { id: ':workspace' }, approvalPolicy: 'on-request', collaborationMode: { mode: 'plan' } });
    assert.equal((await f.adapter.operate(operation('after-explicit-resume'))).status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add']);
});

test('a source resume that does not report settings keeps them unknown rather than inferring a permission profile', async t => {
    const f = await fixture(t, { loaded: true });
    assert.equal((await f.adapter.operate(operation('no-root-settings'))).status, 'accepted');
    assert.equal((await f.adapter.resolve(sessionId)).codex?.settings, undefined);
});

test('shared cold history with unverified writer-lock support cannot acquire execution', async t => {
    const f = await fixture(t, { writerLock: false });
    const [session] = await f.adapter.list(); assert.ok(session);
    const page = await f.adapter.read({ sessionId });
    assert.ok(page.entries.some(entry => entry.event.type === 'assistant/message'));
    assert.equal(session.capabilities.send, false);
    assert.equal((await f.adapter.operate(operation('unknown-cold-send'))).status, 'rejected');
    assert.deepEqual(f.writes(), []);
});

test('an unverified loaded thread cannot silently join for a new send, but keeps explicit steering and cancellation', async t => {
    const f = await fixture(t, { loaded: true, writerLock: false });
    const [session] = await f.adapter.list(); assert.ok(session);
    assert.equal(session.capabilities.send, false);
    assert.equal((await f.adapter.operate(operation('unknown-loaded-send'))).status, 'rejected');
    assert.deepEqual(f.writes(), []);
    assert.equal((await f.adapter.operate(operation('loaded-steer', 'steer'))).status, 'accepted');
    assert.equal((await f.adapter.operate(operation('loaded-cancel', 'cancel'))).status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['turn/steer', 'turn/interrupt']);
});

test('exclusive ownership retains its existing explicit cold-resume policy on an unverified runtime', async t => {
    const f = await fixture(t, { ownership: 'exclusive', writerLock: false });
    assert.equal((await f.adapter.operate(operation('exclusive-unknown-send'))).status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add']);
});

test('an empty prompt never resumes an unloaded thread, even with exclusive ownership', async t => {
    const f = await fixture(t, { ownership: 'exclusive' });
    const receipt = await f.adapter.operate({ ...operation('empty-send'), text: ' \n\t ' });
    assert.equal(receipt.status, 'rejected');
    assert.match(receipt.message, /empty/i);
    assert.deepEqual(f.writes(), [], 'input validation must precede any native resume');
});

test('a definite native resume refusal is rejected and never dispatches the prompt', async t => {
    const f = await fixture(t, { ownership: 'exclusive', resume: 'reject' });
    const send = operation('busy-owner');
    const receipt = await f.adapter.operate(send);
    assert.equal(receipt.status, 'rejected', 'an acknowledged native refusal is not a lost acknowledgement');
    assert.match(receipt.message, /already has an active writer/);
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume']);
    assert.deepEqual(await f.adapter.operate(send), receipt);
    assert.equal(f.writes().length, 1, 'a stored refusal is not automatically retried');
});

test('a resume response for another native ID cannot receive this prompt', async t => {
    const f = await fixture(t, { ownership: 'exclusive', resume: 'wrong-id' });
    const receipt = await f.adapter.operate(operation('wrong-native-id'));
    assert.equal(receipt.status, 'indeterminate');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume']);
});

for (const stage of ['resume', 'turn'] as const) test(`a lost ${stage} acknowledgement remains indeterminate after adapter restart without replay`, async t => {
    const f = await fixture(t, { ownership: 'exclusive', ...(stage === 'resume' ? { resume: 'ack-lost' as const } : { turnAckLost: true }) });
    const send = operation(`lost-${stage}-ack`);
    const receipt = await f.adapter.operate(send);
    assert.equal(receipt.status, 'indeterminate');
    const expected = stage === 'resume' ? ['thread/resume'] : ['thread/resume', 'thread/queue/add'];
    assert.deepEqual(f.writes().map(call => call.method), expected);
    await f.restart();
    assert.deepEqual(await f.adapter.operate(send), receipt);
    assert.deepEqual(f.writes().map(call => call.method), expected, 'durable uncertainty must not cause an automatic native retry');
});

for (const ownership of ['shared', 'exclusive'] as const) test(`${ownership} steering and cancellation cannot resume an unloaded thread`, async t => {
    const f = await fixture(t, { ownership });
    for (const kind of ['steer', 'cancel'] as const) {
        const receipt = await f.adapter.operate(operation(`unloaded-${kind}`, kind));
        assert.equal(receipt.status, 'rejected');
    }
    assert.deepEqual(f.writes(), []);
});

test('read-only receipt recovers a lost ACK only from the exact native user clientId after restart', async t => {
    const f = await fixture(t, { loaded: true, turnAckLost: true, observedClientId: 'exact' }), send = operation('native-client-correlation');
    assert.equal((await f.adapter.operate(send)).status, 'indeterminate');
    await f.restart();
    const receipt = await f.adapter.receipt(send);
    assert.equal(receipt?.status, 'accepted'); assert.ok(receipt?.observed);
    const page = await f.adapter.read({ sessionId, epoch: receipt!.observed!.epoch, around: receipt!.observed!.seq });
    assert.ok(page.entries.some(entry => entry.event.type === 'user/message' && 'rpcId' in entry.event.data.source && entry.event.data.source.rpcId === send.operationId));
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add']);
    const before = f.calls.length;
    assert.equal((await f.adapter.operate(send)).status, 'accepted');
    assert.equal(f.calls.length, before, 'a terminal receipt does not wait for native network reconciliation');
});

test('matching native text with a different clientId cannot confirm or replay an unknown send', async t => {
    const f = await fixture(t, { loaded: true, turnAckLost: true, observedClientId: 'foreign' }), send = operation('native-client-mismatch');
    assert.equal((await f.adapter.operate(send)).status, 'indeterminate');
    await f.restart();
    const receipt = await f.adapter.receipt(send);
    assert.equal(receipt?.status, 'indeterminate'); assert.equal(receipt?.observed, undefined);
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add']);
});

test('a failed native preflight read permits the original operation to retry without inventing a new ID', async t => {
    const f = await fixture(t, { loaded: true, preflightFailures: 1 }), send = operation('preflight-recovery');
    const before = await f.adapter.operate(send);
    assert.equal(before.status, 'rejected'); assert.equal(before.retryable, true); assert.deepEqual(f.writes(), []);
    assert.deepEqual(await f.adapter.receipt(send), before, 'receipt lookup itself never performs the allowed retry');
    f.advanceRecovery();
    assert.equal((await f.adapter.operate(send)).status, 'accepted');
    assert.deepEqual(f.writes().map(call => [call.method, call.params.clientUserMessageId]), [['thread/resume', undefined], ['thread/queue/add', send.operationId]]);
});

test('an accepted receipt supplies an exact cursor after its native user message has left the readable tail', { timeout: 3000 }, async t => {
    const f = await fixture(t, { loaded: true, observedClientId: 'exact', trailingMessages: 220 }), send = operation('accepted-behind-tail');
    assert.equal((await f.adapter.operate(send)).status, 'accepted');
    await f.restart();
    // Neither a mounted Pane nor a lost ACK is required to trigger reconciliation.
    let receipt = await f.adapter.receipt(send);
    assert.equal(receipt?.status, 'accepted');
    for (let attempt = 0; attempt < 100 && !receipt?.observed; attempt++) {
        await new Promise<void>(resolve => { setImmediate(resolve); });
        receipt = await f.adapter.receipt(send);
    }
    assert.ok(receipt?.observed);
    const tail = await f.adapter.read({ sessionId, limit: 160 });
    assert.equal(tail.entries.some(entry => entry.event.type === 'user/message'), false, 'the ordinary bounded tail cannot acknowledge this old message');
    const around = await f.adapter.read({ sessionId, epoch: receipt.observed.epoch, around: receipt.observed.seq, limit: 160 });
    assert.ok(around.entries.some(entry => entry.event.type === 'user/message' && 'rpcId' in entry.event.data.source && entry.event.data.source.rpcId === send.operationId));
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add']);
});

for (const delivery of ['not-dispatched', 'unknown'] as const) test(`an approval ${delivery} response retains the original native request identity on recovery`, async t => {
    const f = await fixture(t, { loaded: true, approvalDelivery: delivery });
    await f.adapter.list();
    f.requestApproval({ id: 42, generation: 1, method: 'item/commandExecution/requestApproval', params: { threadId: identity.nativeId, turnId: 'original-turn', itemId: 'native-command' } });
    const [session] = await f.adapter.list(), requestId = session?.pendingRequests[0]?.id;
    assert.ok(requestId);
    const request: SourceOperation = { sessionId, operationId: `approval-${delivery}`, kind: 'approve', requestId, decision: 'accept' };
    const first = await f.adapter.operate(request);
    assert.equal(first.status, delivery === 'not-dispatched' ? 'rejected' : 'indeterminate');
    assert.equal(first.retryable, delivery === 'not-dispatched' ? true : undefined);
    const next = await f.adapter.operate(request);
    assert.equal(next.status, delivery === 'not-dispatched' ? 'accepted' : 'indeterminate');
    assert.deepEqual(f.responses, [{ id: 42, result: { decision: 'accept' } }], 'only one response ever leaves the local write boundary');
    assert.deepEqual(f.writes(), [], 'approval recovery never creates, resumes or sends a prompt');
});

test('native image inputs preserve the original thread and stable operation identity', async t => {
    const f = await fixture(t, { loaded: true });
    await f.adapter.list();
    const request: SourceOperation = { ...operation('with-image'), text: '', images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }] };
    assert.equal((await f.adapter.operate(request)).status, 'accepted');
    assert.equal((await f.adapter.operate(request)).status, 'accepted');
    const writes = f.writes().filter(call => call.method === 'thread/queue/add');
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.params.threadId, identity.nativeId);
    assert.equal(writes[0]?.params.clientUserMessageId, request.operationId);
    assert.deepEqual(writes[0]?.params.input, [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }]);
    await assert.rejects(f.adapter.operate({ ...request, images: [{ mediaType: 'image/png', data: 'ZGlmZmVyZW50' }] }), /reused/);
});

test('busy ordinary sends join the editable native queue instead of implicitly steering the active turn', async t => {
    const f = await fixture(t, { loaded: true, busy: true });
    const send = operation('busy-queue');
    const receipt = await f.adapter.operate(send);
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.turnId, undefined);
    const page = await f.adapter.nativeAccess.call({ sourceId: identity.sourceId, method: 'thread/queue/list', params: { threadId: identity.nativeId } });
    const rows = (page.result as { data: Array<{ clientUserMessageId: string; input: unknown }> }).data;
    assert.equal(rows.length, 1); assert.equal(rows[0]!.clientUserMessageId, send.operationId);
    assert.deepEqual(rows[0]!.input, [{ type: 'text', text: send.text, text_elements: [] }]);
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add']);
    await f.adapter.operate(send);
    assert.equal(f.writes().length, 2, 'the same accepted request neither joins again nor enqueues twice');
});

for (const exact of [true, false]) test(`a lost busy queue ACK ${exact ? 'recovers the exact ID' : 'does not borrow a foreign ID'} after restart using only reads`, async t => {
    const f = await fixture(t, { loaded: true, busy: true, turnAckLost: true, queuedClientId: exact ? 'exact' : 'foreign' });
    const send = operation(`lost-busy-${exact}`);
    assert.equal((await f.adapter.operate(send)).status, 'indeterminate');
    await f.restart();
    const receipt = await f.adapter.receipt(send);
    assert.equal(receipt?.status, exact ? 'accepted' : 'indeterminate');
    assert.equal(receipt?.observed, undefined, 'native queue admission is separate from a consumed transcript message');
    if (exact) assert.deepEqual(receipt?.ownerAdmission, { localId: send.operationId, state: 'queued' });
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add']);
    await f.adapter.operate(send);
    assert.equal(f.writes().length, 2, 'unknown delivery and reconnect never join again or resubmit');
});

test('plain and structured carriers use the same native queue operation receipt', async t => {
    const f = await fixture(t, { loaded: true, busy: true });
    const send = operation('one-native-carrier');
    const request = { sourceId: identity.sourceId, operationId: send.operationId, method: 'thread/queue/add', params: {
        threadId: identity.nativeId, clientUserMessageId: send.operationId, input: [{ type: 'text', text: send.text, text_elements: [] }],
    } };
    assert.equal((await f.adapter.nativeAccess.call(request)).status, 'accepted');
    await f.restart();
    assert.equal((await f.adapter.operate(send)).status, 'accepted');
    assert.equal((await f.adapter.nativeAccess.call(request, true)).status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add']);
});

test('accepted pre-fix turn/start IDs remain accepted after upgrade without being converted into new queue writes', async t => {
    const f = await fixture(t, { loaded: false });
    const send = operation('legacy-already-accepted');
    const legacy = { sessionId, operationId: send.operationId, status: 'accepted' as const, message: 'The native engine accepted the prompt.', turnId: 'original-turn' };
    await new OperationLedger(join(f.directory, 'operations')).run(send, async () => legacy);
    assert.deepEqual(await f.adapter.operate(send), legacy);
    assert.deepEqual(f.writes(), [], 'an accepted old ID cannot resume or dispatch by the new mapping');
});

test('explicit steering and cancellation retain their exact native turn and never enter the normal queue', async t => {
    const f = await fixture(t, { loaded: true, busy: true });
    assert.equal((await f.adapter.operate(operation('explicit-steer', 'steer'))).turnId, 'original-turn');
    assert.equal((await f.adapter.operate(operation('explicit-cancel', 'cancel'))).turnId, 'original-turn');
    assert.deepEqual(f.writes().map(call => [call.method, call.params.expectedTurnId ?? call.params.turnId]), [
        ['turn/steer', 'original-turn'], ['turn/interrupt', 'original-turn'],
    ]);
});

test('exact native queue admission remains confirmed when consumed-message history is unavailable', async t => {
    const f = await fixture(t, { loaded: true, busy: true, turnAckLost: true, metadataUnavailable: true });
    const send = operation('queue-before-history');
    assert.equal((await f.adapter.operate(send)).status, 'indeterminate');
    const receipt = await f.adapter.receipt(send);
    assert.equal(receipt?.status, 'accepted');
    assert.deepEqual(receipt?.ownerAdmission, { localId: send.operationId, state: 'queued' });
    assert.equal(receipt.observed, undefined);
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'thread/queue/add']);
});

test('online native steering recovers only its original consumed clientID without queueing or resuming another turn', async t => {
    const f = await fixture(t, { loaded: true, busy: true, turnAckLost: true, observedClientId: 'exact' });
    const request = { sourceId: identity.sourceId, operationId: 'native-steer-lost', method: 'turn/steer', params: {
        threadId: identity.nativeId, expectedTurnId: 'original-turn', clientUserMessageId: 'native-steer-lost',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
    } };
    assert.equal((await f.adapter.nativeAccess.call(request)).status, 'indeterminate');
    await f.restart();
    assert.equal((await f.adapter.nativeAccess.call(request, true)).status, 'accepted');
    assert.deepEqual(f.writes().map(call => [call.method, call.params.expectedTurnId]), [['turn/steer', 'original-turn']]);
    assert.equal(f.calls.some(call => call.method === 'thread/queue/list'), false);
    assert.equal((await f.adapter.nativeAccess.call(request)).status, 'accepted');
    assert.equal(f.writes().length, 1);
});
