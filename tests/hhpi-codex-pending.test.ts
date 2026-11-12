/** Production persistence/projection/operation owners; native RPC is the explicit
 * fixture boundary. Canonical records follow the observed 0.162 paginated format. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, appendFile, rm, lstat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { createServer } from 'node:http';
import { chmod } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import test, { type TestContext } from 'node:test';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import { capturePendingCall, pendingCallEvidence } from '../src/remote/codex-pending-history.ts';
import { CodexRpc, type NativeNotification, type NativeRequest } from '../src/remote/codex-rpc.ts';
import { SourceError } from '../src/remote/errors.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import { sourceSessionId, type DirectCodexConfig } from '../src/remote/protocol.ts';
import { nativeMetadataFixture, sliceNativeEntries } from './fixtures/hhpi-native-metadata.ts';
import { SyntheticResponsesModel } from './fixtures/hhpi/model.ts';

async function fixture(t: TestContext) {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-pending-test-'), directory = join(home, 'view');
    await mkdir(join(home, 'sessions'));
    const path = join(home, 'sessions', 'rollout-original.jsonl'), turnId = 'original-turn', nativeId = 'original-thread';
    const sessionId = sourceSessionId({ machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId });
    const request: NativeRequest = { id: 41, generation: 1, method: 'item/tool/requestUserInput',
        params: { threadId: nativeId, turnId, itemId: 'original-call', questions: [{ id: 'choice', header: 'Choice', question: 'Continue?' }] } };
    const frames = [
        { type: 'session_meta', payload: { id: nativeId, history_mode: 'paginated' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
        { type: 'turn_context', payload: { turn_id: turnId } },
        { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: request.params.itemId, arguments: JSON.stringify({ questions: request.params.questions }) } },
    ].map((frame, ordinal) => ({ ...frame, ordinal }));
    await writeFile(path, frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
    let ordinal = frames.length, daemon: string | undefined = 'daemon-a', generation = 1, outcome: 'resolved' | 'unknown' = 'resolved';
    const append = async (type: string, payload: Record<string, unknown>) => { await appendFile(path, JSON.stringify({ ordinal: ordinal++, type, payload }) + '\n'); };
    const native = { id: nativeId, path, historyMode: 'paginated', cwd: home, createdAt: 1, updatedAt: 2, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } };
    const turn = { id: turnId, status: 'inProgress' as const, startedAt: 1, completedAt: null };
    const item = { id: 'original-user', type: 'userMessage', content: [{ type: 'text', text: 'Original input' }] };
    const metadata = nativeMetadataFixture(() => [{ turn, items: [item] }]);
    const responses: Array<{ request: NativeRequest; result: unknown }> = [], writes: string[] = [];
    let deliver: (value: NativeRequest) => void = () => {};
    const config: DirectCodexConfig = { id: 'source', machineId: 'machine', engine: 'codex', ownership: 'shared', writerLock: 'native' };
    const make = () => {
        const rpc = {
            online: true, currentGeneration: generation, daemonIdentity: daemon,
            connect: async () => ({ userAgent: 'hhpi/0.162.0', codexHome: home, platformFamily: 'unix', platformOs: 'linux' }),
            dispose: async () => {}, onDisconnect: () => () => {}, onNotification: (_listener: (f: NativeNotification) => void) => () => {},
            onRequest: (listener: typeof deliver) => { deliver = listener; return () => {}; },
            request: async (method: string, params: Record<string, unknown>, options?: { write?: boolean }) => {
                if (options?.write) writes.push(method);
                if (method === 'thread/list') return { data: [native], nextCursor: null };
                if (method === 'thread/loaded/list') return { data: [nativeId], nextCursor: null };
                if (method === 'thread/read') return { thread: native };
                if (method === 'thread/turns/list') return { data: [turn], nextCursor: null };
                if (method === 'thread/items/list') return sliceNativeEntries([{ turnId, item }], params);
                throw new Error(`Unexpected native call ${method}`);
            },
            respond: async (value: NativeRequest, result: unknown) => {
                responses.push({ request: value, result });
                if (outcome === 'unknown') throw new SourceError('OUTCOME_UNKNOWN', 'Synthetic lost answer outcome');
                await append('response_item', { type: 'function_call_output', call_id: value.params.itemId, output: '{}' });
            },
        } as unknown as CodexRpc;
        return new DirectCodexAdapter(config, directory, { rpc, readMetadata: metadata, pollMs: 60_000 });
    };
    let adapter = make();
    t.after(async () => { await adapter.dispose(); await rm(home, { recursive: true, force: true }); });
    const indexPath = join(directory, 'history', createHash('sha256').update(sessionId).digest('hex') + '.v7.sqlite');
    const durable = () => {
        const db = new DatabaseSync(indexPath, { readOnly: true });
        try { return db.prepare("SELECT value FROM native_cache WHERE key='native-pending-requests:v1'").get()?.value; } finally { db.close(); }
    };
    return {
        home, path, request, sessionId, responses, writes, append,
        get adapter() { return adapter; },
        async receive(value = request) {
            await adapter.read({ sessionId }); deliver(value);
            if (value.method === 'item/tool/requestUserInput' && daemon) {
                for (let i = 0; i < 100 && !durable(); i++) await setImmediate();
                assert.ok(durable(), 'a received question must be durable before restarting its viewer');
            }
        },
        async restart(next: { daemon?: string | undefined; generation?: number; resetEpoch?: boolean } = {}) {
            const session = next.resetEpoch ? await adapter.resolve(sessionId) : undefined;
            await adapter.dispose();
            if (session) {
                const index = new SourceEventIndex(indexPath, session), prior = index.cached('native-pending-requests:v1');
                index.edit(session, () => { index.removeFrom(0); index.forget(''); index.cache('native-pending-requests:v1', prior); }); index.dispose();
            }
            if ('daemon' in next) daemon = next.daemon; generation = next.generation ?? generation;
            adapter = make(); return adapter.read({ sessionId });
        },
        loseOutcome() { outcome = 'unknown'; },
    };
}

test('a received original question restores after viewer restart and resolves by exact native output without resume', async t => {
    const f = await fixture(t); await f.receive();
    const before = await f.adapter.read({ sessionId: f.sessionId }), originalId = before.session.pendingRequests[0]!.id;
    const restored = await f.restart({ generation: 2 });
    assert.equal(restored.session.pendingRequests.length, 1); assert.equal(restored.session.pendingRequests[0]!.id, originalId);
    assert.deepEqual(restored.session.pendingRequests[0]!.params, f.request.params);
    assert.equal(f.responses.length, 0); assert.deepEqual(f.writes, []);
    const operation = { sessionId: f.sessionId, operationId: 'answer-original', kind: 'approve' as const, requestId: originalId, response: { answers: { choice: { answers: ['Continue'] } } } };
    assert.equal((await f.adapter.operate(operation)).status, 'accepted');
    assert.equal(f.responses.length, 1); assert.equal(f.responses[0]!.request.id, f.request.id); assert.equal(f.responses[0]!.request.generation, 2);
    assert.equal((await f.adapter.operate(operation)).status, 'accepted'); assert.equal(f.responses.length, 1);
    assert.equal((await f.adapter.read({ sessionId: f.sessionId })).session.pendingRequests.length, 0);
    assert.deepEqual(f.writes, [], 'replying to the original request must not resume, create a turn, or enqueue input');
});

test('the original output excludes an old card while a second question in the same turn is waiting', async t => {
    const f = await fixture(t); await f.receive();
    await f.append('response_item', { type: 'function_call_output', call_id: f.request.params.itemId, output: '{}' });
    await f.append('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'second-call', arguments: '{}' });
    const page = await f.restart();
    assert.equal(page.session.status, 'waiting'); assert.deepEqual(page.session.pendingRequests, []);
    assert.equal(f.responses.length, 0); assert.deepEqual(f.writes, []);
});

test('daemon replacement and unverified instance identity cannot restore a cached native request', async t => {
    for (const daemon of ['daemon-b', undefined]) {
        const f = await fixture(t); await f.receive(); const page = await f.restart({ daemon });
        assert.deepEqual(page.session.pendingRequests, []); assert.equal(page.session.capabilities.approve, false);
        assert.equal(f.responses.length, 0); assert.deepEqual(f.writes, []);
    }
});

test('a lost answer outcome remains submitted across restart and cannot produce a second native reply', async t => {
    const f = await fixture(t); await f.receive(); const page = await f.restart();
    const operation = { sessionId: f.sessionId, operationId: 'answer-original', kind: 'approve' as const, requestId: page.session.pendingRequests[0]!.id, response: { answers: { choice: { answers: ['Continue'] } } } };
    f.loseOutcome(); assert.equal((await f.adapter.operate(operation)).status, 'indeterminate'); assert.equal(f.responses.length, 1);
    const reopened = await f.restart(); assert.deepEqual(reopened.session.pendingRequests, []);
    assert.equal((await f.adapter.operate(operation)).status, 'indeterminate'); assert.equal(f.responses.length, 1);
    await f.append('response_item', { type: 'function_call_output', call_id: f.request.params.itemId, output: '{}' });
    assert.equal((await f.adapter.receipt(operation))?.status, 'accepted'); assert.equal(f.responses.length, 1);
});

test('history alone and connection-bound verification requests are never invented as recovered questions', async t => {
    const f = await fixture(t);
    assert.deepEqual((await f.adapter.read({ sessionId: f.sessionId })).session.pendingRequests, []);
    await f.receive({ ...f.request, method: 'mcpServer/elicitation/request', params: { ...f.request.params, request: { type: 'userVerification' } } });
    assert.deepEqual((await f.restart()).session.pendingRequests, []); assert.equal(f.responses.length, 0);
});

test('a source epoch replacement invalidates an old received question without a reply', async t => {
    const f = await fixture(t); await f.receive(); const page = await f.restart({ resetEpoch: true });
    assert.deepEqual(page.session.pendingRequests, []); assert.equal(f.responses.length, 0); assert.deepEqual(f.writes, []);
});

test('an incomplete original output cannot confirm a submitted answer or cause a retry', async t => {
    const f = await fixture(t); await f.receive(); const page = await f.restart();
    const operation = { sessionId: f.sessionId, operationId: 'answer-original', kind: 'approve' as const, requestId: page.session.pendingRequests[0]!.id, response: { answers: { choice: { answers: ['Continue'] } } } };
    f.loseOutcome(); assert.equal((await f.adapter.operate(operation)).status, 'indeterminate');
    await appendFile(f.path, JSON.stringify({ ordinal: 4, type: 'response_item', payload: { type: 'function_call_output', call_id: f.request.params.itemId, output: '{}' } }));
    assert.equal((await f.adapter.receipt(operation))?.status, 'indeterminate'); assert.equal(f.responses.length, 1);
    await appendFile(f.path, '\n');
    assert.equal((await f.adapter.receipt(operation))?.status, 'accepted'); assert.equal(f.responses.length, 1);
});

test('incomplete canonical tails and replacement calls cannot prove an original request is pending', async t => {
    const f = await fixture(t); const anchor = await capturePendingCall(f.home, f.path, f.request); assert.ok(anchor);
    assert.equal(await pendingCallEvidence(f.home, anchor), 'pending');
    await f.append('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'second-call', arguments: '{}' });
    assert.equal(await pendingCallEvidence(f.home, anchor), 'unknown');
    await appendFile(f.path, '{"ordinal":5'); assert.equal(await pendingCallEvidence(f.home, anchor), 'unknown');
});

test('private Unix listener identity survives a client replacement and changes with a rebound daemon', async t => {
    const root = await mkdtemp('/mnt/cache/data-cache/hhpi-native-identity-'), path = join(root, 'native.sock');
    const instances: Array<Awaited<ReturnType<typeof listen>>> = [], clients: CodexRpc[] = [];
    async function listen() {
        const server = createServer(), sockets = new WebSocketServer({ server });
        sockets.on('connection', peer => peer.on('message', data => {
            const value = JSON.parse(data.toString());
            if (value.method === 'initialize') peer.send(JSON.stringify({ id: value.id, result: { userAgent: 'hhpi/0.162.0', codexHome: root, platformFamily: 'unix', platformOs: 'linux' } }));
        }));
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
        await chmod(path, 0o600);
        let closed = false;
        return { async close() {
            if (closed) return; closed = true;
            for (const peer of sockets.clients) peer.terminate();
            await new Promise<void>(resolve => sockets.close(() => resolve()));
            await new Promise<void>(resolve => server.close(() => resolve()));
        } };
    }
    t.after(async () => { for (const client of clients) await client.dispose(); for (const instance of instances) await instance.close(); await rm(root, { recursive: true, force: true }); });
    const client = async (forwarded = false) => {
        const value = new CodexRpc({ id: 'source', machineId: 'machine', engine: 'codex', endpoint: `unix://${path}`,
            ...(forwarded ? { historyMetadata: { command: 'unused-forwarded-helper' } } : {}) });
        clients.push(value); await value.connect(); return value;
    };
    const first = await listen(); instances.push(first);
    const a = await client(), identity = a.daemonIdentity; assert.ok(identity); await a.dispose();
    const b = await client(); assert.equal(b.daemonIdentity, identity);
    const forwarded = await client(true); assert.equal(forwarded.daemonIdentity, undefined);
    await b.dispose(); await forwarded.dispose(); await first.close();
    instances.push(await listen()); const replacement = await client(); assert.ok(replacement.daemonIdentity); assert.notEqual(replacement.daemonIdentity, identity);
});

test('actual source 0.162 restores its received question after adapter disposal without native resume', {
    skip: !process.env.HHPI_CODEX_PENDING_TEST_COMMAND ? 'Set HHPI_CODEX_PENDING_TEST_COMMAND to the source executable.' : false,
    timeout: 25_000,
}, async t => {
    const root = await mkdtemp('/mnt/cache/data-cache/hhpi-native-pending-lifecycle-'), path = join(root, 'native.sock');
    const model = new SyntheticResponsesModel(); await model.start(); model.automatic = false;
    await writeFile(join(root, 'config.toml'), model.config() + '\n[features]\nplugins = false\n');
    const child = spawn(process.env.HHPI_CODEX_PENDING_TEST_COMMAND!, ['app-server', '--listen', `unix://${path}`],
        { env: { ...process.env, CODEX_HOME: root }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume(); const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const config: DirectCodexConfig = { id: 'native-fixture', machineId: 'fixture', engine: 'codex', endpoint: `unix://${path}`, ownership: 'shared', writerLock: 'native' };
    const calls: string[] = [], responses: NativeRequest[] = [];
    class RecordedRpc extends CodexRpc {
        override async request<T>(method: string, params: unknown, options: { write?: boolean; signal?: AbortSignal } = {}): Promise<T> {
            if (options.write) calls.push(method);
            return super.request<T>(method, params, options);
        }
        override async respond(request: NativeRequest, result?: unknown, error?: { code: number; message: string }): Promise<void> {
            responses.push(request); return super.respond(request, result, error);
        }
    }
    let source: DirectCodexAdapter | undefined;
    try {
        // 0.162 publishes an advertised symlink after binding its private physical
        // socket. Use that socket, matching the verified source configuration;
        // the production transport deliberately rejects symlinks themselves.
        let ready = false;
        for (let i = 0; i < 200 && !ready; i++) {
            try {
                const physical = await realpath(path), stat = await lstat(physical);
                ready = stat.isSocket() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
                if (ready) config.endpoint = `unix://${physical}`;
            } catch {}
            if (!ready) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(ready, 'the isolated native private physical socket must be published');
        let rpc = new RecordedRpc(config, 5000); const runtime = (await rpc.connect()).userAgent; assert.match(runtime, /\/0\.162\.0\b/);
        source = new DirectCodexAdapter(config, join(root, 'view'), { rpc, pollMs: 60_000 });
        const created = await source.create({ sourceId: source.id, operationId: 'create-fixture', cwd: root }); assert.ok(created.session);
        const sessionId = created.session.id, threadId = created.session.nativeId;
        await source.read({ sessionId });
        await source.nativeAccess.call({ sourceId: source.id, operationId: 'plan-mode', method: 'thread/settings/update',
            params: { threadId, collaborationMode: { mode: 'plan', settings: { model: 'hhpi-fixture', reasoning_effort: null, developer_instructions: null } } } });
        assert.equal((await source.operate({ sessionId, operationId: 'original-input', kind: 'send', text: 'Ask the isolated question.' })).status, 'accepted');
        const request = Promise.withResolvers<NativeRequest>(); rpc.onRequest(value => { if (value.method === 'item/tool/requestUserInput') request.resolve(value); });
        const signal = AbortSignal.timeout(15_000);
        (await model.next(signal)).tool('request_user_input', { questions: [{ id: 'choice', header: 'Choice', question: 'Continue isolated test?', options: [{ label: 'Continue', description: 'Finish the isolated test' }] }] });
        const original = await request.promise;
        const indexPath = join(root, 'view', 'history', createHash('sha256').update(sessionId).digest('hex') + '.v7.sqlite');
        let cached = false;
        for (let i = 0; i < 200 && !cached; i++) {
            const db = new DatabaseSync(indexPath, { readOnly: true });
            try { cached = !!db.prepare("SELECT 1 FROM native_cache WHERE key='native-pending-requests:v1'").get(); } finally { db.close(); }
            if (!cached) await new Promise(resolve => setTimeout(resolve, 1));
        }
        assert.ok(cached, 'the actual native request must have its receipt-time canonical and daemon binding');
        const before = await source.read({ sessionId }), originalId = before.session.pendingRequests[0]!.id;
        const daemon = rpc.daemonIdentity; await source.dispose();
        rpc = new RecordedRpc(config, 5000); source = new DirectCodexAdapter(config, join(root, 'view'), { rpc, pollMs: 60_000 });
        const writesBeforeRecovery = calls.length, restored = await source.read({ sessionId });
        assert.equal(rpc.daemonIdentity, daemon); assert.equal(restored.session.pendingRequests.length, 1);
        assert.equal(restored.session.pendingRequests[0]!.id, originalId); assert.deepEqual(restored.session.pendingRequests[0]!.params, original.params);
        assert.equal(calls.length, writesBeforeRecovery); assert.equal(responses.length, 0);
        const answer = { sessionId, operationId: 'answer-original', kind: 'approve' as const, requestId: originalId, response: { answers: { choice: { answers: ['Continue'] } } } };
        const receipt = source.operate(answer);
        (await model.next(signal)).reply('Original question completed.');
        assert.equal((await receipt).status, 'accepted'); assert.equal(responses.length, 1); assert.equal(responses[0]!.id, original.id);
        assert.equal((await source.operate(answer)).status, 'accepted'); assert.equal(responses.length, 1);
        assert.equal((await source.read({ sessionId })).session.pendingRequests.length, 0);
        assert.equal(calls.length, writesBeforeRecovery); assert.equal(calls.filter(method => method === 'thread/resume').length, 0);
        t.diagnostic(JSON.stringify({ runtime, isolatedNativeHome: true, externalModelCalls: 0, syntheticModelCalls: model.calls,
            sameDaemonAfterAdapterRestart: true, recoveredOriginalQuestion: true, recoveryNativeWrites: 0, repliesToOriginalId: responses.length, acceptedByCanonicalOutput: true }));
    } finally {
        await source?.dispose(); child.kill('SIGTERM'); await closed; await model.close(); await rm(root, { recursive: true, force: true });
    }
});
