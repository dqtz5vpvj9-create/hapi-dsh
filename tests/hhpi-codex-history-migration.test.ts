/** Real source indexes and projector; the accepted native records are synthetic. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import { CodexAttachments } from '../src/remote/codex-attachments.ts';
import { CodexHistory } from '../src/remote/codex-history.ts';
import { migrateLegacyCodexHistory } from '../src/remote/codex-history-migration.ts';
import type { NativeThread } from '../src/remote/codex-native.ts';
import type { CodexRpc } from '../src/remote/codex-rpc.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import { sourceSessionId, type SourcePage, type SourceSession } from '../src/remote/protocol.ts';

const key = (...parts: string[]): string => JSON.stringify(parts);
const checkpointKey = 'native-history-checkpoint:v1';
const identity = { machineId: 'migration-machine', sourceId: 'native', engine: 'codex', nativeId: 'native-thread' };
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic migration', cwd: '/synthetic', updatedAt: 30_000,
    status: 'idle', activeTurnId: null, capabilities: { send: false, steer: false, cancel: false, approve: false, files: false }, pendingRequests: [] };
const thread: NativeThread = { id: identity.nativeId, cwd: session.cwd, createdAt: 1, updatedAt: 30, status: { type: 'idle' } };
const checkpoint = { version: 1, state: 'complete', updatedAt: 30, statusType: 'idle' };

async function fixture(run: (path: string, destination: CodexHistory, oldEpoch: string) => void): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'hhpi-codex-migration-')), path = join(directory, 'old.sqlite');
    const old = new SourceEventIndex(path, session), oldHistory = new CodexHistory(old);
    const turn = { id: 'turn-z', status: 'completed' as const, startedAt: 1, completedAt: 12 };
    oldHistory.beginTurn(session, turn);
    oldHistory.acceptItems(session, [
        { turnId: turn.id, startedAtMs: 2000, item: { id: 'user-z', type: 'userMessage', content: [{ type: 'text', text: 'Question' }] } },
        { turnId: turn.id, startedAtMs: 3000, completedAtMs: 9000, item: { id: 'tool-z', type: 'commandExecution', command: 'printf hello',
            commandActions: [{ type: 'unknown', command: 'printf hello' }], aggregatedOutput: 'hello', exitCode: 0, durationMs: 6000 } },
        { turnId: turn.id, startedAtMs: 10_000, completedAtMs: 11_000, item: { id: 'answer-a', type: 'agentMessage', text: 'Native answer' } },
    ], true);
    oldHistory.acceptTurn(session, turn);
    old.edit(session, () => {
        old.cache('turn-order', [turn.id]); old.cache(checkpointKey, checkpoint);
        old.cache(`tail:${turn.id}`, { last: 'answer-a', previous: 'tool-z' });
        // v1 did not retain completion timestamps in its raw ItemState.
        for (const id of ['tool-z', 'answer-a']) {
            const itemKey = key('item', turn.id, id), state = old.cached<Record<string, unknown>>(itemKey)!;
            delete state.completedAtMs; old.cache(itemKey, state);
        }
        // A turn that originally lacked a native start timestamp retains its accepted time.
        old.cache(key('turn', turn.id), { turn: { id: turn.id, status: turn.status, completedAt: turn.completedAt }, time: 1000 });
        const messageKey = key(key('item', turn.id, 'answer-a'), 'message'), entry = old.entry(messageKey)!;
        assert.equal(entry.event.type, 'assistant/message');
        if (entry.event.type !== 'assistant/message') throw new Error('Fixture assistant missing');
        const { seq: _seq, ...event } = entry.event;
        old.put(messageKey, { ...event, data: { ...event.data, message: { ...event.data.message, content: [{ type: 'text', text: 'Legacy placeholder' }] } } },
            [key('turn', turn.id, 'start'), key(key('item', turn.id, 'answer-a'), 'step/start')]);
    });
    const oldEpoch = old.epoch;
    old.dispose();
    const destination = new CodexHistory(new SourceEventIndex(':memory:', session));
    try { run(path, destination, oldEpoch); }
    finally { destination.index.dispose(); await rm(directory, { recursive: true, force: true }); }
}

function mutate(path: string, change: (db: DatabaseSync) => void): void {
    const db = new DatabaseSync(path);
    try { change(db); } finally { db.close(); }
}

test('an unchanged complete v1 cache reprojects native content, identity, order and timestamps locally', async () => {
    await fixture((path, history, oldEpoch) => {
        const originalBytes = readFileSync(path);
        // Opening the legacy file itself is read only, including its SQLite journal mode.
        const legacy = new DatabaseSync(path, { readOnly: true });
        const before = legacy.prepare('SELECT value FROM metadata WHERE key=?').get('version')!.value;
        legacy.close();
        assert.equal(migrateLegacyCodexHistory(path, history, session, thread), true);
        assert.notEqual(history.index.epoch, oldEpoch);
        const page = history.index.read({ sessionId: session.id, limit: 100 });
        const text = JSON.stringify(page.entries);
        assert.match(text, /Native answer/); assert.doesNotMatch(text, /Legacy placeholder/);
        assert.ok(text.indexOf('user-z') < text.indexOf('tool-z') && text.indexOf('tool-z') < text.indexOf('answer-a'));
        assert.match(text, /codex:native-thread:turn-z:tool-z/);
        const result = page.entries.find(entry => entry.event.type === 'tool/result')!.event;
        assert.equal(result.type, 'tool/result');
        if (result.type === 'tool/result') assert.match(JSON.stringify(result.data.message.content), /exitCode/);
        assert.equal(history.index.entry(key('turn', 'turn-z', 'start'))!.event.time, 1000);
        assert.equal(history.index.entry(key(key('item', 'turn-z', 'tool-z'), 'step/end'))!.event.time, 9000);
        assert.equal(history.index.entry(key(key('item', 'turn-z', 'answer-a'), 'step/end'))!.event.time, 11_000);
        assert.deepEqual(history.index.cached(checkpointKey), checkpoint);
        assert.deepEqual(history.index.cached('tail:turn-z'), { last: 'answer-a', previous: 'tool-z' });
        const unchanged = new DatabaseSync(path, { readOnly: true });
        assert.equal(unchanged.prepare('SELECT value FROM metadata WHERE key=?').get('version')!.value, before);
        assert.match(String(unchanged.prepare('SELECT event FROM events WHERE source_key=?').get(key(key('item', 'turn-z', 'answer-a'), 'message'))!.event), /Legacy placeholder/);
        unchanged.close();
        assert.deepEqual(readFileSync(path), originalBytes);
        assert.equal(migrateLegacyCodexHistory(path, history, session, thread), false, 'an existing destination is never replaced');
    });
});

test('unverified or incomplete legacy caches leave the destination untouched for an authoritative scan', async t => {
    const cases: Array<[string, (db: DatabaseSync) => void]> = [
        ['changed revision', db => { db.prepare('UPDATE native_cache SET value=? WHERE key=?').run(JSON.stringify({ ...checkpoint, updatedAt: 29 }), checkpointKey); }],
        ['changed native status', db => { db.prepare('UPDATE native_cache SET value=? WHERE key=?').run(JSON.stringify({ ...checkpoint, statusType: 'active' }), checkpointKey); }],
        ['unfinished checkpoint', db => { db.prepare('UPDATE native_cache SET value=? WHERE key=?').run(JSON.stringify({ ...checkpoint, state: 'building' }), checkpointKey); }],
        ['missing turn order', db => { db.prepare('DELETE FROM native_cache WHERE key=?').run('turn-order'); }],
        ['duplicate turn', db => { db.prepare('UPDATE native_cache SET value=? WHERE key=?').run(JSON.stringify(['turn-z', 'turn-z']), 'turn-order'); }],
        ['missing native item', db => { db.prepare('DELETE FROM native_cache WHERE key=?').run(key('item', 'turn-z', 'answer-a')); }],
        ['missing completed event', db => { db.prepare('DELETE FROM events WHERE source_key=?').run(key(key('item', 'turn-z', 'tool-z'), 'step/end')); }],
        ['wrong native scope', db => { db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({ ...session, nativeId: 'other-thread' }), 'session'); }],
    ];
    for (const [name, change] of cases) await t.test(name, () => fixture((path, history) => {
        mutate(path, change);
        const epoch = history.index.epoch;
        assert.equal(migrateLegacyCodexHistory(path, history, session, thread), false);
        assert.equal(history.index.count, 0); assert.equal(history.index.version, 0); assert.equal(history.index.epoch, epoch);
        assert.equal(history.index.cached(checkpointKey), undefined); assert.equal(history.index.cached('turn-order'), undefined);
    }));
});

test('the entire new projection is validated before the first durable import', async () => {
    await fixture((path, history) => {
        mutate(path, db => {
            const itemKey = key('item', 'turn-z', 'answer-a');
            const state = JSON.parse(String(db.prepare('SELECT value FROM native_cache WHERE key=?').get(itemKey)!.value));
            state.item.text = 'x'.repeat(4 * 1024 * 1024);
            db.prepare('UPDATE native_cache SET value=? WHERE key=?').run(JSON.stringify(state), itemKey);
        });
        assert.equal(migrateLegacyCodexHistory(path, history, session, thread), false);
        assert.equal(history.index.count, 0, 'an invalid late event must not publish earlier valid items');
        assert.equal(history.index.cached(checkpointKey), undefined);
    });
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC';
const pageImages = (page: SourcePage) => page.entries.flatMap(({ event }) => (event.type === 'user/message' ? event.data.content
    : event.type === 'tool/result' ? event.data.message.content : []).filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image'));

/** Seed the actual v2 cache and official immutable storage before making the source file unavailable. */
async function legacyImageFixture(t: TestContext, includeTool = false) {
    const directory = await mkdtemp(join(tmpdir(), 'hhpi-image-upgrade-'));
    const oldPath = join(directory, 'history', `${createHash('sha256').update(session.id).digest('hex')}.v2.sqlite`);
    const old = new SourceEventIndex(oldPath, session), lifetime = new AbortController();
    const ready = Promise.withResolvers<void>(); let published = 0;
    const attachments = new CodexAttachments(old, join(directory, 'images'), async () => ({ dataBase64: PNG }), lifetime.signal, ({ turnId, itemId }) => {
        const state = history.itemState(turnId, itemId)!;
        history.acceptItem(session, turnId, state.item, state.completed);
        if (++published === (includeTool ? 2 : 1)) ready.resolve();
    });
    const history = new CodexHistory(old, { userContent: (turnId, item) => attachments.content(turnId, item), toolContent: (turnId, item) => attachments.content(turnId, item) });
    const turn = { id: 'image-turn', status: 'completed' as const, startedAt: 1, completedAt: 12 };
    history.beginTurn(session, turn);
    history.acceptItem(session, turn.id, { id: 'image-user', type: 'userMessage', content: [{ type: 'text', text: 'A previously saved screenshot.' },
        { type: 'localImage', path: '/synthetic/removed-after-v2.png' }] }, true);
    if (includeTool) history.acceptItem(session, turn.id, { id: 'image-tool', type: 'imageView', path: '/synthetic/removed-preview.png' }, true);
    history.acceptTurn(session, turn);
    old.edit(session, () => { old.cache('turn-order', [turn.id]); old.cache(checkpointKey, checkpoint); });
    attachments.schedule(old.read({ sessionId: session.id, limit: 100 }).entries);
    await ready.promise; await attachments.dispose(); lifetime.abort();
    const reference = pageImages(old.read({ sessionId: session.id, limit: 100 }))[0]!.attachment, oldEpoch = old.epoch;
    old.dispose();
    let sourceImageReads = 0;
    const calls: string[] = [];
    const rpc = {
        online: true, currentGeneration: 1, connect: async () => ({}), dispose: async () => {},
        onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string): Promise<unknown> => {
            calls.push(method);
            if (method === 'thread/loaded/list') return { data: [thread.id], nextCursor: null };
            if (method === 'thread/list') return { data: [thread], nextCursor: null };
            if (method === 'thread/read') return { thread };
            throw new Error(`A verified cache upgrade must not call ${method}`);
        },
    } as unknown as CodexRpc;
    const adapter = new DirectCodexAdapter({ id: identity.sourceId, machineId: identity.machineId, engine: 'codex' }, directory, {
        rpc, readImage: async () => { sourceImageReads++; throw new Error('The original native image was deleted after it was saved.'); },
    });
    t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
    return { adapter, oldPath, reference, oldEpoch, calls, sourceImageReads: () => sourceImageReads };
}

test('upgrading a v2 cache preserves saved user and tool images even after their original native files disappear', { timeout: 5000 }, async t => {
    const f = await legacyImageFixture(t, true), originalBytes = readFileSync(f.oldPath);
    const page = await f.adapter.read({ sessionId: session.id, limit: 100 });
    assert.equal(pageImages(page).length, 2, 'both images are reprojected from verified immutable references during the upgrade');
    assert.notEqual(page.epoch, f.oldEpoch);
    for (const { attachment } of pageImages(page)) {
        const resource = await f.adapter.readResource({ sessionId: session.id, path: `attachment:${attachment.attachmentId}` });
        assert.equal(resource.attachment?.attachmentId, attachment.attachmentId);
        const bytes = Buffer.from(resource.content, 'base64');
        assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, attachment.attachmentId);
    }
    assert.equal(f.sourceImageReads(), 0, 'upgrading must not reread a deleted source image whose accepted bytes were already saved');
    assert.equal(f.calls.some(method => method === 'thread/items/list' || method === 'thread/turns/list' || method.startsWith('fs/')), false);
    assert.deepEqual(readFileSync(f.oldPath), originalBytes);
});

test('cache upgrades do not reauthorize revoked, mismatched or malformed saved image references', { timeout: 5000 }, async t => {
    const contentKey = key('codex-image-content', 'image-turn', 'image-user');
    const cases: Array<[string, (db: DatabaseSync) => void]> = [
        ['stale native fingerprint', db => {
            const value = JSON.parse(String(db.prepare('SELECT value FROM native_cache WHERE key=?').get(contentKey)!.value));
            value.fingerprint = 'stale'; db.prepare('UPDATE native_cache SET value=? WHERE key=?').run(JSON.stringify(value), contentKey);
        }],
        ['grant for another turn', db => {
            const row = db.prepare("SELECT key,value FROM native_cache WHERE key LIKE 'codex-image-grants:%'").get()!;
            const value = JSON.parse(String(row.value)); value[0].turnId = 'another-turn';
            db.prepare('UPDATE native_cache SET value=? WHERE key=?').run(JSON.stringify(value), String(row.key));
        }],
        ['invalid official image reference', db => {
            const value = JSON.parse(String(db.prepare('SELECT value FROM native_cache WHERE key=?').get(contentKey)!.value));
            value.content.find((block: { type: string }) => block.type === 'image').attachment.width = 0;
            db.prepare('UPDATE native_cache SET value=? WHERE key=?').run(JSON.stringify(value), contentKey);
        }],
        ['native item no longer references an image', db => {
            const nativeKey = key('item', 'image-turn', 'image-user');
            const value = JSON.parse(String(db.prepare('SELECT value FROM native_cache WHERE key=?').get(nativeKey)!.value));
            value.item.content = [{ type: 'text', text: 'The native image was removed.' }]; delete value.presentationContent;
            db.prepare('UPDATE native_cache SET value=? WHERE key=?').run(JSON.stringify(value), nativeKey);
        }],
    ];
    for (const [name, change] of cases) await t.test(name, async t => {
        const f = await legacyImageFixture(t);
        mutate(f.oldPath, change);
        const originalBytes = readFileSync(f.oldPath), page = await f.adapter.read({ sessionId: session.id, limit: 100 });
        assert.equal(pageImages(page).length, 0);
        await assert.rejects(f.adapter.readResource({ sessionId: session.id, path: `attachment:${f.reference.attachmentId}` }), { code: 'INVALID_REQUEST' });
        assert.deepEqual(readFileSync(f.oldPath), originalBytes);
    });
});
