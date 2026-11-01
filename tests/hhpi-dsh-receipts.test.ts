/** Real adapter + durable ledger; only the authenticated owner HTTP boundary is a fixture. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DirectDshAdapter } from '../src/remote/dsh-adapter.ts';
import { sourceSessionId, type DirectDshConfig, type SourceOperation } from '../src/remote/protocol.ts';
import type { HapiQueuedState } from '../src/codex/contracts.ts';

function ownerBoundary(root: string) {
    const config: DirectDshConfig = { id: 'native-dsh', machineId: 'machine', engine: 'dsh', root,
        owner: { hubId: 'original-hub', url: 'http://owner.fixture', tokenEnv: 'FIXTURE_OWNER_TOKEN' } };
    const metadata = { name: 'Original native', path: '/synthetic', flavor: 'dsh', machineId: 'machine', dshSessionId: 'native-root' };
    const sourceRow = { id: 'original-owner', metadata, active: true, thinking: false, activeAt: 100, updatedAt: 100,
        metadataVersion: 1, agentStateVersion: 0, namespace: 'fixture', seq: 0, createdAt: 100, thinkingAt: 0, agentState: {} };
    const state = { loseSendAck: false, offline: false, writes: [] as unknown[], paths: [] as string[],
        queuedState: { queuedLocalIds: [], invokedLocalMessages: [] } as HapiQueuedState };
    const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input)); state.paths.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (state.offline) throw new Error('Synthetic owner network outage');
        if (url.pathname === '/api/auth') return Response.json({ token: 'fixture-jwt' });
        if (url.pathname === '/api/sessions') return Response.json({ sessions: [sourceRow] });
        if (url.pathname === '/api/sessions/original-owner') return Response.json({ session: sourceRow });
        if (url.pathname === '/api/sessions/original-owner/messages/queued-state') {
            assert.deepEqual(JSON.parse(String(init?.body)), { localIds: ['one-message'] });
            return Response.json(state.queuedState);
        }
        if (url.pathname === '/api/sessions/original-owner/messages' && init?.method === 'POST') {
            state.writes.push(JSON.parse(String(init.body)));
            if (state.loseSendAck) throw new Error('Synthetic lost send acknowledgement');
            return Response.json({ ok: true });
        }
        throw new Error('Unexpected owner request');
    };
    const operation: SourceOperation = { sessionId: sourceSessionId({ sourceId: config.id, machineId: config.machineId,
        engine: 'dsh', nativeId: 'native-root' }), operationId: 'one-message', kind: 'send', text: 'Keep this exact intent' };
    const create = (directory: string) => new DirectDshAdapter(config, directory,
        { env: { FIXTURE_OWNER_TOKEN: 'fixture-access' }, fetch: fetcher });
    return { state, operation, create };
}

test('a DSH receipt read cannot create a first operation, owner request, or durable uncertainty marker', async t => {
    const directory = await mkdtemp('/tmp/hhpi-dsh-receipts-'), fixture = ownerBoundary(join(directory, 'native'));
    const derived = join(directory, 'derived'), adapter = fixture.create(derived);
    t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
    assert.equal(await adapter.receipt(fixture.operation), null);
    assert.equal(fixture.state.paths.length, 0);
    await assert.rejects(stat(derived), { code: 'ENOENT' });
    await assert.rejects(adapter.receipt({ ...fixture.operation, sessionId: sourceSessionId({
        sourceId: 'another-source', machineId: 'machine', engine: 'dsh', nativeId: 'native-root' }) }), { code: 'INVALID_REQUEST' });
    await assert.rejects(adapter.receipt(fixture.operation, AbortSignal.abort()), { name: 'AbortError' });
    assert.equal(fixture.state.paths.length, 0);
});

test('a restarted DSH adapter recovers a lost reply from exact durable owner admission without replay or native coordinates', async t => {
    const directory = await mkdtemp('/tmp/hhpi-dsh-receipts-'), fixture = ownerBoundary(join(directory, 'native'));
    const derived = join(directory, 'derived');
    let adapter = fixture.create(derived);
    t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
    fixture.state.loseSendAck = true;
    assert.equal((await adapter.operate(fixture.operation)).status, 'indeterminate');
    assert.equal(fixture.state.writes.length, 1);
    await adapter.dispose(); adapter = fixture.create(derived);
    fixture.state.queuedState = { queuedLocalIds: ['one-message'], invokedLocalMessages: [] };
    const receipt = await adapter.receipt(fixture.operation);
    assert.equal(receipt?.status, 'accepted');
    assert.deepEqual(receipt?.ownerAdmission, { localId: 'one-message', state: 'queued' });
    assert.equal(receipt?.observed, undefined, 'owner durability is never presented as a native history event');
    assert.match(receipt?.message ?? '', /Native DSH execution is not confirmed/);
    const reads = fixture.state.paths.length;
    fixture.state.offline = true;
    assert.deepEqual(await adapter.operate(fixture.operation), receipt, 'accepted receipt is local even when the owner goes offline');
    assert.equal(fixture.state.paths.length, reads);
    assert.equal(fixture.state.writes.length, 1);
    await assert.rejects(adapter.receipt({ ...fixture.operation, text: 'Different intent' }), { code: 'INVALID_REQUEST' });
    assert.equal(fixture.state.paths.length, reads, 'a reused ID with changed arguments is rejected before any owner lookup');
});

test('missing queue evidence cannot convert an unknown DSH send into a retry or acceptance', async t => {
    const directory = await mkdtemp('/tmp/hhpi-dsh-receipts-'), fixture = ownerBoundary(join(directory, 'native'));
    const adapter = fixture.create(join(directory, 'derived'));
    t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
    fixture.state.loseSendAck = true;
    assert.equal((await adapter.operate(fixture.operation)).status, 'indeterminate');
    fixture.state.queuedState = { queuedLocalIds: ['other-operation'], invokedLocalMessages: [] };
    const receipt = await adapter.receipt(fixture.operation);
    assert.equal(receipt?.status, 'indeterminate'); assert.equal(receipt?.ownerAdmission, undefined);
    assert.equal(receipt?.retryable, undefined);
    assert.deepEqual(await adapter.operate(fixture.operation), receipt);
    assert.equal(fixture.state.writes.length, 1, 'read-side uncertainty never becomes another POST');
});

test('already accepted DSH sends stay fast and only explicit receipt reads acquire a separate owner handoff', async t => {
    const directory = await mkdtemp('/tmp/hhpi-dsh-receipts-'), fixture = ownerBoundary(join(directory, 'native'));
    const adapter = fixture.create(join(directory, 'derived'));
    t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
    const accepted = await adapter.operate(fixture.operation), calls = fixture.state.paths.length;
    fixture.state.offline = true;
    assert.deepEqual(await adapter.operate(fixture.operation), accepted);
    assert.equal(fixture.state.paths.length, calls, 'terminal operation retries never wait for the original owner');
    assert.deepEqual(await adapter.receipt(fixture.operation), accepted, 'an owner outage cannot erase the known HTTP acceptance');
    fixture.state.offline = false;
    fixture.state.queuedState = { queuedLocalIds: [], invokedLocalMessages: [{ localId: 'one-message', invokedAt: 456 }] };
    const handoff = await adapter.receipt(fixture.operation);
    assert.equal(handoff?.status, 'accepted');
    assert.deepEqual(handoff?.ownerAdmission, { localId: 'one-message', state: 'consumed' });
    assert.equal(handoff?.observed, undefined, 'session-end/queue consumed markers cannot prove native execution');
    assert.equal(fixture.state.writes.length, 1);
});
