/** Real sparse metadata/production projection; only the native RPC is a fixture.
 * Mirrors 0.162 Review: no outer task_started, nested interrupted turn, and a
 * stale inProgress sparse row after the outer Review has completed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import { readNativeMetadata } from '../src/remote/codex-metadata-core.mjs';
import type { CodexRpc, NativeNotification } from '../src/remote/codex-rpc.ts';
import type { NativeItemEntry } from '../src/remote/codex-native.ts';
import { sourceSessionId, type SourcePage } from '../src/remote/protocol.ts';

const threadId = '11111111-1111-4111-8111-111111111111';
async function fixture(endOnlyFirstWindow = false) {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-review-return-');
    const db = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
    db.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER,rollout_end_ordinal INTEGER,error_json TEXT);
        CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,updated_at_ordinal INTEGER,item_type TEXT);
        CREATE INDEX item_order ON thread_items(thread_id,rollout_ordinal);
        CREATE INDEX turn_order ON thread_turns(thread_id,rollout_end_ordinal);`);
    const entries = new Map<string, Array<{ ordinal: number; entry: NativeItemEntry }>>();
    const turn = (id: string, status: string, start: number, end: number | null) =>
        db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?)').run(threadId, id, status, 1, end === null ? null : 2, start, end, null);
    const item = (turnId: string, ordinal: number, type: string, fields: Record<string, unknown> = {}) => {
        const id = `${turnId}-${ordinal}`;
        db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?)').run(threadId, turnId, id, ordinal, 1000, 1000, null, ordinal, type);
        const list = entries.get(turnId) ?? [];
        list.push({ ordinal, entry: { turnId, item: { id, type, ...fields } } }); entries.set(turnId, list);
    };
    turn('ordinary', 'completed', 1, 37);
    item('ordinary', 9, 'userMessage', { content: [{ type: 'text', text: 'original question' }] });
    item('ordinary', 11, 'reasoning', { summary: ['original reasoning'] });
    item('ordinary', 13, 'agentMessage', { text: 'original answer' });
    const directory = join(home, 'sessions', '2026', '11', '08'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `rollout-2026-11-08T00-00-00-${threadId}.jsonl`), JSON.stringify({ type: 'session_meta', ordinal: 0, payload: { id: threadId } }) + '\n');
    let notify = (_frame: NativeNotification) => {};
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const native = { id: threadId, cwd: home, createdAt: 1, updatedAt: 2, status: { type: 'idle' } };
    const rpc = { online: true, currentGeneration: 1, connect: async () => ({ codexHome: home }), dispose: async () => {},
        onNotification: (listener: typeof notify) => { notify = listener; return () => {}; }, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            if (method === 'thread/read') return { thread: native };
            if (method === 'thread/turns/list') return { data: [
                { id: 'outer-review', status: 'completed', startedAt: 1, completedAt: 2 },
                { id: 'inner-review', status: 'interrupted', startedAt: 1, completedAt: null },
                { id: 'ordinary', status: 'completed', startedAt: 1, completedAt: 2 },
            ], nextCursor: null };
            if (method !== 'thread/items/list') throw Error(`Reading must not execute ${method}`);
            const list = entries.get(String(params.turnId)) ?? [];
            const cursor = params.cursor as { itemId: string } | undefined;
            const start = cursor ? list.findIndex(row => row.entry.item.id === cursor.itemId) + 1 : 0;
            return { data: list.slice(start, start + Number(params.limit)).map(row => row.entry), nextCursor: null };
        } } as unknown as CodexRpc;
    const source = new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex' }, join(home, 'projection'), { rpc, pollMs: 60_000,
        // Use the real SQLite selector with a smaller initial budget to expose
        // the valid end-only page without manufacturing a different history.
        ...(endOnlyFirstWindow ? { readMetadata: (request: Parameters<typeof readNativeMetadata>[0]) => readNativeMetadata({ ...request,
            ...(request.position === undefined && request.before === undefined && request.after === undefined && request.around === undefined ? { limit: 1 } : {}) }) } : {}),
    });
    const sessionId = sourceSessionId({ sourceId: 'source', machineId: 'machine', engine: 'codex', nativeId: threadId });
    return { source, sessionId, calls,
        review: () => {
            turn('outer-review', 'completed', 50, 50);
            item('outer-review', 38, 'enteredReviewMode', { review: 'Review uncommitted changes' });
            item('outer-review', 47, 'exitedReviewMode', { review: 'No findings' });
            item('outer-review', 49, 'agentMessage', { text: 'Review complete' });
            turn('inner-review', 'inProgress', 39, null);
            item('inner-review', 40, 'userMessage', { content: [{ type: 'text', text: 'Review source' }] });
            item('inner-review', 41, 'reasoning', { summary: ['Inspecting changes'] });
            for (const ordinal of [42, 43, 45]) item('inner-review', ordinal, 'commandExecution', {
                command: 'git diff', cwd: home, status: 'completed', aggregatedOutput: 'review output', exitCode: 0 });
            item('inner-review', 44, 'reasoning', { summary: ['Final review'] });
            entries.get('inner-review')!.sort((a, b) => a.ordinal - b.ordinal);
            native.updatedAt++;
            notify({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } });
        },
        dispose: async () => { await source.dispose(); db.close(); await rm(home, { recursive: true, force: true }); } };
}

function assertReview(page: SourcePage) {
    assert.equal(page.session.status, 'idle', 'completed Review must return to a readable idle thread, not revive its stale inner turn');
    assert.equal(page.session.activeTurnId, null);
    const rows = page.entries.map(entry => entry.event);
    const start = rows.find(event => event.type === 'turn/start' && event.data.turn === 50);
    assert.ok(start, 'the outer Review keeps its exact native turn identity');
    const first = rows.find(event => event.type === 'step/start' && event.data.turn === 50 && event.data.step === 38);
    assert.ok(first);
    const previousEnd = rows.find(event => event.type === 'turn/end' && event.data.turn === 1);
    if (previousEnd) assert.ok(previousEnd.seq < start.seq, 'Review cannot start before the preceding native terminal boundary');
    assert.ok(start.seq < first.seq, 'the derived Review start must precede its exact first item');
    assert.equal(new Set(rows.map(event => event.seq)).size, rows.length, 'Review subevents cannot collide with other source coordinates');
    for (const event of rows) if (event.type === 'step/start') {
        assert.ok(rows.some(parent => parent.type === 'turn/start' && parent.data.turn === event.data.turn && parent.seq < event.seq),
            'each exact native item has its earlier turn context in the readable page');
    }
    assert.ok(rows.some(event => event.type === 'turn/end' && event.data.turn === 50 && event.data.reason.kind === 'completed'));
    assert.ok(!rows.some(event => event.type === 'turn/end' && event.data.turn === 39), 'no terminal ordinal is invented for the nested interrupted turn');
    assert.match(JSON.stringify(rows), /Review complete/);
    assert.ok(rows.some(event => event.type === 'tool/result'), 'the nested native tool results remain readable');
}

test('return from native Review preserves outer/inner item ordering, terminal state and ordinary coordinates', async () => {
    const f = await fixture();
    try {
        const before = await f.source.read({ sessionId: f.sessionId, limit: 160 });
        const original = before.entries.map(entry => entry.event);
        assert.equal(f.calls.some(call => call.method === 'thread/turns/list'), false, 'ordinary sparse pages do not enumerate native turns');
        f.review();
        const page = await f.source.read({ sessionId: f.sessionId, after: 0, limit: 160 });
        assertReview(page);
        assert.deepEqual(page.entries.filter(entry => original.some(event => event.seq === entry.event.seq)).map(entry => entry.event), original);
        const anchor = await f.source.locatePosition(f.sessionId, { turnId: 'outer-review', itemId: 'outer-review-38' });
        const around = await f.source.read({ sessionId: f.sessionId, around: anchor.seq, limit: 32 });
        assert.ok(around.entries.some(entry => entry.event.seq === anchor.seq));
        const terminalReads = f.calls.filter(call => call.method === 'thread/turns/list').length;
        const inner = await f.source.read({ sessionId: f.sessionId, around: 42 * 8, limit: 8 });
        assert.equal(inner.session.status, 'idle', 'an inner-only page cannot revive a previously confirmed terminal Review turn');
        assert.equal(inner.session.activeTurnId, null);
        assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, terminalReads, 'accepted exact terminal facts are reused without enumerating history');
        assert.ok(f.calls.every(call => ['thread/read', 'thread/items/list', 'thread/turns/list'].includes(call.method)), 'return is read-only and never resumes or starts a turn');
    } finally { await f.dispose(); }
});

test('a cold end-only Review page anchors the start to its exact first native item, not the selected tail', async () => {
    const f = await fixture(true);
    try {
        f.review();
        const tail = await f.source.read({ sessionId: f.sessionId, after: 49 * 8, limit: 8 });
        const start = tail.entries.find(entry => entry.event.type === 'turn/start' && entry.event.data.turn === 50);
        assert.equal(start?.event.seq, 38 * 8, 'a terminal-only selected page must retain the real first-item boundary');
        const page = await f.source.read({ sessionId: f.sessionId, after: 0, limit: 160 });
        assertReview(page);
    } finally { await f.dispose(); }
});
