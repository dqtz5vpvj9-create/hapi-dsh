/** Real adapter/gateway ownership; only the native RPC boundary is synthetic. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import { CodexRpcError, type CodexRpc } from '../src/remote/codex-rpc.ts';
import { SourceGateway } from '../src/remote/gateway.ts';
import { sourceSessionId } from '../src/remote/protocol.ts';
import type { NativeThread } from '../src/remote/codex-native.ts';

const identity = { sourceId: 'native', machineId: 'machine', engine: 'codex' } as const;
const sessionId = (nativeId: string) => sourceSessionId({ ...identity, nativeId });

async function fixture(t: TestContext, options: { unmaterialized?: boolean; lateEphemeral?: boolean } = {}) {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-ephemeral-');
    const thread = (id: string, updatedAt: number, ephemeral?: boolean): NativeThread => ({ id, cwd: directory,
        createdAt: 1, updatedAt, status: { type: 'idle' }, ...(ephemeral === undefined ? {} : { ephemeral }) });
    const persisted = [thread('ordinary', 20), thread('older', 10, false), thread('listed-ephemeral', 100, true)];
    const loadedOnly = thread('loaded-ephemeral', 200, true);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc = {
        online: true, currentGeneration: 1,
        connect: async () => ({}), dispose: async () => {},
        onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            if (method === 'thread/loaded/list') return { data: ['ordinary', 'loaded-ephemeral'], nextCursor: null };
            if (method === 'thread/list') { assert.equal(params.useStateDbOnly, true); return { data: persisted, nextCursor: null }; }
            if (method === 'thread/read') {
                assert.equal(params.includeTurns, false);
                const native = params.threadId === loadedOnly.id ? loadedOnly : persisted.find(row => row.id === params.threadId);
                assert.ok(native);
                return { thread: options.lateEphemeral && native.id === 'ordinary' ? { ...native, ephemeral: true } : native };
            }
            if (method === 'thread/turns/list') {
                assert.equal(params.threadId, 'ordinary', 'ephemeral metadata must prevent history dispatch');
                if (options.unmaterialized) throw new CodexRpcError(-32600, 'thread ordinary is not materialized yet; thread/turns/list is unavailable before first user message');
                return { data: [{ id: 'turn', status: 'completed' }], nextCursor: null };
            }
            if (method === 'thread/items/list') return { data: [{ turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: 'Available ordinary history' } }], nextCursor: null };
            throw new Error(`Unexpected native operation: ${method}`);
        },
    } as unknown as CodexRpc;
    const adapter = new DirectCodexAdapter({ id: identity.sourceId, machineId: identity.machineId, engine: 'codex', ownership: 'shared' }, directory, { rpc });
    const gateway = new SourceGateway([adapter], false);
    t.after(async () => { await gateway.dispose(); await rm(directory, { recursive: true, force: true }); });
    return { adapter, gateway, calls };
}

test('the sorted catalog hides listed and loaded-only ephemeral threads without hiding ordinary history', async t => {
    const { gateway, calls } = await fixture(t);
    for (let read = 0; read < 2; read++) {
        const catalog = await gateway.catalog(() => true);
        assert.deepEqual(catalog.sessions.map(row => row.nativeId), ['ordinary', 'older']);
        assert.equal(catalog.sources[0]?.online, true);
        assert.equal(catalog.sessions[0]?.capabilities.send, true);
    }
    assert.equal(calls.filter(call => call.method === 'thread/list').length, 1, 'the cached catalog applies the same visibility rule');
    const page = await gateway.read({ sessionId: sessionId('ordinary') }, () => true);
    assert.ok(page.entries.some(entry => entry.event.type === 'assistant/message'));
    assert.equal(calls.some(call => call.method === 'thread/resume'), false);
});

test('old ephemeral links return UNSUPPORTED before turns, items or execution requests', async t => {
    const { gateway, calls } = await fixture(t);
    for (const nativeId of ['loaded-ephemeral', 'listed-ephemeral']) {
        await assert.rejects(gateway.read({ sessionId: sessionId(nativeId) }, () => true), { code: 'UNSUPPORTED' });
    }
    assert.ok(calls.some(call => call.method === 'thread/read' && call.params.threadId === 'loaded-ephemeral'));
    assert.ok(calls.every(call => ['thread/list', 'thread/loaded/list', 'thread/read'].includes(call.method)));
});

test('fresh metadata identifying an ephemeral thread rejects a previously advertised link before paging', async t => {
    const { gateway, calls } = await fixture(t, { lateEphemeral: true });
    await gateway.catalog(() => true);
    await assert.rejects(gateway.read({ sessionId: sessionId('ordinary') }, () => true), { code: 'UNSUPPORTED' });
    assert.deepEqual((await gateway.catalog(() => true)).sessions.map(row => row.nativeId), ['older']);
    assert.ok(calls.every(call => ['thread/list', 'thread/loaded/list', 'thread/read'].includes(call.method)));
});

test('ordinary threads without their first user message remain valid empty conversations', async t => {
    const { gateway, calls } = await fixture(t, { unmaterialized: true });
    const page = await gateway.read({ sessionId: sessionId('ordinary') }, () => true);
    assert.deepEqual(page.entries, []);
    assert.equal(page.session.status, 'idle');
    assert.equal(page.session.capabilities.send, true);
    assert.equal(calls.filter(call => call.method === 'thread/turns/list').length, 1);
    assert.equal(calls.some(call => call.method === 'thread/items/list' || call.method === 'thread/resume'), false);
});
