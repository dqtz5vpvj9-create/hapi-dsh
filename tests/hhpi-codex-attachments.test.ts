/** Production native adapter and official image storage; only Codex JSON-RPC is a fixture. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc, NativeNotification } from '../src/remote/codex-rpc.ts';
import type { NativeItem } from '../src/remote/codex-native.ts';
import type { SourcePage } from '../src/remote/protocol.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';
type Image = Extract<ContentBlock, { type: 'image' }>;
const images = (page: SourcePage): Image[] => page.entries.flatMap(({ event }) => {
    const content = event.type === 'user/message' ? event.data.content
        : event.type === 'tool/result' ? event.data.message.content : [];
    return content.filter((block): block is Image => block.type === 'image');
});

async function fixture(t: TestContext, items: NativeItem[], options: { turns?: number; readFile?: (path: string) => Promise<unknown>; beforeThreadRead?: () => Promise<void> } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'hhpi-image-')), calls: string[] = [], fileReads: string[] = [];
    const thread = { id: 'thread-images', cwd: '/native', createdAt: 1, updatedAt: 2, status: { type: 'idle' } };
    const other = { ...thread, id: 'other-thread' };
    let turnCount = options.turns ?? 1;
    let notify: (frame: NativeNotification) => void = () => {};
    const rpc = {
        online: true, currentGeneration: 1, connect: async () => ({}), dispose: async () => {},
        onNotification: (listener: typeof notify) => { notify = listener; return () => {}; }, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
            calls.push(method);
            if (method === 'thread/loaded/list') return { data: [thread.id, other.id], nextCursor: null };
            if (method === 'thread/list') return { data: [thread, other], nextCursor: null };
            if (method === 'thread/read') {
                const snapshot = structuredClone(params.threadId === other.id ? other : thread);
                await options.beforeThreadRead?.(); return { thread: snapshot };
            }
            if (method === 'thread/turns/list') return { data: Array.from({ length: turnCount }, (_, i) => ({ id: `turn-${i}`, status: 'completed', startedAt: i + 1, completedAt: i + 2 })), nextCursor: null };
            if (method === 'thread/items/list') return { data: (params.threadId === other.id
                ? [{ type: 'userMessage', id: 'other-user', content: [{ type: 'text', text: 'No images in this session.' }] }]
                : items).map(item => ({ turnId: params.turnId, item })), nextCursor: null };
            if (method === 'fs/readFile') {
                assert.equal(typeof params.path, 'string'); fileReads.push(String(params.path));
                return options.readFile ? options.readFile(String(params.path)) : { dataBase64: PNG };
            }
            throw new Error(`Unexpected native method ${method}`);
        },
    } as unknown as CodexRpc;
    const adapter = new DirectCodexAdapter({ id: 'native', machineId: 'machine', engine: 'codex' }, directory, { rpc, pollMs: 60_000 });
    t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
    const sessions = await adapter.list(), session = sessions.find(value => value.nativeId === thread.id)!, otherSession = sessions.find(value => value.nativeId === other.id)!;
    const read = (limit = 100): Promise<SourcePage> => adapter.read({ sessionId: session.id, limit });
    const rewrite = (sameTimestamp = false): void => { turnCount = 0; if (!sameTimestamp) thread.updatedAt++; notify({ method: 'thread/reverted', params: { threadId: thread.id } }); };
    return { adapter, session, otherSession, calls, fileReads, read, rewrite, notify };
}

test('native images are imported only for a requested page and displayed with verified official references', async t => {
    const f = await fixture(t, [
        { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Inspect this screenshot.' },
            { type: 'localImage', path: '/native/1700000000000-00000000-1111-2222-3333-444444444444-Screenshot.jpg' }] },
        { id: 'answer', type: 'agentMessage', text: 'Screenshot reviewed.' },
    ], { turns: 40 });
    const page = await f.read(6), [image] = images(page);
    assert.ok(image, 'the initial requested page must have an official image block');
    assert.equal(image.attachment.name, 'Screenshot.jpg');
    assert.equal(image.attachment.width, 1); assert.equal(image.attachment.height, 1);
    assert.ok(f.fileReads.length > 0 && f.fileReads.length <= 2, 'opening the latest page must not load forty historical images');
    const afterFirst = f.fileReads.length;
    const again = await f.read(6);
    assert.deepEqual(images(again), images(page)); assert.equal(f.fileReads.length, afterFirst, 'accepted image references reuse immutable stored bytes');
    const value = await f.adapter.readResource({ sessionId: f.session.id, path: `attachment:${image.attachment.attachmentId}` });
    assert.deepEqual(value.attachment, image.attachment);
    const bytes = Buffer.from(value.content, 'base64');
    assert.equal(bytes.length, image.attachment.bytes);
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, image.attachment.attachmentId);
    assert.equal(f.session.capabilities.files, false, 'attachment preview must not claim arbitrary native file browsing');
});

test('source resource reads reject arbitrary paths, cross-thread images and revoked transcript references', async t => {
    const f = await fixture(t, [{ id: 'user', type: 'userMessage', content: [{ type: 'localImage', path: '/native/only-this-thread.png' }] }]);
    const [image] = images(await f.read()); assert.ok(image);
    const path = `attachment:${image.attachment.attachmentId}`, count = f.fileReads.length;
    await assert.rejects(f.adapter.readResource({ sessionId: f.session.id, path: '/etc/passwd' }), { code: 'INVALID_REQUEST' });
    await assert.rejects(f.adapter.readResource({ sessionId: f.otherSession.id, path }), { code: 'INVALID_REQUEST' });
    assert.equal(f.fileReads.length, count, 'browser-controlled paths must never reach native fs/readFile');
    f.rewrite(true);
    await assert.rejects(f.adapter.readResource({ sessionId: f.session.id, path }), { code: 'INVALID_REQUEST' });
});

test('a later page read retries a transient native image failure without retrying every render', async t => {
    let now = Date.now(), attempts = 0;
    t.mock.method(Date, 'now', () => now);
    const f = await fixture(t, [{ id: 'user', type: 'userMessage', content: [{ type: 'localImage', path: '/native/recoverable.png' }] }], {
        readFile: async () => { if (++attempts === 1) throw new Error('Native source temporarily unavailable'); return { dataBase64: PNG }; },
    });
    assert.equal(images(await f.read()).length, 0);
    assert.equal(images(await f.read()).length, 0); assert.equal(attempts, 1);
    now += 30_001;
    assert.equal(images(await f.read()).length, 1); assert.equal(attempts, 2);
});

test('a refresh started before a same-timestamp rewrite cannot readmit the old image grant', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let pause = false;
    const gate = Promise.withResolvers<void>(), reading = Promise.withResolvers<void>();
    const f = await fixture(t, [{ id: 'user', type: 'userMessage', content: [{ type: 'localImage', path: '/native/rewritten.png' }] }], {
        beforeThreadRead: async () => { if (pause) { reading.resolve(); await gate.promise; } },
    });
    const [image] = images(await f.read()); assert.ok(image);
    const path = `attachment:${image.attachment.attachmentId}`;
    pause = true;
    f.notify({ method: 'thread/status/changed', params: { threadId: f.session.nativeId, status: { type: 'active' } } });
    t.mock.timers.tick(60_000); await reading.promise;
    f.rewrite(true);
    const pending = f.adapter.readResource({ sessionId: f.session.id, path });
    await Promise.resolve(); await Promise.resolve();
    pause = false; gate.resolve();
    await assert.rejects(pending, { code: 'STALE_VERSION' });
    await assert.rejects(f.adapter.readResource({ sessionId: f.session.id, path }), { code: 'INVALID_REQUEST' });
});

test('embedded images and image-view results use real image blocks while inaccessible references remain readable', async t => {
    const f = await fixture(t, [
        { id: 'user', type: 'userMessage', content: [
            { type: 'text', text: 'Two native references:' }, { type: 'image', url: `data:image/png;base64,${PNG}` },
            { type: 'image', fileId: 'private-file-id' }, { type: 'image', url: 'https://example.invalid/private.png' },
        ] },
        { id: 'view', type: 'imageView', path: '/native/viewed.png' },
    ]);
    const page = await f.read();
    assert.equal(images(page).length, 2);
    assert.deepEqual(f.fileReads, ['/native/viewed.png'], 'data URLs are already authenticated source bytes; external URLs are not fetched');
    assert.match(JSON.stringify(page.entries), /Image preview unavailable/);
    assert.doesNotMatch(JSON.stringify(page.entries), /\[Native|private-file-id|data:image\/png/);
    const result = page.entries.find(({ event }) => event.type === 'tool/result');
    assert.ok(result?.event.type === 'tool/result');
    assert.ok(result.event.data.message.content.some(block => block.type === 'text' && block.text.includes('<type>image</type>')),
        'the official image gallery receives its image-read result envelope');
});

test('a source rewrite while native image bytes are pending cannot reauthorize those bytes', async t => {
    const gate = Promise.withResolvers<unknown>(), reading = Promise.withResolvers<void>();
    const f = await fixture(t, [{ id: 'user', type: 'userMessage', content: [{ type: 'localImage', path: '/native/late.png' }] }], {
        readFile: async () => { reading.resolve(); return gate.promise; },
    });
    const pending = f.read();
    await reading.promise; f.rewrite(); gate.resolve({ dataBase64: PNG });
    const page = await pending;
    assert.equal(images(page).length, 0, 'late bytes from a revoked source reference must never become a displayed image');
});

test('cancelled image-page waiters complete promptly and released adapters revoke the pending import', async t => {
    const gate = Promise.withResolvers<unknown>(), reading = Promise.withResolvers<void>();
    const f = await fixture(t, [{ id: 'user', type: 'userMessage', content: [{ type: 'localImage', path: '/native/pending.png' }] }], {
        readFile: async () => { reading.resolve(); return gate.promise; },
    });
    const abort = new AbortController();
    const pending = f.adapter.read({ sessionId: f.session.id }, abort.signal);
    await reading.promise; abort.abort(new DOMException('Reading was cancelled.', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
    await f.adapter.dispose(); gate.resolve({ dataBase64: PNG });
    await assert.rejects(f.adapter.readResource({ sessionId: f.session.id, path: 'attachment:sha256:' + '0'.repeat(64) }));
});
