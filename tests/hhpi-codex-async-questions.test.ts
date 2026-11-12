import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { acceptNativeQuestions } from '../src/remote/codex-async-questions.ts';
import { nativeQuestionReply, questionItemId, sourceQuestionCallId } from '../src/shared/native-async-questions.ts';
import { sourceControlOperationId } from '../src/shared/source-operation-policy.ts';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import { CodexRpc } from '../src/remote/codex-rpc.ts';
import type { NativeQuestionsPage } from '../src/remote/codex-metadata-core.mjs';
import type { DirectCodexConfig } from '../src/remote/protocol.ts';
import { SyntheticResponsesModel } from './fixtures/hhpi/model.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import { CodexHistory } from '../src/remote/codex-history.ts';
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts';
import { nativeMetadataFixture, sliceNativeEntries } from './fixtures/hhpi-native-metadata.ts';

const question = { turnId: 'original', itemId: 'async-call', ordinal: 10, revision: 12,
    item: { type: 'agentMessage', id: 'async-call', delivery: 'async', questions: [
        { title: 'Choose a route', options: ['Blue', 'Green'] }, { title: 'Explain the route', options: null },
    ] } };
const page = (items: NativeQuestionsPage['items'], reset = false): NativeQuestionsPage => ({ items, reset,
    coordinates: 'native-generation', through: Math.max(0, ...items.map(item => item.revision)), more: false });
const answer = (id: string, selected: string[], custom?: string) => ({ answers: [{ id, selected, ...(custom ? { custom } : {}) }] });

test('actual async title/string-option schema persists across turns and settles each exact question independently', () => {
    const initial = acceptNativeQuestions(undefined, page([question], true));
    assert.equal(initial.active.length, 2);
    const first = initial.active[0]!, second = initial.active[1]!;
    assert.equal(first.id, questionItemId('async-call', 0));
    assert.deepEqual(acceptNativeQuestions(initial, page([])).active, initial.active, 'turn completion is not a question answer');
    const text = nativeQuestionReply(first, answer(first.id, ['Blue']));
    const partial = acceptNativeQuestions(initial, page([{ turnId: 'later', itemId: 'user-reply', ordinal: 20, revision: 20,
        item: { type: 'userMessage', content: [{ type: 'text', text }] } }]));
    assert.deepEqual(partial.active, [second]);
    assert.deepEqual(acceptNativeQuestions(partial, page([{ ...question, revision: 30 }])).active, [
        { ...second, params: { ...second.params, revision: 30 } },
    ], 'a later question revision cannot reopen an explicitly answered sibling');
    const free = nativeQuestionReply(second, answer(second.id, [], 'My own route'));
    assert.equal(acceptNativeQuestions(partial, page([{ turnId: 'later', itemId: 'free-reply', ordinal: 40, revision: 40,
        item: { type: 'userMessage', content: [{ type: 'text', text: free }] } }])).active.length, 0);
});

test('revisions, removals and source generation replacement invalidate old native question cards', () => {
    const state = acceptNativeQuestions(undefined, page([question], true));
    const revised = acceptNativeQuestions(state, page([{ ...question, revision: 15, item: { ...question.item,
        questions: [{ title: 'Revised route', options: ['Orange'] }] } }]));
    assert.equal(revised.active.length, 1); assert.equal((revised.active[0]!.params.question as { title: string }).title, 'Revised route');
    assert.throws(() => nativeQuestionReply(revised.active[0]!, answer(revised.active[0]!.id, ['Blue'])), /does not match/);
    assert.equal(acceptNativeQuestions(revised, page([{ ...question, revision: 16,
        item: { type: 'agentMessage', id: question.itemId, text: 'Question withdrawn' } }])).active.length, 0);
    assert.equal(acceptNativeQuestions(state, page([], true)).active.length, 0);
    const forged = nativeQuestionReply(state.active[0]!, answer(state.active[0]!.id, ['Blue'])).replace('Choose a route', 'Different question');
    assert.equal(acceptNativeQuestions(state, page([{ turnId: 'later', itemId: 'other', ordinal: 20, revision: 20,
        item: { type: 'userMessage', content: [{ type: 'text', text: forged }] } }])).active.length, 2);
});

test('official Skip sends an explicit empty native answer and settles only that question', () => {
    const state = acceptNativeQuestions(undefined, page([question], true)), request = state.active[0]!;
    const text = nativeQuestionReply(request, answer(request.id, []));
    assert.match(text, /"answer":""/);
    const skipped = acceptNativeQuestions(state, page([{ turnId: 'later', itemId: 'skip-reply', ordinal: 20, revision: 20,
        item: { type: 'userMessage', content: [{ type: 'text', text }] } }]));
    assert.deepEqual(skipped.active, [state.active[1]!]);
});

test('typed question/history projections show the official answer payload and retain exact native message correlation', () => {
    const session: SourceSession = { id: sourceSessionId({ machineId: 'fixture', sourceId: 'source', engine: 'codex', nativeId: 'thread' }),
        machineId: 'fixture', sourceId: 'source', engine: 'codex', nativeId: 'thread', title: 'Fixture', cwd: '/', status: 'idle', updatedAt: 1,
        activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: true, cancel: true, approve: true, files: true } };
    const index = new SourceEventIndex(':memory:', session), history = new CodexHistory(index);
    try {
        const state = acceptNativeQuestions(undefined, page([question], true)), reply = nativeQuestionReply(state.active[0]!, answer(state.active[0]!.id, ['Blue']));
        history.acceptTurn(session, { id: 'original', status: 'completed', items: [{ ...question.item, text: 'Choose a route\n- Blue\n- Green' },
            { type: 'userMessage', id: 'reply', clientId: 'original-reply', content: [{ type: 'text', text: reply }] }] }, true);
        const events = index.read({ sessionId: session.id, limit: 100 }).entries;
        const questionEvent = events.find(entry => entry.event.type === 'assistant/message')!;
        assert.equal(questionEvent.event.type, 'assistant/message');
        if (questionEvent.event.type === 'assistant/message') assert.deepEqual(questionEvent.event.data.message.content, []);
        const user = events.find(entry => entry.event.type === 'user/message')!;
        if (user.event.type !== 'user/message') throw new Error('Missing human answer');
        assert.equal(user.event.data.source.kind, 'user-question-reply');
        const text = user.event.data.content.find(content => content.type === 'text'); assert.ok(text && text.type === 'text');
        assert.deepEqual(JSON.parse(text.text), { questions: [{ id: state.active[0]!.id, question: 'Choose a route' }], answers: [{ id: state.active[0]!.id, selected: ['Blue'] }] });
        assert.doesNotMatch(text.text, /send_user_message_question_reply/);
        assert.equal(index.userMessageSequence('original-reply'), user.event.seq);
    } finally { index.dispose(); }
});

test('optional question-index failures preserve readable chat and last good pending state, but cannot authorize an answer', async t => {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-question-projection-');
    const turn = { id: 'original', status: 'inProgress' as const, startedAt: 1, completedAt: null }, item = { id: 'answer', type: 'agentMessage', text: 'Readable existing conversation' };
    const native = { id: 'thread', cwd: home, createdAt: 1, updatedAt: 2, status: { type: 'active', activeFlags: [] } };
    let fail = false, changed = false, notify = (_value: { method: string; params: Record<string, unknown> }) => {};
    const writes: string[] = [];
    const rpc = { online: true, currentGeneration: 1, connect: async () => ({ codexHome: home }), dispose: async () => {},
        onNotification: (callback: typeof notify) => { notify = callback; return () => {} }, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>, options?: { write?: boolean }) => {
            if (options?.write) writes.push(method);
            if (method === 'thread/read') return { thread: native };
            if (method === 'thread/items/list') return sliceNativeEntries([{ turnId: turn.id, item }], params);
            throw new Error(`Unexpected source method ${method}`);
        } } as unknown as CodexRpc;
    const source = new DirectCodexAdapter({ id: 'source', machineId: 'fixture', engine: 'codex' }, join(home, 'view'), { rpc, pollMs: 60_000,
        readMetadata: nativeMetadataFixture(() => [{ turn, items: [item] }]), readQuestions: async request => {
            if (fail) throw new Error('Synthetic question-index read failure');
            const rows = request.after === undefined || changed ? [question] : [];
            return { ...page(rows, request.coordinates === undefined), through: 12 };
        } });
    t.after(async () => { await source.dispose(); await rm(home, { recursive: true, force: true }); });
    const sessionId = sourceSessionId({ machineId: 'fixture', sourceId: 'source', engine: 'codex', nativeId: native.id });
    const good = await source.read({ sessionId }); assert.equal(good.session.pendingRequests.length, 2);
    fail = true; changed = true; notify({ method: 'item/completed', params: { threadId: native.id, turnId: turn.id, item } });
    const readable = await source.read({ sessionId });
    assert.match(JSON.stringify(readable.entries), /Readable existing conversation/);
    assert.deepEqual(readable.session.pendingRequests, good.session.pendingRequests);
    const pending = good.session.pendingRequests[0]!, operation = { sessionId, kind: 'approve' as const, requestId: pending.id,
        operationId: await sourceControlOperationId(sessionId, 'approve', sourceQuestionCallId(pending)), response: {
            ...answer(pending.id, ['Blue']), nativeQuestionRevision: pending.params.revision } };
    const receipt = await source.operate(operation);
    assert.equal(receipt.status, 'rejected'); assert.equal(receipt.retryable, true); assert.deepEqual(writes, []);
});

test('real native async tool: running steer and idle queue reach the Agent exactly once, with refresh recovery', {
    skip: !process.env.HHPI_CODEX_ASYNC_QUESTION_TEST_COMMAND ? 'Set HHPI_CODEX_ASYNC_QUESTION_TEST_COMMAND to the pinned native executable.' : false,
    timeout: 35_000,
}, async t => {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-native-async-question-'), socket = join(home, 'native.sock');
    const model = new SyntheticResponsesModel(); model.automatic = false; model.captureInput = true; await model.start();
    await writeFile(join(home, 'config.toml'), model.config().replace('model = \"hhpi-fixture\"', 'model = \"gpt-6.1-sol\"') + '\n[features]\nplugins = false\ncode_mode_host = true\n');
    const child = spawn(process.env.HHPI_CODEX_ASYNC_QUESTION_TEST_COMMAND!, ['app-server', '--listen', `unix://${socket}`],
        { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume(); const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    let source: DirectCodexAdapter | undefined;
    t.after(async () => {
        await model.close(); await source?.dispose(); child.kill('SIGTERM');
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
        await rm(home, { recursive: true, force: true });
    });
    const signal = AbortSignal.timeout(28_000);
    let physical = '';
    for (let attempt = 0; attempt < 200 && !physical; attempt++) {
        try { const path = await realpath(socket), stat = await lstat(path); if (stat.isSocket() && (stat.mode & 0o077) === 0) physical = path; } catch {}
        if (!physical) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(physical);
    const config: DirectCodexConfig = { id: 'native-fixture', machineId: 'fixture', engine: 'codex', endpoint: `unix://${physical}`, ownership: 'shared', writerLock: 'native' };
    const writes: string[] = [];
    class RecordedRpc extends CodexRpc {
        override request<T>(method: string, params: unknown, options: { write?: boolean; signal?: AbortSignal } = {}): Promise<T> {
            if (options.write) writes.push(method);
            return super.request(method, params, options);
        }
    }
    const make = () => new DirectCodexAdapter(config, join(home, 'view'), { rpc: new RecordedRpc(config), pollMs: 60_000 });
    source = make();
    const created = await source.create({ sourceId: source.id, operationId: 'create-async-fixture', cwd: home }); assert.ok(created.session);
    const sessionId = created.session.id;
    assert.equal((await source.operate({ sessionId, operationId: 'ask-async-fixture', kind: 'send', text: 'Ask the isolated async questions.' })).status, 'accepted');
    const asking = await model.next(signal);
    t.diagnostic('native model request received');
    await writeFile(join('/mnt/cache/data-cache/hhpi-native-questions-20261112', 'isolated-model-input.private.json'), JSON.stringify(asking.input), { mode: 0o600 });
    assert.ok(JSON.stringify(asking.input).includes('request_user_input_async'), 'the real engine must advertise the actual async tool');
    asking.tool('request_user_input_async', { questions: [{ title: 'Choose a route', options: ['Blue', 'Green'] }, { title: 'Explain the route' }] });
    const working = await model.next(signal);
    t.diagnostic('native async tool completed and Agent continued');
    const before = await source.read({ sessionId });
    assert.equal(before.session.pendingRequests.length, 2, 'actual engine-produced typed questions must be discovered');
    assert.equal(before.session.status, 'running', 'nonblocking questions do not stop the native turn');
    await source.dispose(); source = make();
    const restored = await source.read({ sessionId });
    assert.equal(restored.session.pendingRequests.length, 2);
    const first = restored.session.pendingRequests[0]!, firstOperation = { sessionId, operationId: await sourceControlOperationId(sessionId, 'approve', sourceQuestionCallId(first)),
        kind: 'approve' as const, requestId: first.id, response: { ...answer(first.id, ['Blue']), nativeQuestionRevision: first.params.revision } };
    const count = writes.filter(method => method === 'turn/steer').length;
    const receipts = await Promise.all([source.operate(firstOperation), source.operate(firstOperation)]);
    t.diagnostic(`running reply receipts ${receipts.map(receipt => receipt.status).join(',')}`);
    assert.ok(receipts.every(receipt => receipt.status === 'accepted'));
    assert.equal(writes.filter(method => method === 'turn/steer').length, count + 1);
    working.reply('Continuing the isolated work.');
    const received = await model.next(signal);
    const inputText = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(inputText)
        : value && typeof value === 'object' ? Object.values(value).flatMap(inputText) : [];
    const delivered = inputText(received.input).filter(text => text.includes('<send_user_message_question_reply>'));
    assert.equal(delivered.filter(text => text.includes('"answer":"Blue"')).length, 1, 'the running Agent actually receives one reply envelope');
    assert.equal((await source.read({ sessionId })).session.pendingRequests.length, 1);
    received.reply('This turn is complete. The other question remains open.');
    let idle = await source.read({ sessionId });
    for (let i = 0; i < 200 && idle.session.status !== 'idle'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); idle = await source.read({ sessionId }); }
    assert.equal(idle.session.status, 'idle'); assert.equal(idle.session.pendingRequests.length, 1);
    await source.dispose(); source = make();
    const second = (await source.read({ sessionId })).session.pendingRequests[0]!;
    const secondOperation = { sessionId, operationId: await sourceControlOperationId(sessionId, 'approve', sourceQuestionCallId(second)), kind: 'approve' as const,
        requestId: second.id, response: { ...answer(second.id, [], 'My own route'), nativeQuestionRevision: second.params.revision } };
    const queued = writes.filter(method => method === 'thread/queue/add').length;
    assert.equal((await source.operate(secondOperation)).status, 'accepted');
    const nextTurn = await model.next(signal);
    assert.equal(inputText(nextTurn.input).filter(text => text.includes('"answer":"My own route"')).length, 1);
    assert.equal((await source.operate(secondOperation)).status, 'accepted');
    assert.equal(writes.filter(method => method === 'thread/queue/add').length, queued + 1);
    assert.equal((await source.read({ sessionId })).session.pendingRequests.length, 0);
    nextTurn.reply('Both isolated answers received.');
});


test('real native idle queue: interruption keeps original items and explicit selected start continues their original queue', {
    skip: !process.env.HHPI_CODEX_QUEUE_START_TEST_COMMAND ? 'Set HHPI_CODEX_QUEUE_START_TEST_COMMAND to the pinned native executable.' : false,
    timeout: 30_000,
}, async t => {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-native-queue-start-'), socket = join(home, 'native.sock');
    const model = new SyntheticResponsesModel(); model.automatic = false; model.captureInput = true; await model.start();
    await writeFile(join(home, 'config.toml'), model.config().replace('model = "hhpi-fixture"', 'model = "gpt-6.1-sol"'));
    const child = spawn(process.env.HHPI_CODEX_QUEUE_START_TEST_COMMAND!, ['app-server', '--listen', `unix://${socket}`],
        { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume(); const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    let source: DirectCodexAdapter | undefined;
    t.after(async () => { await model.close(); await source?.dispose(); child.kill('SIGTERM');
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]); if (child.exitCode === null) child.kill('SIGKILL'); await rm(home, { recursive: true, force: true }); });
    const signal = AbortSignal.timeout(24_000); let physical = '';
    for (let i = 0; i < 200 && !physical; i++) { try { const path = await realpath(socket); if ((await lstat(path)).isSocket()) physical = path; } catch {} if (!physical) await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(physical);
    const config: DirectCodexConfig = { id: 'queue-start-fixture', machineId: 'fixture', engine: 'codex', endpoint: `unix://${physical}`, ownership: 'shared', writerLock: 'native' };
    source = new DirectCodexAdapter(config, join(home, 'view'), { pollMs: 60_000 });
    const created = await source.create({ sourceId: source.id, operationId: 'create-idle-queue-fixture', cwd: home }); assert.ok(created.session);
    const sessionId = created.session.id, threadId = created.session.nativeId;
    assert.equal((await source.operate({ sessionId, operationId: 'initial-owned-turn', kind: 'send', text: 'Isolated pending request, no tools or files.' })).status, 'accepted');
    await model.next(signal);
    const active = (await source.read({ sessionId })).session.activeTurnId; assert.ok(active);
    const call = (method: string, operationId: string, params: Record<string, unknown>) => source!.nativeAccess.call({ sourceId: source!.id, method, operationId, params: { threadId, ...params } });
    assert.equal((await call('turn/interrupt', 'stop-owned-turn', { turnId: active })).status, 'accepted');
    let state = await source.read({ sessionId });
    for (let i = 0; i < 200 && state.session.status !== 'idle'; i++) { await new Promise(resolve => setTimeout(resolve, 10)); state = await source.read({ sessionId }); }
    assert.equal(state.session.status, 'idle');
    const add = async (id: string) => { const result = await call('thread/queue/add', `add-${id}`, { clientUserMessageId: id, input: [{ type: 'text', text: id, text_elements: [] }] }); assert.equal(result.status, 'accepted'); return (result.result as { queuedSubmission: { id: string } }).queuedSubmission.id; };
    const first = await add('OWNED_QUEUE_FIRST'), selected = await add('OWNED_QUEUE_SELECTED');
    const rows = async () => { const r = await call('thread/queue/list', 'readonly-list', {}); assert.equal(r.status, 'accepted'); return (r.result as { data: Array<{ id: string; clientUserMessageId: string }> }).data; };
    assert.deepEqual((await rows()).map(row => row.id), [first, selected]);
    assert.equal(model.calls, 1, 'interrupted source does not dispatch either queued input on enqueue');
    assert.equal((await call('thread/queue/start', 'start-selected-owned', { queuedSubmissionId: selected })).status, 'accepted');
    const selectedRequest = await model.next(signal);
    const input = JSON.stringify(selectedRequest.input);
    assert.ok(input.includes('OWNED_QUEUE_SELECTED')); assert.ok(!input.includes('OWNED_QUEUE_FIRST'));
    assert.deepEqual((await rows()).map(row => row.id), [first]);
    selectedRequest.reply('Selected queued input received.');
    const following = await model.next(signal);
    assert.ok(JSON.stringify(following.input).includes('OWNED_QUEUE_FIRST'), 'normal completion continues the remaining native queue');
    following.reply('Remaining original queue received.');
    assert.deepEqual(await rows(), []);
    t.diagnostic('Codex actual selected-ID start: interrupted no automatic dispatch, selected item once then remaining native queue. Synthetic loopback model only.');
});
