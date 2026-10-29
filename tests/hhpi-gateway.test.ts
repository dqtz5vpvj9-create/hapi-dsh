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
