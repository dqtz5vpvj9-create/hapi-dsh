/** Official rollout headers + sparse SQLite; only native item RPC is isolated. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { readNativeMetadata } from '../src/remote/codex-metadata-core.mjs';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc, NativeNotification } from '../src/remote/codex-rpc.ts';
import { sourceSessionId } from '../src/remote/protocol.ts';
import { createSessionSourceExporter } from '../src/client/source-export-state.ts';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';

const parent = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const execution = '33333333-3333-4333-8333-333333333333';
async function fixture(compressed = false) {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-native-revert-');
    const db = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
    db.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER,rollout_end_ordinal INTEGER,error_json TEXT);
        CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,updated_at_ordinal INTEGER,item_type TEXT);
        CREATE INDEX item_order ON thread_items(thread_id,rollout_ordinal);
        CREATE INDEX turn_order ON thread_turns(thread_id,rollout_end_ordinal); BEGIN`);
    for (let turn = 0; turn < 12; turn++) {
        const start = turn * 6 + 1;
        db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?)').run(parent, `turn-${turn}`, 'completed', turn + 1, turn + 2, start, start + 5, null);
        for (let item = 0; item < 4; item++) db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?)')
            .run(parent, `turn-${turn}`, `item-${turn}-${item}`, start + item + 1, 1000, 1000, 2000, start + item + 1, item === 1 ? 'commandExecution' : 'agentMessage');
    }
    db.exec('COMMIT');
    const directory = join(home, 'sessions', '2026', '11', '08'); await mkdir(directory, { recursive: true });
    const header = async (time: string, suffix: string, cutoff: number) => {
        const data = JSON.stringify({ type: 'session_meta', ordinal: cutoff,
            payload: { id: child, forked_from_id: parent, forked_from_ordinal_exclusive: cutoff } }) + '\n';
        await writeFile(join(directory, `rollout-2026-11-08T${time}-${child}${suffix}.jsonl${compressed ? '.zst' : ''}`), compressed ? zstdCompressSync(data) : data);
    };
    await header('05-46-34', '', 73);
    let retained = 12, notify = (_frame: NativeNotification) => {};
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const native = { id: child, cwd: home, createdAt: 1, updatedAt: 2, status: { type: 'idle' } };
    const rpc = { online: true, currentGeneration: 1, connect: async () => ({ codexHome: home }), dispose: async () => {},
        onNotification: (listener: typeof notify) => { notify = listener; return () => {}; }, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            if (method === 'thread/read') return { thread: native };
            if (method !== 'thread/items/list') throw Error('A bounded exact-source read must not enumerate turns/catalog or start execution');
            const turn = Number(String(params.turnId).slice(5));
            if (!Number.isInteger(turn) || turn >= retained) throw Error('cursor.itemId does not identify an item in the requested history scope');
            const cursor = params.cursor as { itemId: string } | undefined;
            const start = cursor ? Number(cursor.itemId.split('-')[2]) + 1 : 0;
            return { data: Array.from({ length: Math.min(Number(params.limit), 4 - start) }, (_, offset) => {
                const item = start + offset;
                return { turnId: params.turnId, item: item === 1
                    ? { id: `item-${turn}-${item}`, type: 'commandExecution', command: 'printf retained', cwd: home, status: 'completed', aggregatedOutput: 'retained tool output', exitCode: 0 }
                    : { id: `item-${turn}-${item}`, type: 'agentMessage', text: `retained-${turn}-${item}` } };
            }), nextCursor: null };
        } } as unknown as CodexRpc;
    const source = new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex' }, join(home, 'projection'), { rpc, pollMs: 60_000 });
    const sessionId = sourceSessionId({ sourceId: 'source', machineId: 'machine', engine: 'codex', nativeId: child });
    return { home, calls, source, sessionId,
        revert: async () => { await header('06-20-01', '_' + execution, 49); retained = 8; notify({ method: 'thread/reverted', params: { threadId: child } }); },
        dispose: async () => { await source.dispose(); db.close(); await rm(home, { recursive: true, force: true }); } };
}

for (const compressed of [false, true]) test(`revert replacement header narrows inherited native history (compressed=${compressed})`, async () => {
    const f = await fixture(compressed);
    try {
        await f.revert();
        const latest = await readNativeMetadata({ home: f.home, threadId: child, limit: 20 });
        assert.ok(latest.items.some(item => item.turnId === 'turn-7'));
        assert.ok(latest.items.every(item => Number(item.turnId.slice(5)) < 8), 'the original fork cutoff must not resurrect its parent suffix');
        assert.equal(latest.hasBefore, true, 'the retained branch still spans real sparse pages');
        const removed = await readNativeMetadata({ home: f.home, threadId: child, position: { turnId: 'turn-9', itemId: 'item-9-3' }, limit: 1 });
        assert.equal(removed.positionMissing, true);
        const kept = await readNativeMetadata({ home: f.home, threadId: child, position: { turnId: 'turn-0', itemId: 'item-0-1' }, limit: 1 });
        assert.equal(kept.positionMissing, false);
        assert.equal(kept.items[0]?.itemId, 'item-0-1');
    } finally { await f.dispose(); }
});

test('warm fork revert reopens latest and exact native anchors, exports only the retained rich branch', async () => {
    const f = await fixture();
    try {
        const old = await f.source.read({ sessionId: f.sessionId, limit: 160 });
        assert.match(JSON.stringify(old.entries), /retained-11-3/);
        await f.revert();
        const latest = await f.source.read({ sessionId: f.sessionId, limit: 160 });
        assert.notEqual(latest.epoch, old.epoch, 'an actual rewrite revokes prior cursors');
        assert.match(JSON.stringify(latest.entries), /retained-7-3/);
        assert.doesNotMatch(JSON.stringify(latest.entries), /retained-(?:8|9|10|11)-/);
        await assert.rejects(f.source.read({ sessionId: f.sessionId, epoch: old.epoch, before: old.before!, limit: 160 }), { code: 'STALE_VERSION' });
        const anchor = await f.source.locatePosition(f.sessionId, { turnId: 'turn-0', itemId: 'item-0-1' });
        const around = await f.source.read({ sessionId: f.sessionId, epoch: anchor.epoch, around: anchor.seq, limit: 32 });
        assert.ok(around.entries.some(entry => entry.event.seq === anchor.seq && entry.event.type === 'assistant/message'));
        await assert.rejects(f.source.locatePosition(f.sessionId, { turnId: 'turn-9', itemId: 'item-9-3' }), { code: 'TARGET_UNAVAILABLE' });
        const route = { kind: 'hhpi' as const, hostId: 'original-host', sessionId: f.sessionId, identity: { machineId: 'machine', sourceId: 'source', engine: 'codex' as const, nativeId: child } };
        const exporter = createSessionSourceExporter({ list: { getSnapshot: () => ({ byId: {} }) } } as unknown as Pick<ISessions, 'list'>,
            route.hostId, () => true, undefined, { read: async (request, signal) => ({ ok: true as const, value: await f.source.read(request, signal) }) });
        const result = await exporter.sourceExport({ source: route, format: 'json' }, new AbortController().signal);
        assert.equal(result.type, 'ready'); if (result.type !== 'ready') return;
        const value = JSON.parse(await result.blob.text());
        assert.deepEqual(value.source, route);
        const ids = value.events.filter((event: { type: string }) => event.type === 'assistant/message').map((event: { data: { message: { id: string } } }) => event.data.message.id);
        assert.equal(ids.length, 32, 'all four native items in each of the eight retained turns export once');
        assert.ok(value.events.some((event: { type: string }) => event.type === 'tool/result'));
        assert.doesNotMatch(JSON.stringify(value.events), /retained-(?:8|9|10|11)-/);
        assert.ok(f.calls.filter(call => call.method === 'thread/items/list').every(call => Number(call.params.limit) <= 20), 'every read remains bounded to selected native items');
    } finally { await f.dispose(); }
});
