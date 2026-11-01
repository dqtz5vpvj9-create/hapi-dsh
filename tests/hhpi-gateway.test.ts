/** Production router; only the native adapter boundary is a synthetic fixture. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceGateway, type SourceAccess } from '../src/remote/gateway.ts';
import { sourceSessionId, type SourceAdapter, type SourceChanges, type SourcePage, type SourceReceipt, type SourceSession } from '../src/remote/protocol.ts';

const identity = { machineId: 'machine-a', sourceId: 'codex', engine: 'codex', nativeId: 'thread-a' };
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic scope', cwd: '/synthetic', updatedAt: 1, status: 'idle', activeTurnId: null,
    capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, pendingRequests: [] };
const page: SourcePage = { session, epoch: 'epoch-a', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] };
const allow: SourceAccess = () => true;
function fixture(): { adapter: SourceAdapter; calls: string[] } {
    const calls: string[] = [];
    return { calls, adapter: { id: identity.sourceId, machineId: identity.machineId, engine: identity.engine,
        list: async () => { calls.push('list'); return [session]; }, read: async () => { calls.push('read'); return page; },
        async *changes() { calls.push('changes'); yield { session, epoch: 'epoch-a', version: 2, base: 1, reset: false, upserts: [], removed: [] }; },
        operate: async request => { calls.push('operate'); return { operationId: request.operationId, sessionId: request.sessionId, status: 'accepted', message: 'Synthetic acknowledgement' }; },
        dispose: () => { calls.push('dispose'); },
    } };
}
test('source machine and canonical identity are enforced before native dispatch', async () => {
    const { adapter, calls } = fixture(), gateway = new SourceGateway([adapter], false);
    await assert.rejects(gateway.read({ sessionId: sourceSessionId({ ...identity, machineId: 'other' }) }, allow), { code: 'TARGET_UNAVAILABLE' });
    await assert.rejects(gateway.read({ sessionId: 'hhpi:bad' }, allow), { code: 'INVALID_REQUEST' });
    await assert.rejects(gateway.read({ sessionId: session.id }, () => false), { code: 'UNSUPPORTED' });
    assert.deepEqual(calls, []);
    assert.equal((await gateway.read({ sessionId: session.id }, allow)).session.id, session.id);
    await gateway.dispose(); await gateway.dispose(); assert.equal(calls.filter(call => call === 'dispose').length, 1);
});
test('catalog filters per-session grants without requiring source-wide creation rights', async () => {
    const { adapter } = fixture(), gateway = new SourceGateway([adapter], false);
    try {
        const catalog = await gateway.catalog(resource => resource.kind === 'session' && resource.id === session.id);
        assert.deepEqual(catalog.sessions, [session]); assert.deepEqual(catalog.sources, []); assert.equal(catalog.legacyHapi, false);
        assert.deepEqual((await gateway.catalog(() => false)).sessions, []);
    } finally { await gateway.dispose(); }
});
test('permission revocation during IO rejects a late history or resource response', async () => {
    const { adapter } = fixture(), gate = Promise.withResolvers<SourcePage>(), resource = Promise.withResolvers<{ encoding: 'base64'; content: string; mimeType: string }>();
    adapter.read = async () => gate.promise; adapter.readResource = async () => resource.promise;
    const gateway = new SourceGateway([adapter], false); let allowed = true;
    const pending = gateway.read({ sessionId: session.id }, () => allowed);
    const file = gateway.resource({ sessionId: session.id, path: 'synthetic' }, () => allowed);
    allowed = false; gate.resolve(page); resource.resolve({ encoding: 'base64', content: '', mimeType: 'text/plain' });
    await assert.rejects(pending, { code: 'UNSUPPORTED' }); await assert.rejects(file, { code: 'UNSUPPORTED' }); await gateway.dispose();
});
test('streaming revocation and foreign source frames fail before publication', async () => {
    const { adapter } = fixture(); let allowed = true;
    const gate = Promise.withResolvers<SourceChanges>();
    adapter.changes = async function* () { yield await gate.promise; };
    const gateway = new SourceGateway([adapter], false);
    const stream = gateway.changes({ sessionId: session.id, epoch: 'epoch-a', version: 1 }, () => allowed);
    const next = stream[Symbol.asyncIterator]().next(); allowed = false;
    gate.resolve({ session, epoch: 'epoch-a', base: 1, version: 2, reset: false, upserts: [], removed: [] });
    await assert.rejects(next, { code: 'UNSUPPORTED' });
    adapter.read = async () => ({ ...page, session: { ...session, ...identity, machineId: 'foreign', id: sourceSessionId({ ...identity, machineId: 'foreign' }) } });
    await assert.rejects(gateway.read({ sessionId: session.id }, allow), { code: 'INVALID_REQUEST' }); await gateway.dispose();
});
test('unavailable source retains offline catalog but never falls back to central Host resources', async () => {
    const { adapter, calls } = fixture(), gateway = new SourceGateway([adapter], false);
    try {
        await gateway.catalog(allow); adapter.list = async () => { throw new Error('Synthetic source outage'); };
        const catalog = await gateway.catalog(allow);
        assert.equal(catalog.sessions[0]?.status, 'offline'); assert.equal(catalog.sources[0]?.online, false);
        assert.equal(catalog.sessions[0]?.capabilities.send, false);
        await assert.rejects(gateway.resource({ sessionId: session.id, path: '/etc/passwd' }, allow), { code: 'UNSUPPORTED' });
        assert.ok(!calls.includes('read'));
    } finally { await gateway.dispose(); }
});
test('foreign acknowledgements remain indeterminate and disposed gateways reject new work', async () => {
    const { adapter } = fixture(), gateway = new SourceGateway([adapter], false);
    adapter.operate = async request => ({ operationId: request.operationId, sessionId: 'foreign', status: 'accepted', message: 'Synthetic foreign receipt' }) as SourceReceipt;
    await assert.rejects(gateway.operate({ sessionId: session.id, operationId: 'one', kind: 'cancel' }, allow), { code: 'OUTCOME_UNKNOWN' });
    await gateway.dispose(); await assert.rejects(gateway.read({ sessionId: session.id }, allow), { code: 'DISPOSED' });
});

test('revocation during a native operation or creation never publishes its late receipt', async () => {
    const { adapter } = fixture();
    const mutation = Promise.withResolvers<SourceReceipt>();
    const creation = Promise.withResolvers<import('../src/remote/protocol.ts').SourceCreationReceipt>();
    adapter.operate = async () => mutation.promise;
    adapter.create = async () => creation.promise;
    const gateway = new SourceGateway([adapter], false);
    let allowed = true;
    const access: SourceAccess = () => allowed;
    const writing = gateway.operate({ sessionId: session.id, operationId: 'request-1', kind: 'send', text: 'synthetic' }, access);
    const creating = gateway.create({ sourceId: adapter.id, operationId: 'request-2' }, access);
    allowed = false;
    mutation.resolve({ operationId: 'request-1', sessionId: session.id, status: 'accepted', message: 'Native source accepted' });
    creation.resolve({ operationId: 'request-2', sourceId: adapter.id, status: 'accepted', message: 'Created', session });
    await assert.rejects(writing, { code: 'UNSUPPORTED' });
    await assert.rejects(creating, { code: 'UNSUPPORTED' });
    await gateway.dispose();
});

test('gateway disposal before a late read or resource response rejects the stale result', async () => {
    const { adapter } = fixture();
    const pageGate = Promise.withResolvers<SourcePage>();
    const fileGate = Promise.withResolvers<{ encoding: 'base64'; content: string; mimeType: string }>();
    adapter.read = async () => pageGate.promise;
    adapter.readResource = async () => fileGate.promise;
    const gateway = new SourceGateway([adapter], false);
    const reading = gateway.read({ sessionId: session.id }, allow);
    const resource = gateway.resource({ sessionId: session.id, path: 'synthetic' }, allow);
    await gateway.dispose();
    pageGate.resolve(page);
    fileGate.resolve({ encoding: 'base64', content: '', mimeType: 'text/plain' });
    await assert.rejects(reading, { code: 'DISPOSED' });
    await assert.rejects(resource, { code: 'DISPOSED' });
});

test('a slow source cannot delay a healthy catalog and late discovery joins the same gateway', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { adapter } = fixture(), slow = fixture().adapter;
    const slowSession = { ...session, sourceId: 'slow', nativeId: 'late', id: sourceSessionId({ ...identity, sourceId: 'slow', nativeId: 'late' }) };
    const gate = Promise.withResolvers<SourceSession[]>();
    let slowCalls = 0;
    Object.assign(slow, { id: 'slow', list: async () => { slowCalls++; return gate.promise; } });
    const gateway = new SourceGateway([adapter, slow], false);
    try {
        const opening = gateway.catalog(allow);
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(100);
        const first = await opening;
        assert.deepEqual(first.sessions.map(row => row.id), [session.id]);
        assert.deepEqual(first.sources.map(row => [row.id, row.online]), [['codex', true], ['slow', false]]);

        const cached = gateway.catalog(allow);
        t.mock.timers.tick(0);
        assert.deepEqual((await cached).sessions.map(row => row.id), [session.id]);
        assert.equal(slowCalls, 1, 'repeated catalogs share the slow source discovery');

        gate.resolve([slowSession]);
        await new Promise<void>(resolve => setImmediate(resolve));
        const recovered = await gateway.catalog(resource => resource.kind === 'source' || resource.id === slowSession.id);
        assert.deepEqual(recovered.sessions.map(row => row.id), [slowSession.id], 'late results remain permission filtered');
        assert.equal(recovered.sources.find(row => row.id === 'slow')?.online, true);
    } finally { await gateway.dispose(); }
});

test('catalog cancellation releases only its caller and gateway disposal cancels shared discovery', async () => {
    const { adapter } = fixture(), gate = Promise.withResolvers<SourceSession[]>();
    let calls = 0, sourceSignal: AbortSignal | undefined;
    adapter.list = async signal => { calls++; sourceSignal = signal; return gate.promise; };
    const gateway = new SourceGateway([adapter], false);
    const cancelled = new AbortController();
    const first = gateway.catalog(allow, cancelled.signal), second = gateway.catalog(allow);
    await new Promise<void>(resolve => setImmediate(resolve));
    cancelled.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(sourceSignal?.aborted, false);
    gate.resolve([session]);
    assert.deepEqual((await second).sessions, [session]);
    assert.equal(calls, 1);

    const delayed = Promise.withResolvers<SourceSession[]>();
    adapter.list = async signal => { sourceSignal = signal; return delayed.promise; };
    const reading = gateway.catalog(allow);
    await Promise.resolve();
    const rejected = assert.rejects(reading, { code: 'DISPOSED' });
    await gateway.dispose();
    assert.equal(sourceSignal?.aborted, true);
    delayed.resolve([session]);
    await rejected;
    await assert.rejects(gateway.catalog(allow), { code: 'DISPOSED' });
});
