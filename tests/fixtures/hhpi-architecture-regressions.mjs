import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const scratch = existsSync('/mnt/cache/data-cache') ? '/mnt/cache/data-cache' : tmpdir();
const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(root + '/package.json');
const { build } = require('esbuild');
async function load(path, alias = {}) { const r = await build({ entryPoints: [root + '/' + path], alias, define: { 'import.meta.url': JSON.stringify(pathToFileURL(root + '/' + path).href) }, external: ['@deepseek-ai/cordis'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent' }); const m = { exports: {} }; new Function('require', 'module', 'exports', r.outputFiles[0].text)(require, m, m.exports); return m.exports; }
const { RemoteSourceHistory } = await load('src/client/remote-history.ts');
const { RemoteSourceSession, RemoteSessions } = await load('src/client/remote-sessions.ts', { '@deepseek-ai/dsh-api-session-controller/client': root + '/tests/fixtures/client-session-contract.ts' });
const { RemoteOutbox } = await load('src/client/remote-outbox.ts');
const metadata = { id: 'hhpi:machine:source:codex:thread', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread', title: 'synthetic', cwd: '/synthetic', updatedAt: 1, status: 'running', activeTurnId: 'turn-1', capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, pendingRequests: [] };
const budget = { events: 5000, bytes: 12 * 1024 * 1024, nodes: 2000 };
const entry = (seq, text = 'body-' + seq) => ({ type: 'event', event: { seq, time: 1, type: 'user/message', data: { id: 'm' + seq, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } });
const text = (s, seq) => s.entries.find(x => x.event.seq === seq)?.event.data.content[0].text;
const turn = () => new Promise(r => setImmediate(r));
async function spin(check) { for (let i = 0; i < 50 && !check(); i++)
    await turn(); assert.ok(check(), 'controlled operation did not reach its gate'); }
class Wire {
    epoch = 'epoch-a';
    version = 1;
    entries = Array.from({ length: 800 }, (_, i) => entry(i + 1));
    queue = [];
    wake = undefined;
    calls = [];
    gate = undefined;
    async read(r, signal) { this.calls.push(r); let rows = this.entries.filter(x => r.before !== undefined ? x.event.seq < r.before : r.after !== undefined ? x.event.seq > r.after : true); let limit = r.limit ?? 160; if (r.around !== undefined) {
        let k = rows.findIndex(x => x.event.seq >= r.around);
        rows = rows.slice(Math.max(0, k - Math.floor(limit / 2)), Math.max(0, k - Math.floor(limit / 2)) + limit);
    }
    else
        rows = r.after !== undefined ? rows.slice(0, limit) : rows.slice(-limit); const before = rows[0]?.event.seq ?? null, after = rows.at(-1)?.event.seq ?? null; const page = { session: metadata, epoch: this.epoch, version: this.version, entries: rows, before, after, hasBefore: before > 1, hasAfter: after < 800, context: [] }; const gate = this.gate?.(r); if (gate)
        await gate; signal?.throwIfAborted(); return page; }
    async *changes(r, signal) { while (!signal?.aborted) {
        if (this.queue.length) {
            yield this.queue.shift();
            continue;
        }
        await new Promise(res => { this.wake = res; signal?.addEventListener('abort', res, { once: true }); });
    } }
    push(change) { this.epoch = change.epoch; this.version = change.version; this.queue.push(change); this.wake?.(); }
}
test('replacement reset completes recovery', { timeout: 5000 }, async () => {
    const w = new Wire(), h = new RemoteSourceHistory(metadata.id, w);
    const f = await h.openView('pane', budget);
    f.publication.accept(f.initial.version);
    const gate = Promise.withResolvers();
    let blocked = false;
    w.gate = r => { if (!blocked) {
        blocked = true;
        return gate.promise;
    } };
    w.push({ session: metadata, epoch: 'epoch-b', base: 1, version: 2, reset: true, upserts: [], removed: [] });
    await spin(() => blocked);
    w.push({ session: metadata, epoch: 'epoch-c', base: 2, version: 3, reset: true, upserts: [], removed: [] });
    await spin(() => h.sourceEpoch === 'epoch-c');
    gate.resolve();
    await turn();
    await turn();
    const recovered = await f.refresh(budget, new AbortController().signal);
    assert.equal(JSON.parse(recovered.version)[0], 'epoch-c');
    assert.equal(w.calls.length, 3);
    h.dispose();
});
test('recovery normalizes pages through intervening changes', { timeout: 5000 }, async () => {
    const w = new Wire(), h = new RemoteSourceHistory(metadata.id, w), f = await h.openView('pane', budget);
    let snap = f.initial;
    for (let i = 0; i < 4; i++) {
        snap = await f.read({ kind: 'before', cursor: snap.before }, budget, new AbortController().signal);
        f.publication.accept(snap.version);
    }
    const gate = Promise.withResolvers();
    let blocked = false;
    w.gate = r => { if (r.after === 500) {
        blocked = true;
        return gate.promise;
    } };
    w.push({ session: metadata, epoch: w.epoch, base: 1, version: 2, reset: true, upserts: [], removed: [] });
    await spin(() => blocked);
    w.entries = w.entries.map(x => x.event.seq === 100 ? entry(100, 'new-revision') : x);
    w.push({ session: metadata, epoch: w.epoch, base: 2, version: 3, reset: false, upserts: [entry(100, 'new-revision')], removed: [] });
    await spin(() => h.sourceVersion === 3);
    gate.resolve();
    await turn();
    await turn();
    await turn();
    const recovered = await f.refresh(budget, new AbortController().signal);
    const cached = h.currentEntries([100])[0].event.data.content[0].text;
    f.publication.accept(recovered.version);
    assert.equal(text(f.publication.published.snapshot, 100), 'new-revision');
    assert.equal(text(recovered, 100), 'new-revision');
    assert.equal(cached, 'new-revision');
    h.dispose();
});
test('uncertain steer remains pending', { timeout: 5000 }, async () => {
    const h = new RemoteSourceHistory(metadata.id, { read: async () => ({ session: metadata, epoch: 'epoch', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] }), async *changes() { } });
    const retire = [];
    const s = new RemoteSourceSession(metadata.id, metadata, h, { operate: async (op) => ({ ok: true, value: { sessionId: op.sessionId, operationId: op.operationId, status: 'indeterminate', message: 'ACK lost' } }) });
    await s.ready;
    const handle = s.beginSubmission({ mode: 'steer', text: 'once', attachments: [], onRetire: r => retire.push(r.reason) });
    const r = await s.prompt([{ type: 'text', text: 'once' }], 'steer', undefined, handle.requestId);
    assert.equal(r.ok, false);
    assert.equal(s.getSnapshot().pendingSubmissions.length, 1);
    assert.deepEqual(retire, []);
    s.dispose();
    h.dispose();
});
test('accepted steer waits for native observation', { timeout: 5000 }, async () => {
    const h = new RemoteSourceHistory(metadata.id, { read: async () => ({ session: metadata, epoch: 'epoch', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] }), async *changes() { } });
    const s = new RemoteSourceSession(metadata.id, metadata, h, { operate: async (op) => ({ ok: true, value: { sessionId: op.sessionId, operationId: op.operationId, status: 'accepted', message: 'admitted only' } }) });
    await s.ready;
    const ret = [];
    const x = s.beginSubmission({ mode: 'steer', text: 'once', attachments: [], onRetire: r => ret.push(r.reason) });
    await s.prompt([{ type: 'text', text: 'once' }], 'steer', undefined, x.requestId);
    assert.equal(s.getSnapshot().pendingSubmissions.length, 1);
    assert.equal(h.currentEntries([1]).length, 0);
    s.dispose();
    h.dispose();
});
test('late cross-context ACK cannot resurrect observed work', { timeout: 5000 }, async () => {
    // Shared storage reproduces independent browser contexts without mocking the outbox.
    const data = new Map();
    const storage = { get length() { return data.size; }, key: i => [...data.keys()][i] ?? null, getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
    const access = { scope: 'synthetic', storage };
    const gate = Promise.withResolvers();
    const accepted = op => ({ sessionId: op.sessionId, operationId: op.operationId, status: 'accepted', message: 'accepted' });
    const a = new RemoteOutbox(async (op) => accepted(op));
    a.setStorage(access);
    a.enqueue({ sessionId: metadata.id, operationId: 'same-id', kind: 'send', text: 'once' });
    a.start('same-id');
    const b = new RemoteOutbox(async () => gate.promise);
    b.setStorage(access);
    b.acceptCatalog([metadata]);
    await turn();
    a.observe(metadata.id, [{ ...entry(1), event: { ...entry(1).event, data: { ...entry(1).event.data, source: { rpcId: 'same-id' } } } }]);
    assert.equal(data.size, 0);
    gate.resolve(accepted({ sessionId: metadata.id, operationId: 'same-id' }));
    await turn();
    await turn();
    assert.equal(data.size, 0);
    a.dispose();
    b.dispose();
});
test('directory hints cannot overwrite accepted history facts', { timeout: 5000 }, async () => {
    const { Context } = require('@deepseek-ai/cordis');
    const ctx = new Context();
    const base = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} };
    const original = { list: { getSnapshot: () => base, subscribe: () => () => { } }, windowCommit: {}, searchResultLimit: 100, refresh: async () => { }, binding: () => undefined, retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 0, retainedBy: {} }), subscribe: () => () => { } }) };
    const old = { ...metadata, status: 'idle', activeTurnId: null, title: 'old-directory' };
    const api = { catalog: async () => ({ ok: true, value: { protocol: 1, legacyHapi: false, sessions: [old], sources: [] } }), read: async () => ({ ok: true, value: { session: { ...metadata, title: 'new-history' }, epoch: 'epoch', version: 2, entries: [entry(1)], before: 1, after: 1, hasBefore: false, hasAfter: false, context: [] } }) };
    const sessions = new RemoteSessions(ctx, original, api);
    await sessions.refresh();
    const ref = sessions.retain(metadata.id, { source: 'hapiWorkspace' });
    await ref.ready;
    const before = ref.binding.session.metadata.getSnapshot().title;
    assert.equal(before, 'new-history');
    await sessions.refresh();
    const after = ref.binding.session.metadata.getSnapshot().title;
    assert.equal(after, 'new-history');
    assert.equal(ref.binding.session.metadata.getSnapshot().activeTurnId, 'turn-1');
    ref.release();
    sessions.dispose();
    await ctx.fiber.dispose();
});
test('quick remount reuses the shared subscription', { timeout: 5000 }, async () => {
    const w = new Wire();
    let subscriptions = 0, stopped = 0;
    const original = w.changes.bind(w);
    w.changes = async function* (...args) { subscriptions++; try {
        yield* original(...args);
    }
    finally {
        stopped++;
    } };
    const h = new RemoteSourceHistory(metadata.id, w), a = await h.openView('a', budget), b = await h.openView('b', budget);
    await turn();
    assert.equal(subscriptions, 1);
    a.release();
    await turn();
    assert.equal(stopped, 0);
    b.release();
    await turn();
    const c = await h.openView('c', budget);
    await turn();
    assert.equal(subscriptions, 1);
    c.release();
    h.dispose();
});
test('old native generation cannot overwrite the active turn', { timeout: 5000 }, async () => {
    const { DirectCodexAdapter } = await require('tsx/esm/api').tsImport(root + '/src/remote/codex-adapter.ts', import.meta.url);
    const { nativeMetadataFixture, sliceNativeEntries } = await load('tests/fixtures/hhpi-native-metadata.ts');
    let notify = () => { }, disconnect = () => { }, hold = false;
    const gate = Promise.withResolvers(), started = Promise.withResolvers();
    const turnA = { id: 'turn-A', status: 'inProgress', startedAt: 1, completedAt: null };
    const turnB = { id: 'turn-B', status: 'inProgress', startedAt: 2, completedAt: null };
    const item = { id: 'answer-A', type: 'agentMessage', text: 'A body' };
    const native = { id: 'thread', cwd: '/synthetic', createdAt: 1, updatedAt: 2, status: { type: 'active' } };
    const metadataRead = nativeMetadataFixture(() => [{ turn: turnA, items: [item] }]);
    const rpc = { online: true, currentGeneration: 1, connect: async () => ({ codexHome: '/synthetic' }), dispose: async () => { }, onNotification: f => (notify = f, () => { }), onRequest: () => () => { }, onDisconnect: f => (disconnect = f, () => { }), request: async (method, params) => {
            if (method === 'thread/loaded/list')
                return { data: ['thread'], nextCursor: null };
            if (method === 'thread/list')
                return { data: [structuredClone(native)], nextCursor: null };
            if (method === 'thread/read')
                return { thread: structuredClone(native) };
            if (method === 'thread/items/list')
                return sliceNativeEntries([{ turnId: 'turn-A', item, startedAtMs: 1000 }], params);
            throw Error(method);
        } };
    const nativeDirectory = mkdtempSync(scratch + '/hhpi-audit-native-');
    const adapter = new DirectCodexAdapter({ id: 'gen-source', machineId: 'machine', engine: 'codex' }, nativeDirectory, { rpc, pollMs: 999999, readMetadata: async (r) => { const p = await metadataRead(r); if (hold) {
            hold = false;
            started.resolve();
            await gate.promise;
        } return p; } });
    const [ss] = await adapter.list();
    await adapter.read({ sessionId: ss.id });
    hold = true;
    const pending = adapter.read({ sessionId: ss.id, around: 16 });
    await started.promise;
    rpc.online = false;
    disconnect();
    rpc.currentGeneration = 2;
    rpc.online = true;
    notify({ method: 'turn/started', params: { threadId: 'thread', turn: turnB } });
    const before = (await adapter.resolve(ss.id)).activeTurnId;
    assert.equal(before, 'turn-B');
    gate.resolve();
    await assert.rejects(pending, { code: 'TARGET_UNAVAILABLE' });
    const after = (await adapter.resolve(ss.id)).activeTurnId;
    assert.equal(after, 'turn-B');
    await adapter.dispose();
    rmSync(nativeDirectory, { recursive: true, force: true });
});
test('explicit native deletion is absent from subsequent catalogs', { timeout: 5000 }, async () => {
    const { mkdtempSync } = require('node:fs');
    const { DirectCodexAdapter } = await require('tsx/esm/api').tsImport(root + '/src/remote/codex-adapter.ts', import.meta.url);
    let notify = () => { }, deleted = false, now = 10000;
    const native = { id: 'thread', cwd: '/synthetic', createdAt: 1, updatedAt: 2, status: { type: 'idle' } };
    const rpc = { online: true, currentGeneration: 1, connect: async () => ({ codexHome: '/synthetic' }), dispose: async () => { }, onNotification: f => (notify = f, () => { }), onDisconnect: () => () => { }, onRequest: () => () => { }, request: async (method) => { if (method === 'thread/loaded/list')
            return { data: [], nextCursor: null }; if (method === 'thread/list')
            return { data: deleted ? [] : [native], nextCursor: null }; throw Error(method); } };
    const directory = mkdtempSync(scratch + '/hhpi-deleted-source-');
    const adapter = new DirectCodexAdapter({ id: 'good', machineId: 'machine', engine: 'codex' }, directory, { rpc, now: () => now, pollMs: 999999, readMetadata: async () => { throw Error('No body read permitted'); } });
    assert.equal((await adapter.list()).length, 1);
    deleted = true;
    notify({ method: 'thread/deleted', params: { threadId: 'thread' } });
    now += 2000;
    const rows = await adapter.list();
    assert.equal(rows.length, 0);
    await adapter.dispose();
    rmSync(directory, { recursive: true, force: true });
});
test('overlapping native reads cannot roll a committed body backward', { timeout: 5000 }, async () => {
    const { DirectCodexAdapter } = await require('tsx/esm/api').tsImport(root + '/src/remote/codex-adapter.ts', import.meta.url);
    const { nativeMetadataFixture } = await load('tests/fixtures/hhpi-native-metadata.ts');
    const { mkdtempSync, rmSync } = require('node:fs');
    const dir = mkdtempSync(scratch + '/hhpi-same-generation-');
    const native = { id: 'thread', cwd: '/synthetic', createdAt: 1, updatedAt: 2, status: { type: 'idle' } };
    const turn = { id: 'turn', status: 'completed', startedAt: 1, completedAt: 2 };
    let body = 'A', hold = false;
    const gate = Promise.withResolvers(), started = Promise.withResolvers();
    const item = () => ({ id: 'answer', type: 'agentMessage', text: body });
    const meta = nativeMetadataFixture(() => [{ turn, items: [item()] }]);
    const rpc = { online: true, currentGeneration: 1, connect: async () => ({ codexHome: '/synthetic' }), dispose: async () => { }, onNotification: () => () => { }, onDisconnect: () => () => { }, onRequest: () => () => { }, request: async (method) => {
            if (method === 'thread/loaded/list')
                return { data: [], nextCursor: null };
            if (method === 'thread/list')
                return { data: [native], nextCursor: null };
            if (method === 'thread/read')
                return { thread: native };
            if (method === 'thread/items/list') {
                const data = [{ turnId: 'turn', item: item(), startedAtMs: 1000, completedAtMs: 2000 }];
                if (hold) {
                    hold = false;
                    started.resolve();
                    await gate.promise;
                }
                return { data, nextCursor: null };
            }
            throw Error(method);
        } };
    const adapter = new DirectCodexAdapter({ id: 'good', machineId: 'machine', engine: 'codex' }, dir, { rpc, pollMs: 999999, readMetadata: meta });
    const [session] = await adapter.list();
    await adapter.read({ sessionId: session.id });
    body = 'B';
    hold = true;
    const oldRead = adapter.read({ sessionId: session.id, around: 16 });
    await started.promise;
    body = 'C';
    const newRead = await adapter.read({ sessionId: session.id, after: 0 });
    assert.ok(JSON.stringify(newRead.entries).includes('"text":"C"'));
    gate.resolve();
    await assert.rejects(oldRead, { code: 'TARGET_UNAVAILABLE' });
    const reread = await adapter.read({ sessionId: session.id });
    assert.ok(JSON.stringify(reread.entries).includes('"text":"C"'));
    await adapter.dispose();
    rmSync(dir, { recursive: true, force: true });
});
