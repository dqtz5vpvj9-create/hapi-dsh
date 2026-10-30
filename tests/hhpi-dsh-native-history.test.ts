import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { apply as applyJsonlPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { DirectDshHistory, pageNativeEvents } from '../src/remote/dsh-history.ts';
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts';

const nativeId = 'native-history-contract';
const sourceIdentity = { machineId: 'fixture-machine', sourceId: 'native-dsh', engine: 'dsh', nativeId } as const;
const source: SourceSession = {
    ...sourceIdentity, id: sourceSessionId(sourceIdentity), title: 'Native DSH fixture', cwd: '/synthetic', updatedAt: 1,
    status: 'running', activeTurnId: '1', capabilities: { send: false, steer: false, cancel: false, approve: false, files: false }, pendingRequests: [],
};
const callId = ToolCallId('native-history-tool-call');
const timeBase = 1_800_000_000_000;

function nativeEvents(): SessionEvent[] {
    const events: SessionEvent[] = [];
    const add = (type: string, data: unknown, extra: Record<string, unknown> = {}): void => {
        const seq = events.length;
        events.push({ type, seq: SessionSeq(seq), time: timeBase + seq, data, ...extra } as SessionEvent);
    };
    add('turn/start', { turn: 1 });
    add('step/start', { turn: 1, step: 1 });
    add('assistant/message', {
        turn: 1, step: 1,
        message: createAssistantMessage({
            content: [{ type: 'tool-call', id: callId, name: 'fixture_tool', arguments: '{}' }],
            source: { provider: 'fixture', model: 'fixture-model' },
        }),
        stream: [],
    }, { surfaceOp: 'append' });
    add('tool/call', { turn: 1, step: 1, callId, name: 'fixture_tool', arguments: '{}' });
    for (let index = 0; index < 1000; index++) add('plugin:fixture/heartbeat', { index }, { ignorable: true });
    add('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'fixture result' }], isError: false }),
    }, { surfaceOp: 'append' });
    add('step/end', { turn: 1, step: 1 });
    add('turn/end', { turn: 1, reason: { kind: 'completed' } });
    return events;
}

test('DirectDshHistory reads original native events, pages them without resequencing, and leaves write ownership with the native writer', async t => {
    const root = await mkdtemp(join('/mnt/cache/data-cache', 'hhpi-direct-dsh-history-'));
    const ownerContext = new Context();
    await ownerContext.plugin(applyJsonlPersistence, { root, compression: 'zstd' });
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId(nativeId), createdAt: timeBase, cwd: '/synthetic', isSeeded: false };
    const writer = await ownerContext.sessionPersistence.create(header);
    const events = nativeEvents();
    await writer.append(events);
    await writer.flush();
    const reader = new DirectDshHistory(root);
    t.after(async () => {
        await reader.dispose();
        await writer.close();
        await ownerContext.fiber.dispose();
        await rm(root, { recursive: true, force: true });
    });

    await t.test('official catalog and bounded reads expose the writer-owned log unchanged', async () => {
        const listed = await reader.list();
        const listedSession = listed.find(item => item.header.id === nativeId);
        assert.ok(listedSession);
        assert.equal(listedSession.header.createdAt, header.createdAt);

        const batch = await reader.readEvents(nativeId, 2, 4);
        assert.deepEqual(batch.events.map(event => event.seq), [2, 3, 4, 5]);
        assert.equal(batch.events[1]?.type, 'tool/call');
        assert.equal(batch.events[1]?.type === 'tool/call' ? batch.events[1].data.callId : undefined, callId);
        assert.equal(batch.offset, 2);
        assert.equal((await reader.stat(nativeId))?.revision, batch.revision);

        const first = await reader.read(source, { sessionId: source.id, limit: 4 });
        const body = first.entries.filter(entry => !first.context.includes(entry.event.seq));
        assert.deepEqual(body.map(entry => entry.event.seq), [1003, 1004, 1005, 1006]);
        assert.deepEqual(first.entries.find(entry => entry.event.seq === 1004)?.event, events[1004]);
    });

    await t.test('six earlier pages are contiguous and keep every native sequence', async () => {
        let before: number | undefined;
        let priorFirst: number | undefined;
        const observed: number[] = [];
        for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
            const page = await reader.read(source, { sessionId: source.id, limit: 160, ...(before === undefined ? {} : { before }) });
            const body = page.entries.filter(entry => !page.context.includes(entry.event.seq)).map(entry => entry.event.seq);
            assert.equal(body.length, 160);
            assert.equal(page.version, events.length);
            if (priorFirst !== undefined) assert.equal(body.at(-1), priorFirst - 1);
            assert.deepEqual(body, Array.from({ length: 160 }, (_, index) => (1007 - (pageIndex + 1) * 160) + index));
            observed.push(...body);
            priorFirst = page.before ?? undefined;
            before = page.before ?? undefined;
        }
        assert.equal(observed.length, 960);
        assert.equal(new Set(observed).size, observed.length);
        assert.deepEqual(observed.slice().sort((left, right) => left - right), Array.from({ length: 960 }, (_, index) => index + 47));
    });

    await t.test('a page containing a tool result carries its earlier assistant, call, turn, and step context', async () => {
        const snapshot = await reader.snapshot(source);
        assert.equal(snapshot.epoch, `${source.id}:${header.createdAt}`);
        const page = await reader.read(source, { sessionId: source.id, before: 1005, limit: 160, epoch: snapshot.epoch });
        assert.equal(page.before, 845);
        assert.equal(page.after, 1004);
        assert.deepEqual(page.context, [0, 1, 2, 3]);
        assert.equal(page.entries.find(entry => entry.event.seq === 2)?.event.type, 'assistant/message');
        assert.equal(page.entries.find(entry => entry.event.seq === 3)?.event.type, 'tool/call');
        assert.ok(page.entries.some(entry => entry.event.type === 'tool/result' && entry.event.seq === 1004));
        assert.equal(page.context.includes(page.before), false);

        const callPage = pageNativeEvents(source, snapshot, { sessionId: source.id, before: 4, limit: 1 });
        assert.equal(callPage.before, 3);
        assert.equal(callPage.after, 3);
        assert.deepEqual(callPage.context, [0, 1, 2]);
    });

    await t.test('a stable native revision shares its in-memory prefix, then publishes only new original seqs', async () => {
        const original = await reader.snapshot(source);
        const cached = await reader.snapshot(source);
        assert.strictEqual(cached.events, original.events);
        assert.equal(cached.revision, original.revision);

        const nextSeq = events.length;
        await writer.append([{ type: 'plugin:fixture/heartbeat', seq: SessionSeq(nextSeq), time: timeBase + nextSeq,
            data: { index: 1000 }, ignorable: true } as SessionEvent]);
        await writer.flush();

        const updated = await reader.snapshot(source);
        assert.notEqual(updated.revision, original.revision);
        assert.equal(updated.version, original.version + 1);
        assert.equal(updated.events.at(-1)?.seq, nextSeq);
        const frame = await reader.changes(source, { sessionId: source.id, epoch: original.epoch, version: original.version });
        assert.ok(frame);
        assert.equal(frame.reset, false);
        assert.deepEqual(frame.upserts.map(entry => entry.event.seq), [nextSeq]);
        const newest = await reader.read(source, { sessionId: source.id, limit: 1, epoch: updated.epoch });
        assert.equal(newest.entries.find(entry => !newest.context.includes(entry.event.seq))?.event.seq, nextSeq);
    });

    await t.test('read-only native access neither acquires nor releases the live writer lock', async () => {
        const rival = new Context();
        await rival.plugin(applyJsonlPersistence, { root, compression: 'zstd' });
        try {
            await assert.rejects(rival.sessionPersistence.open(SessionId(nativeId), 'write'), { name: 'SessionAlreadyOwnedError' });
            const latest = await reader.readEvents(nativeId, events.length, 1);
            assert.equal(latest.events.length, 1);
            assert.equal(latest.events[0]?.seq, events.length);
            await assert.rejects(rival.sessionPersistence.open(SessionId(nativeId), 'write'), { name: 'SessionAlreadyOwnedError' });
            const ownerRead = await writer.read(0, 1);
            assert.equal(ownerRead.events[0]?.seq, 0);
        } finally { await rival.fiber.dispose(); }
    });

    await t.test('canonical source identity and epoch are required for page and change reads', async () => {
        await assert.rejects(reader.read({ ...source, nativeId: 'other-session' }, { sessionId: source.id }), { code: 'INVALID_REQUEST' });
        await assert.rejects(reader.read(source, { sessionId: `${source.id}-other` }), { code: 'INVALID_REQUEST' });
        const snapshot = await reader.snapshot(source);
        await assert.rejects(reader.read(source, { sessionId: source.id, epoch: `${snapshot.epoch}-old` }), { code: 'STALE_VERSION' });
        const reset = await reader.changes(source, { sessionId: source.id, epoch: `${snapshot.epoch}-old`, version: snapshot.version });
        assert.equal(reset?.reset, true);
    });
});
