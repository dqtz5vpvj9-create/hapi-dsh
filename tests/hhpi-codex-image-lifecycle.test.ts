/** Real native adapter, display index and image storage; only native RPC/file IO are fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import { CODEX_HISTORY_PROJECTION_VERSION, CodexHistory } from '../src/remote/codex-history.ts';
import type { CodexRpc, NativeNotification } from '../src/remote/codex-rpc.ts';
import type { NativeItem } from '../src/remote/codex-native.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import type { SourceChanges, SourceEntry, SourcePage } from '../src/remote/protocol.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';
const imageItem = (id: string): NativeItem => ({ id, type: 'userMessage', content: [{ type: 'localImage', path: `/synthetic/${id}.png` }] });
const imageMessages = (entries: readonly SourceEntry[]): string[] => entries.flatMap(({ event }) => event.type === 'user/message'
    && event.data.content.some(part => part.type === 'image') ? [String(event.data.id)] : []);
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function fixture(t: TestContext, initialItems: NativeItem[], readImage: (path: string, signal: AbortSignal) => Promise<unknown>, active = true) {
    const directory = await mkdtemp(join(tmpdir(), 'hhpi-image-lifecycle-'));
    const native = { id: 'thread', cwd: '/synthetic', createdAt: 1, updatedAt: 2, status: { type: active ? 'active' : 'idle' } };
    const items = [...initialItems], fileReads: string[] = [], calls: string[] = [];
    let notify: (frame: NativeNotification) => void = () => {};
    const readFile = async (path: string, signal: AbortSignal): Promise<unknown> => { fileReads.push(path); return readImage(path, signal); };
    const rpc = {
        online: true, currentGeneration: 1, connect: async () => ({}), dispose: async () => {},
        onNotification: (listener: typeof notify) => { notify = listener; return () => {}; }, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
            calls.push(method);
            if (method === 'thread/loaded/list') return { data: [native.id], nextCursor: null };
            if (method === 'thread/list') return { data: [native], nextCursor: null };
            if (method === 'thread/read') return { thread: native };
            if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: active ? 'inProgress' : 'completed', startedAt: 1,
                ...(active ? {} : { completedAt: 2 }) }], nextCursor: null };
            if (method === 'thread/items/list') return { data: items.map(item => ({ turnId: 'turn', item })), nextCursor: null };
            throw new Error(`Unexpected native method ${method}`);
        },
    } as unknown as CodexRpc;
    const adapter = new DirectCodexAdapter({ id: 'native', machineId: 'synthetic-machine', engine: 'codex' }, directory, { rpc, readImage: readFile });
    t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
    const [session] = await adapter.list(); assert.ok(session);
    return { adapter, session, fileReads, calls, directory,
        read: (limit = 100, signal?: AbortSignal) => adapter.read({ sessionId: session.id, limit }, signal),
        append: (item: NativeItem) => { items.push(item); notify({ method: 'item/completed', params: { threadId: native.id, turnId: 'turn', item } }); },
    };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function following(t: TestContext, f: Fixture, page: SourcePage) {
    const stop = new AbortController(), changes = f.adapter.changes({ sessionId: f.session.id, epoch: page.epoch, version: page.version }, stop.signal)[Symbol.asyncIterator]();
    t.after(async () => { stop.abort(); await changes.return?.(); });
    return changes;
}
async function collectImages(changes: AsyncIterator<SourceChanges>, count: number): Promise<Set<string>> {
    const found = new Set<string>();
    while (found.size < count) {
        const next = await changes.next(); assert.equal(next.done, false);
        for (const id of imageMessages(next.value!.upserts)) found.add(id);
    }
    return found;
}

test('an idle reader can close while image IO continues and the completed image is published without another native update', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const started = Promise.withResolvers<void>(), bytes = Promise.withResolvers<unknown>();
    t.after(() => { bytes.resolve({ dataBase64: PNG }); });
    const f = await fixture(t, [imageItem('idle-image')], async () => { started.resolve(); return bytes.promise; }, false);
    const reader = new AbortController(); let returned: SourcePage | undefined;
    const pageRead = f.read(100, reader.signal).then(page => { returned = page; return page; });
    void pageRead.catch(() => {});
    await started.promise; await flush();
    assert.ok(returned, 'a ready text/history page must return without waiting for image bytes');
    const page = await pageRead;
    reader.abort(new DOMException('The original reader closed.', 'AbortError'));
    const changes = following(t, f, page), imagePublished = collectImages(changes, 1);
    bytes.resolve({ dataBase64: PNG }); await imagePublished;
    const nativeReads = f.calls.filter(method => method === 'thread/read').length;
    t.mock.timers.tick(250); await flush();
    assert.equal(f.calls.filter(method => method === 'thread/read').length, nativeReads, 'idle polling must not be needed to repair the image');
    assert.equal(imageMessages((await f.read()).entries).length, 1);
    assert.equal(imageMessages((await f.read()).entries).length, 1);
    assert.equal(f.fileReads.length, 1, 'closing the first reader neither drops the result nor duplicates the native image read');
    assert.equal(f.calls.some(method => method.startsWith('fs/')), false, 'preview IO cannot use the native execution transport');
});

test('pending image preparation never blocks later accepted text from the changes stream', { timeout: 5000 }, async t => {
    const started = Promise.withResolvers<void>(), bytes = Promise.withResolvers<unknown>();
    t.after(() => { bytes.resolve({ dataBase64: PNG }); });
    const f = await fixture(t, [{ id: 'initial', type: 'userMessage', content: [{ type: 'text', text: 'Initial text' }] }], async () => { started.resolve(); return bytes.promise; });
    const changes = following(t, f, await f.read()); await changes.next();
    const imageChange = changes.next(); f.append(imageItem('slow-image')); await imageChange;
    let delivered: SourceChanges | undefined;
    const next = changes.next().then(value => { delivered = value.value; return value; }); void next.catch(() => {});
    await started.promise;
    f.append({ id: 'later-answer', type: 'agentMessage', text: 'Text accepted while the image is pending' });
    await flush();
    assert.match(JSON.stringify(delivered), /Text accepted while the image is pending/, 'the source must deliver the next text update before unrelated image IO finishes');
    await next;
});

test('a page retains its original snapshot and later image messages are prepared through normal follow', { timeout: 5000 }, async t => {
    const started = Promise.withResolvers<void>(), firstBytes = Promise.withResolvers<unknown>();
    t.after(() => { firstBytes.resolve({ dataBase64: PNG }); });
    const f = await fixture(t, [imageItem('first')], async path => {
        if (path.endsWith('/first.png')) { started.resolve(); return firstBytes.promise; }
        return { dataBase64: PNG };
    });
    const firstRead = f.read(); await started.promise;
    f.append(imageItem('later')); firstBytes.resolve({ dataBase64: PNG });
    const page = await firstRead;
    assert.equal(page.entries.filter(entry => entry.event.type === 'user/message').length, 1,
        'a page must not silently advance to a newer version containing messages absent from its scheduled image set');
    const found = await collectImages(following(t, f, page), 2);
    assert.deepEqual([...found].sort(), ['codex:thread:turn:first', 'codex:thread:turn:later']);
    assert.deepEqual(f.fileReads.sort(), ['/synthetic/first.png', '/synthetic/later.png']);
});

test('a successful old image cache repairs a missing display projection without another source file read', { timeout: 5000 }, async t => {
    const f = await fixture(t, [imageItem('cached')], async () => ({ dataBase64: PNG }), false);
    const original = await f.read(); await collectImages(following(t, f, original), 1);
    const hash = createHash('sha256').update(f.session.id).digest('hex');
    const index = new SourceEventIndex(join(f.directory, 'history', `${hash}.v${CODEX_HISTORY_PROJECTION_VERSION}.sqlite`), f.session);
    try {
        const unpreparedProjection = new CodexHistory(index), state = unpreparedProjection.itemState('turn', 'cached')!;
        // Recreate the released version's canceled-reader state: content cache exists,
        // but its accepted native item and display event still lack presentationContent.
        unpreparedProjection.acceptItem(f.session, 'turn', state.item, state.completed);
    } finally { index.dispose(); }
    const page = await f.read();
    assert.equal(imageMessages(page.entries).length, 0, 'the fixture starts from the old unprojected cache state');
    await collectImages(following(t, f, page), 1);
    const corrected = await f.read(), stable = await f.read();
    assert.equal(imageMessages(corrected.entries).length, 1);
    assert.equal(stable.version, corrected.version, 'cache-hit projection is idempotent');
    assert.equal(f.fileReads.length, 1);
});

test('multiple page readers share at most two source-owned image preparations', { timeout: 5000 }, async t => {
    const bothStarted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    t.after(() => { release.resolve(); });
    let active = 0, peak = 0;
    const f = await fixture(t, Array.from({ length: 6 }, (_, i) => imageItem(`image-${i}`)), async () => {
        peak = Math.max(peak, ++active); if (active === 2) bothStarted.resolve();
        try { await release.promise; return { dataBase64: PNG }; } finally { active--; }
    }, false);
    const first = f.read(100); await bothStarted.promise;
    const second = f.read(100); await flush();
    assert.equal(peak, 2);
    release.resolve();
    const page = await first; await second;
    await collectImages(following(t, f, page), 6);
    assert.equal(peak, 2); assert.equal(f.fileReads.length, 6, 'shared readers must not duplicate image preparations');
});
