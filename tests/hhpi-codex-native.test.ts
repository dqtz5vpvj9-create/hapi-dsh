/** Actual Codex 0.165.0 process; only the external model Responses API is a local fixture. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import { CodexRpc, CodexRpcError } from '../src/remote/codex-rpc.ts';
import type { DirectCodexConfig, SourcePage } from '../src/remote/protocol.ts';
import { SyntheticResponsesModel } from './fixtures/hhpi/model.ts';

const script = process.env.HHPI_CODEX_TEST_SCRIPT;
const command = process.env.HHPI_CODEX_TEST_COMMAND;

function isolatedNativeConfig(model: SyntheticResponsesModel): string {
    // Codex 0.165 gates startup marketplace/git warmups on features.plugins.
    // This fixture exercises threads and model RPC, with no plugin discovery or background clones.
    return `${model.config()}\n[features]\nplugins = false\n`;
}

async function completedNativeTurn(source: DirectCodexAdapter, page: SourcePage, nativeTurnId: string, signal: AbortSignal): Promise<SourcePage> {
    const sessionId = page.session.id;
    for await (const change of source.changes({ sessionId, epoch: page.epoch, version: page.version }, signal)) {
        if (!change.upserts.some(entry => entry.event.type === 'turn/end')) continue;
        const current = await source.read({ sessionId, limit: 500 }, signal);
        // A replay or revision of an older completed turn cannot complete this send.
        let coordinate: number | undefined; let found = false;
        for (const entry of current.entries) {
            if (entry.event.type === 'turn/start') coordinate = (entry.event.data as { turn: number }).turn;
            if (entry.event.type === 'user/message' && (entry.event.data as { id: string }).id.includes(`:${encodeURIComponent(nativeTurnId)}:`)) { found = true; break; }
        }
        if (found && coordinate !== undefined && current.entries.some(entry => entry.event.type === 'turn/end' && (entry.event.data as { turn: number }).turn === coordinate)) return current;
    }
    throw new Error('The native turn ended without a source completion event');
}

/** Observe actual native writes without replacing the transport or its responses. */
class RecordedNativeRpc extends CodexRpc {
    readonly writes: Array<{ method: string; threadId: string | undefined; error: CodexRpcError | undefined }> = [];
    readonly reads: Array<{ order: number; method: string; replyOrder?: number; status?: string; updatedAt?: number;
        turns?: Array<{ id: string; status: string }>; itemCount?: number; errorCode?: number }> = [];
    private order = 0;
    override async request<T>(method: string, params: unknown, options: { write?: boolean; signal?: AbortSignal } = {}): Promise<T> {
        const order = ++this.order;
        const read: (typeof this.reads)[number] | undefined = ['thread/read', 'thread/turns/list', 'thread/items/list'].includes(method) ? { order, method } : undefined;
        if (read) this.reads.push(read);
        const call = options.write ? { method,
            threadId: typeof params === 'object' && params !== null && 'threadId' in params && typeof params.threadId === 'string' ? params.threadId : undefined,
            error: undefined as CodexRpcError | undefined } : undefined;
        if (call) this.writes.push(call);
        try {
            const value = await super.request<T>(method, params, options);
            const replyOrder = ++this.order;
            if (read) {
                read.replyOrder = replyOrder;
                const result = value as { thread?: { status?: { type?: string }; updatedAt?: number }; data?: Array<{ id: string; status: string }> };
                if (method === 'thread/read') {
                    if (result.thread?.status?.type) read.status = result.thread.status.type;
                    if (result.thread?.updatedAt !== undefined) read.updatedAt = result.thread.updatedAt;
                } else if (method === 'thread/turns/list') read.turns = result.data?.map(turn => ({ id: turn.id, status: turn.status })) ?? [];
                else read.itemCount = result.data?.length ?? 0;
            }
            return value;
        } catch (error) {
            if (read) { read.replyOrder = ++this.order; if (error instanceof CodexRpcError) read.errorCode = error.code; }
            if (call && error instanceof CodexRpcError) call.error = error;
            throw error;
        }
    }
}

function messageTexts(page: SourcePage, type: 'user/message' | 'assistant/message'): string[] {
    return page.entries.filter(entry => entry.event.type === type).flatMap(entry => {
        const data = entry.event.data as { message?: unknown };
        const message = (type === 'assistant/message' ? data.message : data) as { content: Array<{ type: string; text?: string }> };
        return message.content.flatMap(part => part.type === 'text' ? [part.text!] : []);
    });
}

test('native Codex creates once, sends, streams, pages, steers and interrupts without a DSH execution Session', {
    skip: !script && !command ? 'Set HHPI_CODEX_TEST_COMMAND or HHPI_CODEX_TEST_SCRIPT to the pinned native Codex 0.165.0 executable.' : false,
    timeout: 45_000,
}, async t => {
    const root = await mkdtemp(join(tmpdir(), 'hhpi-native-'));
    const model = new SyntheticResponsesModel(); await model.start();
    await writeFile(join(root, 'config.toml'), isolatedNativeConfig(model));
    const config: DirectCodexConfig = { id: 'synthetic', machineId: 'fixture-machine', engine: 'codex', command: script ? process.execPath : command!,
        args: script ? [script, 'app-server'] : ['app-server'], codexHome: root, cwd: root, ownership: 'exclusive' };
    const rpc = new RecordedNativeRpc(config);
    const notifications: Array<{ method: string; turnId: unknown; status: unknown }> = [];
    rpc.onNotification(({ method, params }) => {
        const turn = params.turn as { id?: string; status?: string } | undefined;
        notifications.push({ method, turnId: turn?.id ?? params.turnId, status: turn?.status });
    });
    const source = new DirectCodexAdapter(config, join(root, 'source-index'), { rpc });
    const signal = AbortSignal.timeout(40_000);
    let phase = 'catalog empty native home', targetTurn: string | undefined, diagnosticSessionId: string | undefined, nativeId: string | undefined;
    try {
        assert.equal((await source.list()).length, 0);
        phase = 'create original native thread';
        const creation = { sourceId: source.id, operationId: 'one-creation', cwd: root };
        const [a, b] = await Promise.all([source.create(creation), source.create(creation)]);
        assert.equal(a.status, 'accepted'); assert.ok(a.session); assert.deepEqual(a, b);
        const sessionId = a.session.id;
        diagnosticSessionId = sessionId; nativeId = a.session.nativeId; phase = 'read empty native history';
        const initial = await source.read({ sessionId }); assert.equal(initial.entries.length, 0);
        assert.equal((await source.list()).length, 1);
        let accepted = initial;
        const completed = (page: SourcePage, nativeTurnId: string) => completedNativeTurn(source, page, nativeTurnId, signal);
        for (let turn = 0; turn < 8; turn++) {
            phase = `send automatic native turn ${turn}`;
            const operation = { sessionId, operationId: `send-${turn}`, kind: 'send' as const, text: `Synthetic prompt ${turn}` };
            const [first, duplicate] = await Promise.all([source.operate(operation), source.operate(operation)]);
            assert.equal(first.status, 'accepted'); assert.deepEqual(first, duplicate);
            assert.ok(first.turnId); targetTurn = first.turnId; phase = `observe automatic native turn ${turn}`;
            accepted = await completed(accepted, first.turnId);
        }
        assert.equal(model.calls, 8, 'duplicate submissions must reach the native model only once');
        const identities = accepted.entries.map(entry => entry.event.seq);
        assert.equal(new Set(identities).size, identities.length);
        assert.equal(accepted.entries.filter(entry => entry.event.type === 'user/message').length, 8);
        assert.equal(accepted.entries.filter(entry => entry.event.type === 'assistant/message').length, 8);
        phase = 'read six older source pages';
        let page = await source.read({ sessionId, limit: 6 });
        for (let segment = 0; segment < 6; segment++) {
            assert.ok(page.before !== null);
            const older = await source.read({ sessionId, before: page.before, epoch: page.epoch, limit: 6 });
            assert.ok(older.entries.some(entry => entry.event.type === 'user/message' || entry.event.type === 'assistant/message'), `segment ${segment + 1} must contain body text`);
            assert.ok(older.before! < page.before); page = older;
        }
        // Hold only the model boundary; native steering and execution ownership remain real.
        model.automatic = false;
        phase = 'start held steering turn';
        const running = await source.operate({ sessionId, operationId: 'running', kind: 'send', text: 'Wait for synthetic feedback.' });
        assert.equal(running.status, 'accepted'); assert.ok(running.turnId);
        targetTurn = running.turnId; phase = 'receive held steering model request';
        const held = await model.next(signal);
        phase = 'native steering acknowledgement';
        const steering = { sessionId, operationId: 'steer', kind: 'steer' as const, text: 'Additional synthetic feedback.', turnId: running.turnId };
        const steer = await source.operate(steering);
        assert.equal(steer.status, 'accepted'); assert.deepEqual(await source.operate(steering), steer);
        model.automatic = true; held.reply('Synthetic steered completion');
        phase = 'observe steered turn completion';
        accepted = await completed(accepted, running.turnId);
        model.automatic = false;
        phase = 'start held cancellable turn';
        const cancellable = await source.operate({ sessionId, operationId: 'cancellable', kind: 'send', text: 'Wait for synthetic cancellation.' });
        assert.equal(cancellable.status, 'accepted'); assert.ok(cancellable.turnId);
        targetTurn = cancellable.turnId; phase = 'receive held cancellable model request';
        await model.next(signal);
        phase = 'native interrupt acknowledgement';
        const cancel = { sessionId, operationId: 'cancel', kind: 'cancel' as const, turnId: cancellable.turnId };
        const cancelled = await source.operate(cancel); assert.equal(cancelled.status, 'accepted');
        assert.deepEqual(await source.operate(cancel), cancelled);
        phase = 'observe interrupted turn completion';
        await completed(accepted, cancellable.turnId);
        phase = 'verify retained source identities';
        const final = await source.read({ sessionId, limit: 500 });
        assert.deepEqual(final.entries.filter(entry => identities.includes(entry.event.seq)).map(entry => entry.event.seq), identities, 'native streaming and later turns preserve earlier source identities');
        await assert.rejects(source.read({ sessionId: sessionId.replace('fixture-machine', 'other-machine') }), { code: 'INVALID_REQUEST' });
    } catch (error) {
        const observedReads = rpc.reads.slice(-40);
        const diagnosticSignal = AbortSignal.timeout(1000);
        const [turns, page] = await Promise.allSettled([
            rpc.request<{ data: Array<{ id: string; status: string }> }>('thread/turns/list', { threadId: nativeId, sortDirection: 'asc', itemsView: 'notLoaded', limit: 100 }, { signal: diagnosticSignal }),
            diagnosticSessionId ? source.read({ sessionId: diagnosticSessionId, limit: 500 }, diagnosticSignal) : Promise.reject(new Error('No thread created')),
        ]);
        t.diagnostic(JSON.stringify({ phase, modelCalls: model.calls, targetTurn, nativeOnline: rpc.online,
            writes: rpc.writes.map(call => ({ method: call.method, code: call.error?.code })), notifications: notifications.slice(-24),
            observedReads,
            nativeTurns: turns.status === 'fulfilled' ? turns.value.data.map(turn => ({ id: turn.id, status: turn.status })) : 'unavailable',
            sourceStatus: page.status === 'fulfilled' ? page.value.session.status : 'unavailable',
            sourceEventTypes: page.status === 'fulfilled' ? page.value.entries.map(entry => entry.event.type) : [],
            sourceTurns: page.status === 'fulfilled' ? page.value.entries.filter(entry => ['turn/start', 'turn/end', 'user/message'].includes(entry.event.type)).map(entry => {
                const data = entry.event.data as { turn?: number; reason?: string; id?: string };
                return { type: entry.event.type, turn: data.turn, reason: data.reason, id: data.id };
            }) : 'unavailable' }));
        throw error;
    } finally { await source.dispose(); await model.close(); await rm(root, { recursive: true, force: true }); }
});

test('shared Codex source resumes the original persisted thread only after its native writer exits', {
    skip: !script && !command ? 'Set HHPI_CODEX_TEST_COMMAND or HHPI_CODEX_TEST_SCRIPT to the pinned native Codex 0.165.0 executable.' : false,
    timeout: 45_000,
}, async t => {
    const root = await mkdtemp(join(tmpdir(), 'hhpi-native-handoff-'));
    const model = new SyntheticResponsesModel(); await model.start();
    const sources: DirectCodexAdapter[] = [];
    const native: Array<{ rpc: RecordedNativeRpc; notifications: string[] }> = [];
    const signal = AbortSignal.timeout(40_000);
    let phase = 'prepare isolated home';
    try {
        await writeFile(join(root, 'config.toml'), isolatedNativeConfig(model));
        const open = (name: string, ownership: DirectCodexConfig['ownership']) => {
            const config: DirectCodexConfig = { id: 'persisted', machineId: 'fixture-machine', engine: 'codex',
                command: script ? process.execPath : command!, args: script ? [script, 'app-server'] : ['app-server'],
                codexHome: root, cwd: root, writerLock: 'native', ...(ownership ? { ownership } : {}) };
            const rpc = new RecordedNativeRpc(config);
            const notifications: string[] = [];
            rpc.onNotification(value => { notifications.push(value.method); });
            native.push({ rpc, notifications });
            const source = new DirectCodexAdapter(config, join(root, name), { rpc });
            sources.push(source);
            return { rpc, source };
        };
        const loaded = async (rpc: CodexRpc): Promise<string[]> => {
            const page = await rpc.request<{ data: string[]; nextCursor: string | null }>('thread/loaded/list', { limit: 100 }, { signal });
            assert.equal(page.nextCursor, null, 'the isolated native home contains one thread');
            return page.data;
        };

        const owner = open('owner-index', 'exclusive');
        phase = 'create original native thread';
        const creation = await owner.source.create({ sourceId: owner.source.id, operationId: 'create-persisted', cwd: root });
        assert.equal(creation.status, 'accepted'); assert.ok(creation.session);
        const { id: sessionId, nativeId } = creation.session;
        phase = 'read original empty thread';
        const initial = await owner.source.read({ sessionId }, signal);
        phase = 'send original turn';
        const first = await owner.source.operate({ sessionId, operationId: 'persist-first-turn', kind: 'send', text: 'Persist this original thread.' });
        assert.equal(first.status, 'accepted'); assert.ok(first.turnId);
        phase = 'observe original turn completion';
        const persisted = await completedNativeTurn(owner.source, initial, first.turnId, signal);
        assert.deepEqual(messageTexts(persisted, 'assistant/message'), ['Synthetic response 1']);
        assert.equal(model.calls, 1);

        // A different real app-server sees persisted history, but does not own A's writer.
        const attached = open('attached-index', 'shared');
        phase = 'catalog persisted thread in second process';
        assert.deepEqual((await attached.source.list(signal)).map(session => session.id), [sessionId]);
        assert.deepEqual(await loaded(attached.rpc), []);
        phase = 'read and page second-process history';
        let page = await attached.source.read({ sessionId, limit: 2 }, signal);
        let olderReads = 0;
        while (page.hasBefore) {
            assert.ok(olderReads++ < 8, 'the single native turn must finish paging within its bounded history');
            assert.notEqual(page.before, null);
            const before = page.before!;
            page = await attached.source.read({ sessionId, epoch: page.epoch, before, limit: 2 }, signal);
            assert.ok(page.before !== null && page.before < before, 'each native history page advances to older events');
        }
        assert.ok(olderReads > 0, 'the persisted thread was read across more than one source page');
        const beforeSend = await attached.source.read({ sessionId, limit: 500 }, signal);
        assert.deepEqual(messageTexts(beforeSend, 'user/message'), ['Persist this original thread.']);
        assert.deepEqual(messageTexts(beforeSend, 'assistant/message'), ['Synthetic response 1']);
        const observing = attached.source.changes({ sessionId, epoch: beforeSend.epoch, version: beforeSend.version }, signal)[Symbol.asyncIterator]();
        try { assert.equal((await observing.next()).done, false, 'an unloaded native thread remains observable'); }
        finally { await observing.return?.(); }
        assert.deepEqual(await loaded(attached.rpc), [], 'reading, paging and subscribing cannot load a native execution');
        assert.equal(attached.rpc.writes.length, 0, 'catalog, history reads and subscriptions cannot resume the original thread');
        assert.equal(model.calls, 1, 'observing persisted history must not invoke the model');

        phase = 'reject competing native writer';
        const blocked = await attached.source.operate({ sessionId, operationId: 'while-owner-alive', kind: 'send', text: 'Do not steal the active native writer.' });
        assert.equal(blocked.status, 'rejected', 'a definite native writer conflict must be reported as rejected');
        assert.deepEqual(attached.rpc.writes.map(call => call.method), ['thread/resume'],
            'an explicit shared send must reach native ownership arbitration instead of rejecting unloaded history locally');
        const conflicting = attached.rpc.writes[0]!;
        assert.equal(conflicting.threadId, nativeId);
        assert.ok(conflicting.error instanceof CodexRpcError, 'the live-writer refusal must come from the real native app-server');
        assert.equal(conflicting.error.code, -32600);
        assert.match(conflicting.error.message, /already has an active writer/);
        assert.equal(blocked.message, conflicting.error.message, 'the rejected receipt preserves the native writer refusal');
        assert.equal(beforeSend.session.capabilities.send, true, 'persisted history permits an explicit native send attempt');
        assert.deepEqual(await loaded(attached.rpc), []);
        assert.deepEqual(await loaded(owner.rpc), [nativeId], 'a rejected competing resume leaves the original writer loaded');
        assert.equal(model.calls, 1, 'a refused competing writer must never start another model request');

        phase = 'close original app-server';
        await owner.source.dispose();
        assert.equal(owner.rpc.online, false, 'the original app-server has exited before its thread is resumed');
        const reopened = await attached.source.read({ sessionId, limit: 500 }, signal);
        assert.deepEqual(await loaded(attached.rpc), [], 'reading after the original process exits still cannot resume it');
        assert.equal(model.calls, 1);
        model.automatic = false;
        const operation = { sessionId, operationId: 'continue-after-owner-exit', kind: 'send' as const, text: 'Continue the same persisted thread.' };
        phase = 'explicit shared continuation after original exit';
        const [receipt, duplicate] = await Promise.all([attached.source.operate(operation), attached.source.operate({ ...operation })]);
        assert.equal(receipt.status, 'accepted'); assert.deepEqual(duplicate, receipt);
        assert.equal(receipt.sessionId, sessionId); assert.ok(receipt.turnId); assert.notEqual(receipt.turnId, first.turnId);
        phase = 'observe resumed model request';
        const response = await model.next(signal);
        assert.equal(model.calls, 2, 'duplicate explicit sends must start exactly one new native model request');
        assert.deepEqual(await loaded(attached.rpc), [nativeId]);
        response.reply('Resumed the original persisted thread.');
        phase = 'observe resumed turn completion';
        const completed = await completedNativeTurn(attached.source, reopened, receipt.turnId, signal);
        assert.deepEqual(messageTexts(completed, 'user/message'), ['Persist this original thread.', 'Continue the same persisted thread.']);
        assert.deepEqual(messageTexts(completed, 'assistant/message'), ['Synthetic response 1', 'Resumed the original persisted thread.']);
        assert.equal(completed.session.id, sessionId); assert.equal(completed.session.nativeId, nativeId);
        assert.deepEqual(await attached.source.operate({ ...operation }), receipt, 'an observed send retains its deduplicated receipt');
        assert.deepEqual(attached.rpc.writes.map(call => [call.method, call.threadId]),
            [['thread/resume', nativeId], ['thread/resume', nativeId], ['turn/start', nativeId]],
            'explicit continuation resumes once and starts one turn in the original thread');
        assert.equal(model.calls, 2);
        t.diagnostic(JSON.stringify({ olderReads, modelCalls: model.calls, nativeConflictCode: conflicting.error.code,
            resumedOriginalThread: completed.session.nativeId === nativeId, resumedTurnStarts: attached.rpc.writes.filter(call => call.method === 'turn/start').length,
            userMessages: messageTexts(completed, 'user/message').length, assistantMessages: messageTexts(completed, 'assistant/message').length }));
    } catch (error) {
        t.diagnostic(JSON.stringify({ phase, modelCalls: model.calls, native: native.map(({ rpc, notifications }) => ({
            online: rpc.online, writes: rpc.writes.map(call => ({ method: call.method, code: call.error?.code })), notifications: notifications.slice(-15), reads: rpc.reads.slice(-40),
        })) }));
        throw error;
    } finally {
        await Promise.all(sources.map(source => source.dispose()));
        await model.close(); await rm(root, { recursive: true, force: true });
    }
});
