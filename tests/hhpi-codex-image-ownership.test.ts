/** Production image ownership, adapter and index; only native RPC and file bytes are synthetic. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc, NativeNotification } from '../src/remote/codex-rpc.ts';
import type { NativeItem } from '../src/remote/codex-native.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import type { SourcePage } from '../src/remote/protocol.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';
const item = (id: string, caption = id): NativeItem => ({ id, type: 'userMessage', content: [
    { type: 'text', text: caption }, { type: 'localImage', path: `/synthetic/${caption}.png` },
] });
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function fixture(t: TestContext, initial: NativeItem[], readImage: (path: string, signal: AbortSignal) => Promise<unknown>) {
    const directory = await mkdtemp(join(tmpdir(), 'hhpi-image-ownership-'));
    const native = { id: 'thread', cwd: '/synthetic', createdAt: 1, updatedAt: 2, status: { type: 'idle' } };
    const items = [...initial];
    let notification: (value: NativeNotification) => void = () => {};
    const rpc = {
        online: true, currentGeneration: 1, connect: async () => ({}), dispose: async () => {},
        onNotification: (callback: typeof notification) => { notification = callback; return () => { notification = () => {}; }; },
        onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string): Promise<unknown> => {
            if (method === 'thread/loaded/list') return { data: ['thread'], nextCursor: null };
            if (method === 'thread/list') return { data: [native], nextCursor: null };
            if (method === 'thread/read') return { thread: native };
            if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: 'completed', startedAt: 1, completedAt: 2 }], nextCursor: null };
            if (method === 'thread/items/list') return { data: items.map(value => ({ turnId: 'turn', item: value })), nextCursor: null };
            throw new Error(`Unexpected method ${method}`);
        },
    } as unknown as CodexRpc;
    const adapter = new DirectCodexAdapter({ id: 'native', machineId: 'fixture', engine: 'codex' }, directory, { rpc, readImage, pollMs: 60_000 });
    t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
    const [session] = await adapter.list(); assert.ok(session);
    return { adapter, session,
        read: () => adapter.read({ sessionId: session.id, limit: 100 }),
        replace: (replacement: NativeItem) => {
            items[items.findIndex(value => value.id === replacement.id)] = replacement;
            notification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: replacement } });
        },
    };
}

function follow(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, page: SourcePage) {
    const controller = new AbortController();
    const changes = f.adapter.changes({ sessionId: f.session.id, epoch: page.epoch, version: page.version }, controller.signal)[Symbol.asyncIterator]();
    t.after(async () => { controller.abort(); await changes.return?.(); });
    return changes;
}

test('same-ID content replacement during image IO cannot restore the earlier caption or image name', { timeout: 5000 }, async t => {
    const started = Promise.withResolvers<void>(), oldBytes = Promise.withResolvers<unknown>();
    t.after(() => { oldBytes.resolve({ dataBase64: PNG }); });
    const reads: string[] = [];
    const f = await fixture(t, [item('same', 'old-caption')], async path => {
        reads.push(path);
        if (path.endsWith('/old-caption.png')) { started.resolve(); return oldBytes.promise; }
        return { dataBase64: PNG };
    });
    const page = await f.read(); await started.promise;
    const changes = follow(t, f, page); await changes.next();
    const updated = changes.next(); f.replace(item('same', 'new-caption'));
    assert.match(JSON.stringify((await updated).value), /new-caption/);
    oldBytes.resolve({ dataBase64: PNG });
    for (;;) {
        const next = await changes.next(); assert.equal(next.done, false);
        const message = next.value!.upserts.find(({ event }) => event.type === 'user/message' && event.data.content.some(part => part.type === 'image'));
        if (!message || message.event.type !== 'user/message') continue;
        assert.equal(message.event.data.id, 'codex:thread:turn:same');
        assert.match(JSON.stringify(message), /new-caption/);
        assert.doesNotMatch(JSON.stringify(message), /old-caption/);
        break;
    }
    const current = await f.read();
    assert.doesNotMatch(JSON.stringify(current.entries), /old-caption/);
    assert.deepEqual(reads, ['/synthetic/old-caption.png', '/synthetic/new-caption.png']);
});

test('source disposal drains active preparations and discards queued images before closing SQLite', { timeout: 5000 }, async t => {
    const closed = new WeakSet<SourceEventIndex>();
    let closedIndexes = 0, callsAfterClose = 0;
    const originalDispose = SourceEventIndex.prototype.dispose;
    t.mock.method(SourceEventIndex.prototype, 'dispose', function (this: SourceEventIndex) {
        closed.add(this); closedIndexes++; return originalDispose.call(this);
    });
    // Observe late access without replacing SQLite or the actual cache behavior.
    for (const name of ['cached', 'cache', 'edit'] as const) {
        const original = SourceEventIndex.prototype[name];
        t.mock.method(SourceEventIndex.prototype, name, function (this: SourceEventIndex, ...args: unknown[]) {
            if (closed.has(this)) callsAfterClose++;
            return Reflect.apply(original, this, args);
        });
    }
    const started = Promise.withResolvers<void>(), late = Promise.withResolvers<unknown>();
    t.after(() => { late.resolve({ dataBase64: PNG }); });
    let reads = 0, aborts = 0;
    const f = await fixture(t, Array.from({ length: 5 }, (_, i) => item(`image-${i}`)), async (_path, signal) => {
        signal.addEventListener('abort', () => { aborts++; }, { once: true });
        if (++reads === 2) started.resolve();
        return late.promise; // Deliberately ignores abort to exercise a late external completion.
    });
    await f.read(); await started.promise;
    await f.adapter.dispose();
    assert.ok(closedIndexes >= 1, 'the adapter must actually close its index');
    assert.equal(reads, 2); assert.equal(aborts, 2);
    late.resolve({ dataBase64: PNG }); await flush();
    assert.equal(reads, 2, 'no queued image starts after disposal');
    assert.equal(callsAfterClose, 0, 'late image work must not access the closed SQLite cache');
});
