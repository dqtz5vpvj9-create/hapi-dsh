/** Real source indexes and projector; the accepted native records are synthetic. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CodexHistory } from '../src/remote/codex-history.ts';
import { migrateLegacyCodexHistory } from '../src/remote/codex-history-migration.ts';
import type { NativeThread } from '../src/remote/codex-native.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts';

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
