/** Completed source-owned native indexes are reused only at a matching idle revision. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DirectCodexAdapter } from '../src/remote/codex-adapter.ts';
import type { CodexRpc } from '../src/remote/codex-rpc.ts';
import { CodexHistory } from '../src/remote/codex-history.ts';
import { SourceEventIndex } from '../src/remote/event-index.ts';
import type { NativeTurn } from '../src/remote/codex-native.ts';
import { sourceSessionId, type DirectCodexConfig, type SourceSession } from '../src/remote/protocol.ts';

const checkpointKey = 'native-history-checkpoint:v1';
const source = { sourceId: 'native', machineId: 'same-machine', engine: 'codex', nativeId: 'existing-thread' } as const;
const sourceId = sourceSessionId(source);
const thread = (directory: string, updatedAt: number, statusType: string) => ({ id: source.nativeId, cwd: directory, name: 'Synthetic history',
    createdAt: 1, updatedAt, status: { type: statusType } });
const turns: NativeTurn[] = [
    { id: 'turn-1', status: 'completed' as const, startedAt: 1, completedAt: 2 },
    { id: 'turn-2', status: 'completed' as const, startedAt: 3, completedAt: 4 },
];
const entriesFor = (turnId: string, answer: string) => [
    { turnId, startedAtMs: 1000, item: { id: `${turnId}-user`, type: 'userMessage', content: [{ type: 'text', text: `Question ${turnId}` }] } },
    { turnId, startedAtMs: 2000, completedAtMs: 3000, item: { id: `${turnId}-assistant`, type: 'agentMessage', text: answer } },
];

interface NativeFixture {
    directory: string;
    updatedAt: number;
    statusType: string;
    turns: NativeTurn[];
    answers: Map<string, string>;
}

function makeRpc(fixture: NativeFixture, calls: Array<{ method: string; params: Record<string, unknown> }>): CodexRpc {
    const nativeThread = (): ReturnType<typeof thread> => thread(fixture.directory, fixture.updatedAt, fixture.statusType);
    return {
        online: true, currentGeneration: 1,
        connect: async () => ({}), dispose: async () => {},
        onNotification: () => () => {}, onRequest: () => () => {}, onDisconnect: () => () => {},
        request: async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            if (method === 'thread/loaded/list') return { data: [source.nativeId], nextCursor: null };
            if (method === 'thread/list') {
                assert.equal(params.useStateDbOnly, true);
                return { data: [nativeThread()], nextCursor: null };
            }
            if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread: nativeThread() }; }
            if (method === 'thread/turns/list') {
                assert.equal(params.itemsView, 'notLoaded');
                return { data: fixture.turns, nextCursor: null };
            }
            if (method === 'thread/items/list') {
                const turnId = String(params.turnId);
                return { data: entriesFor(turnId, fixture.answers.get(turnId) ?? `Answer ${turnId}`), nextCursor: null };
            }
            throw new Error(`Unexpected native read operation: ${method}`);
        },
    } as unknown as CodexRpc;
}

function adapterFor(directory: string, fixture: NativeFixture, calls: Array<{ method: string; params: Record<string, unknown> }>): DirectCodexAdapter {
    const config: DirectCodexConfig = { id: source.sourceId, machineId: source.machineId, engine: source.engine, ownership: 'shared' };
    return new DirectCodexAdapter(config, directory, { rpc: makeRpc(fixture, calls) });
}

async function readOnce(adapter: DirectCodexAdapter): Promise<{ session: SourceSession; text: string }> {
    const [session] = await adapter.list();
    assert.ok(session);
    const page = await adapter.read({ sessionId: session.id, limit: 100 });
    return { session, text: JSON.stringify(page.entries) };
}

function databasePath(directory: string): string {
    const hash = createHash('sha256').update(sourceId).digest('hex');
    return join(directory, 'history', `${hash}.sqlite`);
}

async function removeCheckpoint(directory: string, session: SourceSession): Promise<void> {
    const index = new SourceEventIndex(databasePath(directory), session);
    try { index.edit(session, () => index.forget(checkpointKey)); }
    finally { index.dispose(); }
}

function fixture(directory: string, updatedAt = 10, statusType = 'idle', nativeTurns: NativeTurn[] = [...turns]): NativeFixture {
    return { directory, updatedAt, statusType, turns: nativeTurns, answers: new Map() };
}

test('a complete idle native index reopens without turn or item scans at the same revision', async () => {
    const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hhpi-history-checkpoint-'));
    const native = fixture(directory), initialCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let adapter = adapterFor(directory, native, initialCalls);
    try {
        const first = await readOnce(adapter);
        assert.match(first.text, /Answer turn-1/);
        assert.equal(initialCalls.filter(call => call.method === 'thread/items/list').length, turns.length);
        await adapter.dispose();

        const reopenedCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
        adapter = adapterFor(directory, native, reopenedCalls);
        const reopened = await readOnce(adapter);
        assert.equal(reopened.text, first.text);
        assert.deepEqual(reopenedCalls.map(call => call.method).filter(method => method === 'thread/read'), ['thread/read']);
        assert.equal(reopenedCalls.some(call => call.method === 'thread/turns/list' || call.method === 'thread/items/list'), false,
            'a verified checkpoint serves the persistent DSH event page directly');
    } finally { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('a complete active snapshot reopens from cache and leaves new tail work to the running refresh', async () => {
    const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hhpi-history-active-'));
    const activeTurns: NativeTurn[] = [turns[0]!, { id: 'turn-active', status: 'inProgress', startedAt: 5 }];
    const native = fixture(directory, 10, 'active', activeTurns), initialCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let adapter = adapterFor(directory, native, initialCalls);
    try {
        await readOnce(adapter);
        assert.equal(initialCalls.filter(call => call.method === 'thread/items/list').length, activeTurns.length);
        await adapter.dispose();

        const reopenedCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
        adapter = adapterFor(directory, native, reopenedCalls);
        await readOnce(adapter);
        assert.equal(reopenedCalls.some(call => call.method === 'thread/turns/list' || call.method === 'thread/items/list'), false,
            'an unchanged active revision reuses its completed checkpoint instead of rescanning hundreds of turns');
    } finally { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('a legacy complete index adopts a checkpoint after matching idle turn headers without rereading bodies', async () => {
    const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hhpi-history-legacy-'));
    const native = fixture(directory), firstCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let adapter = adapterFor(directory, native, firstCalls);
    try {
        const first = await readOnce(adapter);
        await adapter.dispose();
        await removeCheckpoint(directory, first.session);

        const adoptionCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
        adapter = adapterFor(directory, native, adoptionCalls);
        const adopted = await readOnce(adapter);
        assert.equal(adopted.text, first.text);
        assert.equal(adoptionCalls.filter(call => call.method === 'thread/turns/list').length, 1,
            'a legacy index is validated against lightweight native turn headers once');
        assert.equal(adoptionCalls.some(call => call.method === 'thread/items/list'), false,
            'matching complete legacy history upgrades without the 50-second item replay');
        await adapter.dispose();

        const reuseCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
        adapter = adapterFor(directory, native, reuseCalls);
        await readOnce(adapter);
        assert.equal(reuseCalls.some(call => call.method === 'thread/turns/list' || call.method === 'thread/items/list'), false,
            'the adopted checkpoint is durable for later Host starts');
    } finally { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('a changed native revision invalidates the checkpoint and refreshes event content', async () => {
    const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hhpi-history-revision-'));
    const native = fixture(directory), firstCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let adapter = adapterFor(directory, native, firstCalls);
    try {
        await readOnce(adapter);
        await adapter.dispose();
        native.updatedAt++;
        native.answers.set('turn-1', 'Revised answer');
        const changedCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
        adapter = adapterFor(directory, native, changedCalls);
        const changed = await readOnce(adapter);
        assert.match(changed.text, /Revised answer/);
        assert.equal(changedCalls.filter(call => call.method === 'thread/items/list').length, turns.length);
    } finally { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('an interrupted full build is marked incomplete and must finish before it can be reused', async () => {
    const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hhpi-history-incomplete-'));
    const native = fixture(directory), session: SourceSession = { ...source, id: sourceId, title: 'Synthetic history', cwd: directory,
        updatedAt: native.updatedAt * 1000, status: 'idle', activeTurnId: null,
        capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, pendingRequests: [] };
    const index = new SourceEventIndex(databasePath(directory), session), history = new CodexHistory(index);
    try {
        index.edit(session, () => index.cache(checkpointKey, { version: 1, state: 'building', updatedAt: native.updatedAt, statusType: 'idle' }));
        history.beginTurn(session, turns[0]!);
        history.acceptItem(session, turns[0]!.id, { id: 'partial-item', type: 'userMessage', content: [{ type: 'text', text: 'Partial build' }] }, true);
    } finally { index.dispose(); }

    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const adapter = adapterFor(directory, native, calls);
    try {
        const result = await readOnce(adapter);
        assert.match(result.text, /Answer turn-2/);
        assert.equal(calls.filter(call => call.method === 'thread/items/list').length, turns.length,
            'building state never claims that a partial index is complete');
    } finally { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('a legacy index with a missing turn header falls back to full reconciliation', async () => {
    const directory = await mkdtemp(join('/mnt/cache/data-cache', 'hhpi-history-legacy-partial-'));
    const native = fixture(directory), firstCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let adapter = adapterFor(directory, native, firstCalls);
    try {
        const first = await readOnce(adapter);
        await adapter.dispose();
        const index = new SourceEventIndex(databasePath(directory), first.session);
        try { index.edit(first.session, () => { index.forget(checkpointKey); index.cache('turn-order', ['turn-1']); }); }
        finally { index.dispose(); }

        const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
        adapter = adapterFor(directory, native, calls);
        await readOnce(adapter);
        assert.equal(calls.filter(call => call.method === 'thread/items/list').length, turns.length,
            'header mismatch is treated as an incomplete legacy cache');
    } finally { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); }
});
