import { nativeMetadataFixture, sliceNativeEntries } from './fixtures/hhpi-native-metadata.ts';
/** Real DirectCodexAdapter, native history projection and persistent source index.
 * Only native RPC/notifications are controlled; virtual polling never sends a prompt. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc, NativeNotification } from '../src/remote/codex-rpc.ts';
import type { NativeItemEntry, NativeThread, NativeTurn } from '../src/remote/codex-native.ts';

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const previous: NativeTurn = { id: 'previous-turn', status: 'completed', startedAt: 1, completedAt: 2 };
const current: NativeTurn = { id: 'current-turn', status: 'completed', startedAt: 3, completedAt: 4, items: [] };
const finalText = 'Final body accepted after native persistence catches up.';

async function fixture(t: TestContext, older: NativeTurn[]) {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const privateHome = await mkdtemp(join('/mnt/cache/data-cache', 'hhpi-native-completion-'));
    let native: NativeThread = { id: 'original-thread', cwd: privateHome, createdAt: 1, updatedAt: 2,
        name: 'Synthetic completion source', status: { type: 'idle' } };
    let visibleTurns = older;
    let notify: (frame: NativeNotification) => void = () => {};
    const calls: string[] = [], started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let holdNextTurnPage = false;
    const itemsFor = (turnId: string): NativeItemEntry[] => turnId === current.id ? [
                    { turnId, item: { id: 'question', type: 'userMessage', content: [{ type: 'text', text: 'Synthetic current prompt' }] }, startedAtMs: 3000 },
                    { turnId, item: { id: 'answer', type: 'agentMessage', text: finalText }, startedAtMs: 3500, completedAtMs: 4000 },
                ] : [{ turnId, item: { id: 'previous-answer', type: 'agentMessage', text: 'Earlier completed answer.' }, completedAtMs: 2000 }];
    const metadata = nativeMetadataFixture(() => visibleTurns.map(turn => ({ turn, items: itemsFor(turn.id).map(entry => entry.item) })));
    const readMetadata: typeof metadata = async request => {
        const page = await metadata(request);
        if (holdNextTurnPage) { holdNextTurnPage = false; started.resolve(); await release.promise; }
        return page;
    };
    const rpc = {
        online: true, currentGeneration: 1, supportsThreadWriterLock: true,
        connect: async () => ({}), dispose: async () => {},
        onNotification: (listener: typeof notify) => { notify = listener; return () => { notify = () => {}; }; },
        onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
            calls.push(method);
            if (method === 'thread/loaded/list') return { data: [native.id], nextCursor: null };
            if (method === 'thread/list') return { data: [structuredClone(native)], nextCursor: null };
            if (method === 'thread/read') return { thread: structuredClone(native) };
            if (method === 'thread/turns/list') {
                const direction = params.sortDirection === 'asc' ? 1 : -1;
                const page = { data: structuredClone(visibleTurns).sort((a, b) => direction * ((a.startedAt ?? 0) - (b.startedAt ?? 0))), nextCursor: null };
                if (holdNextTurnPage) { holdNextTurnPage = false; started.resolve(); await release.promise; }
                return page;
            }
            if (method === 'thread/items/list') {
                const turnId = String(params.turnId);
                const data = itemsFor(turnId);
                return sliceNativeEntries(data, params);
            }
            throw new Error(`Unexpected native completion operation: ${method}`);
        },
    } as unknown as CodexRpc;
    const adapter = new DirectCodexAdapter({ id: 'native', machineId: 'synthetic-machine', engine: 'codex' }, join(privateHome, 'source'), { rpc, readMetadata });
    t.after(async () => { release.resolve(); await adapter.dispose(); await rm(privateHome, { recursive: true, force: true }); });
    const [session] = await adapter.list(); assert.ok(session);
    const read = () => adapter.read({ sessionId: session.id, limit: 100 });
    const head = await read();
    const reader = new AbortController(), follow = adapter.changes({ sessionId: session.id, epoch: head.epoch, version: head.version }, reader.signal)[Symbol.asyncIterator]();
    await follow.next();
    t.after(async () => { reader.abort(); await follow.return?.(); });
    const completeBeforeHistory = () => {
        native = { ...native, status: { type: 'active' }, updatedAt: 3 };
        notify({ method: 'turn/started', params: { threadId: native.id, turn: { ...current, status: 'inProgress', completedAt: null } } });
        notify({ method: 'item/completed', params: { threadId: native.id, turnId: current.id,
            item: { id: 'question', type: 'userMessage', content: [{ type: 'text', text: 'Synthetic current prompt' }] } } });
        native = { ...native, status: { type: 'idle' }, updatedAt: 4 };
        notify({ method: 'turn/completed', params: { threadId: native.id, turn: current } });
        holdNextTurnPage = true;
    };
    return { adapter, calls, read, completeBeforeHistory, started: started.promise,
        catchUp: () => { visibleTurns = [current, ...older]; release.resolve(); },
        poll: async () => { t.mock.timers.tick(250); await flush(); } };
}

for (const [description, older] of [['empty native turn page', []], ['only an older terminal turn', [previous]]] as const) {
    test(`a completed notification survives an idle thread with ${description}`, { timeout: 5000 }, async t => {
        const f = await fixture(t, [...older]);
        f.completeBeforeHistory();
        const firstPoll = f.poll();
        await f.started;
        // The response was captured before persistence caught up. Its arrival
        // must not consume the obligation created by turn/completed.
        f.catchUp(); await firstPoll; await flush();
        await f.poll(); await f.poll();
        const page = await f.read();
        const promptIndex = page.entries.findIndex(entry => entry.event.type === 'user/message'
            && entry.event.data.id === 'codex:original-thread:current-turn:question');
        assert.ok(promptIndex >= 0, 'the accepted native prompt identifies the target turn');
        const start = page.entries.slice(0, promptIndex).findLast(entry => entry.event.type === 'turn/start');
        assert.ok(start && start.event.type === 'turn/start', 'the native prompt must follow its real turn/start');
        const coordinate = start.event.data.turn;
        assert.equal(typeof coordinate, 'number', 'the regression must match a real projected numeric turn');
        const ends = page.entries.filter(entry => entry.event.type === 'turn/end' && entry.event.data.turn === coordinate);
        assert.equal(ends.length, 1, 'an already-notified completed native turn must publish its end after persisted history catches up');
        assert.match(JSON.stringify(page.entries), new RegExp(finalText.replaceAll('.', '\\.')),
            'the completed boundary must include the final native body, not just the completion notification');
        assert.equal(page.session.status, 'idle');
        const reads = f.calls.filter(method => method === 'thread/read').length;
        t.mock.timers.tick(5000); await flush();
        assert.equal(f.calls.filter(method => method === 'thread/read').length, reads,
            'after terminal history is accepted an idle source must stop polling');
    });
}
