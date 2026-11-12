/** Real pinned Cordis, Typert registry/gateway and access policy; only the native engine is a fixture. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import RemoteAccessService, { type RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access';
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway';
import { RemoteError, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FederationHub } from '../src/hub/federation.ts';
import { WorkspaceRepository } from '../src/hub/workspaces.ts';
import { WorkspaceShell } from '../src/hub/workspace-shell.ts';
import { HhpiSourceService, installSources, registerSourceContract, sourceStorageScope } from '../src/remote/service.ts';
import { SourceGateway } from '../src/remote/gateway.ts';
import { sourceSessionId, type SourceAdapter, type SourceCatalog, type SourcePage, type SourceReceipt, type SourceSession } from '../src/remote/protocol.ts';

declare module '@deepseek-ai/dsh-typert-protocol' {
    interface PrincipalMap { 'hhpi-service-fixture': { kind: 'hhpi-service-fixture' } }
}
const identity = { machineId: 'synthetic-machine', sourceId: 'synthetic-source', engine: 'codex', nativeId: 'synthetic-thread' };
const session: SourceSession = { ...identity, id: sourceSessionId(identity), title: 'Synthetic source', cwd: '/synthetic', updatedAt: 1,
    status: 'idle', activeTurnId: null, capabilities: { send: true, steer: true, cancel: true, approve: false, files: false }, pendingRequests: [] };
const privateSession: SourceSession = { ...session, nativeId: 'private-thread', id: sourceSessionId({ ...identity, nativeId: 'private-thread' }) };
const page: SourcePage = { session, epoch: 'epoch-a', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] };
async function mount() {
    const ctx = new Context(); await ctx.plugin(TypertRegistry); new RemoteAccessService(ctx);
    const writes: string[] = [], lookups: string[] = [], receipts = new Map<string, SourceReceipt>();
    const adapter: SourceAdapter = { id: identity.sourceId, machineId: identity.machineId, engine: identity.engine,
        list: async () => [session, privateSession], read: async () => page,
        async *changes() { yield { session, epoch: 'epoch-a', base: 1, version: 2, reset: false, upserts: [], removed: [] }; },
        operate: async request => {
            writes.push(request.sessionId);
            const receipt: SourceReceipt = { sessionId: request.sessionId, operationId: request.operationId, status: 'accepted', message: 'Synthetic acknowledgement' };
            receipts.set(JSON.stringify([request.sessionId, request.operationId]), receipt); return receipt;
        },
        receipt: async request => { lookups.push(request.sessionId); return receipts.get(JSON.stringify([request.sessionId, request.operationId])) ?? null; },
        dispose: () => {},
    };
    const source = new SourceGateway([adapter]);
    new HhpiSourceService(ctx, source, '/synthetic/installation');
    registerSourceContract(ctx);
    const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}));
    const grants: RemoteAccessBinding[] = [];
    ctx.remoteAccess.registerPolicy('hhpi-service-fixture', { bindings: () => grants });
    const principal: Principal = { kind: 'hhpi-service-fixture' };
    const signal = new AbortController();
    const peer = (value: Principal): PeerScope => ({ id: 'hhpi-service' as PeerId, ctx, principal: value, interactions: 'answer', signal: signal.signal, dispose: async () => {} });
    return { ctx, grants, writes, lookups, adapter, signal,
        invoke: (method: string, args: Readonly<Record<string, unknown>>, value: Principal = principal) => gateway.invoke({ peer: peer(value), namespace: 'hhpi', method, args }),
        stream: (method: string, args: Readonly<Record<string, unknown>>, value: Principal = principal) => gateway.stream({ peer: peer(value), namespace: 'hhpi', method, args }),
        close: async () => { signal.abort(); await source.dispose(); await ctx.fiber.dispose(); },
    };
}
const denied = (error: unknown): boolean => error instanceof RemoteError && ['remote-access/denied', 'hhpi/source'].includes(error.code);

test('real Host registers HHPI and workspace RPCs without a compatibility controller', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'hhpi-host-contract-'));
    const ctx = new Context();
    try {
        await ctx.plugin(TypertRegistry);
        new RemoteAccessService(ctx);
        installSources(ctx, [], join(directory, 'sources'));
        const workspace = new WorkspaceRepository(join(directory, 'workspace.json'));
        new WorkspaceShell(ctx, new FederationHub({ credentialsFile: join(directory, 'pairings.json') }), workspace, directory);
        const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}));
        const peer: PeerScope = { id: 'host-contract' as PeerId, ctx, principal: { kind: 'owner' },
            interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} };
        const catalog = await gateway.invoke({ peer, namespace: 'hhpi', method: 'catalog', args: {} }) as SourceCatalog;
        assert.equal(catalog.legacyHapi, false);
        assert.equal(catalog.storageScope, sourceStorageScope(join(directory, 'sources')), 'owner bootstrap and authenticated invocation use the same stable installation scope');
        assert.deepEqual(catalog.sources, []);
        assert.deepEqual(await gateway.invoke({ peer, namespace: 'hapi', method: 'workspaceGet', args: {} }), await workspace.get());
        const warnings: string[] = [], stderr = process.stderr.write;
        t.mock.method(process.stderr, 'write', function (chunk: string | Uint8Array, ...args: unknown[]) {
            const text = String(chunk);
            if (text.startsWith('Attachment upload failure ')) { warnings.push(text); return true; }
            return Reflect.apply(stderr, process.stderr, [chunk, ...args]) as boolean;
        });
        const report = { stage: 'draft-checkpoint', source: 'hhpi', build: 'development', name: 'QuotaExceededError', code: 'unknown' };
        assert.equal(await gateway.invoke({ peer, namespace: 'hapi', method: 'uploadFailure', args: { request: report } }), null);
        await assert.rejects(gateway.invoke({ peer, namespace: 'hapi', method: 'uploadFailure', args: { request: { ...report, message: 'private' } } }));
        await assert.rejects(gateway.invoke({ peer: { ...peer, principal: { kind: 'hhpi-service-fixture' } }, namespace: 'hapi', method: 'uploadFailure', args: { request: report } }),
            error => error instanceof RemoteError && error.code === 'remote-access/denied');
        assert.equal(warnings.length, 1, 'only a valid, authorized failure reaches the durable Host stderr sink');
        assert.deepEqual(JSON.parse(warnings[0]!.slice('Attachment upload failure '.length)), report);
        await assert.rejects(gateway.invoke({ peer, namespace: 'hapi', method: 'sourceSessionResolve',
            args: { request: { hubId: 'saved-legacy-hub', sourceSessionId: 'saved-session' } } }),
        /no active Remote method/,
        'the retired online Hub resolver must not be registered; finite offline aliases have their own authenticated service');
        assert.equal(ctx.typert.listPackages({ package: 'hapi-dsh', face: 'host' }).length, 1);
    } finally {
        await ctx.fiber.dispose();
        await rm(directory, { recursive: true, force: true });
    }
});

test('the real DSH gateway exposes HHPI without HAPI and rejects an ungranted caller', async () => {
    const app = await mount();
    try {
        assert.equal(app.ctx.get('hapi'), undefined);
        const owner = await app.invoke('catalog', {}, { kind: 'owner' }) as SourceCatalog;
        assert.equal(owner.legacyHapi, false); assert.equal(owner.sessions.length, 2);
        await assert.rejects(app.invoke('catalog', {}), denied);
        await assert.rejects(app.invoke('read', { request: { sessionId: session.id } }), denied);
        await assert.rejects(app.invoke('operate', { request: { sessionId: session.id, operationId: 'forbidden', kind: 'send', text: 'synthetic' } }), denied);
        assert.deepEqual(app.writes, []);
    } finally { await app.close(); }
});

test('invocation-scoped grants filter catalog and authorize the exact source on the real gateway', async () => {
    const app = await mount();
    try {
        app.grants.push({ role: { name: 'Catalog invocation', resource: 'global', actions: ['hhpi/catalog'] }, resource: { kind: 'global' } },
            { role: { name: 'One source session', resource: 'session', actions: ['hhpi/catalog', 'hhpi/read', 'hhpi/changes', 'hhpi/operate'] }, resource: { kind: 'session', id: SessionId(session.id) } });
        const filtered = await app.invoke('catalog', {}) as SourceCatalog;
        assert.deepEqual(filtered.sessions.map(value => value.id), [session.id]); assert.deepEqual(filtered.sources, []);
        assert.equal(filtered.storageScope, sourceStorageScope('/synthetic/installation', { kind: 'hhpi-service-fixture' }));
        assert.notEqual(filtered.storageScope, sourceStorageScope('/synthetic/installation'), 'session-only readers never adopt the owner cache scope');
        assert.deepEqual(await app.invoke('read', { request: { sessionId: session.id } }), page);
        await assert.rejects(app.invoke('read', { request: { sessionId: privateSession.id } }), denied);
        await app.invoke('operate', { request: { sessionId: session.id, operationId: 'one', kind: 'send', text: 'synthetic' } });
        assert.deepEqual(app.writes, [session.id]);
        app.grants.length = 0;
        await assert.rejects(app.invoke('read', { request: { sessionId: session.id } }), denied);
    } finally { await app.close(); }
});

test('read-only receipts use official exact-session authorization without granting operate or creating an operation', async () => {
    const app = await mount(), request = { sessionId: session.id, operationId: 'stored-operation', kind: 'send', text: 'synthetic' };
    try {
        const accepted = await app.invoke('operate', { request }, { kind: 'owner' });
        app.grants.push({ role: { name: 'Read one receipt', resource: 'session', actions: ['hhpi/receipt'] }, resource: { kind: 'session', id: SessionId(session.id) } });
        assert.deepEqual(await app.invoke('receipt', { request }), accepted);
        assert.equal(await app.invoke('receipt', { request: { ...request, operationId: 'never-sent' } }), null);
        await assert.rejects(app.invoke('operate', { request }), denied, 'receipt permission is not write permission');
        await assert.rejects(app.invoke('receipt', { request: { ...request, sessionId: privateSession.id } }), denied);
        assert.deepEqual(app.writes, [session.id]); assert.deepEqual(app.lookups, [session.id, session.id]);
        app.grants.length = 0;
        await assert.rejects(app.invoke('receipt', { request }), denied);
        assert.equal(app.lookups.length, 2, 'revoked lookups cannot enter the source adapter');
    } finally { await app.close(); }
});

test('native Codex routes require a source grant even when the caller owns one session', async () => {
    const app = await mount();
    let calls = 0;
    Object.assign(app.adapter, { nativeAccess: { call: async () => { calls++; return { status: 'accepted', message: 'Synthetic native read', result: { data: [] } }; } } });
    try {
        app.grants.push({ role: { name: 'Session native route', resource: 'session', actions: ['hhpi/nativeCall'] }, resource: { kind: 'session', id: SessionId(session.id) } });
        const request = { sourceId: identity.sourceId, method: 'model/list', params: {} };
        await assert.rejects(app.invoke('nativeCall', { request }), denied);
        assert.equal(calls, 0);
        app.grants.push({ role: { name: 'Source native route', resource: 'hhpiSource', actions: ['hhpi/nativeCall'] }, resource: { kind: 'hhpiSource', id: identity.sourceId } });
        assert.deepEqual(await app.invoke('nativeCall', { request }), { status: 'accepted', message: 'Synthetic native read', result: { data: [] } });
        assert.equal(calls, 1);
        await assert.rejects(app.invoke('nativeCall', { request: { ...request, sourceId: 'another-source' } }), denied);
        assert.equal(calls, 1);
    } finally { await app.close(); }
});
