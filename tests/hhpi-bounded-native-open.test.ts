import { zstdCompressSync } from 'node:zlib';
/** Actual native sparse SQLite queries and production adapter; item RPC is the isolated boundary. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readNativeMetadata } from '../src/remote/codex-metadata-core.mjs';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc } from '../src/remote/codex-rpc.ts';
import { sourceSessionId } from '../src/remote/protocol.ts';

async function fixture(items: number, turns = 1, beforeBody?: (signal: AbortSignal) => Promise<void>) {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-bounded-native-');
    const db = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
    db.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER,rollout_end_ordinal INTEGER,error_json TEXT);
        CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,updated_at_ordinal INTEGER,item_type TEXT);
        CREATE INDEX item_order ON thread_items(thread_id,rollout_ordinal);
        CREATE INDEX turn_order ON thread_turns(thread_id,rollout_end_ordinal); BEGIN`);
    for (let turn = 0; turn < turns; turn++) {
        const start = turn * (items + 2) + 1;
        db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?)').run('thread', `turn-${turn}`, 'completed', turn + 1, turn + 2, start, start + items + 1, null);
        for (let item = 0; item < items; item++) db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?)')
            .run('thread', `turn-${turn}`, `item-${item}`, start + item + 1, 1000, 1000, 2000, start + item + 1, 'agentMessage');
    }
    db.exec('COMMIT');
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [], answers = new Map<string, string>();
    const native = { id: 'thread', cwd: home, createdAt: 1, updatedAt: 2, status: { type: 'idle' } };
    const rpc = { online: true, currentGeneration: 1, connect: async () => ({ codexHome: home }), dispose: async () => {},
        onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
            calls.push({ method, params });
            if (method === 'thread/read') return { thread: native };
            if (method === 'thread/loaded/list' || method === 'thread/list' || method === 'thread/turns/list') throw new Error('Opening this exact native identity must not scan any catalog or all turns');
            if (method === 'thread/items/list') {
                if (beforeBody) await beforeBody(options!.signal!);
                const cursor = params.cursor as { type: string; itemId: string } | undefined;
                const first = cursor ? Number(cursor.itemId.slice(5)) + 1 : 0;
                return { data: Array.from({ length: Math.min(Number(params.limit), items - first) }, (_, offset) => ({ turnId: params.turnId,
                    item: { id: `item-${first + offset}`, type: 'agentMessage', text: answers.get(`${params.turnId}:item-${first + offset}`) ?? `${params.turnId} readable-${first + offset}` } })), nextCursor: null };
            }
            throw new Error(`Unexpected source operation ${method}`);
        },
    } as unknown as CodexRpc;
    const directory = join(home, 'projection');
    const make = (helper = false) => new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex',
        ...(helper ? { historyMetadata: { command: process.execPath, args: [join(process.cwd(), 'src/remote/codex-metadata-helper.mjs')] } } : {}) }, directory, { rpc, pollMs: 60_000 });
    return { home, db, calls, native, make, answers, sessionId: sourceSessionId({ sourceId: 'source', machineId: 'machine', engine: 'codex', nativeId: 'thread' }),
        dispose: async () => { db.close(); await rm(home, { recursive: true, force: true }); } };
}

test('cold open of a giant native turn reads only its selected tail, then six earlier pages preserve identities', async () => {
    const f = await fixture(10_000), source = f.make();
    try {
        let page = await source.read({ sessionId: f.sessionId, limit: 160 });
        assert.match(JSON.stringify(page.entries), /readable-9999/);
        assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 1);
        assert.ok(Number(f.calls.find(call => call.method === 'thread/items/list')!.params.limit) <= 20, 'the first screen never traverses the giant turn');
        assert.equal(page.hasBefore, true);
        const stable = new Map(page.entries.map(entry => [entry.event.seq, JSON.stringify(entry)]));
        for (let i = 0; i < 6; i++) {
            const before = page.before!;
            page = await source.read({ sessionId: f.sessionId, before, epoch: page.epoch, limit: 160 });
            assert.ok(page.before! < before, 'each second, third and later read obtains older source-native content');
            assert.ok(page.entries.some(entry => entry.event.type === 'assistant/message'));
        }
        const latest = await source.read({ sessionId: f.sessionId, limit: 160 });
        for (const entry of latest.entries) if (stable.has(entry.event.seq)) assert.equal(JSON.stringify(entry), stable.get(entry.event.seq));
        assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
        const bodyReads = f.calls.filter(call => call.method === 'thread/items/list').length;
        await source.dispose();
        const reopened = f.make();
        try {
            assert.match(JSON.stringify((await reopened.read({ sessionId: f.sessionId })).entries), /readable-9999/);
            assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, bodyReads, 'unchanged revision reuses its persisted native projection');
        } finally { await reopened.dispose(); }
    } finally { await source.dispose(); await f.dispose(); }
});

test('cold open never touches unrelated old turns or their malformed bodies', async () => {
    const f = await fixture(2, 1000), source = f.make();
    try {
        const page = await source.read({ sessionId: f.sessionId, limit: 160 });
        assert.match(JSON.stringify(page.entries), /turn-999 readable-1/);
        const bodyReads = f.calls.filter(call => call.method === 'thread/items/list');
        assert.ok(bodyReads.length <= 7, 'source work is bounded by this first metadata page, independently of total turns');
        assert.ok(bodyReads.every(call => Number(String(call.params.turnId).slice(5)) >= 993));
    } finally { await source.dispose(); await f.dispose(); }
});


test('source-side helper reads sparse metadata on its own machine without copying SQLite or bodies', async () => {
    const f = await fixture(1000), source = f.make(true);
    try {
        const page = await source.read({ sessionId: f.sessionId, limit: 160 });
        assert.match(JSON.stringify(page.entries), /readable-999/);
        assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 1);
    } finally { await source.dispose(); await f.dispose(); }
});


for (const compressed of [false, true]) test(`sparse fork cutoffs preserve child positions (compressed=${compressed})`, async () => {
    const f = await fixture(1);
    const parent = '11111111-1111-4111-8111-111111111111', child = '22222222-2222-4222-8222-222222222222';
    try {
        f.db.exec('DELETE FROM thread_items; DELETE FROM thread_turns');
        const insertTurn = (thread: string, id: string, start: number, end: number) => f.db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?)')
            .run(thread, id, 'completed', 1, 2, start, end, null);
        const insertItem = (thread: string, turn: string, id: string, ordinal: number) => f.db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?)')
            .run(thread, turn, id, ordinal, 1000, 1000, 2000, ordinal, 'agentMessage');
        insertTurn(parent, 'inherited-turn', 1, 3); insertItem(parent, 'inherited-turn', 'inherited-answer', 2);
        insertTurn(parent, 'later-parent-turn', 20, 22); insertItem(parent, 'later-parent-turn', 'not-in-the-fork', 21);
        insertTurn(child, 'child-turn', 1, 3); insertItem(child, 'child-turn', 'child-answer', 2);
        const directory = join(f.home, 'sessions', '2026', '11', '04'); await mkdir(directory, { recursive: true });
        const header = JSON.stringify({ type: 'session_meta', ordinal: 0,
            payload: { id: child, forked_from_id: parent, forked_from_ordinal_exclusive: 10 } }) + '\n';
        await writeFile(join(directory, `rollout-2026-${child}.jsonl${compressed ? '.zst' : ''}`), compressed ? zstdCompressSync(header) : header);
        const first = await readNativeMetadata({ home: f.home, threadId: child, limit: 20 });
        assert.deepEqual(first.items.map(item => item.itemId).sort(), ['child-answer', 'inherited-answer']);
        const coordinate = first.items.find(item => item.itemId === 'child-answer')!.ordinal;
        insertTurn(parent, 'much-later-parent-turn', 100, 102); insertItem(parent, 'much-later-parent-turn', 'still-not-in-the-fork', 101);
        const next = await readNativeMetadata({ home: f.home, threadId: child, limit: 20 });
        assert.equal(next.items.find(item => item.itemId === 'child-answer')!.ordinal, coordinate, 'unrelated source appends never renumber accepted child identities');
        assert.equal(next.coordinates, first.coordinates);
    } finally { await f.dispose(); }
});


test('a same-second source revision is validated on Host reentry without relying on coarse thread timestamps', async () => {
    const f = await fixture(1000);
    let source = f.make();
    try {
        const initial = await source.read({ sessionId: f.sessionId });
        const message = initial.entries.find(entry => entry.event.type === 'assistant/message' && entry.event.data.message.id.endsWith(':item-999'))!;
        await source.dispose();
        f.answers.set('turn-0:item-999', 'Same-second genuine source correction');
        f.db.prepare('UPDATE thread_items SET updated_at_ordinal=updated_at_ordinal+10000 WHERE item_id=?').run('item-999');
        f.calls.length = 0;
        source = f.make();
        const corrected = await source.read({ sessionId: f.sessionId });
        assert.match(JSON.stringify(corrected.entries), /Same-second genuine source correction/);
        assert.ok(corrected.entries.some(entry => entry.event.seq === message.event.seq), 'accepted source identity survives the revision');
        assert.equal(f.native.updatedAt, 2, 'the coarse catalog timestamp deliberately did not change');
        assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 1);
    } finally { await source.dispose(); await f.dispose(); }
});


for (const keepReader of [true, false]) test(`cold preparation ${keepReader ? 'preserves another reader' : 'cancels source body IO when every reader leaves'} and retries independently`, async () => {
    const entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>();
    let first = true;
    const f = await fixture(1000, 1, async signal => {
        if (!first) return;
        first = false; entered.resolve(signal);
        await new Promise<void>((resolve, reject) => {
            const abort = () => { reject(signal.reason); };
            signal.addEventListener('abort', abort, { once: true });
            void release.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
            if (signal.aborted) abort();
        });
    });
    const source = f.make(), left = new AbortController(), right = new AbortController();
    const session = { sessionId: f.sessionId, limit: 160 };
    try {
        // Resolve first so both readers join exactly the same owner and preparation.
        await source.resolve(f.sessionId);
        const firstRead = source.read(session, left.signal);
        const firstFailure = assert.rejects(firstRead, error => error === left.signal.reason);
        const nativeSignal = await entered.promise;
        const secondRead = source.read(session, right.signal);
        const secondFailure = keepReader ? undefined : assert.rejects(secondRead, error => error === right.signal.reason);
        await new Promise(resolve => setImmediate(resolve));
        left.abort(new DOMException('First Pane left', 'AbortError'));
        await firstFailure;
        assert.equal(nativeSignal.aborted, false, 'one remaining reader retains shared native preparation');
        if (keepReader) {
            release.resolve();
            const page = await secondRead;
            assert.match(JSON.stringify(page.entries), /readable-999/);
            assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 1);
        } else {
            right.abort(new DOMException('Last Pane left', 'AbortError'));
            await secondFailure;
            assert.equal(nativeSignal.aborted, true, 'the final waiter cancellation reaches the actual native body RPC');
            assert.equal((await source.resolve(f.sessionId)).connection?.state, 'online', 'intentional cancellation must not mark source availability offline');
            const page = await source.read(session);
            assert.match(JSON.stringify(page.entries), /readable-999/);
            assert.notEqual(page.session.connection?.state, 'offline', 'intentional cancellation must not mark the source offline');
            assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 2, 'a new reader gets a fresh preparation, without inherited cancellation/backoff');
        }
    } finally { release.resolve(); await source.dispose(); await f.dispose(); }
});
