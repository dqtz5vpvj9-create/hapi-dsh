/** Native protocol boundary models slow rollout repair and oversized embedded turn bodies. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc } from '../src/remote/codex-rpc.ts';

test('native reading uses the indexed catalog and body-free turn headers, then reuses accepted pages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hhpi-native-reading-'));
    const methods: string[] = [];
    const thread = { id: 'existing-native-thread', cwd: directory, name: 'Synthetic long history', createdAt: 1, updatedAt: 2, status: { type: 'idle' } };
    const rpc = {
        online: true, currentGeneration: 1,
        connect: async () => ({}), dispose: async () => {},
        onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>) => {
            methods.push(method);
            if (method === 'thread/loaded/list') return { data: [thread.id], nextCursor: null };
            if (method === 'thread/list') {
                if (!params.useStateDbOnly) throw new Error('Native rollout repair is unavailable while the indexed catalog remains readable');
                return { data: [thread], nextCursor: null };
            }
            if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread }; }
            if (method === 'thread/turns/list') {
                if (params.itemsView !== 'notLoaded') throw new Error('Embedded historical attachments exceed the native transport frame budget');
                return { data: [{ id: 'turn', status: 'completed', startedAt: 1, completedAt: 2 }], nextCursor: null };
            }
            if (method === 'thread/items/list') return { data: Array.from({ length: 80 }, (_, i) => ({ turnId: 'turn', item: {
                id: `body-${i}`, type: i % 2 ? 'agentMessage' : 'userMessage',
                ...(i % 2 ? { text: `Earlier answer ${i}` } : { content: [{ type: 'text', text: `Earlier question ${i}` }] }),
            } })), nextCursor: null };
            throw new Error(`Reading dispatched an unexpected native operation: ${method}`);
        },
    } as unknown as CodexRpc;
    const adapter = new DirectCodexAdapter({ id: 'native', machineId: 'same-machine', engine: 'codex', ownership: 'shared' }, directory, { rpc });
    try {
        const [session] = await adapter.list(); assert.ok(session);
        let page = await adapter.read({ sessionId: session.id, limit: 12 });
        const reads = methods.filter(method => method === 'thread/items/list').length;
        for (let i = 0; i < 6; i++) {
            const previous = page.before;
            assert.ok(previous !== null);
            page = await adapter.read({ sessionId: session.id, before: previous, epoch: page.epoch, limit: 12 });
            assert.ok(page.before! < previous);
            assert.ok(page.entries.some(entry => ['user/message', 'assistant/message'].includes(entry.event.type)));
        }
        const signal = new AbortController();
        const follow = adapter.changes({ sessionId: session.id, epoch: page.epoch, version: page.version }, signal.signal)[Symbol.asyncIterator]();
        const opened = await follow.next();
        assert.deepEqual(opened.value, { session: page.session, epoch: page.epoch, base: page.version, version: page.version,
            reset: false, upserts: [], removed: [] }, 'a quiet Codex source acknowledges the opened cursor without waiting for a message');
        signal.abort(); await follow.return?.();
        assert.equal(methods.filter(method => method === 'thread/items/list').length, reads, 'accepted history pages do not reread native bodies');
        assert.ok(!methods.includes('thread/resume'));
    } finally { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); }
});
