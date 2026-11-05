/** Persistent sparse projection reuse against real source-native metadata.
 * Native item bodies and connection are RPC fixtures; no catalog/full-log path is allowed. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc } from '../src/remote/codex-rpc.ts';
import { CODEX_HISTORY_PROJECTION_VERSION } from '../src/remote/codex-history.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts';

const source = { sourceId: 'native', machineId: 'same-machine', engine: 'codex', nativeId: 'existing-thread' } as const;
const sourceId = sourceSessionId(source);
const checkpointKey = 'native-history-checkpoint:v1';

async function fixture(turns = 200, active = false) {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-history-checkpoint-');
    const db = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
    db.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER,rollout_end_ordinal INTEGER,error_json TEXT);
        CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,updated_at_ordinal INTEGER,item_type TEXT);
        CREATE INDEX item_order ON thread_items(thread_id,rollout_ordinal); CREATE INDEX turn_order ON thread_turns(thread_id,rollout_end_ordinal); BEGIN`);
    for (let i = 0; i < turns; i++) {
        const start = i * 4 + 1, status = active && i === turns - 1 ? 'inProgress' : 'completed';
        db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?)').run(source.nativeId, `turn-${i}`, status, i + 1,
            status === 'inProgress' ? null : i + 2, start, status === 'inProgress' ? null : start + 3, null);
        for (let item = 0; item < 2; item++) db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?)')
            .run(source.nativeId, `turn-${i}`, `item-${item}`, start + item + 1, 1000, 1000, 2000, start + item + 1, 'agentMessage');
    }
    db.exec('COMMIT');
    const native = { id: source.nativeId, cwd: home, createdAt: 1, updatedAt: 2, status: { type: active ? 'active' : 'idle' } };
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const answers = new Map<string, string>();
    let rejectedTurn: string | undefined;
    const make = () => {
        const rpc = { online: true, currentGeneration: 1, connect: async () => ({ codexHome: home }), dispose: async () => {},
            onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {},
            request: async (method: string, params: Record<string, unknown>) => {
                calls.push({ method, params });
                if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread: native }; }
                if (method === 'thread/loaded/list' || method === 'thread/list' || method === 'thread/turns/list')
                    throw new Error('An exact saved source must not scan a catalog or all turn headers');
                if (method !== 'thread/items/list') throw new Error(`Unexpected native operation: ${method}`);
                const turn = String(params.turnId);
                if (turn === rejectedTurn) throw new Error('Synthetic selected body unavailable');
                const cursor = params.cursor as { itemId: string } | undefined;
                const first = cursor ? Number(cursor.itemId.slice(5)) + 1 : 0;
                return { data: Array.from({ length: Math.min(Number(params.limit), 2 - first) }, (_, offset) => ({ turnId: turn,
                    item: { id: `item-${first + offset}`, type: 'agentMessage', text: answers.get(turn) ?? `Answer ${turn} item-${first + offset}` } })), nextCursor: null };
            },
        } as unknown as CodexRpc;
        return new DirectCodexAdapter({ id: source.sourceId, machineId: source.machineId, engine: source.engine }, join(home, 'projection'), { rpc, pollMs: 60_000 });
    };
    return { home, db, native, calls, make, answers, bodyCalls: () => calls.filter(call => call.method === 'thread/items/list'),
        rejectTurn: (turn: string | undefined) => { rejectedTurn = turn; },
        dispose: async () => { db.close(); await rm(home, { recursive: true, force: true }); } };
}
const read = (adapter: DirectCodexAdapter) => adapter.read({ sessionId: sourceId, limit: 160 });
const databasePath = (home: string, version = CODEX_HISTORY_PROJECTION_VERSION) =>
    join(home, 'projection', 'history', `${createHash('sha256').update(sourceId).digest('hex')}.v${version}.sqlite`);

for (const active of [false, true]) {
    test(`an unchanged ${active ? 'active' : 'idle'} native source reopens its persisted first page without source body reads`, async () => {
        const f = await fixture(200, active);
        let adapter = f.make();
        try {
            const initial = await read(adapter);
            assert.match(JSON.stringify(initial.entries), /Answer turn-199/);
            assert.equal(initial.hasBefore, true);
            assert.ok(f.bodyCalls().length <= 7, 'cold work is bounded by the selected tail instead of all 200 turns');
            await adapter.dispose();
            f.calls.length = 0;
            adapter = f.make();
            const reopened = await read(adapter);
            assert.deepEqual(reopened.entries, initial.entries);
            assert.equal(f.bodyCalls().length, 0, 'Host reentry must reuse the accepted source revision');
            assert.ok(f.calls.every(call => call.method === 'thread/read'));
        } finally { await adapter.dispose(); await f.dispose(); }
    });
}

test('changed native metadata revises only the selected changed turn while preserving source sequence identities', async () => {
    const f = await fixture();
    let adapter = f.make();
    try {
        const initial = await read(adapter);
        await adapter.dispose();
        f.native.updatedAt++;
        f.answers.set('turn-199', 'Revised latest answer');
        f.db.prepare('UPDATE thread_items SET updated_at_ordinal = updated_at_ordinal + 10000 WHERE thread_id = ? AND turn_id = ?')
            .run(source.nativeId, 'turn-199');
        f.calls.length = 0;
        adapter = f.make();
        const revised = await read(adapter);
        assert.match(JSON.stringify(revised.entries), /Revised latest answer/);
        assert.equal(f.bodyCalls().length, 1);
        assert.equal(f.bodyCalls()[0]!.params.turnId, 'turn-199', 'unchanged source turn bodies are not reread');
        assert.deepEqual(revised.entries.map(entry => [entry.key, entry.event.seq]), initial.entries.map(entry => [entry.key, entry.event.seq]));
    } finally { await adapter.dispose(); await f.dispose(); }
});

test('an interrupted first-page build is retried without claiming a complete checkpoint or traversing the archive', async () => {
    const f = await fixture();
    let adapter = f.make();
    try {
        f.rejectTurn('turn-199');
        await assert.rejects(read(adapter), /Synthetic selected body unavailable/);
        await adapter.dispose();
        f.rejectTurn(undefined);
        f.calls.length = 0;
        adapter = f.make();
        const page = await read(adapter);
        assert.match(JSON.stringify(page.entries), /Answer turn-199/);
        assert.ok(f.bodyCalls().length > 0 && f.bodyCalls().length <= 7);
        assert.ok(f.bodyCalls().every(call => Number(String(call.params.turnId).slice(5)) >= 193));
        await adapter.dispose();
        f.calls.length = 0;
        adapter = f.make();
        assert.deepEqual((await read(adapter)).entries, page.entries);
        assert.equal(f.bodyCalls().length, 0, 'a successful bounded retry is durably reusable');
    } finally { await adapter.dispose(); await f.dispose(); }
});

test('pre-native-order display databases remain untouched and cannot force a full-history migration before first paint', async () => {
    const f = await fixture();
    let adapter = f.make();
    try {
        const session: SourceSession = { ...source, id: sourceId, title: 'Legacy cache', cwd: f.home, updatedAt: 2000, status: 'idle', activeTurnId: null,
            capabilities: { send: false, steer: false, cancel: false, approve: false, files: false }, pendingRequests: [] };
        const path = databasePath(f.home, 2), previous = new SourceEventIndex(path, session);
        previous.edit(session, () => { previous.cache('legacy-source', 'Old accepted cache remains recoverable'); previous.cache(checkpointKey, { state: 'complete' }); });
        previous.dispose();
        const bytes = await readFile(path);
        const page = await read(adapter);
        assert.match(JSON.stringify(page.entries), /Answer turn-199/);
        assert.ok(f.bodyCalls().length <= 7, 'native source tail replaces loading-order projection without replaying the archive');
        assert.deepEqual(await readFile(path), bytes, 'upgrading the read projection cannot mutate the previous version');
        await adapter.dispose();
        f.calls.length = 0;
        adapter = f.make();
        assert.deepEqual((await read(adapter)).entries, page.entries);
        assert.equal(f.bodyCalls().length, 0);
    } finally { await adapter.dispose(); await f.dispose(); }
});
