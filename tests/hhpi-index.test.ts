import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceEventIndex, type EventInput } from '../src/remote/event-index.ts';
import { CodexHistory } from '../src/remote/codex-history.ts';
import { sourceSessionId, type SourceSession } from '../src/remote/protocol.ts';

const identity = { machineId: 'synthetic-machine', sourceId: 'synthetic-source', engine: 'codex', nativeId: 'synthetic-thread' };
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic source index', cwd: '/synthetic', updatedAt: 1000,
    status: 'idle', activeTurnId: null, capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, pendingRequests: [] };
const user = (id: number, text = `readable-${id}`): EventInput => ({ type: 'user/message', time: 1000, surfaceOp: 'append',
    data: { id: `message-${id}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } } as EventInput);

test('source index persists stable identities, revised text, replay baseline and page reuse without renormalization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hhpi-index-'));
    let index = new SourceEventIndex(join(directory, 'history.sqlite'), session);
    try {
        index.edit(session, () => { for (let i = 1; i <= 1200; i++) index.put(`item-${i}`, user(i)); });
        const baseline = index.read({ sessionId: session.id });
        const version = index.version, epoch = index.epoch, original = index.sequence('item-1190');
        index.edit(session, () => { index.put('item-1190', user(1190, 'revised')); });
        assert.equal(index.sequence('item-1190'), original);
        const abort = new AbortController(), iterator = index.changes({ sessionId: session.id, epoch, version }, abort.signal)[Symbol.asyncIterator]();
        const next = await iterator.next(); assert.equal(next.value!.upserts[0]!.event.seq, original); assert.equal(next.value!.base, version);
        abort.abort(); await iterator.return?.();
        let page = baseline;
        for (let i = 0; i < 6; i++) { const before = page.before!; page = index.read({ sessionId: session.id, before, epoch }); assert.ok(page.before! < before); }
        assert.equal(index.version, version + 1, 'paging does not modify source order or its version');
        index.dispose(); index = new SourceEventIndex(join(directory, 'history.sqlite'), session);
        assert.equal(index.sequence('item-1190'), original); assert.equal(index.epoch, epoch); assert.equal(index.version, version + 1);
        assert.ok(original);
        const revised = index.read({ sessionId: session.id, around: original });
        assert.ok(JSON.stringify(revised.entries).includes('revised'));
    } finally { index.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('a tool crossing a page carries its original turn, step and call dependencies before its body', () => {
    const index = new SourceEventIndex(':memory:', session), history = new CodexHistory(index);
    try {
        history.beginTurn(session, { id: 'turn-a', status: 'inProgress' });
        history.acceptItem(session, 'turn-a', { id: 'command-a', type: 'commandExecution', command: 'echo synthetic', cwd: '/synthetic', aggregatedOutput: 'synthetic\n', status: 'completed' }, true);
        const all = index.read({ sessionId: session.id });
        const result = all.entries.find(entry => entry.event.type === 'tool/result')!;
        const page = index.read({ sessionId: session.id, around: result.event.seq, limit: 1 });
        assert.equal(page.entries.at(-1)!.event.type, 'tool/result');
        assert.deepEqual(page.entries.slice(0, -1).map(entry => entry.event.type), ['turn/start', 'step/start', 'assistant/message', 'tool/call']);
        assert.equal(page.before, result.event.seq); assert.equal(page.after, result.event.seq);
        assert.equal(page.context.length, 4);
    } finally { index.dispose(); }
});

test('stream completion revises the same official message and native rollback revokes obsolete cursors', () => {
    const index = new SourceEventIndex(':memory:', session), history = new CodexHistory(index);
    try {
        history.beginTurn(session, { id: 'turn-a', status: 'inProgress' });
        history.acceptItem(session, 'turn-a', { id: 'answer-a', type: 'agentMessage', text: 'partial' }, false);
        const first = index.read({ sessionId: session.id }), message = first.entries.find(entry => entry.event.type === 'assistant/message')!;
        history.acceptItem(session, 'turn-a', { id: 'answer-a', type: 'agentMessage', text: 'complete' }, true);
        const final = index.read({ sessionId: session.id }).entries.find(entry => entry.event.type === 'assistant/message')!;
        assert.equal(final.event.seq, message.event.seq);
        assert.equal((final.event.data as { message: { id: string } }).message.id, (message.event.data as { message: { id: string } }).message.id);
        history.acceptItem(session, 'turn-a', { id: 'answer-a', type: 'agentMessage', text: 'late-partial' }, false);
        assert.ok(!JSON.stringify(index.read({ sessionId: session.id })).includes('late-partial'));
        history.invalidateSuffix(session, ['turn-a']);
        assert.throws(() => index.read({ sessionId: session.id, epoch: first.epoch }), { code: 'STALE_VERSION' });
        assert.equal(index.count, 0);
        history.beginTurn(session, { id: 'turn-b', status: 'inProgress' });
        history.acceptItem(session, 'turn-b', { id: 'answer-b', type: 'agentMessage', text: 'new source history' }, true);
        assert.ok(index.read({ sessionId: session.id }).entries[0]!.event.seq > final.event.seq, 'a rewrite never reuses a removed source sequence');
    } finally { index.dispose(); }
});

test('foreign identities and failed source transactions leave accepted history unchanged', () => {
    const index = new SourceEventIndex(':memory:', session);
    try {
        index.edit(session, () => index.put('one', user(1)));
        const baseline = index.read({ sessionId: session.id });
        assert.throws(() => index.read({ sessionId: sourceSessionId({ ...identity, machineId: 'another-machine' }) }), { code: 'INVALID_REQUEST' });
        assert.throws(() => index.edit(session, () => { index.put('two', user(2)); index.put('three', user(3), ['unknown']); }), { code: 'INVALID_REQUEST' });
        assert.deepEqual(index.read({ sessionId: session.id }), baseline);
    } finally { index.dispose(); }
});
