/** Real pinned Cordis, Typert registry/gateway and access policy; only the native engine is a fixture. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import RemoteAccessService, { type RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access';
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway';
import { RemoteError, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import { HhpiSourceService } from '../src/remote/service.ts';
import { SourceGateway } from '../src/remote/gateway.ts';
import { sourceSessionId, type SourceAdapter, type SourceCatalog, type SourcePage, type SourceSession } from '../src/remote/protocol.ts';

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
    const writes: string[] = [];
    const adapter: SourceAdapter = { id: identity.sourceId, machineId: identity.machineId, engine: identity.engine,
        list: async () => [session, privateSession], read: async () => page,
        async *changes() { yield { session, epoch: 'epoch-a', base: 1, version: 2, reset: false, upserts: [], removed: [] }; },
        operate: async request => { writes.push(request.sessionId); return { sessionId: request.sessionId, operationId: request.operationId, status: 'accepted', message: 'Synthetic acknowledgement' }; },
        dispose: () => {},
    };
    const source = new SourceGateway([adapter], false);
    new HhpiSourceService(ctx, source);
    const gateway = new TypertGatewayService(ctx, TypertGatewayService.Config({}));
    const grants: RemoteAccessBinding[] = [];
    ctx.remoteAccess.registerPolicy('hhpi-service-fixture', { bindings: () => grants });
    const principal: Principal = { kind: 'hhpi-service-fixture' };
    const signal = new AbortController();
    const peer = (value: Principal): PeerScope => ({ id: 'hhpi-service' as PeerId, ctx, principal: value, interactions: 'answer', signal: signal.signal, dispose: async () => {} });
    return { ctx, grants, writes, adapter, signal,
        invoke: (method: string, args: Readonly<Record<string, unknown>>, value: Principal = principal) => gateway.invoke({ peer: peer(value), namespace: 'hhpi', method, args }),
        stream: (method: string, args: Readonly<Record<string, unknown>>, value: Principal = principal) => gateway.stream({ peer: peer(value), namespace: 'hhpi', method, args }),
        close: async () => { signal.abort(); await source.dispose(); await ctx.fiber.dispose(); },
    };
}
const denied = (error: unknown): boolean => error instanceof RemoteError && ['remote-access/denied', 'hhpi/source'].includes(error.code);

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
        assert.deepEqual(await app.invoke('read', { request: { sessionId: session.id } }), page);
        await assert.rejects(app.invoke('read', { request: { sessionId: privateSession.id } }), denied);
        await app.invoke('operate', { request: { sessionId: session.id, operationId: 'one', kind: 'send', text: 'synthetic' } });
        assert.deepEqual(app.writes, [session.id]);
        app.grants.length = 0;
        await assert.rejects(app.invoke('read', { request: { sessionId: session.id } }), denied);
    } finally { await app.close(); }
});
