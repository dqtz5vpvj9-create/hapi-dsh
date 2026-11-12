/** Real native-format SQLite/rollout headers; no app-server execution or model. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { NativeHistorySearch } from '../src/remote/codex-search-core.mjs';
import { NativeMetadataReader } from '../src/remote/codex-metadata.ts';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc } from '../src/remote/codex-rpc.ts';

const first = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const execution = '33333333-3333-4333-8333-333333333333';
async function fixture() {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-source-search-');
    const state = new DatabaseSync(join(home, 'state_5.sqlite'));
    state.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,source TEXT,history_mode TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,recency_at INTEGER)`);
    const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
    history.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER,rollout_end_ordinal INTEGER,error_json TEXT);
        CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,updated_at_ordinal INTEGER,item_type TEXT,item_json TEXT);
        CREATE UNIQUE INDEX item_identity ON thread_items(thread_id,turn_id,item_id);
        CREATE INDEX item_order ON thread_items(thread_id,rollout_ordinal);
        CREATE INDEX turn_order ON thread_turns(thread_id,rollout_end_ordinal);
        CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY,next_rollout_byte_offset INTEGER,next_rollout_ordinal INTEGER)`);
    const header = async (id: string, options: { archived?: boolean; parent?: string; cutoff?: number; suffix?: string; compressed?: boolean } = {}) => {
        const directory = options.archived ? join(home, 'archived_sessions') : join(home, 'sessions', '2026', '11', '09');
        await mkdir(directory, { recursive: true });
        const path = join(directory, `rollout-2026-11-09T${options.suffix ? '02' : '01'}-00-00-${id}${options.suffix ? '_' + options.suffix : ''}.jsonl${options.compressed ? '.zst' : ''}`);
        const text = JSON.stringify({ type: 'session_meta', ordinal: options.cutoff ?? 0, payload: { id,
            ...(options.parent ? { forked_from_id: options.parent, forked_from_ordinal_exclusive: options.cutoff } : {}) } }) + '\n';
        await writeFile(path, options.compressed ? zstdCompressSync(text) : text);
        history.prepare('INSERT OR REPLACE INTO thread_history_projection_state VALUES(?,?,?)').run(options.suffix ?? id, Buffer.byteLength(text), (options.cutoff ?? 0) + 1);
        state.prepare('INSERT OR REPLACE INTO threads VALUES(?,?,?,?,?,?,?,?)').run(id, path, 'cli', 'paginated', Number(options.archived ?? false), 1, 1, 1);
        return path;
    };
    const item = (threadId: string, ordinal: number, type: string, text: string) => {
        if (!history.prepare('SELECT 1 FROM thread_turns WHERE thread_id=?').get(threadId)) history.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?,?)').run(threadId, 'turn', 'completed', 1, 2, 0, 10_000, null);
        const body = { id: `item-${ordinal}`, type, ...(type === 'userMessage' ? { content: [{ type: 'text', text }] } : { text }) };
        history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?,?)').run(threadId, 'turn', body.id, ordinal, 1000, 1000, 2000, ordinal, type, JSON.stringify(body));
    };
    return { home, state, history, header, item, async dispose() { state.close(); history.close(); await rm(home, { recursive: true, force: true }); } };
}
const request = (home: string, searchTerm: string, cursor: string | null = null, archived = false) => ({ home, params: { searchTerm, cursor, archived, limit: 50, sourceKinds: ['cli'] } });
async function finish(reader: NativeHistorySearch, input: ReturnType<typeof request>) {
    const data: Array<{ threadId: string; snippet: string }> = [], pages = [];
    do { const page = await reader.search(input); pages.push(page); data.push(...page.data); input.params.cursor = page.nextCursor; } while (input.params.cursor);
    return { data, pages };
}

test('source search continues empty bounded batches and finds real message/code text rather than title/tool JSON', async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 2, bytes: 512 });
    try {
        await f.header(first);
        for (let n = 1; n <= 8; n++) f.item(first, n, 'agentMessage', n === 1 ? 'Code sample:\n```ts\nconst needle = 1;\n```' : 'another response');
        const result = await finish(reader, request(f.home, 'needle'));
        assert.equal(result.pages[0]!.data.length, 0); assert.ok(result.pages[0]!.nextCursor);
        assert.equal(result.data.length, 1); assert.equal(result.data[0]!.threadId, first); assert.match(result.data[0]!.snippet, /const needle = 1/);
        f.item(first, 9, 'commandExecution', 'only-in-tool'); f.item(first, 10, 'reasoning', 'only-in-reasoning');
        assert.equal((await finish(reader, request(f.home, 'only-in-tool'))).data.length, 0);
        assert.equal((await finish(reader, request(f.home, 'only-in-reasoning'))).data.length, 0);
    } finally { reader.dispose(); await f.dispose(); }
});

test('source cursors bind query/archive/database identity, do not move on duplicates and reject rewritten lineages', async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 1 });
    try {
        await f.header(first); f.item(first, 1, 'agentMessage', 'wanted'); f.item(first, 2, 'agentMessage', 'other'); f.item(first, 3, 'agentMessage', 'other');
        const page = await reader.search(request(f.home, 'wanted')); assert.ok(page.nextCursor);
        await assert.rejects(reader.search(request(f.home, 'different', page.nextCursor)), { code: 'INVALID_REQUEST' });
        await assert.rejects(reader.search(request(f.home, 'wanted', page.nextCursor, true)), { code: 'INVALID_REQUEST' });
        const next = await reader.search(request(f.home, 'wanted', page.nextCursor));
        assert.deepEqual(await reader.search(request(f.home, 'wanted', page.nextCursor)), next, 'one read continuation cannot skip a page when its reply is lost');
        assert.ok(next.nextCursor);
        await f.header(first, { suffix: execution, cutoff: 1 });
        await assert.rejects(reader.search(request(f.home, 'wanted', next.nextCursor)), { code: 'STALE_VERSION' });
    } finally { reader.dispose(); await f.dispose(); }
});

for (const compressed of [false, true]) test(`archived forks search the inherited retained range and exclude the rewound suffix (zstd=${compressed})`, async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 1 });
    try {
        await f.header(first); f.item(first, 2, 'agentMessage', 'retained needle'); f.item(first, 10, 'agentMessage', 'removed secret');
        await f.header(child, { archived: true, parent: first, cutoff: 6, compressed });
        assert.deepEqual((await finish(reader, request(f.home, 'needle', null, true))).data.map(x => x.threadId), [child]);
        assert.deepEqual((await finish(reader, request(f.home, 'secret', null, true))).data, []);
        await f.header(child, { archived: true, parent: first, cutoff: 1, suffix: execution, compressed });
        assert.deepEqual((await finish(reader, request(f.home, 'needle', null, true))).data, []);
    } finally { reader.dispose(); await f.dispose(); }
});

test('cancelled source-local scan retires only its continuation and a new query remains usable', async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 1000 });
    try {
        await f.header(first); for (let n = 1; n <= 200; n++) f.item(first, n, 'agentMessage', 'no match');
        const abort = new AbortController(), work = reader.search(request(f.home, 'absent'), abort.signal);
        setImmediate(() => abort.abort(new Error('caller cancelled')));
        await assert.rejects(work, /caller cancelled/);
        assert.equal((await finish(reader, request(f.home, 'match'))).data.length, 1);
    } finally { reader.dispose(); await f.dispose(); }
});

test('ordinary append preserves a current continuation while a database generation change invalidates it', async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 1 });
    try {
        await f.header(first); for (let n = 1; n <= 3; n++) f.item(first, n, 'agentMessage', 'older response');
        const page = await reader.search(request(f.home, 'future')); assert.ok(page.nextCursor);
        f.item(first, 4, 'agentMessage', 'future response');
        const continued = await finish(reader, request(f.home, 'future', page.nextCursor));
        assert.deepEqual(continued.data, [], 'the already-scanned tail is not rescanned or advanced on ordinary append');
        assert.equal((await finish(reader, request(f.home, 'future'))).data.length, 1, 'a fresh explicit search sees the append');
        const next = await reader.search(request(f.home, 'absent')); assert.ok(next.nextCursor);
        f.history.exec('CREATE TABLE changed_native_schema(version INTEGER)');
        await assert.rejects(reader.search(request(f.home, 'absent', next.nextCursor)), { code: 'STALE_VERSION' });
    } finally { reader.dispose(); await f.dispose(); }
});

test('oversized visible messages fail explicitly rather than returning a false full-source empty result', async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ bytes: 100 });
    try {
        await f.header(first); f.item(first, 1, 'agentMessage', 'large '.repeat(100));
        await assert.rejects(reader.search(request(f.home, 'absent')), { code: 'HISTORY_UNAVAILABLE' });
    } finally { reader.dispose(); await f.dispose(); }
});

test('an unprojected native generation is searched from bounded canonical history instead of being silently omitted', async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 1 });
    try {
        const path = await f.header(first);
        await appendFile(path, JSON.stringify({ ordinal: 1, type: 'event_msg', payload: { type: 'user_message', message: 'visible needle' } }) + '\n');
        f.history.exec('DELETE FROM thread_history_projection_state');
        assert.equal((await finish(reader, request(f.home, 'needle'))).data[0]!.threadId, first);
    } finally { reader.dispose(); await f.dispose(); }
});

test('a behind projection searches the durable append, and a later fresh query sees subsequent appends', async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 1, bytes: 512 });
    try {
        const path = await f.header(first); f.item(first, 1, 'agentMessage', 'old indexed words');
        await appendFile(path, JSON.stringify({ ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'new code `needle()`' }] } }) + '\n');
        assert.equal((await finish(reader, request(f.home, 'needle'))).data.length, 1);
        await appendFile(path, JSON.stringify({ ordinal: 3, type: 'event_msg', payload: { type: 'agent_message', message: 'future append' } }) + '\n');
        assert.equal((await finish(reader, request(f.home, 'future'))).data.length, 1);
        await appendFile(path, '{"incomplete":');
        await assert.rejects(finish(reader, request(f.home, 'absent')), { code: 'HISTORY_UNAVAILABLE' });
    } finally { reader.dispose(); await f.dispose(); }
});

for (const compressed of [false, true]) test(`readable legacy history remains searchable without a projection (zstd=${compressed})`, async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 1, bytes: 512 });
    try {
        const path = await f.header(first, { compressed });
        const text = JSON.stringify({ type: 'session_meta', payload: { id: first } }) + '\n'
            + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'legacy needle' }] } }) + '\n';
        await writeFile(path, compressed ? zstdCompressSync(text) : text);
        f.state.prepare("UPDATE threads SET history_mode='legacy'").run();
        f.history.exec('DELETE FROM thread_history_projection_state');
        assert.equal((await finish(reader, request(f.home, 'needle'))).data[0]!.threadId, first);
    } finally { reader.dispose(); await f.dispose(); }
});

test('unindexed inherited rollouts retain the native fork cutoff and work without a history database', async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 1 });
    try {
        const path = await f.header(first);
        await appendFile(path, [
            { ordinal: 2, type: 'event_msg', payload: { type: 'agent_message', message: 'retained needle' } },
            { ordinal: 10, type: 'event_msg', payload: { type: 'agent_message', message: 'removed suffix' } },
        ].map(v => JSON.stringify(v) + '\n').join(''));
        await f.header(child, { archived: true, parent: first, cutoff: 6 });
        await rename(join(f.home, 'thread_history_1.sqlite'), join(f.home, 'unused-test-history.sqlite'));
        assert.deepEqual((await finish(reader, request(f.home, 'needle', null, true))).data.map(v => v.threadId), [child]);
        assert.deepEqual((await finish(reader, request(f.home, 'removed', null, true))).data, []);
    } finally { reader.dispose(); await f.dispose(); }
});

test('metadata setup cannot starve a bounded search batch and old blank item_type rows remain searchable', async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 1, ms: 0 });
    try {
        await f.header(first); f.item(first, 1, 'agentMessage', 'old type needle');
        f.history.exec("UPDATE thread_items SET item_type=''");
        assert.equal((await finish(reader, request(f.home, 'needle'))).data.length, 1);
    } finally { reader.dispose(); await f.dispose(); }
});

test('an ahead or rewritten projection cannot contribute removed messages to canonical fallback results', async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 1 });
    try {
        const path = await f.header(first); f.item(first, 1, 'agentMessage', 'removed indexed words');
        await appendFile(path, JSON.stringify({ ordinal: 1, type: 'event_msg', payload: { type: 'agent_message', message: 'canonical needle' } }) + '\n');
        f.history.exec('UPDATE thread_history_projection_state SET next_rollout_byte_offset=999999');
        assert.equal((await finish(reader, request(f.home, 'needle'))).data.length, 1);
        assert.deepEqual((await finish(reader, request(f.home, 'removed'))).data, []);
        const page = await reader.search(request(f.home, 'absent')); assert.ok(page.nextCursor);
        await writeFile(path, '');
        await assert.rejects(reader.search(request(f.home, 'absent', page.nextCursor)), { code: 'STALE_VERSION' });
    } finally { reader.dispose(); await f.dispose(); }
});

test('canonical fallback includes completed visible message items and cancellation releases its source scan', async () => {
    const f = await fixture(), reader = new NativeHistorySearch({ items: 1 });
    try {
        const path = await f.header(first);
        await appendFile(path, Array.from({ length: 100 }, (_, n) => JSON.stringify({ ordinal: n + 1, type: 'event_msg', payload: {
            type: 'item_completed', item: { type: 'agentMessage', text: n === 99 ? 'completed needle' : 'earlier text' },
        } }) + '\n').join(''));
        assert.equal((await finish(reader, request(f.home, 'needle'))).data.length, 1);
        const abort = new AbortController(), work = reader.search(request(f.home, 'absent'), abort.signal);
        setImmediate(() => abort.abort(new Error('canonical caller cancelled')));
        await assert.rejects(work, /canonical caller cancelled/);
        assert.equal((await finish(reader, request(f.home, 'needle'))).data.length, 1);
    } finally { reader.dispose(); await f.dispose(); }
});

test('the existing source helper serves native history search and sparse metadata on the same read-only channel', async () => {
    const f = await fixture(), reader = new NativeMetadataReader({ id: 'source', machineId: 'machine', engine: 'codex',
        historyMetadata: { command: process.execPath, args: [join(process.cwd(), 'src/remote/codex-metadata-helper.mjs')] } });
    try {
        await f.header(first); f.item(first, 1, 'userMessage', 'source helper needle');
        assert.equal((await reader.search(request(f.home, 'needle'), new AbortController().signal)).data[0]!.threadId, first);
        assert.equal((await reader.read({ home: f.home, threadId: first, position: { turnId: 'turn', itemId: 'item-1' }, limit: 1 }, new AbortController().signal)).items[0]!.itemId, 'item-1');
    } finally { await reader.dispose(); await f.dispose(); }
});

test('native carrier keeps source authorization and enriches indexed matches without invoking the unbounded native thread/search', async () => {
    const f = await fixture(), calls: string[] = [];
    const rpc = { online: true, currentGeneration: 1, connect: async () => ({ codexHome: f.home }), dispose: async () => {},
        onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>) => {
            calls.push(method); assert.equal(method, 'thread/read'); assert.equal(params.includeTurns, false);
            return { thread: { id: params.threadId, cwd: f.home, createdAt: 1, updatedAt: 1, status: { type: 'idle' } } };
        } } as unknown as CodexRpc;
    const adapter = new DirectCodexAdapter({ id: 'source', machineId: 'machine', engine: 'codex' }, join(f.home, 'adapter'), { rpc, pollMs: 60_000, localImageFiles: true });
    try {
        await f.header(first); f.item(first, 1, 'userMessage', 'source identity needle');
        await assert.rejects(adapter.nativeAccess.call({ sourceId: 'other', method: 'thread/search', params: request(f.home, 'needle').params }), { code: 'INVALID_REQUEST' });
        const result = await adapter.nativeAccess.call({ sourceId: 'source', method: 'thread/search', params: request(f.home, 'needle').params });
        assert.equal(result.status, 'accepted'); assert.deepEqual(calls, ['thread/read']);
        assert.equal((result.result as { data: Array<{ thread: { id: string } }> }).data[0]!.thread.id, first);
    } finally { await adapter.dispose(); await f.dispose(); }
});
