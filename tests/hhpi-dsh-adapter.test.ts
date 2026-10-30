/** Real official log persistence and HHPI router; only source-owner HTTP is a fixture. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { MessageId } from '@deepseek-ai/dsh-llm';
import { apply as storage } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { DirectDshAdapter } from '../src/remote/dsh-adapter.ts';
import { SourceGateway } from '../src/remote/gateway.ts';
import { sourceSessionId, type DirectDshConfig } from '../src/remote/protocol.ts';

test('a migrated native DSH source keeps continuous pages, live append and exact-owner idempotent writes on one HHPI route', async t => {
    const directory = await mkdtemp('/mnt/cache/data-cache/hhpi-dsh-adapter-'), context = new Context();
    const root = join(directory, 'sessions'); await context.plugin(storage, { root });
    const writer = await context.sessionPersistence.create({ id: SessionId('native-root'), version: SESSION_FORMAT_VERSION,
        createdAt: 100, cwd: '/synthetic', isSeeded: false });
    const event = (seq: number): SessionEvent => ({ seq: SessionSeq(seq), time: 100 + seq, type: 'user/message', surfaceOp: 'append',
        data: { id: MessageId(`user-${seq}`), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Read native row ${seq}` }] } });
    await writer.append(Array.from({ length: 1120 }, (_, seq) => event(seq))); await writer.flush();
    const config: DirectDshConfig = { id: 'native-dsh', machineId: 'machine', engine: 'dsh', root,
        owner: { hubId: 'old-hub', url: 'http://owner.fixture', tokenEnv: 'FIXTURE_OWNER_TOKEN' } };
    const writes: unknown[] = [], paths: string[] = [];
    const metadata = { name: 'Original native', path: '/synthetic', flavor: 'dsh', machineId: 'machine', dshSessionId: 'native-root' };
    const sourceRow = { id: 'old-source', metadata, active: true, thinking: false, activeAt: 100, updatedAt: 100,
        metadataVersion: 1, agentStateVersion: 0, namespace: 'fixture', seq: 0, createdAt: 100, thinkingAt: 0, agentState: {} };
    const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input)); paths.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname === '/api/auth') return Response.json({ token: 'fixture-jwt' });
        if (url.pathname === '/api/sessions') {
            const { dshSessionId: _native, ...summary } = metadata;
            return Response.json({ sessions: [{ ...sourceRow, metadata: summary }] });
        }
        if (url.pathname === '/api/sessions/old-source') return Response.json({ session: sourceRow });
        if (url.pathname === '/api/sessions/old-source/messages' && init?.method === 'POST') {
            writes.push(JSON.parse(String(init.body))); return Response.json({ ok: true });
        }
        throw Error('Unexpected owner request');
    };
    const adapter = new DirectDshAdapter(config, join(directory, 'derived'), { env: { FIXTURE_OWNER_TOKEN: 'fixture-access' }, fetch: fetcher });
    const gateway = new SourceGateway([adapter], false), access = () => true;
    t.after(async () => { await gateway.dispose(); await writer.close(); await context.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
    const catalog = await gateway.catalog(access), session = catalog.sessions[0]!;
    assert.equal(catalog.legacyHapi, false); assert.equal(catalog.sessions.length, 1);
    assert.deepEqual(session.legacyOrigin, { hubId: 'old-hub', sessionId: 'old-source' });
    assert.equal(session.id, sourceSessionId({ sourceId: config.id, machineId: config.machineId, engine: 'dsh', nativeId: 'native-root' }));
    const baseline = await gateway.read({ sessionId: session.id }, access);
    let page = baseline;
    for (let i = 0; i < 6; i++) {
        const before = page.before!;
        page = await gateway.read({ sessionId: session.id, before, epoch: baseline.epoch }, access);
        assert.equal(page.after, before - 1); assert.equal(page.entries.length, 160);
        assert.equal(page.version, baseline.version); assert.equal(page.epoch, baseline.epoch);
    }
    assert.equal(page.before, 0); assert.equal(page.hasBefore, false);
    const signal = new AbortController(), changes = gateway.changes({ sessionId: session.id, epoch: baseline.epoch, version: baseline.version }, access, signal.signal)[Symbol.asyncIterator]();
    await writer.append([event(1120)]); await writer.flush();
    const update = await changes.next();
    assert.equal(update.value?.base, baseline.version); assert.deepEqual(update.value?.upserts.map(entry => entry.event.seq), [1120]);
    assert.equal(update.value?.reset, false); signal.abort(); await changes.return?.();
    const operation = { sessionId: session.id, operationId: 'one-message', kind: 'send' as const, text: 'Continue' };
    const [one, two] = await Promise.all([gateway.operate(operation, access), gateway.operate(operation, access)]);
    assert.equal(one.status, 'accepted'); assert.deepEqual(one, two);
    assert.deepEqual(writes, [{ text: 'Continue', localId: 'one-message', deliveryMode: 'queue' }]);
    assert.equal(paths.some(path => path === 'GET /api/sessions/old-source/messages'), false, 'HAPI bodies never enter native DSH reading');
    assert.equal(writer.access, 'write', 'opening and paging did not transfer native execution ownership');
});
