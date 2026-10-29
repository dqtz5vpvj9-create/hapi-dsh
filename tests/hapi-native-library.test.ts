import { tmpdir as testTemporaryRoot } from 'node:os'
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeLibrary, type NativeLibraryAgent } from '../src/hapi/native-library.ts';
import { HapiRequestError, type HapiSession } from '../src/codex/contracts.ts';
import { bindingFor, nativeSessionId } from '../src/codex/native.ts';
import { nativeSourceActionSchema } from '../src/native-library-types.ts';

/** HAPI protocol fixtures; no live Codex account or native execution is represented by these tests. */
function source(id = 'source-session', threadId = 'thread-one'): HapiSession {
    return { id, namespace: 'fixture', seq: 3, createdAt: 1, updatedAt: 3, active: true, activeAt: 2, thinking: false, thinkingAt: 2,
        metadataVersion: 1, agentStateVersion: 1, metadata: { path: '/fixture', machineId: 'machine-one', flavor: 'codex',
            codexSessionId: threadId, codexHome: '/fixture/codex', codexNativeSession: true, codexNativeConnection: 'attached',
            capabilities: { concurrentClients: true, conversationHistory: { rewindToMessage: true } } }, agentState: {} };
}
function agent(session = source(), revision = 0): NativeLibraryAgent {
    const logicalSessionId = nativeSessionId('fixture-hub', session.id);
    return { sourceSession: session, logicalSessionId, id: revision ? `${logicalSessionId}-${revision}` : logicalSessionId,
        binding: bindingFor('fixture-hub', session), projection: { readOnly: false }, refresh: async () => {}, refreshSettings: async () => {},
        resolveForkBoundary: () => undefined, resolveRewindLocalId: id => id === 'display-user' ? 'original-local-user' : undefined,
        resolveRewindLocalIdAtSeq: seq => seq === 12 ? 'original-local-user' : undefined };
}
async function harness(run: (fixture: {
    library: NativeLibrary; directory: string; current: NativeLibraryAgent;
    historyRewinds: Map<string, string>;
    calls: Array<{ path: string; method: string; body: unknown }>;
    handler: (path: string, method: string, body: unknown) => Promise<unknown>;
    reload(): NativeLibrary;
}) => Promise<void>) {
    const directory = await mkdtemp(join(testTemporaryRoot(), 'hapi-library-'));
    const fixture = {
        current: agent(), calls: [] as Array<{ path: string; method: string; body: unknown }>,
        historyRewinds: new Map<string, string>(),
        handler: async (_path: string, _method: string, _body: unknown): Promise<unknown> => ({ ok: true }),
    };
    const client = { hubId: 'fixture-hub', request: async (path: string, options?: { method?: string; body?: unknown }) => {
        const method = options?.method ?? 'GET'; fixture.calls.push({ path, method, body: options?.body }); return fixture.handler(path, method, options?.body);
    } };
    const sessions = { get: (id: string) => id === fixture.current.id || id === fixture.current.logicalSessionId ? fixture.current : undefined,
        resolveRewindMessage: (_id: string, messageId: string) => fixture.historyRewinds.get(messageId),
        reconcileSource: async () => fixture.current, refreshCatalog: async () => {} };
    const reload = () => new NativeLibrary(client, sessions, directory); const library = reload();
    try { await run(Object.assign(fixture, { directory, library, reload })); } finally { await library.settled(); await rm(directory, { recursive: true, force: true }); }
}

test('native rewind resolves a real displayed user event to the committed original localId', async () => harness(async fixture => {
    fixture.handler = async (path, method, body) => {
        assert.equal(path, '/api/sessions/source-session/rewind'); assert.equal(method, 'POST');
        assert.deepEqual(body, { messageLocalId: 'original-local-user' }); return { success: true };
    };
    const action = { operationId: randomUUID(), sessionId: fixture.current.id, action: { kind: 'rewind', displayMessageSeq: 12 } as const };
    assert.equal((await fixture.library.sourceOperation(action)).status, 'confirmed');
    assert.equal((await fixture.reload().sourceOperation(action)).status, 'confirmed');
    assert.equal(fixture.calls.length, 1);
    await assert.rejects(fixture.library.sourceOperation({ ...action, operationId: randomUUID(), action: { kind: 'rewind', displayMessageSeq: 13 } }), /committed/);
    assert.equal(fixture.calls.length, 1);
    assert.equal(nativeSourceActionSchema.safeParse({ kind: 'rewind', displayMessageSeq: 12, displayMessageId: 'display-user' }).success, false);
}));

test('a paged user message rewinds by stable message identity without a Host display coordinate', async () => harness(async fixture => {
    fixture.historyRewinds.set('paged-user-id', 'committed-history-local-id');
    fixture.handler = async (_path, _method, body) => {
        assert.deepEqual(body, { messageLocalId: 'committed-history-local-id' });
        return { success: true };
    };
    const action = { operationId: randomUUID(), sessionId: fixture.current.id,
        action: { kind: 'rewind', displayMessageId: 'paged-user-id' } as const };
    assert.equal((await fixture.library.sourceOperation(action)).status, 'confirmed');
    assert.equal((await fixture.reload().sourceOperation(action)).status, 'confirmed');
    assert.equal(fixture.calls.length, 1, 'changing views cannot resubmit the operation');
    fixture.historyRewinds.clear();
    await assert.rejects(fixture.library.sourceOperation({ ...action, operationId: randomUUID() }), /committed/);
    assert.equal(fixture.calls.length, 1, 'a revoked or forged boundary never reaches native execution');
}));

test('source mutations with an unknown result are never dispatched again after reload', async () => harness(async fixture => {
    fixture.handler = async () => { throw new HapiRequestError('Original owner response timed out', 'indeterminate', 503); };
    const request = { operationId: randomUUID(), sessionId: fixture.current.id, action: { kind: 'clear' } as const };
    assert.equal((await fixture.library.sourceOperation(request)).status, 'indeterminate');
    assert.equal((await fixture.reload().sourceOperation(request)).status, 'indeterminate');
    assert.equal(fixture.calls.length, 1);
    await assert.rejects(fixture.library.sourceOperation({ ...request, action: { kind: 'archive' } }), /different native input/);
}));

test('replacing a native binding cannot inherit or re-execute the previous thread operation', async () => harness(async fixture => {
    fixture.handler = async () => { throw new HapiRequestError('Lost response', 'indeterminate'); };
    const request = { operationId: randomUUID(), sessionId: fixture.current.id, action: { kind: 'clear' } as const };
    await fixture.library.sourceOperation(request);
    const previousId = fixture.current.id;
    fixture.current = agent(source('source-session', 'thread-two'), 1);
    assert.equal((await fixture.library.sessionTools(fixture.current.id)).operations.length, 0);
    await assert.rejects(fixture.library.sourceOperation({ ...request, sessionId: fixture.current.id }), /different native input/);
    await assert.rejects(fixture.library.sourceOperation({ ...request, operationId: randomUUID(), sessionId: previousId }), /display was replaced/);
    assert.equal(fixture.calls.length, 1);
}));

test('session pin and rewind capability use the original source fields and busy state', async () => harness(async fixture => {
    fixture.current.sourceSession.globalPinned = true;
    let state = await fixture.library.sessionTools(fixture.current.id);
    assert.equal(state.pinMode, 'global'); assert.equal(state.canRewind, true);
    fixture.current.sourceSession.thinking = true;
    state = await fixture.library.sessionTools(fixture.current.id); assert.equal(state.canRewind, false);
    const receipt = await fixture.library.sourceOperation({ operationId: randomUUID(), sessionId: fixture.current.id,
        action: { kind: 'rewind', displayMessageId: 'display-user' } });
    assert.equal(receipt.status, 'rejected'); assert.equal(fixture.calls.length, 0);
}));

test('goal responses are rejected as unconfirmed when they belong to another native thread', async () => harness(async fixture => {
    fixture.handler = async () => ({ goal: { threadId: 'other-thread', objective: 'fixture objective', status: 'active' } });
    const receipt = await fixture.library.sourceOperation({ operationId: randomUUID(), sessionId: fixture.current.id,
        action: { kind: 'goal', command: { action: 'set', objective: 'fixture objective' } } });
    assert.equal(receipt.status, 'indeterminate'); assert.match(receipt.message!, /different native thread/);
}));

test('machine account responses strip credential fields before reaching browser state or receipts', async () => harness(async fixture => {
    const account = { id: 'account', label: 'Fixture account', email: null, chatgptAccountId: 'fixture-public-account', enabled: true, updatedAt: 1, lastRefreshAt: null,
        accessToken: 'fixture-secret-never-public', refreshToken: 'fixture-refresh-never-public' };
    fixture.handler = async path => path.endsWith('/codex-homes') ? { success: true, homes: [] } : path.endsWith('/codex-accounts')
        ? { success: true, accounts: [account], currentAccountId: account.id } : { success: true, account, accessToken: account.accessToken };
    const state = await fixture.library.machineState('machine-one'); assert.equal(JSON.stringify(state).includes('never-public'), false);
    const receipt = await fixture.library.machineOperation({ operationId: randomUUID(), machineId: 'machine-one', action: { kind: 'import-account' } });
    assert.equal(receipt.status, 'confirmed'); assert.equal(JSON.stringify(receipt).includes('never-public'), false);
}));

test('read cursor updates preserve source compare-and-swap conflicts for the browser to rebase', async () => harness(async fixture => {
    fixture.handler = async (path, method, body) => {
        if (method === 'GET') return { sessions: [], readStates: { 'source-session': { version: 4, seenAt: 200, manualUnreadAt: 250 } } };
        assert.equal(path, '/api/sessions/source-session/read-state');
        assert.deepEqual(body, { expectedVersion: 3, seenAt: 300, manualUnreadAt: null });
        return { applied: false, state: { version: 4, seenAt: 200, manualUnreadAt: 250 } };
    };
    assert.equal((await fixture.library.readStates())['source-session']?.version, 4);
    const result = await fixture.library.writeReadState({ sourceSessionId: 'source-session', expectedVersion: 3, seenAt: 300, manualUnreadAt: null });
    assert.equal(result.applied, false); assert.equal(result.state.manualUnreadAt, 250);
}));

test('native catalog cannot silently use a different selected machine', async () => harness(async fixture => {
    fixture.handler = async () => ({ success: true, machineId: 'another-machine', sessions: [], nextCursor: null });
    await assert.rejects(fixture.library.library({ machineId: 'machine-one' }), /another machine/);
}));
