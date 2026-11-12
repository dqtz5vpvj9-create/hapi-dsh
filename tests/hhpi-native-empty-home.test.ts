/** Real SQLite/helper and production adapter; RPC fixtures model the observed
 * 0.162 unmaterialized-thread error, never execute a turn or read user homes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import { CodexRpc, CodexRpcError, type NativeNotification } from '../src/remote/codex-rpc.ts';
import { sourceSessionId, type DirectCodexConfig } from '../src/remote/protocol.ts';

function materializeIndex(home: string): void {
    const db = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
    try {
        db.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER,rollout_end_ordinal INTEGER,error_json TEXT);
            CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,updated_at_ordinal INTEGER,item_type TEXT);
            INSERT INTO thread_turns VALUES('thread','turn','completed',1,2,1,3,NULL);
            INSERT INTO thread_items VALUES('thread','turn','answer',2,1000,1000,2000,2,'agentMessage');`);
    } finally { db.close(); }
}

async function fixture(helper = false) {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-empty-home-');
    const config: DirectCodexConfig = { id: 'source', machineId: 'fixture', engine: 'codex',
        ...(helper ? { historyMetadata: { command: process.execPath, args: [join(process.cwd(), 'src/remote/codex-metadata-helper.mjs')] } } : {}) };
    const calls: Array<{ method: string; params: Record<string, unknown>; write: boolean }> = [];
    const behavior = { confirm: (): unknown => { throw new CodexRpcError(-32600,
        'thread thread is not materialized yet; thread/turns/list is unavailable before first user message'); } };
    let notification: ((frame: NativeNotification) => void) | undefined;
    const rpc = { online: true, currentGeneration: 1, connect: async () => ({ codexHome: home }), dispose: async () => {},
        onNotification: (listener: (frame: NativeNotification) => void) => { notification = listener; return () => { notification = undefined; }; },
        onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>, options?: { write?: boolean }) => {
            calls.push({ method, params, write: options?.write === true });
            if (method === 'thread/read') return { thread: { id: 'thread', cwd: home, createdAt: 1, updatedAt: 1,
                historyMode: 'paginated', ephemeral: false, status: { type: 'idle' }, turns: [] } };
            if (method === 'thread/turns/list') return behavior.confirm();
            if (method === 'thread/items/list') return { data: [{ turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: 'Actual indexed answer' } }], nextCursor: null };
            throw new Error(`Unexpected native operation: ${method}`);
        },
    } as unknown as CodexRpc;
    const source = new DirectCodexAdapter(config, join(home, 'projection'), { rpc, pollMs: 60_000 });
    const request = { sessionId: sourceSessionId({ sourceId: config.id, machineId: config.machineId, engine: 'codex', nativeId: 'thread' }), limit: 160 };
    return { home, source, request, calls, behavior,
        notify: (frame: NativeNotification) => { notification?.(frame); },
        dispose: async () => { await source.dispose(); await rm(home, { recursive: true, force: true }); } };
}

for (const helper of [false, true]) test(`fresh-home first read accepts only the native unmaterialized thread (${helper ? 'source helper' : 'local'})`, async () => {
    const f = await fixture(helper);
    try {
        const page = await f.source.read(f.request);
        assert.deepEqual(page.entries, []);
        assert.equal(page.hasBefore, false); assert.equal(page.hasAfter, false);
        assert.equal(page.session.id, f.request.sessionId);
        assert.equal(existsSync(join(f.home, 'thread_history_1.sqlite')), false, 'a read never creates the native database');
        assert.deepEqual(f.calls.filter(call => call.method === 'thread/turns/list').map(call => call.params), [{ threadId: 'thread', limit: 1 }]);
        assert.equal(f.calls.some(call => call.write), false, 'opening never starts/resumes a turn');

        materializeIndex(f.home);
        f.notify({ method: 'thread/status/changed', params: { threadId: 'thread', status: { type: 'idle' } } });
        const populated = await f.source.read(f.request);
        assert.match(JSON.stringify(populated.entries), /Actual indexed answer/);
        assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 1, 'later reads use the real index without an empty-thread cache');
    } finally { await f.dispose(); }
});

test('a turn materializing during empty confirmation is read from its real index', async () => {
    const f = await fixture();
    try {
        const confirm = f.behavior.confirm;
        f.behavior.confirm = () => { materializeIndex(f.home); return confirm(); };
        assert.match(JSON.stringify((await f.source.read(f.request)).entries), /Actual indexed answer/);
    } finally { await f.dispose(); }
});

test('missing history is not empty for another thread, a generic invalid request, or an ordinary empty page', async () => {
    for (const confirm of [
        () => { throw new CodexRpcError(-32600, 'thread different is not materialized yet; thread/turns/list is unavailable before first user message'); },
        () => { throw new CodexRpcError(-32600, 'Invalid request'); },
        () => ({ data: [], nextCursor: null }),
    ]) {
        const f = await fixture();
        try {
            f.behavior.confirm = confirm;
            await assert.rejects(f.source.read(f.request), { code: 'HISTORY_UNAVAILABLE' });
        } finally { await f.dispose(); }
    }
});

test('corrupt sparse metadata never invokes empty confirmation', async () => {
    const f = await fixture();
    try {
        await writeFile(join(f.home, 'thread_history_1.sqlite'), 'not a sqlite database');
        await assert.rejects(f.source.read(f.request), { code: 'HISTORY_UNAVAILABLE' });
        assert.equal(f.calls.some(call => call.method === 'thread/turns/list'), false);
    } finally { await f.dispose(); }
});

test('an existing native rollout without its index remains unavailable', async () => {
    const f = await fixture();
    try {
        const directory = join(f.home, 'sessions/2026/11/08'); await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'rollout-2026-11-08-thread.jsonl'), '{"type":"session_meta","ordinal":0,"payload":{"id":"thread"}}\n');
        await assert.rejects(f.source.read(f.request), { code: 'HISTORY_UNAVAILABLE' });
    } finally { await f.dispose(); }
});

test('actual native fresh home opens without any user input or materialized history', {
    skip: !process.env.HHPI_CODEX_EMPTY_HOME_COMMAND ? 'Set HHPI_CODEX_EMPTY_HOME_COMMAND to the actual source executable.' : false,
    timeout: 15_000,
}, async t => {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-real-empty-home-');
    // No model server exists and no turn is sent. Plugin discovery is disabled.
    await writeFile(join(home, 'config.toml'), 'model="hhpi-no-turn"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="No-turn fixture"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[features]\nplugins=false\n');
    const config: DirectCodexConfig = { id: 'source', machineId: 'fixture', engine: 'codex', command: process.env.HHPI_CODEX_EMPTY_HOME_COMMAND!,
        args: ['app-server'], codexHome: home, cwd: home, ownership: 'exclusive' };
    const rpc = new CodexRpc(config, 10_000), source = new DirectCodexAdapter(config, join(home, 'projection'), { rpc });
    try {
        const runtime = (await rpc.connect(AbortSignal.timeout(10_000))).userAgent;
        const receipt = await source.create({ sourceId: source.id, operationId: 'create-original-empty', cwd: home });
        assert.ok(receipt.session);
        assert.equal(existsSync(join(home, 'thread_history_1.sqlite')), false);
        const page = await source.read({ sessionId: receipt.session.id, limit: 160 });
        assert.deepEqual(page.entries, []); assert.equal(page.hasBefore, false); assert.equal(page.hasAfter, false);
        assert.equal(page.session.nativeId, receipt.session.nativeId);
        assert.equal(existsSync(join(home, 'thread_history_1.sqlite')), false);
        t.diagnostic(JSON.stringify({ runtime, isolatedHome: true, turnInputs: 0, historyDatabaseCreated: false, exactOriginalThreadOpened: true }));
    } finally { await source.dispose(); await rm(home, { recursive: true, force: true }); }
});
