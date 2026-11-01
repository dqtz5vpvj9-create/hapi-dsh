/** Production adapter, history and durable ledger; only the native RPC boundary is synthetic.
 * Cross-process writer exclusion is covered separately with the pinned native binary. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import { CodexRpcError, type CodexRpc, type NativeNotification, type NativeRequest } from '../src/remote/codex-rpc.ts';
import { SourceError } from '../src/remote/errors.ts';
import type { NativeThread } from '../src/remote/codex-native.ts';
import { sourceSessionId, type DirectCodexConfig, type SourceOperation } from '../src/remote/protocol.ts';

interface FixtureOptions {
    ownership?: 'shared' | 'exclusive';
    loaded?: boolean;
    writerLock?: boolean;
    resume?: 'reject' | 'wrong-id' | 'ack-lost';
    turnAckLost?: boolean;
    observedClientId?: 'exact' | 'foreign';
    preflightFailures?: number;
    trailingMessages?: number;
    approvalDelivery?: 'not-dispatched' | 'unknown';
}
interface Call { method: string; params: Record<string, unknown>; write: boolean }
const identity = { sourceId: 'native-source', machineId: 'native-machine', engine: 'codex', nativeId: 'original-thread' } as const;
const sessionId = sourceSessionId(identity);
const operation = (operationId: string, kind: SourceOperation['kind'] = 'send'): SourceOperation => ({
    sessionId, operationId, kind, text: 'hello', ...(kind === 'steer' || kind === 'cancel' ? { turnId: 'original-turn' } : {}),
});

async function fixture(t: TestContext, options: FixtureOptions = {}) {
    const privateHome = await mkdtemp(join(tmpdir(), 'hhpi-codex-send-'));
    const directory = join(privateHome, 'source');
    const native: NativeThread = { id: identity.nativeId, cwd: privateHome, createdAt: 1, updatedAt: 2,
        name: 'Persisted original thread', status: { type: 'idle' } };
    const calls: Call[] = [];
    let loaded = options.loaded ?? false;
    let clock = Date.now();
    let preflightFailures = options.preflightFailures ?? 0;
    const received: string[] = [];
    let notify: (frame: NativeNotification) => void = () => {};
    let requestApproval: (request: NativeRequest) => void = () => {};
    let responseAttempts = 0;
    const responses: Array<{ id: NativeRequest['id']; result: unknown }> = [];
    const rpc = {
        online: true, currentGeneration: 1,
        supportsThreadWriterLock: options.writerLock ?? true,
        connect: async () => ({ userAgent: 'hhpi/0.165.0 (Linux 6.8; x86_64) unknown (hhpi; 1)', codexHome: privateHome, platformFamily: 'unix', platformOs: 'linux' }),
        dispose: async () => {},
        onNotification: (listener: typeof notify) => { notify = listener; return () => {}; },
        onRequest: (listener: typeof requestApproval) => { requestApproval = listener; return () => {}; }, onDisconnect: () => () => {},
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
                if (preflightFailures-- > 0) throw new SourceError('TARGET_UNAVAILABLE', 'Synthetic failed preflight read');
                return { data: loaded ? [native.id] : [], nextCursor: null };
            }
            if (method === 'thread/list') return { data: [native], nextCursor: null };
            if (method === 'thread/read') return { thread: native };
            if (method === 'thread/turns/list') return { data: [{ id: 'historical-turn', status: 'completed', startedAt: 1, completedAt: 2 }], nextCursor: null };
            if (method === 'thread/items/list') return { data: [{ turnId: 'historical-turn', item: {
                id: 'historical-answer', type: 'agentMessage', text: 'Original persisted history',
            } }, ...received.map((clientId, index) => ({ turnId: 'historical-turn', item: { id: `native-user-${index}`, type: 'userMessage', clientId,
                content: [{ type: 'text', text: 'hello' }] } })), ...Array.from({ length: options.trailingMessages ?? 0 }, (_, index) => ({
                    turnId: 'historical-turn', item: { id: `later-answer-${index}`, type: 'agentMessage', text: `Later persisted answer ${index}` },
                }))], nextCursor: null };
            if (method === 'thread/resume') {
                if (options.resume === 'reject') throw new CodexRpcError(-32600,
                    `thread ${native.id} already has an active writer`);
                loaded = true;
                if (options.resume === 'ack-lost') throw new SourceError('OUTCOME_UNKNOWN', 'The native resume acknowledgement was lost.');
                return { thread: options.resume === 'wrong-id' ? { ...native, id: 'different-native-thread' } : native };
            }
            if (method === 'turn/start') {
                if (options.observedClientId) received.push(options.observedClientId === 'exact' ? String(params.clientUserMessageId) : 'another-operation');
                if (options.turnAckLost) throw new SourceError('OUTCOME_UNKNOWN', 'The native turn acknowledgement was lost.');
                return { turn: { id: 'new-native-turn' } };
            }
            throw new Error(`Unexpected native method: ${method}`);
        },
    } as unknown as CodexRpc;
    const config: DirectCodexConfig = { id: identity.sourceId, machineId: identity.machineId, engine: 'codex',
        ownership: options.ownership ?? 'shared' };
    let adapter = new DirectCodexAdapter(config, directory, { rpc, pollMs: 60_000, now: () => clock });
    t.after(async () => { await adapter.dispose(); await rm(privateHome, { recursive: true, force: true }); });
    return {
        get adapter() { return adapter; }, calls, responses, requestApproval: (request: NativeRequest) => requestApproval(request),
        writes: () => calls.filter(call => call.write),
        advanceRecovery() { clock += 60_000; },
        async restart() { await adapter.dispose(); adapter = new DirectCodexAdapter(config, directory, { rpc, pollMs: 60_000, now: () => clock }); },
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
    assert.equal(receipt.turnId, 'new-native-turn');
    assert.deepEqual(f.writes().map(call => [call.method, call.params]), [
        ['thread/resume', { threadId: identity.nativeId, excludeTurns: true }],
        ['turn/start', { threadId: identity.nativeId, clientUserMessageId: send.operationId,
            input: [{ type: 'text', text: 'hello', text_elements: [] }] }],
    ]);
    assert.deepEqual(await f.adapter.operate(send), receipt, 'repeated operation identity returns the durable receipt');
    assert.equal(f.writes().length, 2);
});

test('an already loaded shared thread sends directly without resuming or creating another owner', async t => {
    const f = await fixture(t, { loaded: true });
    const receipt = await f.adapter.operate(operation('loaded-send'));
    assert.equal(receipt.status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['turn/start']);
    assert.equal(f.writes()[0]?.params.threadId, identity.nativeId);
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

test('an unverified runtime retains control of its already loaded shared thread', async t => {
    const f = await fixture(t, { loaded: true, writerLock: false });
    const [session] = await f.adapter.list(); assert.ok(session);
    assert.equal(session.capabilities.send, true);
    assert.equal((await f.adapter.operate(operation('unknown-loaded-send'))).status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['turn/start']);
});

test('exclusive ownership retains its existing explicit cold-resume policy on an unverified runtime', async t => {
    const f = await fixture(t, { ownership: 'exclusive', writerLock: false });
    assert.equal((await f.adapter.operate(operation('exclusive-unknown-send'))).status, 'accepted');
    assert.deepEqual(f.writes().map(call => call.method), ['thread/resume', 'turn/start']);
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
    const expected = stage === 'resume' ? ['thread/resume'] : ['thread/resume', 'turn/start'];
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
    assert.ok(page.entries.some(entry => entry.event.type === 'user/message' && entry.event.data.source.rpcId === send.operationId));
    assert.deepEqual(f.writes().map(call => call.method), ['turn/start']);
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
    assert.deepEqual(f.writes().map(call => call.method), ['turn/start']);
});

test('a failed native preflight read permits the original operation to retry without inventing a new ID', async t => {
    const f = await fixture(t, { loaded: true, preflightFailures: 1 }), send = operation('preflight-recovery');
    const before = await f.adapter.operate(send);
    assert.equal(before.status, 'rejected'); assert.equal(before.retryable, true); assert.deepEqual(f.writes(), []);
    assert.deepEqual(await f.adapter.receipt(send), before, 'receipt lookup itself never performs the allowed retry');
    f.advanceRecovery();
    assert.equal((await f.adapter.operate(send)).status, 'accepted');
    assert.deepEqual(f.writes().map(call => [call.method, call.params.clientUserMessageId]), [['turn/start', send.operationId]]);
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
    assert.ok(around.entries.some(entry => entry.event.type === 'user/message' && entry.event.data.source.rpcId === send.operationId));
    assert.deepEqual(f.writes().map(call => call.method), ['turn/start']);
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
